import { config } from "../config.js";
import * as dbQueries from "../../../database/queries.js";

/**
 * Payout Engine (Section 5 — Proof-of-Work Economics).
 *
 * Formula:
 *   User_Reward = Base_Rate[Tier] * Total_Verified_Tasks_Processed
 *
 * Tier Base Rates:
 *   Tier 1 = $0.001 per verified task
 *   Tier 2 = $0.020 per verified task
 *   Tier 3 = $0.500 per verified task
 *
 * Anti-Gaming Properties:
 * - Payout requires verified task completion — passive presence earns nothing.
 * - Spoofed hardware profiles are detected at kernel-query time.
 * - Reputation slashing applies compounding cost to incorrect results.
 */

export type TierName = "TIER_1" | "TIER_2" | "TIER_3";

/**
 * Calculate payout for a single verified task.
 */
export function calculatePayout(tier: TierName): number {
  const rate = config.payoutRates[tier];
  if (rate === undefined) {
    throw new Error(`[Payout] Unknown tier: ${tier}`);
  }
  return rate;
}

/**
 * Calculate total earnings for N verified tasks at a given tier.
 */
export function calculateBulkPayout(tier: TierName, taskCount: number): number {
  return calculatePayout(tier) * taskCount;
}

/**
 * Process payout for a node after consensus verification.
 * Called by the consensus engine for each majority node.
 */
export async function processPayout(params: {
  nodeId: string;
  taskId: string;
  cloneId: string;
  tier: TierName;
}): Promise<{ amount: number; newBalance: number }> {
  const { nodeId, taskId, cloneId, tier } = params;
  const amount = calculatePayout(tier);
  const baseRate = config.payoutRates[tier];

  // Record payout in DB
  await dbQueries.recordPayout({
    nodeId,
    taskId,
    cloneId,
    tier,
    baseRate,
    amount,
  });

  // Update node stats
  await dbQueries.incrementNodeStats(nodeId, amount);
  await dbQueries.boostReputation(nodeId);

  // Get updated balance
  const newBalance = await dbQueries.getUnpaidBalance(nodeId);

  console.log(
    `[Payout] ${nodeId.slice(0, 8)}... earned $${amount.toFixed(3)} ` +
      `(${tier}, task=${taskId.slice(0, 8)}...) — balance=$${newBalance.toFixed(3)}`
  );

  return { amount, newBalance };
}

/**
 * Get earnings summary for a node.
 */
export async function getNodeEarnings(nodeId: string): Promise<{
  unpaidBalance: number;
  totalEarned: number;
  taskCount: number;
  reputationScore: number;
  history: Awaited<ReturnType<typeof dbQueries.getPayoutHistory>>;
}> {
  const [node, unpaidBalance, history] = await Promise.all([
    dbQueries.getNodeByNodeId(nodeId),
    dbQueries.getUnpaidBalance(nodeId),
    dbQueries.getPayoutHistory(nodeId),
  ]);

  return {
    unpaidBalance,
    totalEarned: node?.totalEarnings ?? 0,
    taskCount: node?.totalTasksCompleted ?? 0,
    reputationScore: node?.reputationScore ?? 0,
    history,
  };
}

/**
 * Get tier rate information (for API/dashboard).
 */
export function getTierRates(): Record<
  TierName,
  { baseRate: number; description: string }
> {
  return {
    TIER_1: {
      baseRate: config.payoutRates.TIER_1,
      description:
        "Basic CPU, <4GB RAM — Data Scraping, Basic Arithmetic, MicroModels",
    },
    TIER_2: {
      baseRate: config.payoutRates.TIER_2,
      description:
        "Dedicated GPU, 8GB+ RAM — Standard AI Inference, 3D Rendering",
    },
    TIER_3: {
      baseRate: config.payoutRates.TIER_3,
      description:
        "High-End GPU, 32GB+ RAM — Map-Reduce Stitching, Swarm Sharding",
    },
  };
}
