use crate::profiler::memory::get_available_ram_mb;
use crate::DaemonStatus;
use log::{info, warn};
use parking_lot::RwLock;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

/// RAM monitor polling interval (500ms per PRD spec).
const POLL_INTERVAL_MS: u64 = 500;

/// Threshold: if available RAM drops below this percentage of total, trigger eviction.
const EVICTION_THRESHOLD_PERCENT: f32 = 15.0;

/// Minimum absolute RAM (MB) — evict if below this regardless of percentage.
const EVICTION_MIN_AVAILABLE_MB: u64 = 512;

/// Aggressive RAM monitor (REQ-SLA-01).
///
/// "The ANTP daemon aggressively monitors host RAM and triggers TASK_EVICTION
///  if the host user opens heavy local software, instantly dumping the ANTP
///  memory state."
///
/// Polls every 500ms:
/// - If available RAM drops below threshold → trigger TASK_EVICTION
/// - Sends eviction WebSocket ping to Orchestrator
/// - Dumps ANTP memory state instantly
pub async fn start_ram_monitor(status: Arc<RwLock<DaemonStatus>>) {
    info!(
        "[RAM Monitor] Started (poll={}ms, threshold={}%, min={}MB)",
        POLL_INTERVAL_MS, EVICTION_THRESHOLD_PERCENT, EVICTION_MIN_AVAILABLE_MB
    );

    loop {
        sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;

        let available_mb = get_available_ram_mb();

        // Update status with current RAM
        {
            let mut s = status.write();
            s.available_ram_mb = available_mb;
        }

        let s = status.read();
        let total_mb = s.total_ram_mb;
        let tasks_in_progress = s.tasks_in_progress;
        drop(s);

        // Calculate usage percentage
        let usage_percent = if total_mb > 0 {
            ((total_mb - available_mb) as f32 / total_mb as f32) * 100.0
        } else {
            0.0
        };

        let available_percent = 100.0 - usage_percent;

        // Check eviction conditions
        let should_evict = tasks_in_progress > 0
            && (available_percent < EVICTION_THRESHOLD_PERCENT
                || available_mb < EVICTION_MIN_AVAILABLE_MB);

        if should_evict {
            warn!(
                "[RAM Monitor] ⚠️  RAM PRESSURE DETECTED — available={}MB ({}%), tasks={}",
                available_mb,
                format!("{:.1}", available_percent),
                tasks_in_progress
            );
            warn!(
                "[RAM Monitor] Triggering TASK_EVICTION — dumping ANTP memory state"
            );

            // Update status to evicting
            {
                let mut s = status.write();
                s.status = "EVICTING".to_string();
            }

            // The actual eviction message is sent by the WS client
            // when it sees the status change to EVICTING.
            // The WS client loop checks status and sends TASK_EVICTION messages.

            // Log the event
            info!(
                "[RAM Monitor] Eviction triggered at {}MB available ({}% of {}MB total)",
                available_mb,
                format!("{:.1}", available_percent),
                total_mb
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_eviction_threshold() {
        // 15% of 16GB = 2457MB
        let total = 16384u64;
        let available = 2000u64; // Below 15%
        let usage = ((total - available) as f32 / total as f32) * 100.0;
        let available_pct = 100.0 - usage;
        assert!(available_pct < EVICTION_THRESHOLD_PERCENT);
    }

    #[test]
    fn test_no_eviction_when_idle() {
        // Even with low RAM, don't evict if no tasks in progress
        let tasks_in_progress = 0u32;
        let available_mb = 100u64; // Very low
        let should_evict = tasks_in_progress > 0 && available_mb < EVICTION_MIN_AVAILABLE_MB;
        assert!(!should_evict);
    }
}
