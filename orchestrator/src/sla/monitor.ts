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

const slaTimers = new Map<string, NodeJS.Timeout>();
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
 * Start the SLA monitoring subsystem.
 */
export function startSlaMonitor(): void {
  if (isRunning) return;
  isRunning = true;

  console.log(
    `[SLA] Event-driven Monitor started (timeout=${config.slaTimeoutMs}ms)`
  );
}

/**
 * Stop the SLA monitoring subsystem.
 */
export function stopSlaMonitor(): void {
  for (const timer of slaTimers.values()) {
    clearTimeout(timer);
  }
  slaTimers.clear();
  isRunning = false;
  console.log("[SLA] Monitor stopped");
}

/**
 * Track a task's SLA deadline via an event-driven timer.
 * @param taskId The task to track
 * @param timeoutMs The SLA deadline in milliseconds
 */
export function trackTaskSla(taskId: string, timeoutMs: number): void {
  if (!isRunning) return;

  // Clear any existing timer just in case
  clearTaskSla(taskId);

  const timer = setTimeout(async () => {
    slaTimers.delete(taskId);
    await enforceSlaBreach(taskId);
  }, timeoutMs);

  slaTimers.set(taskId, timer);
}

/**
 * Clear a task's SLA timer (e.g., if it successfully reaches consensus early).
 */
export function clearTaskSla(taskId: string): void {
  const timer = slaTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    slaTimers.delete(taskId);
  }
}

/**
 * Core SLA check — trigger cloud fallback for a specific breached task.
 */
async function enforceSlaBreach(taskId: string): Promise<void> {
  const task = taskStore.getTask(taskId);
  if (!task) return; // Task no longer in store

  // Check if it's still active and hasn't already fallen back
  if (
    task.usedCloudFallback ||
    !["QUEUED", "CLONED", "IN_PROGRESS", "CONSENSUS_PENDING"].includes(task.status)
  ) {
    return;
  }

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
