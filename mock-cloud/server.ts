import express from "express";
import { createHash, randomBytes } from "crypto";

/**
 * Mock Cloud Shadow Server (DEV ONLY)
 *
 * Simulates the AWS/GCP Cloud Shadow Server for SLA fallback testing (REQ-SLA-02).
 * Accepts the same payload format the Orchestrator sends and returns a mock result.
 *
 * This is NOT production code — it exists solely to enable end-to-end testing
 * of the SLA breach → cloud fallback path.
 */

const PORT = parseInt(process.env.MOCK_CLOUD_PORT || "3001", 10);

const app = express();
app.use(express.json({ limit: "256mb" }));

// Request counter for logging
let requestCount = 0;

/**
 * POST /shadow — Mock cloud compute endpoint.
 *
 * Accepts the forwarded task payload from the Orchestrator's sla/fallback.ts
 * and returns a canned result with a deterministic hash.
 */
app.post("/shadow", (req, res) => {
  requestCount++;
  const startTime = Date.now();

  const { taskId, familyId, tier, wasmBytes, input, timeoutMs, reason } =
    req.body;

  console.log(
    `\n☁️  [${requestCount}] Cloud Shadow Server received task:` +
      `\n   taskId:   ${taskId?.slice(0, 12) || "unknown"}...` +
      `\n   familyId: ${familyId?.slice(0, 12) || "unknown"}...` +
      `\n   tier:     ${tier || "unknown"}` +
      `\n   reason:   ${reason || "unknown"}` +
      `\n   payload:  ${wasmBytes?.length || 0} bytes WASM, ${input?.length || 0} bytes input` +
      `\n   timeout:  ${timeoutMs || "unknown"}ms`
  );

  // Simulate compute time (10-50ms — cloud is fast)
  const simulatedExecTime = 10 + Math.floor(Math.random() * 40);

  setTimeout(() => {
    // Generate a deterministic mock result based on input
    const inputBuffer = input ? Buffer.from(input, "base64") : Buffer.alloc(0);
    const mockOutput = Buffer.concat([
      Buffer.from("CLOUD_RESULT:"),
      inputBuffer.slice(0, 64), // Echo first 64 bytes of input
      randomBytes(32), // Add some random bytes
    ]);

    const resultHash = createHash("sha256").update(mockOutput).digest("hex");
    const execTimeMs = Date.now() - startTime;

    console.log(
      `   ✅ Computed in ${execTimeMs}ms (simulated: ${simulatedExecTime}ms)` +
        `\n   hash: ${resultHash.slice(0, 24)}...` +
        `\n   output: ${mockOutput.length} bytes`
    );

    res.json({
      taskId,
      output: mockOutput.toString("base64"),
      resultHash,
      execTimeMs,
      status: "OK",
      source: "CLOUD_SHADOW_SERVER",
    });
  }, simulatedExecTime);
});

/**
 * GET /health — Health check.
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    type: "CLOUD_SHADOW_SERVER (MOCK)",
    requestsProcessed: requestCount,
    uptime: process.uptime(),
  });
});

/**
 * GET /stats — Request statistics.
 */
app.get("/stats", (req, res) => {
  res.json({
    totalRequests: requestCount,
    uptime: process.uptime(),
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║       ☁️  Mock Cloud Shadow Server (DEV ONLY)        ║
╠══════════════════════════════════════════════════════╣
║  Endpoint: http://localhost:${PORT}/shadow
║  Health:   http://localhost:${PORT}/health
║                                                      ║
║  This server simulates the AWS/GCP Cloud Shadow      ║
║  Server for SLA fallback testing (REQ-SLA-02).       ║
║  DO NOT USE IN PRODUCTION.                           ║
╚══════════════════════════════════════════════════════╝
  `);
});
