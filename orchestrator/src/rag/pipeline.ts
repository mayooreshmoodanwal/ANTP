import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";
import { taskStore, type TaskPayload } from "../state/task-store.js";
import { createAndEnqueueClones } from "../consensus/clone.js";
import * as dbQueries from "../../../database/queries.js";

/**
 * RAG Pipeline — Three-phase distributed document processing (Section 4).
 *
 * Phase 1 (Map):   Document → chunks → vector embeddings (Tier 1/2 nodes)
 * Phase 2 (Search): Semantic similarity against vector DB (pgvector)
 * Phase 3 (Reduce): Relevant chunks → stitched payload → Tier 3 node
 *
 * Cloud Bypass Guarantee: All phases execute on edge nodes.
 * AWS/GCP is only invoked during SLA breach (Section 6).
 */

export interface RagRequest {
  documentContent: string;
  prompt: string;
  clientCallbackUrl?: string;
}

export interface RagPhaseResult {
  phase: number;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  data?: any;
}

/**
 * Initiate the RAG pipeline for a document + prompt.
 */
export async function initiateRagPipeline(request: RagRequest): Promise<{
  documentId: string;
  taskIds: string[];
}> {
  const documentId = uuidv4();

  console.log(
    `[RAG] Starting pipeline for document ${documentId.slice(0, 8)}... ` +
      `(${request.documentContent.length} chars)`
  );

  // ── Phase 1: Chunking & Vectorisation (Map Phase) ──
  const chunks = chunkDocument(
    request.documentContent,
    config.ragChunkSize,
    config.ragOverlap
  );

  console.log(
    `[RAG] Phase 1: Segmented into ${chunks.length} chunks (size=${config.ragChunkSize}, overlap=${config.ragOverlap})`
  );

  // Store chunks in DB
  const chunkRecords = chunks.map((content, i) => ({
    documentId,
    chunkIndex: i,
    content,
    tokenCount: estimateTokenCount(content),
    isVectorized: false,
    metadata: { prompt: request.prompt, phase: 1 },
  }));

  await dbQueries.storeDocumentChunks(chunkRecords);

  // Create vectorisation tasks for Tier 1/2 nodes
  const taskIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const taskId = uuidv4();
    const familyId = uuidv4();
    taskIds.push(taskId);

    // Create a lightweight WASM-like payload for vectorisation
    // In production, this would be a real vectorisation WASM module
    const encoder = new TextEncoder();
    const inputPayload = encoder.encode(
      JSON.stringify({
        operation: "vectorize",
        chunkIndex: i,
        content: chunks[i],
        documentId,
      })
    );

    // Register in task store
    const slaDeadlineAt = Date.now() + config.slaTimeoutMs;
    const payload: TaskPayload = {
      wasmBytes: new Uint8Array(0), // Placeholder — real WASM in production
      input: inputPayload,
    };

    taskStore.createTask({
      taskId,
      familyId,
      tier: "TIER_1", // Vectorisation is lightweight → Tier 1/2
      status: "QUEUED",
      payload,
      submittedAt: Date.now(),
      slaDeadlineAt,
      slaTimeoutMs: config.slaTimeoutMs,
      cloneIds: [],
      completedClones: new Set(),
      assignedNodes: new Map(),
      results: new Map(),
      clientCallbackUrl: request.clientCallbackUrl,
      usedCloudFallback: false,
    });

    // Create and enqueue 3 clones per chunk task
    createAndEnqueueClones({
      taskId,
      familyId,
      tier: "TIER_1",
      wasmBytes: payload.wasmBytes,
      input: payload.input,
      timeoutMs: config.slaTimeoutMs,
    });

    try {
      const dbTask = await dbQueries.createTask({
        id: taskId,
        familyId,
        type: "RAG_MAP",
        status: "CLONED",
        tier: "TIER_1",
        wasmBytesHash: "rag-vectorize-placeholder",
        inputHash: `chunk-${i}-${documentId.slice(0, 8)}`,
        payloadSizeBytes: inputPayload.byteLength,
        slaTimeoutMs: config.slaTimeoutMs,
        slaDeadlineAt: new Date(slaDeadlineAt),
        ragDocumentId: documentId,
        ragPhase: 1,
        clientCallbackUrl: request.clientCallbackUrl,
      });

      await dbQueries.createClones(dbTask.id, familyId);
    } catch (err) {
      console.error(`[RAG] DB error creating chunk task ${i}:`, err);
    }
  }

  console.log(
    `[RAG] Phase 1: Dispatched ${taskIds.length} vectorisation tasks to TIER_1 queue`
  );

  // Store pipeline metadata for Phase 2/3 orchestration
  ragPipelineState.set(documentId, {
    documentId,
    prompt: request.prompt,
    totalChunks: chunks.length,
    vectorizedChunks: 0,
    phase: 1,
    phase1TaskIds: taskIds,
    clientCallbackUrl: request.clientCallbackUrl,
  });

  return { documentId, taskIds };
}

/**
 * Called when a Phase 1 (vectorisation) task completes.
 * Checks if all chunks are vectorised, then triggers Phase 2.
 */
export async function onVectorizationComplete(
  documentId: string,
  chunkIndex: number,
  embedding: number[],
  nodeId: string
): Promise<void> {
  const pipeline = ragPipelineState.get(documentId);
  if (!pipeline) return;

  // Update chunk in DB
  const chunks = await dbQueries.getUnvectorizedChunks(documentId);
  const chunk = chunks.find((c) => c.chunkIndex === chunkIndex);
  if (chunk) {
    await dbQueries.updateChunkEmbedding(chunk.id, embedding, nodeId);
  }

  pipeline.vectorizedChunks++;

  console.log(
    `[RAG] Phase 1: Chunk ${chunkIndex}/${pipeline.totalChunks} vectorised by ${nodeId.slice(0, 8)}...`
  );

  // Check if all chunks are vectorised
  if (pipeline.vectorizedChunks >= pipeline.totalChunks) {
    console.log(`[RAG] Phase 1 complete. Starting Phase 2 (Semantic Search)...`);
    await executePhase2(documentId);
  }
}

