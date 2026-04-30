import { eq, and, sql, inArray, lt, isNull, desc, count, gt } from "drizzle-orm";
import { db, schema } from "./db.js";
import {
  nodes,
  tasks,
  taskClones,
  taskResults,
  payouts,
  evictionLog,
  ragDocuments,
  users,
  apiKeys,
  pairingCodes,
} from "./schema.js";
import type {
  NewNode,
  NewTask,
  NewTaskClone,
  NewTaskResult,
  NewPayout,
  NewRagDocument,
  Node,
  Task,
  TaskClone,
  User,
  NewUser,
  ApiKey,
  NewApiKey,
  PairingCode,
  NewPairingCode,
} from "./schema.js";

// ──────────────────────────────────────────────
// Node Operations
// ──────────────────────────────────────────────

/** Register a new edge daemon node with kernel-queried hardware profile. */
export async function registerNode(data: NewNode): Promise<Node> {
  const [node] = await db
    .insert(nodes)
    .values(data)
    .onConflictDoUpdate({
      target: nodes.nodeId,
      set: {
        cpuCores: data.cpuCores,
        cpuModel: data.cpuModel,
        cpuFreqMhz: data.cpuFreqMhz,
        cpuArch: data.cpuArch,
        gpuModel: data.gpuModel,
        gpuVramMb: data.gpuVramMb,
        gpuComputeUnits: data.gpuComputeUnits,
        hasCuda: data.hasCuda,
        hasMetal: data.hasMetal,
        totalRamMb: data.totalRamMb,
        availableRamMb: data.availableRamMb,
        osName: data.osName,
        osVersion: data.osVersion,
        status: "ONLINE",
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();
  return node;
}

/** Get a node by its cryptographic hardware-bound ID. */
export async function getNodeByNodeId(
  nodeId: string
): Promise<Node | undefined> {
  return db.query.nodes.findFirst({
    where: eq(nodes.nodeId, nodeId),
  });
}

/** Update node status. */
export async function updateNodeStatus(
  nodeId: string,
  status: Node["status"]
): Promise<void> {
  await db
    .update(nodes)
    .set({ status, lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(nodes.nodeId, nodeId));
}

/** Update node heartbeat timestamp. */
export async function touchNode(nodeId: string): Promise<void> {
  await db
    .update(nodes)
    .set({ lastSeenAt: new Date() })
    .where(eq(nodes.nodeId, nodeId));
}

/** Get all online nodes for a given tier. */
export async function getOnlineNodesByTier(
  tier: Node["tier"]
): Promise<Node[]> {
  return db.query.nodes.findMany({
    where: and(eq(nodes.tier, tier), eq(nodes.status, "ONLINE")),
    orderBy: desc(nodes.reputationScore),
  });
}

/** Increment completed task count and earnings for a node. */
export async function incrementNodeStats(
  nodeId: string,
  earningsAmount: number
): Promise<void> {
  await db
    .update(nodes)
    .set({
      totalTasksCompleted: sql`${nodes.totalTasksCompleted} + 1`,
      totalEarnings: sql`${nodes.totalEarnings} + ${earningsAmount}`,
      consecutiveFailures: 0,
      updatedAt: new Date(),
    })
    .where(eq(nodes.nodeId, nodeId));
}

/**
 * Slash reputation score for a dissenting node (REQ-ORC-03).
 * Compounding: each slash reduces score by 5% of current value.
 */
export async function slashReputation(nodeId: string): Promise<void> {
  await db
    .update(nodes)
    .set({
      reputationScore: sql`${nodes.reputationScore} * 0.95`,
      consecutiveFailures: sql`${nodes.consecutiveFailures} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(nodes.nodeId, nodeId));
}

/** Boost reputation for correct consensus participation. */
export async function boostReputation(nodeId: string): Promise<void> {
  await db
    .update(nodes)
    .set({
      // Cap at 100.0
      reputationScore: sql`LEAST(${nodes.reputationScore} * 1.01, 100.0)`,
      updatedAt: new Date(),
    })
    .where(eq(nodes.nodeId, nodeId));
}

// ──────────────────────────────────────────────
// Task Operations
// ──────────────────────────────────────────────

/** Create a new client task. */
export async function createTask(data: NewTask): Promise<Task> {
  const [task] = await db.insert(tasks).values(data).returning();
  return task;
}

/** Get a task by ID. */
export async function getTask(taskId: string): Promise<Task | undefined> {
  return db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
  });
}

/** Get a task by family ID. */
export async function getTaskByFamily(
  familyId: string
): Promise<Task | undefined> {
  return db.query.tasks.findFirst({
    where: eq(tasks.familyId, familyId),
  });
}

/** Update task status. */
export async function updateTaskStatus(
  taskId: string,
  status: Task["status"],
  extra?: Partial<Task>
): Promise<void> {
  await db
    .update(tasks)
    .set({ status, ...extra })
    .where(eq(tasks.id, taskId));
}

/** Get tasks that have breached SLA deadline. */
export async function getSlaBreachedTasks(): Promise<Task[]> {
  return db.query.tasks.findMany({
    where: and(
      inArray(tasks.status, ["QUEUED", "CLONED", "IN_PROGRESS"]),
      lt(tasks.slaDeadlineAt, new Date())
    ),
  });
}

/** Get all tasks abandoned due to a server restart. */
export async function getAbandonedTasks(): Promise<Task[]> {
  return db.query.tasks.findMany({
    where: inArray(tasks.status, ["QUEUED", "CLONED", "IN_PROGRESS", "CONSENSUS_PENDING"]),
  });
}

// ──────────────────────────────────────────────
// Task Clone Operations
// ──────────────────────────────────────────────

/**
 * Create 3 clones for a task (REQ-ORC-01).
 * Returns all 3 clone records.
 */
export async function createClones(
  taskId: string,
  familyId: string
): Promise<TaskClone[]> {
  const cloneData: NewTaskClone[] = [0, 1, 2].map((i) => ({
    cloneIndex: i,
    taskId,
    familyId,
    status: "QUEUED" as const,
  }));

  return db.insert(taskClones).values(cloneData).returning();
}

/** Get all clones for a task family. */
export async function getClonesByFamily(
  familyId: string
): Promise<TaskClone[]> {
  return db.query.taskClones.findMany({
    where: eq(taskClones.familyId, familyId),
  });
}

/**
 * Assign a clone to a node (anti-affinity enforced via unique index).
 * Throws on conflict — the caller should catch and skip.
 */
export async function assignCloneToNode(
  cloneId: string,
  nodeId: string
): Promise<TaskClone> {
  const [clone] = await db
    .update(taskClones)
    .set({
      assignedNodeId: nodeId,
      assignedAt: new Date(),
      status: "ASSIGNED",
    })
    .where(
      and(eq(taskClones.id, cloneId), eq(taskClones.status, "QUEUED"))
    )
    .returning();
  return clone;
}

/** Mark clone as executing. */
export async function markCloneExecuting(cloneId: string): Promise<void> {
  await db
    .update(taskClones)
    .set({ status: "EXECUTING", startedAt: new Date() })
    .where(eq(taskClones.id, cloneId));
}

/** Mark clone as completed with result hash. */
export async function completeClone(
  cloneId: string,
  resultHash: string,
  execTimeMs: number,
  resultSizeBytes: number
): Promise<void> {
  await db
    .update(taskClones)
    .set({
      status: "COMPLETED",
      completedAt: new Date(),
      resultHash,
      execTimeMs,
      resultSizeBytes,
    })
    .where(eq(taskClones.id, cloneId));
}

/**
 * Evict a clone — resets assignment so it can be re-queued (REQ-SLA-01).
 */
export async function evictClone(cloneId: string): Promise<void> {
  await db
    .update(taskClones)
    .set({
      status: "QUEUED",
      assignedNodeId: null,
      assignedAt: null,
      startedAt: null,
      evictionCount: sql`${taskClones.evictionCount} + 1`,
      lastEvictedAt: new Date(),
    })
    .where(eq(taskClones.id, cloneId));
}

/** Get queued (unassigned) clones for a specific tier (via task). */
export async function getQueuedClonesForTier(
  tier: string
): Promise<(TaskClone & { task: Task })[]> {
  return db.query.taskClones.findMany({
    where: eq(taskClones.status, "QUEUED"),
    with: {
      task: true,
    },
    orderBy: taskClones.evictionCount, // Evicted tasks have higher priority
  }) as any;
}

// ──────────────────────────────────────────────
// Result Operations
// ──────────────────────────────────────────────

/** Record a task result from a node. */
export async function recordResult(data: NewTaskResult) {
  const [result] = await db.insert(taskResults).values(data).returning();
  return result;
}

/** Get all results for a task family (for consensus comparison). */
export async function getResultsByFamily(familyId: string) {
  return db.query.taskResults.findMany({
    where: eq(taskResults.familyId, familyId),
  });
}

/**
 * Process consensus for a task family (REQ-ORC-03).
 * Compares result hashes from all 3 clones.
 * Returns: { accepted: boolean, majorityHash, dissenters: string[] }
 */
export async function processConsensus(familyId: string): Promise<{
  accepted: boolean;
  majorityHash: string | null;
  majority: string[];
  dissenters: string[];
  allResults: Array<{
    nodeId: string;
    resultHash: string;
    cloneId: string;
  }>;
}> {
  const results = await getResultsByFamily(familyId);

  if (results.length < 3) {
    return {
      accepted: false,
      majorityHash: null,
      majority: [],
      dissenters: [],
      allResults: results.map((r) => ({
        nodeId: r.nodeId,
        resultHash: r.resultHash,
        cloneId: r.cloneId,
      })),
    };
  }

  // Count hash occurrences
  const hashCounts = new Map<
    string,
    Array<{ nodeId: string; cloneId: string }>
  >();
  for (const r of results) {
    const arr = hashCounts.get(r.resultHash) || [];
    arr.push({ nodeId: r.nodeId, cloneId: r.cloneId });
    hashCounts.set(r.resultHash, arr);
  }

  // Find majority (≥2 matching)
  let majorityHash: string | null = null;
  let majorityNodes: string[] = [];
  let dissenterNodes: string[] = [];

  for (const [hash, entries] of hashCounts) {
    if (entries.length >= 2) {
      majorityHash = hash;
      majorityNodes = entries.map((e) => e.nodeId);
      // Everyone NOT in majority is a dissenter
      dissenterNodes = results
        .filter((r) => r.resultHash !== hash)
        .map((r) => r.nodeId);
      break;
    }
  }

  // Update result records with consensus roles
  if (majorityHash) {
    // Mark majority results as correct
    for (const r of results) {
      const isCorrect = r.resultHash === majorityHash;
      await db
        .update(taskResults)
        .set({
          isCorrect,
          consensusRole: isCorrect ? "MAJORITY" : "DISSENTER",
        })
        .where(eq(taskResults.id, r.id));
    }
  }

  return {
    accepted: majorityHash !== null,
    majorityHash,
    majority: majorityNodes,
    dissenters: dissenterNodes,
    allResults: results.map((r) => ({
      nodeId: r.nodeId,
      resultHash: r.resultHash,
      cloneId: r.cloneId,
    })),
  };
}

// ──────────────────────────────────────────────
// Payout Operations
// ──────────────────────────────────────────────

/** Record a payout for a node. */
export async function recordPayout(data: NewPayout) {
  const [payout] = await db.insert(payouts).values(data).returning();
  return payout;
}

/** Get total unpaid balance for a node. */
export async function getUnpaidBalance(
  nodeId: string
): Promise<number> {
  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${payouts.amount}), 0)` })
    .from(payouts)
    .where(and(eq(payouts.nodeId, nodeId), eq(payouts.isPaid, false)));
  return result[0]?.total ?? 0;
}

/** Get payout history for a node. */
export async function getPayoutHistory(nodeId: string) {
  return db.query.payouts.findMany({
    where: eq(payouts.nodeId, nodeId),
    orderBy: desc(payouts.createdAt),
    limit: 100,
  });
}

// ──────────────────────────────────────────────
// Eviction Log Operations
// ──────────────────────────────────────────────

/** Log a task eviction event. */
export async function logEviction(data: {
  cloneId: string;
  taskId: string;
  nodeId: string;
  reason: "RAM_PRESSURE" | "NODE_DISCONNECT" | "TIMEOUT" | "MANUAL";
  availableRamMbAtEviction?: number;
}): Promise<void> {
  await db.insert(evictionLog).values({
    ...data,
    requeuedAt: new Date(),
  });
}

// ──────────────────────────────────────────────
// RAG Document Operations
// ──────────────────────────────────────────────

/** Store document chunks for RAG processing. */
export async function storeDocumentChunks(
  chunks: NewRagDocument[]
): Promise<void> {
  await db.insert(ragDocuments).values(chunks);
}

/** Get un-vectorized chunks for processing. */
export async function getUnvectorizedChunks(
  documentId: string
): Promise<typeof ragDocuments.$inferSelect[]> {
  return db.query.ragDocuments.findMany({
    where: and(
      eq(ragDocuments.documentId, documentId),
      eq(ragDocuments.isVectorized, false)
    ),
    orderBy: ragDocuments.chunkIndex,
  });
}

/** Update chunk with vector embedding. */
export async function updateChunkEmbedding(
  chunkId: string,
  embedding: number[],
  nodeId: string
): Promise<void> {
  await db
    .update(ragDocuments)
    .set({
      embedding,
      isVectorized: true,
      vectorizedByNode: nodeId,
      vectorizedAt: new Date(),
    })
    .where(eq(ragDocuments.id, chunkId));
}

/**
 * Semantic similarity search using pgvector cosine distance.
 * Returns top-K most similar chunks to the query embedding.
 */
export async function semanticSearch(
  queryEmbedding: number[],
  documentId: string,
  topK: number = 10,
  threshold: number = 0.78
) {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  const results = await db.execute(sql`
    SELECT 
      id,
      document_id,
      chunk_index,
      content,
      token_count,
      metadata,
      1 - (embedding <=> ${embeddingStr}::vector) as similarity
    FROM rag_documents
    WHERE document_id = ${documentId}
      AND is_vectorized = true
      AND 1 - (embedding <=> ${embeddingStr}::vector) >= ${threshold}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${topK}
  `);
  return results.rows;
}

// ──────────────────────────────────────────────
// Aggregate Queries
// ──────────────────────────────────────────────

/** Get overall system statistics. */
export async function getSystemStats() {
  const [nodeStats] = await db
    .select({
      totalNodes: count(),
      onlineNodes: sql<number>`COUNT(*) FILTER (WHERE ${nodes.status} = 'ONLINE')`,
      tier1Nodes: sql<number>`COUNT(*) FILTER (WHERE ${nodes.tier} = 'TIER_1')`,
      tier2Nodes: sql<number>`COUNT(*) FILTER (WHERE ${nodes.tier} = 'TIER_2')`,
      tier3Nodes: sql<number>`COUNT(*) FILTER (WHERE ${nodes.tier} = 'TIER_3')`,
    })
    .from(nodes);

  const [taskStats] = await db
    .select({
      totalTasks: count(),
      pendingTasks: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} IN ('PENDING', 'QUEUED', 'CLONED', 'IN_PROGRESS'))`,
      completedTasks: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'COMPLETED')`,
      failedTasks: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'FAILED')`,
      cloudFallbacks: sql<number>`COUNT(*) FILTER (WHERE ${tasks.usedCloudFallback} = true)`,
    })
    .from(tasks);

  return { nodes: nodeStats, tasks: taskStats };
}

// ──────────────────────────────────────────────
// User Operations
// ──────────────────────────────────────────────

/** Create a new user account. */
export async function createUser(data: NewUser): Promise<User> {
  const [user] = await db.insert(users).values(data).returning();
  return user;
}

/** Get a user by email. */
export async function getUserByEmail(email: string): Promise<User | undefined> {
  return db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });
}

/** Get a user by ID. */
export async function getUserById(userId: string): Promise<User | undefined> {
  return db.query.users.findFirst({
    where: eq(users.id, userId),
  });
}

/** Update user record. */
export async function updateUser(
  userId: string,
  data: Partial<User>
): Promise<void> {
  await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** Verify user email with OTP code. */
export async function verifyUserEmail(
  email: string,
  token: string
): Promise<User | undefined> {
  const user = await db.query.users.findFirst({
    where: and(
      eq(users.email, email.toLowerCase()),
      eq(users.verificationToken, token),
      gt(users.verificationExpiresAt, new Date())
    ),
  });

  if (user) {
    await db
      .update(users)
      .set({
        isVerified: true,
        verificationToken: null,
        verificationExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
  }

  return user;
}

/** Increment failed login attempts. */
export async function incrementFailedLogin(userId: string): Promise<number> {
  const [result] = await db
    .update(users)
    .set({
      failedLoginAttempts: sql`${users.failedLoginAttempts} + 1`,
    })
    .where(eq(users.id, userId))
    .returning({ attempts: users.failedLoginAttempts });
  return result?.attempts ?? 0;
}

/** Reset failed login attempts on successful login. */
export async function resetFailedLogin(userId: string): Promise<void> {
  await db
    .update(users)
    .set({
      failedLoginAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/** Lock user account for a duration. */
export async function lockUser(
  userId: string,
  until: Date
): Promise<void> {
  await db
    .update(users)
    .set({ lockedUntil: until })
    .where(eq(users.id, userId));
}

/** Link a node to a user (Node Provider). */
export async function linkNodeToUser(
  userId: string,
  nodeId: string
): Promise<void> {
  await db
    .update(users)
    .set({ linkedNodeId: nodeId, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** Get all users (admin). */
export async function getAllUsers(): Promise<User[]> {
  return db.query.users.findMany({
    orderBy: desc(users.createdAt),
  });
}

// ──────────────────────────────────────────────
// API Key Operations
// ──────────────────────────────────────────────

/** Create a new API key (stores hash only). */
export async function createApiKey(data: NewApiKey): Promise<ApiKey> {
  const [key] = await db.insert(apiKeys).values(data).returning();
  return key;
}

/** Get an API key by its SHA-256 hash. */
export async function getApiKeyByHash(
  keyHash: string
): Promise<(ApiKey & { user?: User }) | undefined> {
  const key = await db.query.apiKeys.findFirst({
    where: and(
      eq(apiKeys.keyHash, keyHash),
      eq(apiKeys.isRevoked, false)
    ),
    with: { user: true },
  });

  if (key) {
    // Check expiry
    if (key.expiresAt && key.expiresAt < new Date()) {
      return undefined;
    }
    // Update last used
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id));
  }

  return key as any;
}

/** Get all API keys for a user. */
export async function getUserApiKeys(userId: string): Promise<ApiKey[]> {
  return db.query.apiKeys.findMany({
    where: and(
      eq(apiKeys.userId, userId),
      eq(apiKeys.isRevoked, false)
    ),
    orderBy: desc(apiKeys.createdAt),
  });
}

/** Revoke an API key. */
export async function revokeApiKey(
  keyId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ isRevoked: true })
    .where(
      and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId))
    )
    .returning();
  return result.length > 0;
}

// ──────────────────────────────────────────────
// Pairing Code Operations
// ──────────────────────────────────────────────

/** Create a pairing code for a node. */
export async function createPairingCode(
  data: NewPairingCode
): Promise<PairingCode> {
  const [code] = await db.insert(pairingCodes).values(data).returning();
  return code;
}

/** Get a valid (unused, unexpired) pairing code by code string. */
export async function getPairingCode(
  code: string
): Promise<PairingCode | undefined> {
  return db.query.pairingCodes.findFirst({
    where: and(
      eq(pairingCodes.code, code),
      eq(pairingCodes.isUsed, false),
      gt(pairingCodes.expiresAt, new Date())
    ),
  });
}

/** Check if a node is already paired to a user. */
export async function isNodePaired(nodeId: string): Promise<boolean> {
  const code = await db.query.pairingCodes.findFirst({
    where: and(eq(pairingCodes.nodeId, nodeId), eq(pairingCodes.isUsed, true)),
  });
  return !!code;
}

/** Get an existing unused pairing code for a node. */
export async function getUnusedPairingCodeForNode(
  nodeId: string
): Promise<PairingCode | undefined> {
  return db.query.pairingCodes.findFirst({
    where: and(
      eq(pairingCodes.nodeId, nodeId),
      eq(pairingCodes.isUsed, false),
      gt(pairingCodes.expiresAt, new Date())
    ),
  });
}

/** Mark a pairing code as used and link user. */
export async function usePairingCode(
  code: string,
  userId: string
): Promise<PairingCode | undefined> {
  const [updated] = await db
    .update(pairingCodes)
    .set({
      isUsed: true,
      userId,
    })
    .where(
      and(
        eq(pairingCodes.code, code),
        eq(pairingCodes.isUsed, false),
        gt(pairingCodes.expiresAt, new Date())
      )
    )
    .returning();
  return updated;
}

// ──────────────────────────────────────────────
// User Task Queries
// ──────────────────────────────────────────────

/** Get tasks submitted by a specific user (paginated). */
export async function getUserTasks(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<Task[]> {
  return db.query.tasks.findMany({
    where: eq(tasks.submittedByUserId, userId),
    orderBy: desc(tasks.submittedAt),
    limit,
    offset,
  });
}

/** Get task count per status for a user. */
export async function getUserTaskStats(
  userId: string
): Promise<{ total: number; completed: number; failed: number; pending: number }> {
  const [stats] = await db
    .select({
      total: count(),
      completed: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'COMPLETED')`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'FAILED')`,
      pending: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} IN ('PENDING', 'QUEUED', 'CLONED', 'IN_PROGRESS'))`,
    })
    .from(tasks)
    .where(eq(tasks.submittedByUserId, userId));

  return stats ?? { total: 0, completed: 0, failed: 0, pending: 0 };
}

/** Get all nodes (admin). */
export async function getAllNodes(): Promise<Node[]> {
  return db.query.nodes.findMany({
    orderBy: desc(nodes.lastSeenAt),
  });
}
