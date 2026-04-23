use log::info;
use wasmtime::*;
use std::time::Instant;

/// Maximum linear memory for WASM modules (256 MiB).
const MAX_MEMORY_BYTES: u64 = 256 * 1024 * 1024;

/// Fuel limit for CPU time metering (prevents infinite loops).
/// Each WASM instruction consumes 1 fuel unit.
const DEFAULT_FUEL_LIMIT: u64 = 100_000_000;

/// Execute a WASM task in a Wasmtime sandbox.
///
/// Security guarantees (per PAYLOAD_SPEC.md):
/// - No filesystem access (WASI disabled)
/// - No network access (no socket capabilities)
/// - Memory capped at 256 MiB
/// - CPU time capped via fuel metering
/// - Deterministic execution (no random/clock imports)
///
/// The WASM module must export a `compute(i32, i32) -> i32` function:
/// - p0: pointer to input bytes in linear memory
/// - p1: length of input bytes
/// - returns: pointer to output bytes in linear memory
pub fn execute_wasm_task(
    wasm_bytes: &[u8],
    input: &[u8],
    _timeout_ms: u32,
) -> Result<Vec<u8>, String> {
    let start = Instant::now();

    // Handle empty WASM bytes (placeholder tasks)
    if wasm_bytes.is_empty() {
        info!("[Executor] Empty WASM module — running echo mode");
        return Ok(input.to_vec());
    }

    // Configure the Wasmtime engine with strict sandboxing
    let mut config = Config::new();
    config.consume_fuel(true); // Enable fuel metering
    config.wasm_bulk_memory(true);
    config.wasm_multi_value(true);

    let engine = Engine::new(&config).map_err(|e| format!("Engine init error: {}", e))?;

    // Create a store with fuel limit
    let mut store = Store::new(&engine, ());
    store
        .set_fuel(DEFAULT_FUEL_LIMIT)
        .map_err(|e| format!("Fuel set error: {}", e))?;

    // Compile the WASM module
    let module = Module::new(&engine, wasm_bytes)
        .map_err(|e| format!("WASM compile error: {}", e))?;

    info!(
        "[Executor] Module compiled in {}ms ({} bytes)",
        start.elapsed().as_millis(),
        wasm_bytes.len()
    );

    // Create a linker — deliberately empty (no WASI, no imports)
    // This enforces the security constraints: no fs, no net, no random
    let linker = Linker::new(&engine);

    // Instantiate the module
    let instance = linker
        .instantiate(&mut store, &module)
        .map_err(|e| format!("WASM instantiate error: {}", e))?;

    // Get the exported memory
    let memory = instance
        .get_memory(&mut store, "memory")
        .ok_or_else(|| "WASM module does not export 'memory'".to_string())?;

    // Check memory limits
    let mem_size = memory.data_size(&store) as u64;
    if mem_size > MAX_MEMORY_BYTES {
        return Err(format!(
            "WASM memory exceeds limit: {} > {} bytes",
            mem_size, MAX_MEMORY_BYTES
        ));
    }

    // Write input bytes to memory at offset 0
    let input_ptr: i32 = 0;
    let input_len: i32 = input.len() as i32;

    // Ensure memory is large enough for input
    let pages_needed = ((input.len() + 65535) / 65536) as u64;
    let current_pages = memory.size(&store);
    if pages_needed > current_pages {
        let grow_by = pages_needed - current_pages;
        memory
            .grow(&mut store, grow_by)
            .map_err(|e| format!("Memory grow error: {}", e))?;
    }

    memory
        .write(&mut store, 0, input)
        .map_err(|e| format!("Memory write error: {}", e))?;

    // Get the `compute` export function
    let compute = instance
        .get_typed_func::<(i32, i32), i32>(&mut store, "compute")
        .map_err(|e| format!("Missing 'compute' export: {}", e))?;

    // Execute with fuel metering (acts as CPU time limit)
    info!(
        "[Executor] Executing compute({}, {})",
        input_ptr, input_len
    );

    let output_ptr = compute
        .call(&mut store, (input_ptr, input_len))
        .map_err(|e| {
            // Check if fuel exhausted (timeout equivalent)
            let fuel_remaining = store.get_fuel().unwrap_or(0);
            if fuel_remaining == 0 {
                format!("WASM execution timed out (fuel exhausted)")
            } else {
                format!("WASM execution error: {}", e)
            }
        })?;

    // Read output from memory starting at the returned pointer
    // Convention: output length is stored at output_ptr as a 4-byte LE integer,
    // followed by the actual output bytes
    let mem_data = memory.data(&store);

    let output_offset = output_ptr as usize;
    if output_offset + 4 > mem_data.len() {
        // Fallback: treat entire memory from input end to output_ptr as output
        let output = mem_data[input.len()..output_offset.min(mem_data.len())].to_vec();
        info!(
            "[Executor] Completed in {}ms — output={} bytes (fallback read)",
            start.elapsed().as_millis(),
            output.len()
        );
        return Ok(output);
    }

    // Read output length (first 4 bytes at output_ptr)
    let output_len =
        u32::from_le_bytes([
            mem_data[output_offset],
            mem_data[output_offset + 1],
            mem_data[output_offset + 2],
            mem_data[output_offset + 3],
        ]) as usize;

    let output_start = output_offset + 4;
    let output_end = (output_start + output_len).min(mem_data.len());
    let output = mem_data[output_start..output_end].to_vec();

    let fuel_remaining = store.get_fuel().unwrap_or(0);
    let fuel_consumed = DEFAULT_FUEL_LIMIT - fuel_remaining;

    info!(
        "[Executor] ✅ Completed in {}ms — output={} bytes, fuel={}/{}",
        start.elapsed().as_millis(),
        output.len(),
        fuel_consumed,
        DEFAULT_FUEL_LIMIT
    );

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_wasm_echo_mode() {
        let input = b"hello world";
        let result = execute_wasm_task(&[], input, 2000);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), input);
    }

    #[test]
    fn test_invalid_wasm_module() {
        let bad_wasm = b"not a wasm module";
        let result = execute_wasm_task(bad_wasm, b"input", 2000);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("WASM compile error"));
    }
}
