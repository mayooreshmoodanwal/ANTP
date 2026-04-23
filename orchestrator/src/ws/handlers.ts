import type { WebSocket } from "uWebSockets.js";
import type { WsUserData } from "./server.js";
import { connectedNodes } from "./server.js";
import {
  type AntpMessage,
  MessageType,
  encodeMessage,
} from "./protocol.js";
import { config, determineTier } from "../config.js";
import { taskStore } from "../state/task-store.js";
import { queueManager } from "../queue/manager.js";
import { onCloneResult } from "../consensus/engine.js";
import { requeueEvictedClone } from "../consensus/clone.js";
import * as dbQueries from "../../../database/queries.js";

/**
 * WebSocket message handlers — one handler per message type.
 */

/** Called when a new WebSocket connection opens. */
export function handleOpen(ws: WebSocket<WsUserData>): void {
  // Nothing to do until NODE_REGISTER arrives
}

/** Called when a WebSocket connection closes. */
export function handleClose(ws: WebSocket<WsUserData>, code: number): void {
  const data = ws.getUserData();

  if (data.nodeId) {
    // Remove from connected nodes registry
    connectedNodes.delete(data.nodeId);

    // Mark node as offline in DB
    dbQueries.updateNodeStatus(data.nodeId, "OFFLINE").catch((err) => {
      console.error(
        `[Handler] Error marking node ${data.nodeId} offline:`,
        err
      );
    });

    // Handle eviction for any active clones
    for (const cloneId of data.activeClones) {
      handleCloneEvictionOnDisconnect(data.nodeId, cloneId);
    }

    console.log(
      `[Handler] Node ${data.nodeId.slice(0, 8)}... disconnected ` +
        `(${data.activeClones.size} active clones evicted)`
    );
  }
}

/** Route incoming message to the appropriate handler. */
export function handleMessage(
  ws: WebSocket<WsUserData>,
  msg: AntpMessage
): void {
  switch (msg.type) {
    case MessageType.NODE_REGISTER:
      handleNodeRegister(ws, msg);
      break;
    case MessageType.TASK_STEAL:
      handleTaskSteal(ws, msg);
      break;
    case MessageType.TASK_RESULT:
      handleTaskResult(ws, msg);
      break;
    case MessageType.TASK_EVICTION:
      handleTaskEviction(ws, msg);
      break;
    case MessageType.HEARTBEAT:
      handleHeartbeat(ws, msg);
      break;
    default:
      sendError(ws, "UNKNOWN_TYPE", `Unhandled message type: ${(msg as any).type}`);
  }
}

// ──────────────────────────────────────────────
// NODE_REGISTER
// ──────────────────────────────────────────────

async function handleNodeRegister(
  ws: WebSocket<WsUserData>,
  msg: Extract<AntpMessage, { type: MessageType.NODE_REGISTER }>
): Promise<void> {
  const { nodeId, authToken, profile } = msg;

  // Validate auth token
  if (authToken !== config.nodeAuthSecret) {
    console.warn(
      `[Handler] Registration rejected for ${nodeId.slice(0, 8)}... — invalid auth`
    );
    ws.send(
      encodeMessage({
        type: MessageType.REGISTER_ACK,
        success: false,
        tier: "",
        nodeDbId: "",
        error: "Invalid authentication token",
      }),
      true
    );
    ws.end(1008, "Unauthorized");
    return;
  }

  // Determine tier from hardware profile (kernel-queried data)
  const hasGpu = !!(profile.gpuModel && (profile.hasCuda || profile.hasMetal));
  const tier = determineTier(profile.totalRamMb, hasGpu);

  console.log(
    `[Handler] Registering node ${nodeId.slice(0, 8)}... → ${tier} ` +
      `(CPU=${profile.cpuCores}c/${profile.cpuFreqMhz}MHz, ` +
      `RAM=${profile.totalRamMb}MB, GPU=${profile.gpuModel || "none"})`
  );

  // Persist to DB (upsert — re-registration updates hardware profile)
  let dbNode;
  try {
    dbNode = await dbQueries.registerNode({
      nodeId,
      tier,
      status: "ONLINE",
      cpuCores: profile.cpuCores,
      cpuModel: profile.cpuModel,
      cpuFreqMhz: profile.cpuFreqMhz,
      cpuArch: profile.cpuArch,
      gpuModel: profile.gpuModel,
      gpuVramMb: profile.gpuVramMb,
      gpuComputeUnits: profile.gpuComputeUnits,
      hasCuda: profile.hasCuda,
      hasMetal: profile.hasMetal,
      totalRamMb: profile.totalRamMb,
      availableRamMb: profile.availableRamMb,
      allocatedRamMb: profile.allocatedRamMb,
      osName: profile.osName,
      osVersion: profile.osVersion,
    });
  } catch (err) {
    console.error(`[Handler] DB error registering node:`, err);
    ws.send(
      encodeMessage({
        type: MessageType.REGISTER_ACK,
        success: false,
        tier: "",
        nodeDbId: "",
        error: "Database error during registration",
      }),
      true
    );
    return;
  }

  // Update per-connection state
  const userData = ws.getUserData();
  userData.nodeId = nodeId;
  userData.tier = tier;
  userData.isRegistered = true;

  // Register in connected nodes map
  connectedNodes.set(nodeId, ws);

  // Subscribe to tier-specific topic for potential broadcasts
  ws.subscribe(`tier:${tier}`);

  // Handle PENDING_PROFILE: schedule retry
  if (tier === "PENDING_PROFILE") {
    console.log(
      `[Handler] Node ${nodeId.slice(0, 8)}... placed in PENDING_PROFILE — ` +
        `retry in ${config.pendingProfileBackoffMs / 1000}s`
    );
  }

  // Send acknowledgement
  ws.send(
    encodeMessage({
      type: MessageType.REGISTER_ACK,
      success: true,
      tier,
      nodeDbId: dbNode.id,
    }),
    true
  );
}