/**
 * Phase 2 — Semantic Search.
 * Compare prompt against vectorised chunks, isolate relevant ones.
 */
async function executePhase2(documentId: string): Promise<void> {
  const pipeline = ragPipelineState.get(documentId);
  if (!pipeline) return;

  pipeline.phase = 2;

  // In production, the prompt would be embedded using the same model
  // For now, we use a placeholder embedding
  const promptEmbedding = new Array(1536).fill(0).map(() => Math.random());

  // Semantic search via pgvector
  const relevantChunks = await dbQueries.semanticSearch(
    promptEmbedding,
    documentId,
    10,
    config.ragSimilarityThreshold
  );

  console.log(
    `[RAG] Phase 2: Found ${relevantChunks.length} relevant chunks ` +
      `(threshold=${config.ragSimilarityThreshold})`
  );

  if (relevantChunks.length === 0) {
    console.warn(`[RAG] Phase 2: No relevant chunks found — pipeline ends`);
    pipeline.phase = -1; // Failed
    return;
  }

  // Proceed to Phase 3
  await executePhase3(documentId, relevantChunks);
}

/**
 * Phase 3 — Stitching (Reduce Phase).
 * Compile relevant chunks into a single payload → dispatch to TIER_3 exclusively.
 */
async function executePhase3(
  documentId: string,
  relevantChunks: any[]
): Promise<void> {
  const pipeline = ragPipelineState.get(documentId);
  if (!pipeline) return;

  pipeline.phase = 3;

  // Stitch relevant chunks into a single payload
  const stitchedContent = relevantChunks
    .map((c: any) => c.content)
    .join("\n\n---\n\n");

  console.log(
    `[RAG] Phase 3: Stitched ${relevantChunks.length} chunks ` +
      `(${stitchedContent.length} chars) → dispatching to TIER_3`
  );

  const taskId = uuidv4();
  const familyId = uuidv4();
  const encoder = new TextEncoder();
  const inputPayload = encoder.encode(
    JSON.stringify({
      operation: "rag_reduce",
      documentId,
      prompt: pipeline.prompt,
      context: stitchedContent,
    })
  );

  const slaDeadlineAt = Date.now() + config.slaTimeoutMs * 5; // Longer SLA for reduce
  const payload: TaskPayload = {
    wasmBytes: new Uint8Array(0), // Placeholder
    input: inputPayload,
  };

  taskStore.createTask({
    taskId,
    familyId,
    tier: "TIER_3", // Reduce goes to VIP nodes only
    status: "QUEUED",
    payload,
    submittedAt: Date.now(),
    slaDeadlineAt,
    slaTimeoutMs: config.slaTimeoutMs * 5,
    cloneIds: [],
    completedClones: new Set(),
    assignedNodes: new Map(),
    results: new Map(),
    clientCallbackUrl: pipeline.clientCallbackUrl,
    usedCloudFallback: false,
  });

  createAndEnqueueClones({
    taskId,
    familyId,
    tier: "TIER_3",
    wasmBytes: payload.wasmBytes,
    input: payload.input,
    timeoutMs: config.slaTimeoutMs * 5,
  });

  try {
    const dbTask = await dbQueries.createTask({
      id: taskId,
      familyId,
      type: "RAG_REDUCE",
      status: "CLONED",
      tier: "TIER_3",
      wasmBytesHash: "rag-reduce-placeholder",
      inputHash: `reduce-${documentId.slice(0, 8)}`,
      payloadSizeBytes: inputPayload.byteLength,
      slaTimeoutMs: config.slaTimeoutMs * 5,
      slaDeadlineAt: new Date(slaDeadlineAt),
      ragDocumentId: documentId,
      ragPhase: 3,
      clientCallbackUrl: pipeline.clientCallbackUrl,
    });

    await dbQueries.createClones(dbTask.id, familyId);
  } catch (err) {
    console.error(`[RAG] DB error creating reduce task:`, err);
  }

  console.log(
    `[RAG] Phase 3: Reduce task ${taskId.slice(0, 8)}... dispatched to TIER_3 queue`
  );
}

// ──────────────────────────────────────────────
// Internal Helpers
// ──────────────────────────────────────────────

/** In-memory pipeline state tracker. */
interface RagPipelineMetadata {
  documentId: string;
  prompt: string;
  totalChunks: number;
  vectorizedChunks: number;
  phase: number;
  phase1TaskIds: string[];
  clientCallbackUrl?: string;
}

const ragPipelineState = new Map<string, RagPipelineMetadata>();

/**
 * Chunk a document into overlapping segments.
 * Uses character-based chunking with overlap for context preservation.
 */
function chunkDocument(
  content: string,
  chunkSize: number,
  overlap: number
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(start + chunkSize, content.length);
    chunks.push(content.slice(start, end));

    // Advance by (chunkSize - overlap) to create overlapping windows
    start += chunkSize - overlap;

    // Prevent infinite loop on tiny overlap
    if (chunkSize - overlap <= 0) break;
  }

  return chunks;
}

/**
 * Rough token count estimation (1 token ≈ 4 chars for English).
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Get pipeline state (for API). */
export function getPipelineState(
  documentId: string
): RagPipelineMetadata | undefined {
  return ragPipelineState.get(documentId);
}
