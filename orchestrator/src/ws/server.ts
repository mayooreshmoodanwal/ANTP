import uWS from "uWebSockets.js";
import { config } from "../config.js";
import { handleMessage, handleOpen, handleClose } from "./handlers.js";
import { decodeMessage, encodeMessage, ProtocolError, MessageType } from "./protocol.js";
import type { WebSocket } from "uWebSockets.js";

/**
 * Per-connection user data attached to each WebSocket.
 */
export interface WsUserData {
  nodeId: string | null;
  tier: string | null;
  isRegistered: boolean;
  connectedAt: number;
  lastHeartbeatAt: number;
  activeClones: Set<string>;
  remoteAddress: string;
}

/** Map of nodeId → WebSocket for broadcasting. */
export const connectedNodes = new Map<string, WebSocket<WsUserData>>();

/** Map of nodeId → public IP address for Sybil resistance. */
export const nodeIpMap = new Map<string, string>();

/**
 * Create and configure the uWebSockets.js application.
 * Returns the app instance (not yet listening).
 */
export function createWsServer() {
  const app = uWS.App();

  // ── WebSocket endpoint ──
  app.ws<WsUserData>(config.wsPath, {
    compression: uWS.SHARED_COMPRESSOR,
    maxPayloadLength: config.maxPayloadSizeBytes,
    idleTimeout: 60,
    sendPingsAutomatically: true,

    // Upgrade handler — initialize per-connection data
    upgrade: (res, req, context) => {
      const remoteAddress = Buffer.from(
        res.getRemoteAddressAsText()
      ).toString();

      res.upgrade<WsUserData>(
        {
          nodeId: null,
          tier: null,
          isRegistered: false,
          connectedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          activeClones: new Set(),
          remoteAddress,
        },
        req.getHeader("sec-websocket-key"),
        req.getHeader("sec-websocket-protocol"),
        req.getHeader("sec-websocket-extensions"),
        context
      );
    },

    // Connection opened
    open: (ws) => {
      const data = ws.getUserData();
      console.log(
        `[WS] Connection opened from ${data.remoteAddress}`
      );
      handleOpen(ws);
    },

    // Binary message received
    message: (ws, message, isBinary) => {
      const data = ws.getUserData();

      try {
        const msg = decodeMessage(message);
        handleMessage(ws, msg);
      } catch (err) {
        if (err instanceof ProtocolError) {
          console.warn(
            `[WS] Protocol error from ${data.nodeId || data.remoteAddress}: ${err.message}`
          );
          const errorMsg = encodeMessage({
            type: MessageType.ERROR,
            code: err.code,
            message: err.message,
          });
          ws.send(errorMsg, true);
        } else {
          console.error(
            `[WS] Unexpected error from ${data.nodeId || data.remoteAddress}:`,
            err
          );
        }
      }
    },

    // Connection closed
    close: (ws, code, message) => {
      const data = ws.getUserData();
      console.log(
        `[WS] Connection closed: ${data.nodeId || data.remoteAddress} (code=${code})`
      );
      handleClose(ws, code);
    },

    // Drain — backpressure relief
    drain: (ws) => {
      const data = ws.getUserData();
      console.log(
        `[WS] Backpressure drained for ${data.nodeId || data.remoteAddress} ` +
          `(buffered=${ws.getBufferedAmount()})`
      );
    },
  });

  return app;
}

/**
 * Send a message to a specific connected node.
 */
export function sendToNode(
  nodeId: string,
  msg: Parameters<typeof encodeMessage>[0]
): boolean {
  const ws = connectedNodes.get(nodeId);
  if (!ws) return false;

  try {
    const encoded = encodeMessage(msg);
    ws.send(encoded, true); // true = binary
    return true;
  } catch (err) {
    console.error(`[WS] Failed to send to ${nodeId.slice(0, 8)}...:`, err);
    return false;
  }
}

/**
 * Broadcast to all connected nodes (or a specific tier).
 */
export function broadcast(
  msg: Parameters<typeof encodeMessage>[0],
  tier?: string
): number {
  const encoded = encodeMessage(msg);
  let sent = 0;

  for (const [nodeId, ws] of connectedNodes) {
    const data = ws.getUserData();
    if (tier && data.tier !== tier) continue;

    try {
      ws.send(encoded, true);
      sent++;
    } catch {
      // Node may have disconnected
    }
  }

  return sent;
}

/**
 * Start heartbeat monitoring — marks nodes as OFFLINE if
 * they miss 3 consecutive heartbeats.
 */
export function startHeartbeatMonitor(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const now = Date.now();

    for (const [nodeId, ws] of connectedNodes) {
      const data = ws.getUserData();
      const elapsed = now - data.lastHeartbeatAt;

      if (elapsed > config.heartbeatTimeoutMs) {
        console.warn(
          `[WS] Node ${nodeId.slice(0, 8)}... heartbeat timeout ` +
            `(${elapsed}ms > ${config.heartbeatTimeoutMs}ms) — closing`
        );
        ws.end(1001, "Heartbeat timeout");
      }
    }
  }, config.heartbeatIntervalMs);
}
