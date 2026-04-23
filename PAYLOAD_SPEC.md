# ANTP — WASM Payload Contract Specification

## Overview

All compute payloads in the ANTP network are executed inside a **Wasmtime sandbox**
on Edge Daemon nodes. This document defines the binary payload contract between the
Orchestrator and Edge Daemons.

---

## Payload Wire Format (MessagePack)

```
{
  "task_id":    String,       // UUID — unique task clone identifier
  "family_id":  String,       // UUID — parent task family (all 3 clones share this)
  "tier":       u8,           // 1 | 2 | 3
  "wasm_bytes": Binary,       // Compiled WASM module bytes
  "input":      Binary,       // Raw input bytes passed to the WASM entry point
  "timeout_ms": u32,          // Maximum execution time before forced termination
  "created_at": u64           // Unix timestamp (ms) — used for SLA tracking
}
```

## WASM Module Requirements

Every WASM module submitted to the network **MUST** export a single entry function:

```wat
(func (export "compute") (param i32 i32) (result i32))
```

### Parameters

| Param | Type  | Description                                |
|-------|-------|--------------------------------------------|
| p0    | i32   | Pointer to input bytes in linear memory     |
| p1    | i32   | Length of input bytes                       |
| ret   | i32   | Pointer to output bytes in linear memory    |

### Memory Layout

- The host (Wasmtime) pre-allocates a **shared linear memory** of 64 KiB minimum.
- The `input` bytes from the payload are written to memory offset `0` before invocation.
- The `compute` function writes its result starting at the offset it returns.
- The host reads from the returned offset to the end of written data.

### Output Contract

The WASM module's output bytes are:
1. Captured by the Wasmtime host.
2. SHA-256 hashed to produce the **result hash**.
3. Both `output_bytes` and `result_hash` are sent back to the Orchestrator.

---

## Result Wire Format (MessagePack)

```
{
  "task_id":      String,     // Echoed clone ID
  "family_id":    String,     // Echoed family ID
  "node_id":      String,     // Executing node's cryptographic ID
  "output":       Binary,     // Raw output bytes from WASM execution
  "result_hash":  String,     // SHA-256 hex digest of output bytes
  "exec_time_ms": u32,        // Wall-clock execution duration
  "status":       String      // "OK" | "TIMEOUT" | "ERROR" | "EVICTED"
}
```

---

## Consensus Hash Comparison

The Orchestrator compares `result_hash` from all 3 clone results:

- **2-of-3 match** → Accept majority result, pay correct nodes, slash dissenter.
- **3-of-3 match** → Accept, pay all nodes.
- **0-of-3 match** → All three disagree — task is flagged for manual review or cloud fallback.

---

## Domain-Agnostic Design

All task types (AI inference, data scraping, rendering, arithmetic) are **pre-compiled
to WASM** by the client before submission. The Orchestrator and Edge Daemons are
entirely unaware of the task's semantic domain. They only see:

```
WASM bytes in → raw bytes out → SHA-256 hash
```

This satisfies the PRD's Domain Agnosticism principle: no task-type-specific code
paths exist anywhere in the system.

---

## Security Constraints

| Constraint                  | Enforcement                                    |
|-----------------------------|------------------------------------------------|
| No filesystem access        | Wasmtime WASI disabled by default              |
| No network access           | No WASI socket capability granted              |
| Memory cap                  | Linear memory limited to `256 MiB`             |
| CPU time cap                | `timeout_ms` enforced via Wasmtime fuel metering|
| Deterministic execution     | No random or clock imports granted              |
