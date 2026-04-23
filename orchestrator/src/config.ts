import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, "../../.env.local") });

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseFloat(v) : fallback;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Centralized configuration — all magic numbers live here.
 * Override via .env.local.
 */
export const config = {
  // ── Server ──
  host: envStr("ORCHESTRATOR_HOST", "0.0.0.0"),
  port: envInt("ORCHESTRATOR_PORT", 8080),
  wsPath: envStr("ORCHESTRATOR_WS_PATH", "/ws"),

  // ── SLA ──
  slaTimeoutMs: envInt("SLA_TIMEOUT_MS", 2000),
  slaMonitorIntervalMs: 100, // Poll every 100ms for SLA breaches

  // ── Cloud Fallback ──
  cloudFallbackUrl: envStr(
    "CLOUD_FALLBACK_URL",
    "http://localhost:3001/shadow"
  ),
  cloudFallbackTimeoutMs: 5000, // Max wait for cloud response

  // ── Authentication ──
  jwtSecret: envStr("JWT_SECRET", "dev-secret-change-me"),
  nodeAuthSecret: envStr("NODE_AUTH_SECRET", "dev-node-secret-change-me"),

  // ── Tier Thresholds (RAM in GB) ──
  tiers: {
    tier1MaxRamGb: envInt("TIER1_MAX_RAM_GB", 4),
    tier2MinRamGb: envInt("TIER2_MIN_RAM_GB", 8),
    tier3MinRamGb: envInt("TIER3_MIN_RAM_GB", 32),
  },

  // ── Payout Base Rates (USD per verified task) ──
  payoutRates: {
    TIER_1: envFloat("TIER1_BASE_RATE", 0.001),
    TIER_2: envFloat("TIER2_BASE_RATE", 0.02),
    TIER_3: envFloat("TIER3_BASE_RATE", 0.5),
  } as Record<string, number>,

  // ── Queue ──
  queueMaxDepth: envInt("QUEUE_MAX_DEPTH", 10000),
  evictionRequeuePriority: envInt("EVICTION_REQUEUE_PRIORITY", 0),

  // ── RAG ──
  ragChunkSize: envInt("RAG_CHUNK_SIZE", 512),
  ragOverlap: envInt("RAG_OVERLAP", 64),
  ragSimilarityThreshold: envFloat("RAG_SIMILARITY_THRESHOLD", 0.78),

  // ── Node Management ──
  pendingProfileBackoffMs: envInt("PENDING_PROFILE_BACKOFF_MS", 60000),
  heartbeatIntervalMs: 15000,
  heartbeatTimeoutMs: 45000, // 3 missed heartbeats → offline

  // ── Consensus ──
  clonesPerTask: 3,
  consensusMajority: 2,
  reputationSlashFactor: 0.95, // Multiply rep by this on dissent
  reputationBoostFactor: 1.01, // Multiply rep by this on correct (capped at 100)

  // ── Misc ──
  maxPayloadSizeBytes: 256 * 1024 * 1024, // 256 MiB
} as const;

/**
 * Determine tier from hardware profile.
 * Mirrors the Tier Assignment Matrix from the PRD.
 */
export function determineTier(
  totalRamMb: number,
  hasGpu: boolean
): "TIER_1" | "TIER_2" | "TIER_3" | "PENDING_PROFILE" {
  const ramGb = totalRamMb / 1024;

  if (ramGb < 1) return "PENDING_PROFILE"; // Below minimum

  if (hasGpu && ramGb >= config.tiers.tier3MinRamGb) return "TIER_3";
  if (hasGpu && ramGb >= config.tiers.tier2MinRamGb) return "TIER_2";
  if (ramGb <= config.tiers.tier1MaxRamGb) return "TIER_1";

  // Has enough RAM for Tier 2 but no GPU → still Tier 1
  if (!hasGpu && ramGb >= config.tiers.tier2MinRamGb) return "TIER_1";

  return "TIER_1";
}
