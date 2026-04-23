import { taskStore } from "../state/task-store.js";
import { queueManager } from "../queue/manager.js";
import { forwardToCloud } from "./fallback.js";
import { config } from "../config.js";
import * as dbQueries from "../../../database/queries.js";

/**
 * SLA Monitor — Polls active tasks every 100ms for SLA breaches (REQ-SLA-02).
 *
 * Decision tree:
 * 1. Eviction detected via WebSocket ping → Task re-queued at Priority Index 0
 * 2. SLA timeout (2.0s) exceeded → Swarm routing halted → Payload forwarded to Cloud
 * 3. Cloud Shadow Server response is returned to client within contracted SLA window
 */

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// Callback registry for delivering results to WebSocket connections
type ResultCallback = (
  taskId: string,
  output: Uint8Array,
  resultHash: string,
  source: "EDGE" | "CLOUD"
) => void;

let resultCallback: ResultCallback | null = null;

/**
 * Register a callback for delivering task results.
 * Called by the WebSocket server to wire result delivery.
 */
export function onTaskResult(cb: ResultCallback): void {
  resultCallback = cb;
}

/**
 * Start the SLA monitoring loop.
 * Checks every 100ms for tasks that have exceeded their SLA deadline.
 */
export function startSlaMonitor(): void {
  if (isRunning) return;
  isRunning = true;

  console.log(
    `[SLA] Monitor started (interval=${config.slaMonitorIntervalMs}ms, timeout=${config.slaTimeoutMs}ms)`
  );

  monitorInterval = setInterval(async () => {
    try {
      await checkSlaBreaches();
    } catch (err) {
      console.error("[SLA] Monitor error:", err);
    }
  }, config.slaMonitorIntervalMs);
}

/**
 * Stop the SLA monitoring loop.
 */
export function stopSlaMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  isRunning = false;
  console.log("[SLA] Monitor stopped");
}

/**
 * Core SLA check — find breached tasks and trigger cloud fallback.
 */
async function checkSlaBreaches(): Promise<void> {
  const breachedTasks = taskStore.getSlaBreachedTasks();

  for (const task of breachedTasks) {
    console.warn(
      `[SLA] ⚠️  Task ${task.taskId.slice(0, 8)}... breached SLA ` +
        `(deadline was ${new Date(task.slaDeadlineAt).toISOString()}, ` +
        `elapsed=${Date.now() - task.submittedAt}ms)`
    );

    // Mark as SLA breached in store
    taskStore.updateStatus(task.taskId, "SLA_BREACHED");

    // Remove any remaining queued clones
    queueManager.removeByTaskId(task.taskId);

    // Forward to Cloud Shadow Server
    try {
      const cloudResponse = await forwardToCloud({
        taskId: task.taskId,
        familyId: task.familyId,
        tier: task.tier,
        wasmBytes: task.payload.wasmBytes,
        input: task.payload.input,
        timeoutMs: config.cloudFallbackTimeoutMs,
        reason: "SLA_TIMEOUT",
      });

      // Mark task as cloud fallback
      taskStore.markCloudFallback(task.taskId);

      // Update DB
      try {
        await dbQueries.updateTaskStatus(task.taskId, "CLOUD_FALLBACK", {
          usedCloudFallback: true,
          acceptedResultHash: cloudResponse.resultHash || null,
          completedAt: new Date(),
        });
      } catch (dbErr) {
        console.error("[SLA] DB error updating cloud fallback task:", dbErr);
      }

      // Deliver result to client
      if (cloudResponse.status === "OK" && resultCallback) {
        resultCallback(
          task.taskId,
          cloudResponse.output,
          cloudResponse.resultHash,
          "CLOUD"
        );
      }

      console.log(
        `[SLA] Task ${task.taskId.slice(0, 8)}... resolved via cloud fallback ` +
          `(status=${cloudResponse.status})`
      );
    } catch (err) {
      console.error(
        `[SLA] Cloud fallback failed for ${task.taskId.slice(0, 8)}...:`,
        err
      );

      // Last resort — mark as failed
      taskStore.updateStatus(task.taskId, "FAILED");
      try {
        await dbQueries.updateTaskStatus(task.taskId, "FAILED", {
          usedCloudFallback: true,
          completedAt: new Date(),
        });
      } catch (dbErr) {
        console.error("[SLA] DB error marking task failed:", dbErr);
      }
    }
  }
}

/** Get SLA monitor status (for API). */
export function getSlaStatus() {
  return {
    isRunning,
    intervalMs: config.slaMonitorIntervalMs,
    timeoutMs: config.slaTimeoutMs,
    breachedCount: taskStore
      .getActiveTasks()
      .filter((t) => t.status === "SLA_BREACHED").length,
    cloudFallbackUrl: config.cloudFallbackUrl,
  };
}
