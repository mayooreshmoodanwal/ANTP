import { encode, decode } from "@msgpack/msgpack";

// ──────────────────────────────────────────────
// Message Types — Exhaustive enumeration of all
// WebSocket message types in the ANTP protocol.
// ──────────────────────────────────────────────

export enum MessageType {
  // Node → Orchestrator
  NODE_REGISTER = "NODE_REGISTER",
  TASK_STEAL = "TASK_STEAL",
  TASK_RESULT = "TASK_RESULT",
  TASK_EVICTION = "TASK_EVICTION",
  HEARTBEAT = "HEARTBEAT",

  // Orchestrator → Node
  REGISTER_ACK = "REGISTER_ACK",
  TASK_ASSIGNMENT = "TASK_ASSIGNMENT",
  NO_TASK_AVAILABLE = "NO_TASK_AVAILABLE",
  EVICTION_ACK = "EVICTION_ACK",
  HEARTBEAT_ACK = "HEARTBEAT_ACK",
  ERROR = "ERROR",
}

// ──────────────────────────────────────────────
// Message Payloads
// ──────────────────────────────────────────────

/** Hardware profile sent during node registration. */
export interface HardwareProfile {
  cpuCores: number;
  cpuModel: string;
  cpuFreqMhz: number;
  cpuArch: string;
  gpuModel?: string;
  gpuVramMb?: number;
  gpuComputeUnits?: number;
  hasCuda: boolean;
  hasMetal: boolean;
  totalRamMb: number;
  availableRamMb: number;
  allocatedRamMb: number;
  osName: string;
  osVersion: string;
}

export interface NodeRegisterMessage {
  type: MessageType.NODE_REGISTER;
  nodeId: string;
  authToken: string;
  profile: HardwareProfile;
}

export interface RegisterAckMessage {
  type: MessageType.REGISTER_ACK;
  success: boolean;
  tier: string;
  nodeDbId: string;
  error?: string;
  pairingCode?: string;
}

export interface TaskStealMessage {
  type: MessageType.TASK_STEAL;
  nodeId: string;
}

export interface TaskAssignmentMessage {
  type: MessageType.TASK_ASSIGNMENT;
  taskId: string;
  cloneId: string;
  familyId: string;
  tier: string;
  wasmBytes: Uint8Array;
  input: Uint8Array;
  timeoutMs: number;
  createdAt: number;
}

export interface NoTaskAvailableMessage {
  type: MessageType.NO_TASK_AVAILABLE;
  retryAfterMs: number;
}

export interface TaskResultMessage {
  type: MessageType.TASK_RESULT;
  taskId: string;
  cloneId: string;
  familyId: string;
  nodeId: string;
  output: Uint8Array;
  resultHash: string;
  execTimeMs: number;
  status: "OK" | "TIMEOUT" | "ERROR" | "EVICTED";
}

export interface TaskEvictionMessage {
  type: MessageType.TASK_EVICTION;
  cloneId: string;
  taskId: string;
  familyId: string;
  nodeId: string;
  reason: "RAM_PRESSURE" | "NODE_DISCONNECT" | "TIMEOUT" | "MANUAL";
  availableRamMb?: number;
}

export interface EvictionAckMessage {
  type: MessageType.EVICTION_ACK;
  cloneId: string;
  requeuedAt: number;
}

export interface HeartbeatMessage {
  type: MessageType.HEARTBEAT;
  nodeId: string;
  availableRamMb: number;
  activeTasks: number;
  uptimeMs: number;
}

export interface HeartbeatAckMessage {
  type: MessageType.HEARTBEAT_ACK;
  serverTimeMs: number;
}

export interface ErrorMessage {
  type: MessageType.ERROR;
  code: string;
  message: string;
}

// Union type for all messages
export type AntpMessage =
  | NodeRegisterMessage
  | RegisterAckMessage
  | TaskStealMessage
  | TaskAssignmentMessage
  | NoTaskAvailableMessage
  | TaskResultMessage
  | TaskEvictionMessage
  | EvictionAckMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | ErrorMessage;

// ──────────────────────────────────────────────
// Serialization / Deserialization (MessagePack)
// ──────────────────────────────────────────────

/**
 * Serialize an ANTP message to binary (MessagePack).
 * Used for all WebSocket communication.
 */
export function encodeMessage(msg: AntpMessage): ArrayBuffer {
  const encoded = encode(msg);
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  );
}

/**
 * Deserialize a binary WebSocket message to an ANTP message.
 * Validates the `type` field exists.
 */
export function decodeMessage(data: ArrayBuffer): AntpMessage {
  const decoded = decode(new Uint8Array(data)) as Record<string, unknown>;

  if (!decoded || typeof decoded !== "object" || !("type" in decoded)) {
    throw new ProtocolError("INVALID_MESSAGE", "Message missing 'type' field");
  }

  const type = decoded.type as string;
  if (!Object.values(MessageType).includes(type as MessageType)) {
    throw new ProtocolError(
      "UNKNOWN_TYPE",
      `Unknown message type: ${type}`
    );
  }

  return decoded as unknown as AntpMessage;
}

/**
 * Protocol-level error for malformed messages.
 */
export class ProtocolError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
