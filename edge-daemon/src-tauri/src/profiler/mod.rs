pub mod cpu;
pub mod gpu;
pub mod memory;

use serde::{Deserialize, Serialize};

/// Complete hardware profile — kernel-queried, not user-supplied (Section 2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub cpu_cores: u32,
    pub cpu_model: String,
    pub cpu_freq_mhz: u32,
    pub cpu_arch: String,
    pub gpu_model: Option<String>,
    pub gpu_vram_mb: Option<u32>,
    pub gpu_compute_units: Option<u32>,
    pub has_cuda: bool,
    pub has_metal: bool,
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub allocated_ram_mb: u64,
    pub os_name: String,
    pub os_version: String,
}

/// Profile the host hardware by directly querying the OS kernel.
/// Bypasses user-supplied inputs — cannot be fabricated at userspace layer.
pub fn profile_hardware() -> HardwareProfile {
    let cpu_info = cpu::profile_cpu();
    let gpu_info = gpu::detect_gpu();
    let mem_info = memory::profile_memory();

    // Default allocation: 50% of available RAM
    let allocated = mem_info.available_mb / 2;

    HardwareProfile {
        cpu_cores: cpu_info.cores,
        cpu_model: cpu_info.model,
        cpu_freq_mhz: cpu_info.freq_mhz,
        cpu_arch: cpu_info.arch,
        gpu_model: gpu_info.model,
        gpu_vram_mb: gpu_info.vram_mb,
        gpu_compute_units: gpu_info.compute_units,
        has_cuda: gpu_info.has_cuda,
        has_metal: gpu_info.has_metal,
        total_ram_mb: mem_info.total_mb,
        available_ram_mb: mem_info.available_mb,
        allocated_ram_mb: allocated,
        os_name: std::env::consts::OS.to_string(),
        os_version: os_version(),
    }
}

/// Get OS version string.
fn os_version() -> String {
    sysinfo::System::os_version()
        .unwrap_or_else(|| "unknown".to_string())
}
