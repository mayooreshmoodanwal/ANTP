pub mod crypto;
pub mod executor;
pub mod monitor;
pub mod profiler;
pub mod ws;

use log::info;
use parking_lot::RwLock;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

/// Shared daemon state accessible from Tauri commands and all modules.
#[derive(Debug, Clone, Serialize)]
pub struct DaemonStatus {
    pub node_id: String,
    pub tier: String,
    pub status: String,
    pub tasks_completed: u64,
    pub tasks_in_progress: u32,
    pub total_earnings: f64,
    pub reputation: f64,
    pub uptime_ms: u64,
    pub connected: bool,
    pub cpu_model: String,
    pub gpu_model: String,
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
}

impl Default for DaemonStatus {
    fn default() -> Self {
        Self {
            node_id: String::new(),
            tier: "PENDING_PROFILE".to_string(),
            status: "INITIALIZING".to_string(),
            tasks_completed: 0,
            tasks_in_progress: 0,
            total_earnings: 0.0,
            reputation: 100.0,
            uptime_ms: 0,
            connected: false,
            cpu_model: String::new(),
            gpu_model: "None".to_string(),
            total_ram_mb: 0,
            available_ram_mb: 0,
        }
    }
}

/// Thread-safe shared state wrapper.
pub struct AppState {
    pub status: Arc<RwLock<DaemonStatus>>,
    pub start_time: std::time::Instant,
}

/// Tauri command: Get current daemon status.
#[tauri::command]
fn get_status(state: State<AppState>) -> DaemonStatus {
    let mut status = state.status.read().clone();
    status.uptime_ms = state.start_time.elapsed().as_millis() as u64;
    status
}

/// Tauri command: Get hardware profile.
#[tauri::command]
fn get_hardware_profile() -> profiler::HardwareProfile {
    profiler::profile_hardware()
}

/// Tauri command: Get current RAM usage.
#[tauri::command]
fn get_ram_status() -> monitor::RamStatus {
    monitor::get_ram_status()
}

/// Main entry point — initializes all daemon subsystems.
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    info!("╔══════════════════════════════════════════════════╗");
    info!("║        ANTP Edge Daemon v0.1.0                  ║");
    info!("║   Decentralized Compute Node Agent              ║");
    info!("╚══════════════════════════════════════════════════╝");

    // Profile hardware at startup
    let profile = profiler::profile_hardware();
    info!("Hardware Profile:");
    info!("  CPU:  {} ({} cores @ {}MHz)", profile.cpu_model, profile.cpu_cores, profile.cpu_freq_mhz);
    info!("  GPU:  {}", profile.gpu_model.as_deref().unwrap_or("None"));
    info!("  RAM:  {}MB total, {}MB available", profile.total_ram_mb, profile.available_ram_mb);
    info!("  OS:   {} {}", profile.os_name, profile.os_version);

    // Generate cryptographic node ID from hardware
    let node_id = crypto::node_id::generate_node_id(&profile);
    info!("Node ID: {}", &node_id[..24]);

    // Initialize shared state
    let state = AppState {
        status: Arc::new(RwLock::new(DaemonStatus {
            node_id: node_id.clone(),
            cpu_model: profile.cpu_model.clone(),
            gpu_model: profile.gpu_model.clone().unwrap_or_else(|| "None".to_string()),
            total_ram_mb: profile.total_ram_mb,
            available_ram_mb: profile.available_ram_mb,
            ..Default::default()
        })),
        start_time: std::time::Instant::now(),
    };

    let status_clone = state.status.clone();
    let profile_clone = profile.clone();
    let node_id_clone = node_id.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_hardware_profile,
            get_ram_status,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Spawn background tasks on the Tokio runtime
            tauri::async_runtime::spawn(async move {
                // Start WebSocket connection to orchestrator
                let ws_status = status_clone.clone();
                let ws_profile = profile_clone.clone();
                let ws_node_id = node_id_clone.clone();

                tokio::spawn(async move {
                    ws::client::connect_and_run(
                        "ws://localhost:8080/ws",
                        ws_node_id,
                        ws_profile,
                        ws_status,
                    )
                    .await;
                });

                // Start RAM monitor
                let ram_status = status_clone.clone();
                tokio::spawn(async move {
                    monitor::ram::start_ram_monitor(ram_status).await;
                });
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to run ANTP Edge Daemon");
}
