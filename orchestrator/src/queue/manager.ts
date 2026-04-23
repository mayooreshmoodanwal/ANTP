import { TierQueue, QueueItem } from "./tier-queue.js";
import { config } from "../config.js";

/**
 * QueueManager — Coordinates three tier queues.
 * Routes tasks to the correct queue based on tier assignment.
 */
export class QueueManager {
  private queues: Map<string, TierQueue>;

  constructor() {
    this.queues = new Map([
      ["TIER_1", new TierQueue("TIER_1", config.queueMaxDepth)],
      ["TIER_2", new TierQueue("TIER_2", config.queueMaxDepth)],
      ["TIER_3", new TierQueue("TIER_3", config.queueMaxDepth)],
    ]);
  }

  /** Get a specific tier queue. */
  getQueue(tier: string): TierQueue | undefined {
    return this.queues.get(tier);
  }

  /**
   * Enqueue a clone item into the appropriate tier queue.
   * Returns false if the queue is full or tier is invalid.
   */
  enqueue(item: QueueItem): boolean {
    const queue = this.queues.get(item.tier);
    if (!queue) {
      console.error(`[QueueManager] Invalid tier: ${item.tier}`);
      return false;
    }
    return queue.enqueue(item);
  }

  /**
   * Priority re-queue at index 0 (REQ-SLA-01).
   * Used for evicted tasks.
   */
  enqueuePriority(item: QueueItem): boolean {
    const queue = this.queues.get(item.tier);
    if (!queue) return false;
    return queue.enqueuePriority(item);
  }

  /**
   * Work stealing — node pulls a task from its tier queue.
   * Anti-affinity is enforced by the TierQueue.
   */
  steal(tier: string, nodeId: string): QueueItem | null {
    const queue = this.queues.get(tier);
    if (!queue) return null;
    return queue.steal(nodeId);
  }

  /** Release anti-affinity for a node/family pair. */
  releaseAntiAffinity(tier: string, familyId: string, nodeId: string): void {
    this.queues.get(tier)?.releaseAntiAffinity(familyId, nodeId);
  }

  /** Clean up a completed family from all queues. */
  cleanupFamily(familyId: string): void {
    for (const queue of this.queues.values()) {
      queue.cleanupFamily(familyId);
    }
  }

  /** Remove all queued clones for a task from all queues. */
  removeByTaskId(taskId: string): QueueItem[] {
    const removed: QueueItem[] = [];
    for (const queue of this.queues.values()) {
      removed.push(...queue.removeByTaskId(taskId));
    }
    return removed;
  }

  /** Get aggregated statistics across all queues. */
  getStats() {
    const stats: Record<string, ReturnType<TierQueue["getMetrics"]>> = {};
    let totalDepth = 0;
    let totalThroughput = 0;

    for (const [tier, queue] of this.queues) {
      const m = queue.getMetrics();
      stats[tier] = m;
      totalDepth += m.depth;
      totalThroughput += m.throughput;
    }

    return {
      queues: stats,
      totalDepth,
      totalThroughput,
    };
  }

  /** Graceful shutdown — drain all queues. */
  drainAll(): QueueItem[] {
    const all: QueueItem[] = [];
    for (const queue of this.queues.values()) {
      all.push(...queue.drain());
    }
    return all;
  }
}

/** Singleton queue manager. */
export const queueManager = new QueueManager();
