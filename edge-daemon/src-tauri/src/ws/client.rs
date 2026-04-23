use crate::executor::runtime::execute_wasm_task;
use crate::profiler::HardwareProfile;
use crate::DaemonStatus;
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

/// Maximum reconnection attempts before giving up.
const MAX_RECONNECT_ATTEMPTS: u32 = u32::MAX; // Never give up
const INITIAL_BACKOFF_MS: u64 = 1000;
const MAX_BACKOFF_MS: u64 = 30000;
const HEARTBEAT_INTERVAL_MS: u64 = 15000;
const TASK_STEAL_INTERVAL_MS: u64 = 500;

// ──────────────────────────────────────────────
// Message Types (mirrors orchestrator protocol)
// ──────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
#[allow(non_camel_case_types)]
enum WsMessage {
    // Node → Orchestrator
    NODE_REGISTER {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(rename = "authToken")]
        auth_token: String,
        profile: HardwareProfile,
    },
    TASK_STEAL {
        #[serde(rename = "nodeId")]
        node_id: String,
    },
    TASK_RESULT {
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "cloneId")]
        clone_id: String,
        #[serde(rename = "familyId")]
        family_id: String,
        #[serde(rename = "nodeId")]
        node_id: String,
        output: Vec<u8>,
        #[serde(rename = "resultHash")]
        result_hash: String,
        #[serde(rename = "execTimeMs")]
        exec_time_ms: u32,
        status: String,
    },
    TASK_EVICTION {
        #[serde(rename = "cloneId")]
        clone_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "familyId")]
        family_id: String,
        #[serde(rename = "nodeId")]
        node_id: String,
        reason: String,
        #[serde(rename = "availableRamMb")]
        available_ram_mb: Option<u64>,
    },
    HEARTBEAT {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(rename = "availableRamMb")]
        available_ram_mb: u64,
        #[serde(rename = "activeTasks")]
        active_tasks: u32,
        #[serde(rename = "uptimeMs")]
        uptime_ms: u64,
    },

    // Orchestrator → Node
    REGISTER_ACK {
        success: bool,
        tier: String,
        #[serde(rename = "nodeDbId")]
        node_db_id: String,
        error: Option<String>,
    },
    TASK_ASSIGNMENT {
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "cloneId")]
        clone_id: String,
        #[serde(rename = "familyId")]
        family_id: String,
        tier: String,
        #[serde(rename = "wasmBytes")]
        wasm_bytes: Vec<u8>,
        input: Vec<u8>,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u32,
        #[serde(rename = "createdAt")]
        created_at: u64,
    },
    NO_TASK_AVAILABLE {
        #[serde(rename = "retryAfterMs")]
        retry_after_ms: u64,
    },
    EVICTION_ACK {
        #[serde(rename = "cloneId")]
        clone_id: String,
        #[serde(rename = "requeuedAt")]
        requeued_at: u64,
    },
    HEARTBEAT_ACK {
        #[serde(rename = "serverTimeMs")]
        server_time_ms: u64,
    },
    ERROR {
        code: String,
        message: String,
    },
}

/// Connect to the orchestrator and run the main event loop.
/// Auto-reconnects with exponential backoff on disconnect.
pub async fn connect_and_run(
    url: &str,
    node_id: String,
    profile: HardwareProfile,
    status: Arc<RwLock<DaemonStatus>>,
) {
    let mut attempt = 0u32;
    let mut backoff_ms = INITIAL_BACKOFF_MS;

    loop {
        attempt += 1;
        info!(
            "[WS] Connection attempt #{} to {}",
            attempt, url
        );

        match connect_async(url).await {
            Ok((ws_stream, _)) => {
                info!("[WS] Connected to orchestrator at {}", url);
                attempt = 0;
                backoff_ms = INITIAL_BACKOFF_MS;

                {
                    let mut s = status.write();
                    s.connected = true;
                    s.status = "CONNECTED".to_string();
                }

                // Run the session (blocks until disconnect)
                run_session(ws_stream, &node_id, &profile, &status).await;

                {
                    let mut s = status.write();
                    s.connected = false;
                    s.status = "DISCONNECTED".to_string();
                    s.tier = "PENDING_PROFILE".to_string(); // Reset tier so we don't steal until ACKed again
                }

                warn!("[WS] Disconnected from orchestrator. Reconnecting...");
            }
            Err(e) => {
                error!(
                    "[WS] Connection failed (attempt #{}): {}",
                    attempt, e
                );
            }
        }

        // Exponential backoff with cap
        info!("[WS] Reconnecting in {}ms...", backoff_ms);
        sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(MAX_BACKOFF_MS);
    }
}

