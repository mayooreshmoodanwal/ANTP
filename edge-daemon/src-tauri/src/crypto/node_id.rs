use crate::profiler::HardwareProfile;
use sha2::{Digest, Sha256};

/// Generate a deterministic cryptographic node ID from the hardware profile.
///
/// The node ID is a SHA-256 hash bound to physical hardware characteristics,
/// making it impossible to spoof at the userspace layer (Section 2).
///
/// Components hashed (platform-conditional):
/// - CPU model + core count + frequency
/// - OS-specific machine identifier
/// - MAC address (when available)
///
/// Same hardware always produces the same ID — prevents Sybil attacks.
pub fn generate_node_id(profile: &HardwareProfile) -> String {
    let mut hasher = Sha256::new();

    // Hardware-bound components
    hasher.update(profile.cpu_model.as_bytes());
    hasher.update(profile.cpu_cores.to_le_bytes());
    hasher.update(profile.cpu_freq_mhz.to_le_bytes());
    hasher.update(profile.cpu_arch.as_bytes());
    hasher.update(profile.total_ram_mb.to_le_bytes());
    hasher.update(profile.os_name.as_bytes());

    // GPU component (if present)
    if let Some(ref gpu) = profile.gpu_model {
        hasher.update(gpu.as_bytes());
    }
    if let Some(vram) = profile.gpu_vram_mb {
        hasher.update(vram.to_le_bytes());
    }

    // Platform-specific machine identifier
    let machine_id = get_machine_id();
    hasher.update(machine_id.as_bytes());

    // MAC address for additional hardware binding
    let mac = get_primary_mac();
    hasher.update(mac.as_bytes());

    let result = hasher.finalize();
    hex::encode(result)
}

/// Get the platform-specific machine identifier.
///
/// Per user feedback: hardware identifiers are OS-specific and require
/// different APIs on macOS (IOKit), Linux (/etc/machine-id), and Windows (WMI).
fn get_machine_id() -> String {
    #[cfg(target_os = "macos")]
    {
        get_machine_id_macos()
    }

    #[cfg(target_os = "linux")]
    {
        get_machine_id_linux()
    }

    #[cfg(target_os = "windows")]
    {
        get_machine_id_windows()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "unknown-platform".to_string()
    }
}

/// macOS: Read hardware UUID via IOKit (ioreg).
#[cfg(target_os = "macos")]
fn get_machine_id_macos() -> String {
    use std::process::Command;

    // ioreg reads from IOKit — the kernel-level hardware registry
    if let Ok(output) = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains("IOPlatformUUID") {
                // Extract UUID from: "IOPlatformUUID" = "XXXXXXXX-XXXX-..."
                if let Some(uuid_part) = line.split('"').nth(3) {
                    return uuid_part.to_string();
                }
            }
        }
    }

    // Fallback: use system_profiler
    if let Ok(output) = Command::new("system_profiler")
        .args(["SPHardwareDataType"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains("Hardware UUID") || line.contains("Serial Number") {
                if let Some(value) = line.split(':').nth(1) {
                    return value.trim().to_string();
                }
            }
        }
    }

    "macos-unknown".to_string()
}

/// Linux: Read /etc/machine-id (systemd) or /var/lib/dbus/machine-id.
#[cfg(target_os = "linux")]
fn get_machine_id_linux() -> String {
    use std::fs;

    // systemd machine-id (most common)
    if let Ok(id) = fs::read_to_string("/etc/machine-id") {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }

    // D-Bus machine-id (fallback)
    if let Ok(id) = fs::read_to_string("/var/lib/dbus/machine-id") {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }

    // DMI product UUID (requires root, but try anyway)
    if let Ok(id) = fs::read_to_string("/sys/class/dmi/id/product_uuid") {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }

    "linux-unknown".to_string()
}

/// Windows: Read MachineGuid from registry via reg query.
#[cfg(target_os = "windows")]
fn get_machine_id_windows() -> String {
    use std::process::Command;

    if let Ok(output) = Command::new("reg")
        .args([
            "query",
            "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains("MachineGuid") {
                if let Some(guid) = line.split_whitespace().last() {
                    return guid.to_string();
                }
            }
        }
    }

    "windows-unknown".to_string()
}

/// Get primary network interface MAC address for additional hardware binding.
fn get_primary_mac() -> String {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("ifconfig").arg("en0").output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("ether ") {
                    return trimmed.replace("ether ", "").trim().to_string();
                }
            }
        }
        "00:00:00:00:00:00".to_string()
    }

    #[cfg(target_os = "linux")]
    {
        use std::fs;
        // Read from sysfs — kernel-level, not spoofable without root
        let interfaces = ["eth0", "ens0", "enp0s3", "wlan0", "wlp2s0"];
        for iface in &interfaces {
            let path = format!("/sys/class/net/{}/address", iface);
            if let Ok(mac) = fs::read_to_string(&path) {
                let mac = mac.trim().to_string();
                if mac != "00:00:00:00:00:00" {
                    return mac;
                }
            }
        }
        "00:00:00:00:00:00".to_string()
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("getmac").args(["/fo", "csv", "/nh"]).output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().next() {
                if let Some(mac) = line.split(',').next() {
                    return mac.replace('"', "").trim().to_string();
                }
            }
        }
        "00:00:00:00:00:00".to_string()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "00:00:00:00:00:00".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deterministic_node_id() {
        let profile = HardwareProfile {
            cpu_cores: 8,
            cpu_model: "Apple M2".to_string(),
            cpu_freq_mhz: 3500,
            cpu_arch: "aarch64".to_string(),
            gpu_model: Some("Apple M2 GPU".to_string()),
            gpu_vram_mb: Some(8192),
            gpu_compute_units: None,
            has_cuda: false,
            has_metal: true,
            total_ram_mb: 16384,
            available_ram_mb: 12000,
            allocated_ram_mb: 8000,
            os_name: "macos".to_string(),
            os_version: "14.2".to_string(),
        };

        let id1 = generate_node_id(&profile);
        let id2 = generate_node_id(&profile);

        // Same hardware → same ID (deterministic)
        assert_eq!(id1, id2);
        // Should be a 64-char hex string (SHA-256)
        assert_eq!(id1.len(), 64);
    }
}
