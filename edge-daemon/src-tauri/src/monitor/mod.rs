pub mod ram;

use serde::Serialize;

/// Current RAM status for IPC query.
#[derive(Debug, Clone, Serialize)]
pub struct RamStatus {
    pub total_mb: u64,
    pub available_mb: u64,
    pub used_mb: u64,
    pub usage_percent: f32,
    pub pressure_level: String,
}

/// Get current RAM status.
pub fn get_ram_status() -> RamStatus {
    let mem = crate::profiler::memory::profile_memory();
    let usage_percent = if mem.total_mb > 0 {
        (mem.used_mb as f32 / mem.total_mb as f32) * 100.0
    } else {
        0.0
    };

    let pressure_level = if usage_percent > 90.0 {
        "CRITICAL".to_string()
    } else if usage_percent > 75.0 {
        "HIGH".to_string()
    } else if usage_percent > 50.0 {
        "MODERATE".to_string()
    } else {
        "LOW".to_string()
    };

    RamStatus {
        total_mb: mem.total_mb,
        available_mb: mem.available_mb,
        used_mb: mem.used_mb,
        usage_percent,
        pressure_level,
    }
}