/// Run a single WebSocket session.
async fn run_session(
    ws_stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    node_id: &str,
    profile: &HardwareProfile,
    status: &Arc<RwLock<DaemonStatus>>,
) {
    let (mut write, mut read) = ws_stream.split();

    // Send registration message
    // Read .env.local manually for dev convenience
    let mut auth_token = std::env::var("NODE_AUTH_SECRET").unwrap_or_else(|_| "dev-node-secret-change-me".to_string());
    if let Ok(env_local) = std::fs::read_to_string("../../.env.local") {
        for line in env_local.lines() {
            if line.starts_with("NODE_AUTH_SECRET=") {
                auth_token = line.replace("NODE_AUTH_SECRET=", "").trim().to_string();
                break;
            }
        }
    }

    let register_msg = WsMessage::NODE_REGISTER {
        node_id: node_id.to_string(),
        auth_token,
        profile: profile.clone(),
    };

    if let Ok(bytes) = rmp_serde::to_vec_named(&register_msg) {
        if let Err(e) = write.send(Message::Binary(bytes.into())).await {
            error!("[WS] Failed to send registration: {}", e);
            return;
        }
        info!("[WS] Registration sent (nodeId={}...)", &node_id[..16]);
    }

    // Channel for sending messages from task threads
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WsMessage>();

    let node_id_owned = node_id.to_string();
    let status_clone = status.clone();

    // Spawn heartbeat sender
    let heartbeat_tx = tx.clone();
    let hb_node_id = node_id.to_string();
    let hb_status = status.clone();
    let heartbeat_handle = tokio::spawn(async move {
        loop {
            sleep(Duration::from_millis(HEARTBEAT_INTERVAL_MS)).await;

            let s = hb_status.read();
            let msg = WsMessage::HEARTBEAT {
                node_id: hb_node_id.clone(),
                available_ram_mb: s.available_ram_mb,
                active_tasks: s.tasks_in_progress,
                uptime_ms: s.uptime_ms,
            };
            drop(s);

            if heartbeat_tx.send(msg).is_err() {
                break;
            }
        }
    });

    // Spawn task stealing loop
    let steal_tx = tx.clone();
    let steal_node_id = node_id.to_string();
    let steal_status = status.clone();
    let steal_handle = tokio::spawn(async move {
        // Wait for registration ACK
        sleep(Duration::from_millis(2000)).await;

        loop {
            // Scope the RwLockReadGuard so it is dropped BEFORE the .await
            // (parking_lot guards are !Send — they cannot live across await points)
            let should_steal = {
                let s = steal_status.read();
                let in_progress = s.tasks_in_progress;
                let is_registered = s.tier != "PENDING_PROFILE";
                is_registered && in_progress < 3
            }; // guard dropped here

            if should_steal {
                let msg = WsMessage::TASK_STEAL {
                    node_id: steal_node_id.clone(),
                };
                if steal_tx.send(msg).is_err() {
                    break;
                }
            }

            sleep(Duration::from_millis(TASK_STEAL_INTERVAL_MS)).await;
        }
    });

    // Main event loop — process incoming messages and outgoing queue
    loop {
        tokio::select! {
            // Incoming message from orchestrator
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        match rmp_serde::from_slice::<WsMessage>(&data) {
                            Ok(ws_msg) => {
                                handle_server_message(
                                    ws_msg,
                                    &node_id_owned,
                                    &tx,
                                    &status_clone,
                                ).await;
                            }
                            Err(e) => {
                                warn!("[WS] Failed to decode message: {}", e);
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        info!("[WS] Server sent close frame");
                        break;
                    }
                    Some(Err(e)) => {
                        error!("[WS] Read error: {}", e);
                        break;
                    }
                    None => {
                        info!("[WS] Stream ended");
                        break;
                    }
                    _ => {} // Ignore text, ping, pong
                }
            }

            // Outgoing message to orchestrator
            out_msg = rx.recv() => {
                if let Some(msg) = out_msg {
                    if let Ok(bytes) = rmp_serde::to_vec_named(&msg) {
                        if let Err(e) = write.send(Message::Binary(bytes.into())).await {
                            error!("[WS] Send error: {}", e);
                            break;
                        }
                    }
                }
            }
        }
    }

    // Cleanup
    heartbeat_handle.abort();
    steal_handle.abort();
}