// ──────────────────────────────────────────────
// TASK_STEAL — Pull-based work fetching
// ──────────────────────────────────────────────

async function handleTaskSteal(
  ws: WebSocket<WsUserData>,
  msg: Extract<AntpMessage, { type: MessageType.TASK_STEAL }>
): Promise<void> {
  const userData = ws.getUserData();

  if (!userData.isRegistered || !userData.tier || !userData.nodeId) {
    sendError(ws, "NOT_REGISTERED", "Must register before stealing tasks");
    return;
  }

  if (userData.tier === "PENDING_PROFILE") {
    sendError(
      ws,
      "PENDING_PROFILE",
      `Node is in PENDING_PROFILE state. Retry in ${config.pendingProfileBackoffMs / 1000}s.`
    );
    return;
  }

  // Pull from the node's tier queue (anti-affinity enforced by TierQueue)
  const item = queueManager.steal(userData.tier, userData.nodeId);

  if (!item) {
    ws.send(
      encodeMessage({
        type: MessageType.NO_TASK_AVAILABLE,
        retryAfterMs: 1000, // Suggest retry in 1s
      }),
      true
    );
    return;
  }

  // Track assignment in task store
  taskStore.assignClone(item.taskId, item.cloneId, userData.nodeId);

  // Track active clones on this connection
  userData.activeClones.add(item.cloneId);

  // Update DB
  try {
    await dbQueries.assignCloneToNode(item.cloneId, userData.nodeId);
    await dbQueries.markCloneExecuting(item.cloneId);
    await dbQueries.updateNodeStatus(userData.nodeId, "BUSY");
  } catch (err) {
    console.error(`[Handler] DB error assigning clone:`, err);
    // Don't block — the in-memory state is authoritative for performance
  }

  // Send task payload to node
  ws.send(
    encodeMessage({
      type: MessageType.TASK_ASSIGNMENT,
      taskId: item.taskId,
      cloneId: item.cloneId,
      familyId: item.familyId,
      tier: item.tier,
      wasmBytes: item.payload.wasmBytes,
      input: item.payload.input,
      timeoutMs: item.payload.timeoutMs,
      createdAt: item.enqueuedAt,
    }),
    true
  );

  console.log(
    `[Handler] Task ${item.cloneId.slice(0, 8)}... stolen by ${userData.nodeId.slice(0, 8)}... ` +
      `(family=${item.familyId.slice(0, 8)}..., tier=${item.tier})`
  );
}

// ──────────────────────────────────────────────
// TASK_RESULT — Node submits execution result
// ──────────────────────────────────────────────

