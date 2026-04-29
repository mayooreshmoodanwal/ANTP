/**
 * ML Brain Client — Shadow Mode Integration
 *
 * Queries the Python FastAPI ML Control Plane for predictions.
 * In "Shadow Mode", predictions are logged but static rules are used.
 * When shadow mode is disabled, ML predictions drive actual decisions.
 */

import { config } from "../config.js";

const ML_BRAIN_URL = process.env.ML_BRAIN_URL || "http://localhost:8090";
const SHADOW_MODE = process.env.ML_SHADOW_MODE !== "false"; // Default: shadow mode ON

interface PricingPrediction {
  tier: string;
  predicted_price_usd: number;
  model_active: boolean;
}

interface FraudPrediction {
  node_id: string;
  is_anomalous: boolean;
  score: number;
  action: string;
}

interface ClusterPrediction {
  node_id: string;
  cluster_id: number;
  suggested_tier: string;
}

interface TrafficPrediction {
  current_hour: number;
  next_hour: number;
  predicted_load: number;
  spike_incoming: boolean;
  should_prefetch: boolean;
}

/**
 * Query the ML Brain for dynamic spot pricing.
 * In shadow mode, logs the AI answer but returns the static rate.
 */
export async function getMLPrice(
  queueDepth: number,
  activeNodes: number,
  tier: string
): Promise<number> {
  const staticPrice = config.payoutRates[tier] || 0.001;

  try {
    const res = await fetch(`${ML_BRAIN_URL}/predict/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queue_depth: queueDepth,
        active_nodes: activeNodes,
        tier,
      }),
    });

    if (!res.ok) throw new Error(`ML Brain returned ${res.status}`);

    const prediction: PricingPrediction = await res.json();

    if (SHADOW_MODE) {
      console.log(
        `[ML:Shadow] Pricing → static=$${staticPrice} | ai=$${prediction.predicted_price_usd} (logged, not used)`
      );
      return staticPrice;
    }

    console.log(
      `[ML:Live] Pricing → $${prediction.predicted_price_usd} for ${tier}`
    );
    return prediction.predicted_price_usd;
  } catch {
    // ML Brain unreachable — use static rate silently
    return staticPrice;
  }
}

/**
 * Check if a node is flagged as fraudulent.
 * In shadow mode, logs the result but never bans.
 */
export async function checkNodeFraud(nodeStats: {
  nodeId: string;
  avgExecMs: number;
  totalResults: number;
  okCount: number;
  failCount: number;
  cpuCores: number;
  totalRamMb: number;
}): Promise<FraudPrediction> {
  const safe: FraudPrediction = {
    node_id: nodeStats.nodeId,
    is_anomalous: false,
    score: 0,
    action: "NONE",
  };

  try {
    const res = await fetch(`${ML_BRAIN_URL}/predict/fraud`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node_id: nodeStats.nodeId,
        avg_exec_ms: nodeStats.avgExecMs,
        total_results: nodeStats.totalResults,
        ok_count: nodeStats.okCount,
        fail_count: nodeStats.failCount,
        cpu_cores: nodeStats.cpuCores,
        total_ram_mb: nodeStats.totalRamMb,
      }),
    });

    if (!res.ok) return safe;

    const prediction: FraudPrediction = await res.json();

    if (SHADOW_MODE) {
      if (prediction.is_anomalous) {
        console.warn(
          `[ML:Shadow] Fraud → Node ${nodeStats.nodeId.slice(0, 8)}... flagged (score=${prediction.score}), but shadow mode — no action taken.`
        );
      }
      return safe;
    }

    if (prediction.is_anomalous) {
      console.warn(
        `[ML:Live] Fraud → Node ${nodeStats.nodeId.slice(0, 8)}... SHADOW BANNED (score=${prediction.score})`
      );
    }
    return prediction;
  } catch {
    return safe;
  }
}

/**
 * Get the performance cluster for a node.
 */
export async function getNodeCluster(
  nodeId: string
): Promise<ClusterPrediction | null> {
  try {
    const res = await fetch(`${ML_BRAIN_URL}/predict/cluster/${nodeId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Get the traffic prediction for the next hour.
 */
export async function getTrafficPrediction(): Promise<TrafficPrediction | null> {
  try {
    const res = await fetch(`${ML_BRAIN_URL}/predict/traffic`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
