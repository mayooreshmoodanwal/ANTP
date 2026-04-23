use sysinfo::System;

/// CPU profile data queried from the OS kernel.
pub struct CpuInfo {
    pub cores: u32,
    pub model: String,
    pub freq_mhz: u32,
    pub arch: String,
}

/// Profile CPU by querying the host OS kernel.
/// Uses sysinfo crate which reads from /proc/cpuinfo (Linux),
/// sysctl (macOS), or WMI (Windows).
pub fn profile_cpu() -> CpuInfo {
    let mut sys = System::new();
    sys.refresh_cpu_all();

    let cpus = sys.cpus();
    let cores = cpus.len() as u32;

    let model = if !cpus.is_empty() {
        cpus[0].brand().to_string()
    } else {
        "Unknown CPU".to_string()
    };

    let freq_mhz = if !cpus.is_empty() {
        cpus[0].frequency() as u32
    } else {
        0
    };

    let arch = std::env::consts::ARCH.to_string();

    CpuInfo {
        cores,
        model,
        freq_mhz,
        arch,
    }
}
