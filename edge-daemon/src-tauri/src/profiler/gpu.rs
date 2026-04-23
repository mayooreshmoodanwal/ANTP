/// GPU detection result.
pub struct GpuInfo {
    pub model: Option<String>,
    pub vram_mb: Option<u32>,
    pub compute_units: Option<u32>,
    pub has_cuda: bool,
    pub has_metal: bool,
}

/// Detect GPU capabilities.
///
/// Uses platform-conditional compilation as different OS APIs are needed:
/// - macOS: IOKit / Metal framework detection
/// - Linux: Read from /sys/class/drm or nvidia-smi
/// - Windows: WMI queries
///
/// Per user feedback: hardware identifiers are OS-specific and require
/// different APIs per platform.
pub fn detect_gpu() -> GpuInfo {
    #[cfg(target_os = "macos")]
    {
        detect_gpu_macos()
    }

    #[cfg(target_os = "linux")]
    {
        detect_gpu_linux()
    }

    #[cfg(target_os = "windows")]
    {
        detect_gpu_windows()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        GpuInfo {
            model: None,
            vram_mb: None,
            compute_units: None,
            has_cuda: false,
            has_metal: false,
        }
    }
}

/// macOS GPU detection using system_profiler.
#[cfg(target_os = "macos")]
fn detect_gpu_macos() -> GpuInfo {
    use std::process::Command;

    // Query system_profiler for GPU info (reads from IOKit)
    let output = Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output();

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);

            // Parse JSON output to extract GPU model
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
                if let Some(displays) = json.get("SPDisplaysDataType").and_then(|d| d.as_array()) {
                    if let Some(gpu) = displays.first() {
                        let model = gpu
                            .get("sppci_model")
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown GPU")
                            .to_string();

                        let vram_str = gpu
                            .get("spdisplays_vram")
                            .and_then(|v| v.as_str())
                            .unwrap_or("0");

                        // Parse VRAM (e.g., "8 GB" → 8192)
                        let vram_mb = parse_vram_string(vram_str);

                        // Check for Metal support (all Apple GPUs since 2012 support Metal)
                        let has_metal = gpu
                            .get("sppci_metal")
                            .and_then(|m| m.as_str())
                            .map(|m| m.contains("sppci_metal_supported") || m.contains("Supported"))
                            .unwrap_or(true); // Assume Metal on macOS

                        return GpuInfo {
                            model: Some(model),
                            vram_mb: Some(vram_mb),
                            compute_units: None,
                            has_cuda: false,
                            has_metal,
                        };
                    }
                }
            }

            // Fallback: assume Apple Silicon integrated GPU
            GpuInfo {
                model: Some("Apple Silicon GPU".to_string()),
                vram_mb: None, // Shared memory on Apple Silicon
                compute_units: None,
                has_cuda: false,
                has_metal: true,
            }
        }
        Err(_) => GpuInfo {
            model: None,
            vram_mb: None,
            compute_units: None,
            has_cuda: false,
            has_metal: false,
        },
    }
}

/// Linux GPU detection using /sys/class/drm and nvidia-smi.
#[cfg(target_os = "linux")]
fn detect_gpu_linux() -> GpuInfo {
    use std::fs;
    use std::process::Command;

    // Try NVIDIA first (nvidia-smi)
    if let Ok(output) = Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total,gpu_uuid", "--format=csv,noheader,nounits"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let parts: Vec<&str> = stdout.trim().split(", ").collect();

            if parts.len() >= 2 {
                let model = parts[0].to_string();
                let vram_mb = parts[1].parse::<u32>().unwrap_or(0);

                return GpuInfo {
                    model: Some(model),
                    vram_mb: Some(vram_mb),
                    compute_units: None,
                    has_cuda: true,
                    has_metal: false,
                };
            }
        }
    }

    // Try reading from /sys/class/drm for AMD/Intel GPUs
    if let Ok(entries) = fs::read_dir("/sys/class/drm") {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();

            if name.starts_with("card") && !name.contains('-') {
                let device_path = path.join("device");

                // Read vendor
                if let Ok(vendor) = fs::read_to_string(device_path.join("vendor")) {
                    let vendor = vendor.trim();

                    // Read device name from uevent
                    if let Ok(uevent) = fs::read_to_string(device_path.join("uevent")) {
                        for line in uevent.lines() {
                            if line.starts_with("PCI_SLOT_NAME=") || line.starts_with("DRIVER=") {
                                let model = format!(
                                    "{} GPU ({})",
                                    match vendor {
                                        "0x1002" => "AMD",
                                        "0x10de" => "NVIDIA",
                                        "0x8086" => "Intel",
                                        _ => "Unknown",
                                    },
                                    line
                                );

                                return GpuInfo {
                                    model: Some(model),
                                    vram_mb: None,
                                    compute_units: None,
                                    has_cuda: vendor == "0x10de",
                                    has_metal: false,
                                };
                            }
                        }
                    }
                }
            }
        }
    }

    GpuInfo {
        model: None,
        vram_mb: None,
        compute_units: None,
        has_cuda: false,
        has_metal: false,
    }
}

/// Windows GPU detection using WMI.
#[cfg(target_os = "windows")]
fn detect_gpu_windows() -> GpuInfo {
    use std::process::Command;

    // Use WMIC to query GPU info
    if let Ok(output) = Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "Name,AdapterRAM", "/format:csv"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();

        if lines.len() >= 2 {
            let parts: Vec<&str> = lines[1].split(',').collect();
            if parts.len() >= 3 {
                let vram_bytes = parts[1].trim().parse::<u64>().unwrap_or(0);
                let model = parts[2].trim().to_string();

                let has_cuda = model.to_lowercase().contains("nvidia")
                    || model.to_lowercase().contains("geforce")
                    || model.to_lowercase().contains("quadro");

                return GpuInfo {
                    model: Some(model),
                    vram_mb: Some((vram_bytes / (1024 * 1024)) as u32),
                    compute_units: None,
                    has_cuda,
                    has_metal: false,
                };
            }
        }
    }

    GpuInfo {
        model: None,
        vram_mb: None,
        compute_units: None,
        has_cuda: false,
        has_metal: false,
    }
}

/// Parse VRAM strings like "8 GB", "2048 MB" into MB.
fn parse_vram_string(s: &str) -> u32 {
    let s = s.trim().to_lowercase();

    if let Some(gb_str) = s.strip_suffix("gb").or_else(|| s.strip_suffix(" gb")) {
        if let Ok(gb) = gb_str.trim().parse::<f32>() {
            return (gb * 1024.0) as u32;
        }
    }

    if let Some(mb_str) = s.strip_suffix("mb").or_else(|| s.strip_suffix(" mb")) {
        if let Ok(mb) = mb_str.trim().parse::<u32>() {
            return mb;
        }
    }

    // Try parsing as raw number (assume MB)
    s.parse::<u32>().unwrap_or(0)
}