async function handleTaskResult(
  ws: WebSocket<WsUserData>,
  msg: Extract<AntpMessage, { type: MessageType.TASK_RESULT }>
): Promise<void> {
  const userData = ws.getUserData();

  if (!userData.isRegistered || !userData.nodeId) {
    sendError(ws, "NOT_REGISTERED", "Must register before submitting results");
    return;
  }

  // Remove from active clones
  userData.activeClones.delete(msg.cloneId);

  // Update node status
  if (userData.activeClones.size === 0) {
    try {
      await dbQueries.updateNodeStatus(userData.nodeId, "ONLINE");
    } catch {}
  }

  console.log(
    `[Handler] Result received: clone=${msg.cloneId.slice(0, 8)}... ` +
      `node=${msg.nodeId.slice(0, 8)}... hash=${msg.resultHash.slice(0, 12)}... ` +
      `status=${msg.status} exec=${msg.execTimeMs}ms`
  );

  // Feed into consensus engine
  const consensus = await onCloneResult(msg.taskId, msg.cloneId, {
    nodeId: msg.nodeId,
    resultHash: msg.resultHash,
    output: msg.output,
    execTimeMs: msg.execTimeMs,
    status: msg.status,
  });

  // If consensus was reached, we could send result to the client here
  // (The REST API /task/:id/status can also be polled)
  if (consensus) {
    console.log(
      `[Handler] Consensus for task ${msg.taskId.slice(0, 8)}...: ` +
        `accepted=${consensus.accepted}, hash=${consensus.majorityHash?.slice(0, 12) || "NONE"}`
    );
  }
}

// ──────────────────────────────────────────────
// TASK_EVICTION — Node is evicting a task (RAM pressure)
// ──────────────────────────────────────────────

async function handleTaskEviction(
  ws: WebSocket<WsUserData>,
  msg: Extract<AntpMessage, { type: MessageType.TASK_EVICTION }>
): Promise<void> {
  const userData = ws.getUserData();

  console.warn(
    `[Handler] ⚠️  EVICTION: clone=${msg.cloneId.slice(0, 8)}... ` +
      `node=${msg.nodeId.slice(0, 8)}... reason=${msg.reason} ` +
      `RAM=${msg.availableRamMb}MB`
  );

  // Remove from active clones
  userData.activeClones.delete(msg.cloneId);

  // Get task info for re-queue
  const task = taskStore.getTask(msg.taskId);
  if (!task) {
    console.error(
      `[Handler] Eviction for unknown task ${msg.taskId} — cannot re-queue`
    );
    return;
  }

  // Re-queue at priority 0 (REQ-SLA-01)
  requeueEvictedClone(
    msg.cloneId,
    msg.taskId,
    msg.familyId,
    task.tier,
    msg.nodeId,
    {
      wasmBytes: task.payload.wasmBytes,
      input: task.payload.input,
      timeoutMs: task.slaTimeoutMs,
    }
  );

  // Log eviction in DB
  try {
    await dbQueries.logEviction({
      cloneId: msg.cloneId,
      taskId: msg.taskId,
      nodeId: msg.nodeId,
      reason: msg.reason,
      availableRamMbAtEviction: msg.availableRamMb,
    });

    await dbQueries.evictClone(msg.cloneId);
    await dbQueries.updateNodeStatus(msg.nodeId, "ONLINE");
  } catch (err) {
    console.error(`[Handler] DB error logging eviction:`, err);
  }

  // Acknowledge eviction
  ws.send(
    encodeMessage({
      type: MessageType.EVICTION_ACK,
      cloneId: msg.cloneId,
      requeuedAt: Date.now(),
    }),
    true
  );
}

// ──────────────────────────────────────────────
// HEARTBEAT
// ──────────────────────────────────────────────

async function handleHeartbeat(
  ws: WebSocket<WsUserData>,
  msg: Extract<AntpMessage, { type: MessageType.HEARTBEAT }>
): Promise<void> {
  const userData = ws.getUserData();
  userData.lastHeartbeatAt = Date.now();

  // Touch node in DB (update last_seen_at)
  if (userData.nodeId) {
    dbQueries.touchNode(userData.nodeId).catch(() => {});
  }

  ws.send(
    encodeMessage({
      type: MessageType.HEARTBEAT_ACK,
      serverTimeMs: Date.now(),
    }),
    true
  );
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function sendError(ws: WebSocket<WsUserData>, code: string, message: string): void {
  ws.send(
    encodeMessage({
      type: MessageType.ERROR,
      code,
      message,
    }),
    true
  );
}

/**
 * Handle eviction when a node disconnects unexpectedly.
 * Re-queues all active clones at priority 0.
 */
function handleCloneEvictionOnDisconnect(
  nodeId: string,
  cloneId: string
): void {
  // Find which task this clone belongs to
  for (const task of taskStore.getActiveTasks()) {
    if (task.assignedNodes.has(cloneId)) {
      requeueEvictedClone(
        cloneId,
        task.taskId,
        task.familyId,
        task.tier,
        nodeId,
        {
          wasmBytes: task.payload.wasmBytes,
          input: task.payload.input,
          timeoutMs: task.slaTimeoutMs,
        }
      );

      dbQueries
        .logEviction({
          cloneId,
          taskId: task.taskId,
          nodeId,
          reason: "NODE_DISCONNECT",
        })
        .catch(() => {});

      break;
    }
  }
}
