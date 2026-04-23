import { v4 as uuidv4 } from "uuid";
import { taskStore } from "../state/task-store.js";
import { queueManager } from "../queue/manager.js";
import type { QueueItem } from "../queue/tier-queue.js";
import { config } from "../config.js";

/**
 * Task Cloning (REQ-ORC-01).
 *
 * "Upon receiving a client task, the Orchestrator generates three identical
 *  clone IDs (e.g., Task_A, Task_B, Task_C) and places them in the
 *  corresponding Tier Queue."
 */

export interface CloneSet {
  taskId: string;
  familyId: string;
  tier: string;
  cloneIds: string[];
  payload: {
    wasmBytes: Uint8Array;
    input: Uint8Array;
    timeoutMs: number;
  };
}

/**
 * Create 3 clones for a task and enqueue them into the tier queue.
 * Returns the clone set with all clone IDs.
 */
export function createAndEnqueueClones(params: {
  taskId: string;
  familyId: string;
  tier: "TIER_1" | "TIER_2" | "TIER_3";
  wasmBytes: Uint8Array;
  input: Uint8Array;
  timeoutMs: number;
}): CloneSet {
  const { taskId, familyId, tier, wasmBytes, input, timeoutMs } = params;

  const cloneIds: string[] = [];
  const now = Date.now();

  for (let i = 0; i < config.clonesPerTask; i++) {
    const cloneId = uuidv4();
    cloneIds.push(cloneId);

    const queueItem: QueueItem = {
      cloneId,
      taskId,
      familyId,
      tier,
      priority: 1, // Normal priority
      enqueuedAt: now,
      evictionCount: 0,
      payload: { wasmBytes, input, timeoutMs },
    };

    const enqueued = queueManager.enqueue(queueItem);
    if (!enqueued) {
      console.error(
        `[Clone] Failed to enqueue clone ${i} for task ${taskId} — queue full`
      );
    }
  }

  // Update task store with clone info
  const taskState = taskStore.getTask(taskId);
  if (taskState) {
    taskState.cloneIds = cloneIds;
    taskState.status = "CLONED";
  }

  console.log(
    `[Clone] Created ${cloneIds.length} clones for task ${taskId.slice(0, 8)}... → ${tier}`
  );

  return {
    taskId,
    familyId,
    tier,
    cloneIds,
    payload: { wasmBytes, input, timeoutMs },
  };
}

/**
 * Re-queue an evicted clone at priority index 0 (REQ-SLA-01).
 */
export function requeueEvictedClone(
  cloneId: string,
  taskId: string,
  familyId: string,
  tier: string,
  nodeId: string,
  payload: { wasmBytes: Uint8Array; input: Uint8Array; timeoutMs: number }
): boolean {
  // Release anti-affinity for the evicted node
  queueManager.releaseAntiAffinity(tier, familyId, nodeId);

  // Update task store
  taskStore.evictClone(taskId, cloneId, nodeId);

  // Re-queue at priority 0
  const item: QueueItem = {
    cloneId,
    taskId,
    familyId,
    tier,
    priority: 0,
    enqueuedAt: Date.now(),
    evictionCount: 1, // Will be incremented in DB layer
    payload,
  };

  const success = queueManager.enqueuePriority(item);

  if (success) {
    console.log(
      `[Clone] Re-queued evicted clone ${cloneId.slice(0, 8)}... at priority 0`
    );
  }

  return success;
}
