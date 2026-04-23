import { EventEmitter } from "events";

/**
 * Shared in-memory task state store.
 *
 * This is the explicit interface between consensus/engine.ts and sla/monitor.ts
 * (per user feedback). Both modules read from and write to this store, making
 * the handoff between consensus tracking and SLA monitoring explicit.
 */

export interface TaskPayload {
  wasmBytes: Uint8Array;
  input: Uint8Array;
}

export interface TaskState {
  taskId: string;
  familyId: string;
  tier: "TIER_1" | "TIER_2" | "TIER_3";
  status:
    | "QUEUED"
    | "CLONED"
    | "IN_PROGRESS"
    | "CONSENSUS_PENDING"
    | "COMPLETED"
    | "FAILED"
    | "SLA_BREACHED"
    | "CLOUD_FALLBACK";

  // Payload (kept in memory for re-queue / cloud fallback)
  payload: TaskPayload;

  // SLA tracking
  submittedAt: number; // Unix ms
  slaDeadlineAt: number; // Unix ms
  slaTimeoutMs: number;

  // Clone tracking
  cloneIds: string[];
  completedClones: Set<string>;
  assignedNodes: Map<string, string>; // cloneId → nodeId

  // Consensus
  results: Map<
    string, // cloneId
    {
      nodeId: string;
      resultHash: string;
      output: Uint8Array;
      execTimeMs: number;
      status: string;
    }
  >;

  // Client callback
  clientCallbackUrl?: string;

  // Cloud fallback flag
  usedCloudFallback: boolean;
}

export type TaskStoreEvent =
  | "task:created"
  | "task:cloned"
  | "task:assigned"
  | "task:result"
  | "task:consensus"
  | "task:completed"
  | "task:failed"
  | "task:sla_breached"
  | "task:evicted"
  | "task:cloud_fallback";

/**
 * In-memory task state store with event system.
 *
 * Design:
 * - consensus/engine.ts writes results and triggers consensus checks.
 * - sla/monitor.ts reads deadlines and triggers cloud fallback.
 * - Both emit events that the orchestrator main loop listens to.
 */
export class TaskStore extends EventEmitter {
  private tasks = new Map<string, TaskState>(); // taskId → state
  private familyIndex = new Map<string, string>(); // familyId → taskId
  private activeByNode = new Map<string, Set<string>>(); // nodeId → Set<cloneId>

  /** Create a new task in the store. */
  createTask(state: TaskState): void {
    this.tasks.set(state.taskId, state);
    this.familyIndex.set(state.familyId, state.taskId);
    this.emit("task:created", state);
  }

  /** Get task state by task ID. */
  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  /** Get task state by family ID. */
  getTaskByFamily(familyId: string): TaskState | undefined {
    const taskId = this.familyIndex.get(familyId);
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  /** Update task status. */
  updateStatus(taskId: string, status: TaskState["status"]): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = status;
    }
  }

  /** Register a clone assignment to a node. */
  assignClone(taskId: string, cloneId: string, nodeId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.assignedNodes.set(cloneId, nodeId);

      // Track active clones per node (for anti-affinity)
      if (!this.activeByNode.has(nodeId)) {
        this.activeByNode.set(nodeId, new Set());
      }
      this.activeByNode.get(nodeId)!.add(cloneId);

      this.emit("task:assigned", { taskId, cloneId, nodeId });
    }
  }

  /**
   * Check anti-affinity: has this node already been assigned a clone
   * from the same task family?
   */
  hasAntiAffinityConflict(familyId: string, nodeId: string): boolean {
    const task = this.getTaskByFamily(familyId);
    if (!task) return false;

    for (const [, assignedNodeId] of task.assignedNodes) {
      if (assignedNodeId === nodeId) return true;
    }
    return false;
  }

  /** Record a clone result. */
  addResult(
    taskId: string,
    cloneId: string,
    result: {
      nodeId: string;
      resultHash: string;
      output: Uint8Array;
      execTimeMs: number;
      status: string;
    }
  ): number {
    const task = this.tasks.get(taskId);
    if (!task) return 0;

    task.results.set(cloneId, result);
    task.completedClones.add(cloneId);

    this.emit("task:result", { taskId, cloneId, result });

    return task.results.size;
  }

  /** Handle clone eviction — unassign and prepare for re-queue. */
  evictClone(taskId: string, cloneId: string, nodeId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.assignedNodes.delete(cloneId);
      task.completedClones.delete(cloneId);
      task.results.delete(cloneId);

      // Remove from node's active set
      this.activeByNode.get(nodeId)?.delete(cloneId);

      this.emit("task:evicted", { taskId, cloneId, nodeId });
    }
  }

  /** Get all tasks that have exceeded their SLA deadline. */
  getSlaBreachedTasks(): TaskState[] {
    const now = Date.now();
    const breached: TaskState[] = [];

    for (const task of this.tasks.values()) {
      if (
        task.slaDeadlineAt <= now &&
        !task.usedCloudFallback &&
        ["QUEUED", "CLONED", "IN_PROGRESS", "CONSENSUS_PENDING"].includes(
          task.status
        )
      ) {
        breached.push(task);
      }
    }

    return breached;
  }

  /** Get all active (non-terminal) tasks. */
  getActiveTasks(): TaskState[] {
    const active: TaskState[] = [];
    for (const task of this.tasks.values()) {
      if (
        !["COMPLETED", "FAILED", "CLOUD_FALLBACK"].includes(task.status)
      ) {
        active.push(task);
      }
    }
    return active;
  }

  /** Get clone IDs currently assigned to a node. */
  getNodeActiveClones(nodeId: string): Set<string> {
    return this.activeByNode.get(nodeId) || new Set();
  }

  /** Mark task as completed and clean up. */
  completeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "COMPLETED";

      // Clean up node assignments
      for (const [, nodeId] of task.assignedNodes) {
        this.activeByNode.get(nodeId)?.delete(taskId);
      }

      this.emit("task:completed", task);
    }
  }

  /** Mark task as using cloud fallback. */
  markCloudFallback(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.usedCloudFallback = true;
      task.status = "CLOUD_FALLBACK";
      this.emit("task:cloud_fallback", task);
    }
  }

  /** Get store statistics. */
  getStats() {
    let queued = 0,
      inProgress = 0,
      completed = 0,
      failed = 0,
      cloudFallback = 0;

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case "QUEUED":
        case "CLONED":
          queued++;
          break;
        case "IN_PROGRESS":
        case "CONSENSUS_PENDING":
          inProgress++;
          break;
        case "COMPLETED":
          completed++;
          break;
        case "FAILED":
          failed++;
          break;
        case "CLOUD_FALLBACK":
          cloudFallback++;
          break;
      }
    }

    return {
      total: this.tasks.size,
      queued,
      inProgress,
      completed,
      failed,
      cloudFallback,
      activeNodes: this.activeByNode.size,
    };
  }

  /** Purge completed/failed tasks older than maxAgeMs to prevent memory leaks. */
  purgeOld(maxAgeMs: number = 3600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let purged = 0;

    for (const [taskId, task] of this.tasks) {
      if (
        ["COMPLETED", "FAILED", "CLOUD_FALLBACK"].includes(task.status) &&
        task.submittedAt < cutoff
      ) {
        this.tasks.delete(taskId);
        this.familyIndex.delete(task.familyId);
        purged++;
      }
    }

    return purged;
  }
}

/** Singleton task store instance. */
export const taskStore = new TaskStore();
