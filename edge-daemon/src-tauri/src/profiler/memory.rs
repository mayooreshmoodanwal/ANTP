use sysinfo::System;

/// Memory profile data.
pub struct MemoryInfo {
    pub total_mb: u64,
    pub available_mb: u64,
    pub used_mb: u64,
    pub swap_total_mb: u64,
    pub swap_used_mb: u64,
}

/// Profile RAM by querying the OS kernel.
/// sysinfo reads from:
/// - Linux: /proc/meminfo
/// - macOS: sysctl / host_statistics
/// - Windows: GlobalMemoryStatusEx
pub fn profile_memory() -> MemoryInfo {
    let mut sys = System::new();
    sys.refresh_memory();

    let total_mb = sys.total_memory() / (1024 * 1024);
    let available_mb = sys.available_memory() / (1024 * 1024);
    let used_mb = sys.used_memory() / (1024 * 1024);
    let swap_total_mb = sys.total_swap() / (1024 * 1024);
    let swap_used_mb = sys.used_swap() / (1024 * 1024);

    MemoryInfo {
        total_mb,
        available_mb,
        used_mb,
        swap_total_mb,
        swap_used_mb,
    }
}

/// Quick RAM availability check (used by the RAM Monitor).
pub fn get_available_ram_mb() -> u64 {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.available_memory() / (1024 * 1024)
}
