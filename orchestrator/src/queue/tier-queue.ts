/**
 * TierQueue — Priority-aware double-ended queue for a single tier.
 *
 * Design:
 * - O(1) push to back (normal enqueue)
 * - O(1) push to front (priority re-queue for evicted tasks, REQ-SLA-01)
 * - O(1) pop from front (work stealing)
 * - Anti-affinity tracking per task family
 * - Depth metrics
 */

export interface QueueItem {
  cloneId: string;
  taskId: string;
  familyId: string;
  tier: string;
  priority: number; // Lower = higher priority. Evicted tasks get 0.
  enqueuedAt: number; // Unix ms
  evictionCount: number;
  payload: {
    wasmBytes: Uint8Array;
    input: Uint8Array;
    timeoutMs: number;
  };
}

export class TierQueue {
  readonly tier: string;
  private queue: QueueItem[] = [];
  private maxDepth: number;

  // Anti-affinity: familyId → Set of nodeIds that have already stolen a clone
  private familyNodeMap = new Map<string, Set<string>>();

  // Metrics
  private totalEnqueued = 0;
  private totalDequeued = 0;
  private totalEvictionRequeues = 0;

  constructor(tier: string, maxDepth: number = 10000) {
    this.tier = tier;
    this.maxDepth = maxDepth;
  }

  /** Current queue depth. */
  get depth(): number {
    return this.queue.length;
  }

  /** Check if queue is empty. */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /** Check if queue is full. */
  get isFull(): boolean {
    return this.queue.length >= this.maxDepth;
  }

  /**
   * Enqueue an item at the back (normal priority).
   */
  enqueue(item: QueueItem): boolean {
    if (this.isFull) return false;

    this.queue.push(item);
    this.totalEnqueued++;

    // Initialize anti-affinity set for this family
    if (!this.familyNodeMap.has(item.familyId)) {
      this.familyNodeMap.set(item.familyId, new Set());
    }

    return true;
  }

  /**
   * Enqueue at the FRONT (priority index 0) — used for evicted tasks (REQ-SLA-01).
   * "If an eviction WebSocket ping is received, the Orchestrator reclaims the
   *  Task ID and places it at Index 0 (Priority) of the queue."
   */
  enqueuePriority(item: QueueItem): boolean {
    if (this.isFull) return false;

    item.priority = 0;
    this.queue.unshift(item);
    this.totalEnqueued++;
    this.totalEvictionRequeues++;

    // Reset the node from anti-affinity for this family
    // (since the evicted node is no longer processing it)
    return true;
  }

  /**
   * Steal (dequeue) a task for a given node.
   * Enforces anti-affinity: a node cannot steal a clone from a family
   * it is already processing (REQ-ORC-02).
   *
   * Returns null if no eligible task is available for this node.
   */
  steal(nodeId: string): QueueItem | null {
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      const familyNodes = this.familyNodeMap.get(item.familyId);

      // Anti-affinity check: skip if this node already has a clone from this family
      if (familyNodes?.has(nodeId)) {
        continue;
      }

      // Eligible! Remove from queue and record assignment.
      this.queue.splice(i, 1);
      this.totalDequeued++;

      // Record anti-affinity
      if (!familyNodes) {
        this.familyNodeMap.set(item.familyId, new Set([nodeId]));
      } else {
        familyNodes.add(nodeId);
      }

      return item;
    }

    return null; // No eligible task for this node
  }

  /**
   * Remove anti-affinity record when a node finishes or is evicted from a family.
   */
  releaseAntiAffinity(familyId: string, nodeId: string): void {
    this.familyNodeMap.get(familyId)?.delete(nodeId);
  }

  /**
   * Clean up anti-affinity data for a completed task family.
   */
  cleanupFamily(familyId: string): void {
    this.familyNodeMap.delete(familyId);
  }

  /**
   * Remove all queued clones for a specific task (e.g., when consensus is reached
   * and remaining clones are no longer needed).
   */
  removeByTaskId(taskId: string): QueueItem[] {
    const removed: QueueItem[] = [];
    this.queue = this.queue.filter((item) => {
      if (item.taskId === taskId) {
        removed.push(item);
        return false;
      }
      return true;
    });
    return removed;
  }

  /** Get queue metrics. */
  getMetrics() {
    const waitTimes: number[] = [];
    const now = Date.now();
    for (const item of this.queue) {
      waitTimes.push(now - item.enqueuedAt);
    }

    return {
      tier: this.tier,
      depth: this.depth,
      maxDepth: this.maxDepth,
      totalEnqueued: this.totalEnqueued,
      totalDequeued: this.totalDequeued,
      totalEvictionRequeues: this.totalEvictionRequeues,
      throughput: this.totalDequeued,
      avgWaitMs:
        waitTimes.length > 0
          ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
          : 0,
      maxWaitMs: waitTimes.length > 0 ? Math.max(...waitTimes) : 0,
      activeFamilies: this.familyNodeMap.size,
    };
  }

  /** Drain — remove all items (for graceful shutdown). */
  drain(): QueueItem[] {
    const items = [...this.queue];
    this.queue = [];
    this.familyNodeMap.clear();
    return items;
  }
}
