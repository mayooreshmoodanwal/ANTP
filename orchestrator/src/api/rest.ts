import type { TemplatedApp, HttpResponse, HttpRequest } from "uWebSockets.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";
import { config } from "../config.js";
import { taskStore, type TaskPayload } from "../state/task-store.js";
import { queueManager } from "../queue/manager.js";
import { createAndEnqueueClones } from "../consensus/clone.js";
import { connectedNodes } from "../ws/server.js";
import { initiateRagPipeline, getPipelineState } from "../rag/pipeline.js";
import { getNodeEarnings, getTierRates } from "../economics/payout.js";
import { getSlaStatus } from "../sla/monitor.js";
import * as dbQueries from "../../../database/queries.js";

/**
 * Register HTTP REST endpoints on the uWebSockets app.
 *
 * Endpoints:
 * - POST /api/task           — Submit a compute task
 * - GET  /api/task/:id/status — Poll task status
 * - GET  /api/node/:id/stats — Node statistics
 * - GET  /api/queue/stats    — Queue depth and throughput
 * - POST /api/rag/process    — Submit RAG document
 * - GET  /api/system/stats   — Overall system statistics
 * - GET  /api/tiers          — Tier rate information
 * - GET  /api/health         — Health check
 */
export function registerRestApi(app: TemplatedApp): void {
  // ── CORS Preflight ──
  app.options("/*", (res, req) => {
    res
      .writeHeader("Access-Control-Allow-Origin", "*")
      .writeHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
      .writeHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
      .writeHeader("Access-Control-Max-Age", "86400")
      .writeStatus("204 No Content")
      .end();
  });

  // ── Health Check ──
  app.get("/api/health", (res, req) => {
    jsonResponse(res, 200, {
      status: "ok",
      uptime: process.uptime(),
      connectedNodes: connectedNodes.size,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Submit Task ──
  app.post("/api/task", (res, req) => {
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    readJson(res, req, async (body: any) => {
      if (aborted) return;
      try {
        if (!body || !body.tier) {
          if (!aborted) jsonResponse(res, 400, {
            error: "Missing required field: tier",
          });
          return;
        }

        const taskId = uuidv4();
        const familyId = uuidv4();
        const tier = body.tier as "TIER_1" | "TIER_2" | "TIER_3";

        // Parse payload
        const wasmBytes = body.wasmBytes
          ? Buffer.from(body.wasmBytes, "base64")
          : new Uint8Array(0);
        const input = body.input
          ? Buffer.from(body.input, "base64")
          : new Uint8Array(0);
        const timeoutMs = body.timeoutMs || config.slaTimeoutMs;

        const slaDeadlineAt = Date.now() + timeoutMs;
        const payload: TaskPayload = { wasmBytes, input };

        // Register in task store
        taskStore.createTask({
          taskId,
          familyId,
          tier,
          status: "QUEUED",
          payload,
          submittedAt: Date.now(),
          slaDeadlineAt,
          slaTimeoutMs: timeoutMs,
          cloneIds: [],
          completedClones: new Set(),
          assignedNodes: new Map(),
          results: new Map(),
          clientCallbackUrl: body.callbackUrl,
          usedCloudFallback: false,
        });

        // Create and enqueue 3 clones (REQ-ORC-01)
        const cloneSet = createAndEnqueueClones({
          taskId,
          familyId,
          tier,
          wasmBytes,
          input,
          timeoutMs,
        });

        // Persist to DB
        try {
          const dbTask = await dbQueries.createTask({
            familyId,
            type: "COMPUTE",
            status: "CLONED",
            tier,
            wasmBytesHash: hashBytes(wasmBytes),
            inputHash: hashBytes(input),
            payloadSizeBytes: wasmBytes.byteLength + input.byteLength,
            slaTimeoutMs: timeoutMs,
            slaDeadlineAt: new Date(slaDeadlineAt),
            clientCallbackUrl: body.callbackUrl,
          });
          await dbQueries.createClones(dbTask.id, familyId);
        } catch (err) {
          console.error("[REST] DB error creating task:", err);
        }

        if (!aborted) jsonResponse(res, 201, {
          taskId,
          familyId,
          tier,
          cloneIds: cloneSet.cloneIds,
          slaDeadlineAt: new Date(slaDeadlineAt).toISOString(),
          status: "CLONED",
        });
      } catch (err: any) {
        console.error("[REST] Error submitting task:", err);
        if (!aborted) jsonResponse(res, 500, { error: err.message });
      }
    });
  });

  // ── Task Status ──
  app.get("/api/task/:id/status", (res, req) => {
    const taskId = req.getParameter(0);

    const task = taskStore.getTask(taskId);
    if (!task) {
      jsonResponse(res, 404, { error: "Task not found" });
      return;
    }

    const results: Record<string, any> = {};
    for (const [cloneId, result] of task.results) {
      results[cloneId] = {
        nodeId: result.nodeId,
        resultHash: result.resultHash,
        execTimeMs: result.execTimeMs,
        status: result.status,
        outputSize: result.output.byteLength,
      };
    }

    jsonResponse(res, 200, {
      taskId: task.taskId,
      familyId: task.familyId,
      tier: task.tier,
      status: task.status,
      submittedAt: new Date(task.submittedAt).toISOString(),
      slaDeadlineAt: new Date(task.slaDeadlineAt).toISOString(),
      cloneIds: task.cloneIds,
      completedClones: Array.from(task.completedClones),
      assignedNodes: Object.fromEntries(task.assignedNodes),
      results,
      usedCloudFallback: task.usedCloudFallback,
    });
  });

  // ── Node Stats ──
  app.get("/api/node/:id/stats", async (res, req) => {
    const nodeId = req.getParameter(0);
    res.onAborted(() => {});

    try {
      const earnings = await getNodeEarnings(nodeId);
      const node = await dbQueries.getNodeByNodeId(nodeId);

      if (!node) {
        jsonResponse(res, 404, { error: "Node not found" });
        return;
      }

      jsonResponse(res, 200, {
        nodeId: node.nodeId,
        tier: node.tier,
        status: node.status,
        hardware: {
          cpu: `${node.cpuModel} (${node.cpuCores}c @ ${node.cpuFreqMhz}MHz)`,
          gpu: node.gpuModel || "None",
          ram: `${node.totalRamMb}MB`,
        },
        reputation: node.reputationScore,
        totalTasksCompleted: node.totalTasksCompleted,
        earnings,
        isConnected: connectedNodes.has(nodeId),
        registeredAt: node.registeredAt,
        lastSeenAt: node.lastSeenAt,
      });
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  // ── Queue Stats ──
  app.get("/api/queue/stats", (res, req) => {
    jsonResponse(res, 200, queueManager.getStats());
  });

  // ── RAG Process ──
  app.post("/api/rag/process", (res, req) => {
    readJson(res, req, async (body: any) => {
      try {
        if (!body?.documentContent || !body?.prompt) {
          jsonResponse(res, 400, {
            error: "Missing required fields: documentContent, prompt",
          });
          return;
        }

        const result = await initiateRagPipeline({
          documentContent: body.documentContent,
          prompt: body.prompt,
          clientCallbackUrl: body.callbackUrl,
        });

        jsonResponse(res, 202, {
          documentId: result.documentId,
          phase1TaskIds: result.taskIds,
          status: "PROCESSING",
          message:
            "RAG pipeline initiated. Phase 1 (vectorisation) in progress.",
        });
      } catch (err: any) {
        console.error("[REST] RAG error:", err);
        jsonResponse(res, 500, { error: err.message });
      }
    });
  });

  // ── RAG Pipeline Status ──
  app.get("/api/rag/:id/status", (res, req) => {
    const documentId = req.getParameter(0);
    const pipeline = getPipelineState(documentId);

    if (!pipeline) {
      jsonResponse(res, 404, { error: "RAG pipeline not found" });
      return;
    }

    jsonResponse(res, 200, pipeline);
  });

  // ── System Stats ──
  app.get("/api/system/stats", async (res, req) => {
    res.onAborted(() => {});

    try {
      const dbStats = await dbQueries.getSystemStats();
      const queueStats = queueManager.getStats();
      const storeStats = taskStore.getStats();
      const slaStatus = getSlaStatus();

      jsonResponse(res, 200, {
        database: dbStats,
        queues: queueStats,
        inMemory: storeStats,
        sla: slaStatus,
        connectedNodes: connectedNodes.size,
        uptime: process.uptime(),
      });
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  // ── Tier Rates ──
  app.get("/api/tiers", (res, req) => {
    jsonResponse(res, 200, getTierRates());
  });

  // ── SLA Status ──
  app.get("/api/sla/status", (res, req) => {
    jsonResponse(res, 200, getSlaStatus());
  });

  console.log("[REST] API endpoints registered");
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Send a JSON response with CORS headers. */
function jsonResponse(res: HttpResponse, status: number, data: any): void {
  const statusTexts: Record<number, string> = {
    200: "200 OK",
    201: "201 Created",
    202: "202 Accepted",
    400: "400 Bad Request",
    404: "404 Not Found",
    500: "500 Internal Server Error",
  };

  try {
    res.cork(() => {
      res
        .writeStatus(statusTexts[status] || `${status}`)
        .writeHeader("Content-Type", "application/json")
        .writeHeader("Access-Control-Allow-Origin", "*")
        .writeHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .writeHeader("Access-Control-Allow-Headers", "Content-Type")
        .end(JSON.stringify(data));
    });
  } catch {
    // Response may already be aborted
  }
}

/** Read JSON body from a POST request (uWebSockets streaming body API). */
function readJson(
  res: HttpResponse,
  req: HttpRequest,
  callback: (body: any) => void
): void {
  let buffer = Buffer.alloc(0);
  let aborted = false;

  res.onAborted(() => {
    aborted = true;
  });

  res.onData((chunk, isLast) => {
    if (aborted) return;

    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

    if (isLast) {
      try {
        const body = JSON.parse(buffer.toString());
        callback(body);
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON body" });
      }
    }
  });
}

/** Quick SHA-256 hash of bytes (for payload identification). */
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
