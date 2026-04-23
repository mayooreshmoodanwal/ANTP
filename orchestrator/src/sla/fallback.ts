import { config } from "../config.js";

/**
 * Cloud Shadow Server Fallback (REQ-SLA-02).
 *
 * "If a task remains unverified past the hard-coded SLA timeout (e.g., 2.0 seconds),
 *  the Orchestrator halts swarm routing and forwards the payload to the internal
 *  AWS/GCP Shadow Server to guarantee an immediate enterprise response."
 *
 * This is the ONLY scenario where cloud compute is utilised.
 */

export interface CloudFallbackRequest {
  taskId: string;
  familyId: string;
  tier: string;
  wasmBytes: Uint8Array;
  input: Uint8Array;
  timeoutMs: number;
  reason: "SLA_TIMEOUT" | "ALL_DISAGREE";
}

export interface CloudFallbackResponse {
  taskId: string;
  output: Uint8Array;
  resultHash: string;
  execTimeMs: number;
  status: "OK" | "ERROR";
  error?: string;
}

/**
 * Forward a task payload to the Cloud Shadow Server.
 * Returns the cloud-computed result.
 */
export async function forwardToCloud(
  request: CloudFallbackRequest
): Promise<CloudFallbackResponse> {
  const url = config.cloudFallbackUrl;

  console.log(
    `[CloudFallback] Forwarding task ${request.taskId.slice(0, 8)}... to ${url} ` +
      `(reason: ${request.reason})`
  );

  const startTime = Date.now();

  try {
    // Serialize payload as JSON with base64 binary data
    const body = JSON.stringify({
      taskId: request.taskId,
      familyId: request.familyId,
      tier: request.tier,
      wasmBytes: Buffer.from(request.wasmBytes).toString("base64"),
      input: Buffer.from(request.input).toString("base64"),
      timeoutMs: request.timeoutMs,
      reason: request.reason,
    });

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.cloudFallbackTimeoutMs
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ANTP-Auth": config.nodeAuthSecret,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(
        `Cloud server responded with ${response.status}: ${response.statusText}`
      );
    }

    const result = await response.json() as any;
    const execTimeMs = Date.now() - startTime;

    console.log(
      `[CloudFallback] ✅ Cloud response for ${request.taskId.slice(0, 8)}... ` +
        `in ${execTimeMs}ms (hash=${(result.resultHash || "").slice(0, 12)}...)`
    );

    return {
      taskId: request.taskId,
      output: Buffer.from(result.output || "", "base64"),
      resultHash: result.resultHash || "",
      execTimeMs,
      status: result.status || "OK",
      error: result.error,
    };
  } catch (err: any) {
    const execTimeMs = Date.now() - startTime;

    console.error(
      `[CloudFallback] ❌ Cloud fallback failed for ${request.taskId.slice(0, 8)}... ` +
        `after ${execTimeMs}ms:`,
      err.message
    );

    return {
      taskId: request.taskId,
      output: new Uint8Array(0),
      resultHash: "",
      execTimeMs,
      status: "ERROR",
      error: err.message,
    };
  }
}
