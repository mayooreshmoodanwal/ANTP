import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
  customType,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ──────────────────────────────────────────────
// Custom Types
// ──────────────────────────────────────────────

/**
 * pgvector `vector` column type.
 * Neon supports pgvector natively — enable it with:
 *   CREATE EXTENSION IF NOT EXISTS vector;
 */
const vector = customType<{
  data: number[];
  driverParam: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config!.dimensions})`;
  },
  fromDriver(value: unknown): number[] {
    // pgvector returns '[1,2,3]' format
    const str = value as string;
    return str
      .slice(1, -1)
      .split(",")
      .map((v) => parseFloat(v));
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
});

// ──────────────────────────────────────────────
// Enums
// ──────────────────────────────────────────────

export const nodeTierEnum = pgEnum("node_tier", [
  "TIER_1",
  "TIER_2",
  "TIER_3",
  "PENDING_PROFILE",
]);

export const nodeStatusEnum = pgEnum("node_status", [
  "ONLINE",
  "OFFLINE",
  "BUSY",
  "EVICTING",
  "BANNED",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "PENDING",
  "QUEUED",
  "CLONED",
  "IN_PROGRESS",
  "CONSENSUS_PENDING",
  "COMPLETED",
  "FAILED",
  "SLA_BREACHED",
  "CLOUD_FALLBACK",
]);

export const cloneStatusEnum = pgEnum("clone_status", [
  "QUEUED",
  "ASSIGNED",
  "EXECUTING",
  "COMPLETED",
  "EVICTED",
  "TIMEOUT",
  "FAILED",
]);

export const taskTypeEnum = pgEnum("task_type", [
  "COMPUTE",
  "RAG_MAP",
  "RAG_SEARCH",
  "RAG_REDUCE",
]);

export const evictionReasonEnum = pgEnum("eviction_reason", [
  "RAM_PRESSURE",
  "NODE_DISCONNECT",
  "TIMEOUT",
  "MANUAL",
]);

export const userRoleEnum = pgEnum("user_role", [
  "DEVELOPER",
  "NODE_PROVIDER",
  "ADMIN",
]);

// ──────────────────────────────────────────────
// Tables
// ──────────────────────────────────────────────

/**
 * Nodes — Registered edge daemon instances.
 * Cryptographic node_id is derived from hardware profile (Section 2).
 */
export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: varchar("node_id", { length: 128 }).notNull().unique(),
    tier: nodeTierEnum("tier").notNull().default("PENDING_PROFILE"),
    status: nodeStatusEnum("status").notNull().default("OFFLINE"),

    // Hardware profile (kernel-queried, not user-supplied)
    cpuCores: integer("cpu_cores"),
    cpuModel: varchar("cpu_model", { length: 256 }),
    cpuFreqMhz: integer("cpu_freq_mhz"),
    cpuArch: varchar("cpu_arch", { length: 64 }),
    gpuModel: varchar("gpu_model", { length: 256 }),
    gpuVramMb: integer("gpu_vram_mb"),
    gpuComputeUnits: integer("gpu_compute_units"),
    hasCuda: boolean("has_cuda").default(false),
    hasMetal: boolean("has_metal").default(false),
    totalRamMb: integer("total_ram_mb"),
    availableRamMb: integer("available_ram_mb"),
    allocatedRamMb: integer("allocated_ram_mb"),
    osName: varchar("os_name", { length: 64 }),
    osVersion: varchar("os_version", { length: 64 }),

    // Economics
    reputationScore: real("reputation_score").notNull().default(100.0),
    totalTasksCompleted: integer("total_tasks_completed").notNull().default(0),
    totalEarnings: real("total_earnings").notNull().default(0.0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),

    // Timestamps
    lastSeenAt: timestamp("last_seen_at"),
    registeredAt: timestamp("registered_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_nodes_node_id").on(table.nodeId),
    index("idx_nodes_tier").on(table.tier),
    index("idx_nodes_status").on(table.status),
    index("idx_nodes_reputation").on(table.reputationScore),
  ]
);

/**
 * Tasks — Client-submitted compute jobs.
 * Each task spawns 3 clones for consensus verification (REQ-ORC-01).
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id").notNull().unique(),
    type: taskTypeEnum("type").notNull().default("COMPUTE"),
    status: taskStatusEnum("status").notNull().default("PENDING"),
    tier: nodeTierEnum("tier").notNull(),

    // Payload — the WASM module + input
    wasmBytesHash: varchar("wasm_bytes_hash", { length: 64 }).notNull(),
    inputHash: varchar("input_hash", { length: 64 }).notNull(),
    payloadSizeBytes: integer("payload_size_bytes").notNull(),

    // SLA tracking
    slaTimeoutMs: integer("sla_timeout_ms").notNull().default(2000),
    slaDeadlineAt: timestamp("sla_deadline_at"),

    // Consensus result
    acceptedResultHash: varchar("accepted_result_hash", { length: 64 }),
    consensusReachedAt: timestamp("consensus_reached_at"),
    dissentingNodeId: varchar("dissenting_node_id", { length: 128 }),

    // Cloud fallback
    usedCloudFallback: boolean("used_cloud_fallback").notNull().default(false),

    // RAG metadata (only for RAG tasks)
    ragDocumentId: uuid("rag_document_id"),
    ragPhase: integer("rag_phase"),

    // Client callback
    clientCallbackUrl: varchar("client_callback_url", { length: 2048 }),

    // User who submitted (null for legacy/anonymous tasks)
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, { onDelete: "set null" }),

    // Timestamps
    submittedAt: timestamp("submitted_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_tasks_status").on(table.status),
    index("idx_tasks_tier").on(table.tier),
    index("idx_tasks_family").on(table.familyId),
    index("idx_tasks_sla").on(table.slaDeadlineAt),
  ]
);

/**
 * Task Clones — 3 identical execution copies per task (REQ-ORC-01).
 * Anti-affinity: no single node can execute >1 clone of the same family.
 */
export const taskClones = pgTable(
  "task_clones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cloneIndex: integer("clone_index").notNull(), // 0, 1, or 2
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    status: cloneStatusEnum("status").notNull().default("QUEUED"),

    // Assignment
    assignedNodeId: varchar("assigned_node_id", { length: 128 }),
    assignedAt: timestamp("assigned_at"),

    // Execution
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    execTimeMs: integer("exec_time_ms"),

    // Result
    resultHash: varchar("result_hash", { length: 64 }),
    resultSizeBytes: integer("result_size_bytes"),

    // Eviction tracking
    evictionCount: integer("eviction_count").notNull().default(0),
    lastEvictedAt: timestamp("last_evicted_at"),
  },
  (table) => [
    index("idx_clones_task").on(table.taskId),
    index("idx_clones_family").on(table.familyId),
    index("idx_clones_status").on(table.status),
    index("idx_clones_node").on(table.assignedNodeId),
    // Anti-affinity unique constraint: one node can only have one clone per family
    uniqueIndex("idx_clones_antiaff").on(table.familyId, table.assignedNodeId),
  ]
);

/**
 * Task Results — Raw result data from clone execution.
 * Stored separately for efficient consensus comparison.
 */
export const taskResults = pgTable(
  "task_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cloneId: uuid("clone_id")
      .notNull()
      .references(() => taskClones.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    nodeId: varchar("node_id", { length: 128 }).notNull(),

    // Result data
    resultHash: varchar("result_hash", { length: 64 }).notNull(),
    outputSizeBytes: integer("output_size_bytes").notNull(),

    // Execution metadata
    execTimeMs: integer("exec_time_ms").notNull(),
    status: varchar("status", { length: 32 }).notNull(), // OK, TIMEOUT, ERROR

    // Consensus outcome
    isCorrect: boolean("is_correct"),
    consensusRole: varchar("consensus_role", { length: 32 }), // MAJORITY, DISSENTER

    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_results_task").on(table.taskId),
    index("idx_results_family").on(table.familyId),
    index("idx_results_node").on(table.nodeId),
    index("idx_results_hash").on(table.resultHash),
  ]
);

/**
 * Payouts — Reward ledger for verified task completions.
 * Payout = Base_Rate[Tier] * 1 (per verified task).
 */
export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: varchar("node_id", { length: 128 }).notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    cloneId: uuid("clone_id")
      .notNull()
      .references(() => taskClones.id, { onDelete: "cascade" }),
    tier: nodeTierEnum("tier").notNull(),

    // Payout amount
    baseRate: real("base_rate").notNull(),
    amount: real("amount").notNull(),

    // Status
    isPaid: boolean("is_paid").notNull().default(false),
    paidAt: timestamp("paid_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_payouts_node").on(table.nodeId),
    index("idx_payouts_task").on(table.taskId),
    index("idx_payouts_unpaid").on(table.isPaid),
  ]
);

/**
 * Eviction Log — Tracks task evictions for analytics and re-queue auditing.
 */
export const evictionLog = pgTable(
  "eviction_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cloneId: uuid("clone_id")
      .notNull()
      .references(() => taskClones.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    nodeId: varchar("node_id", { length: 128 }).notNull(),
    reason: evictionReasonEnum("reason").notNull(),
    availableRamMbAtEviction: integer("available_ram_mb_at_eviction"),
    requeuedAt: timestamp("requeued_at"),
    evictedAt: timestamp("evicted_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_eviction_task").on(table.taskId),
    index("idx_eviction_node").on(table.nodeId),
    index("idx_eviction_reason").on(table.reason),
  ]
);

/**
 * RAG Documents — Document chunks with vector embeddings.
 * Requires pgvector extension on Neon:
 *   CREATE EXTENSION IF NOT EXISTS vector;
 */
export const ragDocuments = pgTable(
  "rag_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(), // Groups all chunks of one document
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),

    // Vector embedding (1536 dimensions — OpenAI ada-002 compatible)
    embedding: vector("embedding", { dimensions: 1536 }),

    // Metadata
    tokenCount: integer("token_count"),
    metadata: jsonb("metadata"),

    // Processing state
    isVectorized: boolean("is_vectorized").notNull().default(false),
    vectorizedByNode: varchar("vectorized_by_node", { length: 128 }),
    vectorizedAt: timestamp("vectorized_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_rag_document").on(table.documentId),
    index("idx_rag_chunk").on(table.documentId, table.chunkIndex),
    index("idx_rag_vectorized").on(table.isVectorized),
  ]
);

// ──────────────────────────────────────────────
// User & Auth Tables
// ──────────────────────────────────────────────

/**
 * Users — Platform accounts for developers, node providers, and admins.
 * Passwords are bcrypt-hashed (12 salt rounds).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    role: userRoleEnum("role").notNull().default("DEVELOPER"),

    // Email verification
    isVerified: boolean("is_verified").notNull().default(false),
    verificationToken: varchar("verification_token", { length: 128 }),
    verificationExpiresAt: timestamp("verification_expires_at"),

    // Node Provider linking
    linkedNodeId: varchar("linked_node_id", { length: 128 }),

    // Rate limiting
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_users_email").on(table.email),
    index("idx_users_role").on(table.role),
    index("idx_users_linked_node").on(table.linkedNodeId),
  ]
);

/**
 * API Keys — Programmatic access tokens for developers.
 * Keys are SHA-256 hashed; only the prefix is stored for display.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    keyHash: varchar("key_hash", { length: 64 }).notNull().unique(),
    keyPrefix: varchar("key_prefix", { length: 12 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    permissions: jsonb("permissions").notNull().default('{"submitTask":true,"readStats":true}'),

    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    isRevoked: boolean("is_revoked").notNull().default(false),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_api_keys_user").on(table.userId),
    uniqueIndex("idx_api_keys_hash").on(table.keyHash),
    index("idx_api_keys_prefix").on(table.keyPrefix),
  ]
);

/**
 * Pairing Codes — Temporary codes for auto-linking edge daemons to user accounts.
 * The .dmg app generates a 6-char code, user enters it in the dashboard.
 */
export const pairingCodes = pgTable(
  "pairing_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 8 }).notNull().unique(),
    nodeId: varchar("node_id", { length: 128 }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    isUsed: boolean("is_used").notNull().default(false),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_pairing_code").on(table.code),
    index("idx_pairing_node").on(table.nodeId),
  ]
);

// ──────────────────────────────────────────────
// Relations
// ──────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  tasks: many(tasks),
  apiKeys: many(apiKeys),
  pairingCodes: many(pairingCodes),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

export const pairingCodesRelations = relations(pairingCodes, ({ one }) => ({
  user: one(users, {
    fields: [pairingCodes.userId],
    references: [users.id],
  }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  submittedBy: one(users, {
    fields: [tasks.submittedByUserId],
    references: [users.id],
  }),
  clones: many(taskClones),
  results: many(taskResults),
  payouts: many(payouts),
  evictions: many(evictionLog),
}));

export const taskClonesRelations = relations(taskClones, ({ one, many }) => ({
  task: one(tasks, {
    fields: [taskClones.taskId],
    references: [tasks.id],
  }),
  results: many(taskResults),
  payouts: many(payouts),
  evictions: many(evictionLog),
}));

export const taskResultsRelations = relations(taskResults, ({ one }) => ({
  task: one(tasks, {
    fields: [taskResults.taskId],
    references: [tasks.id],
  }),
  clone: one(taskClones, {
    fields: [taskResults.cloneId],
    references: [taskClones.id],
  }),
}));

export const payoutsRelations = relations(payouts, ({ one }) => ({
  task: one(tasks, {
    fields: [payouts.taskId],
    references: [tasks.id],
  }),
  clone: one(taskClones, {
    fields: [payouts.cloneId],
    references: [taskClones.id],
  }),
}));

export const evictionLogRelations = relations(evictionLog, ({ one }) => ({
  task: one(tasks, {
    fields: [evictionLog.taskId],
    references: [tasks.id],
  }),
  clone: one(taskClones, {
    fields: [evictionLog.cloneId],
    references: [taskClones.id],
  }),
}));

// ──────────────────────────────────────────────
// Type Exports
// ──────────────────────────────────────────────

export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskClone = typeof taskClones.$inferSelect;
export type NewTaskClone = typeof taskClones.$inferInsert;
export type TaskResult = typeof taskResults.$inferSelect;
export type NewTaskResult = typeof taskResults.$inferInsert;
export type Payout = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
export type EvictionLogEntry = typeof evictionLog.$inferSelect;
export type RagDocument = typeof ragDocuments.$inferSelect;
export type NewRagDocument = typeof ragDocuments.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type PairingCode = typeof pairingCodes.$inferSelect;
export type NewPairingCode = typeof pairingCodes.$inferInsert;