/// Handle a message from the orchestrator.
async fn handle_server_message(
    msg: WsMessage,
    node_id: &str,
    tx: &tokio::sync::mpsc::UnboundedSender<WsMessage>,
    status: &Arc<RwLock<DaemonStatus>>,
) {
    match msg {
        WsMessage::REGISTER_ACK {
            success,
            tier,
            node_db_id,
            error,
        } => {
            if success {
                info!(
                    "[WS] ✅ Registered successfully — tier={}, dbId={}...",
                    tier,
                    &node_db_id[..8.min(node_db_id.len())]
                );
                let mut s = status.write();
                s.tier = tier;
                s.status = "IDLE".to_string();
            } else {
                error!(
                    "[WS] ❌ Registration failed: {}",
                    error.unwrap_or_default()
                );
            }
        }

        WsMessage::TASK_ASSIGNMENT {
            task_id,
            clone_id,
            family_id,
            tier,
            wasm_bytes,
            input,
            timeout_ms,
            created_at: _,
        } => {
            info!(
                "[WS] 📥 Task received: clone={}..., family={}..., tier={}, timeout={}ms",
                &clone_id[..8.min(clone_id.len())],
                &family_id[..8.min(family_id.len())],
                tier,
                timeout_ms
            );

            // Update status
            {
                let mut s = status.write();
                s.tasks_in_progress += 1;
                s.status = "EXECUTING".to_string();
            }

            // Execute task in background
            let tx_clone = tx.clone();
            let node_id = node_id.to_string();
            let status_clone = status.clone();

            tokio::spawn(async move {
                let start = std::time::Instant::now();

                // Execute in Wasmtime sandbox
                let result = execute_wasm_task(&wasm_bytes, &input, timeout_ms);

                let exec_time_ms = start.elapsed().as_millis() as u32;

                let (output, result_status) = match result {
                    Ok(output) => (output, "OK".to_string()),
                    Err(e) => {
                        error!("[Executor] Task failed: {}", e);
                        (Vec::new(), "ERROR".to_string())
                    }
                };

                // Compute SHA-256 hash of output
                let mut hasher = Sha256::new();
                hasher.update(&output);
                let result_hash = hex::encode(hasher.finalize());

                info!(
                    "[WS] 📤 Submitting result: clone={}..., hash={}..., status={}, exec={}ms",
                    &clone_id[..8.min(clone_id.len())],
                    &result_hash[..12],
                    result_status,
                    exec_time_ms
                );

                // Send result back to orchestrator
                let result_msg = WsMessage::TASK_RESULT {
                    task_id,
                    clone_id,
                    family_id,
                    node_id,
                    output,
                    result_hash,
                    exec_time_ms,
                    status: result_status,
                };

                let _ = tx_clone.send(result_msg);

                // Update status
                let mut s = status_clone.write();
                s.tasks_in_progress = s.tasks_in_progress.saturating_sub(1);
                s.tasks_completed += 1;
                if s.tasks_in_progress == 0 {
                    s.status = "IDLE".to_string();
                }
            });
        }

        WsMessage::NO_TASK_AVAILABLE { retry_after_ms: _ } => {
            // Silent — just wait and try again
        }

        WsMessage::EVICTION_ACK {
            clone_id,
            requeued_at,
        } => {
            info!(
                "[WS] Eviction acknowledged: clone={}..., requeued at {}",
                &clone_id[..8.min(clone_id.len())],
                requeued_at
            );
        }

        WsMessage::HEARTBEAT_ACK { server_time_ms: _ } => {
            // Update RAM in status
            let available_ram = crate::profiler::memory::get_available_ram_mb();
            let mut s = status.write();
            s.available_ram_mb = available_ram;
        }

        WsMessage::ERROR { code, message } => {
            error!("[WS] Server error: {}  — {}", code, message);
        }

        _ => {
            warn!("[WS] Unexpected message type received");
        }
    }
}
