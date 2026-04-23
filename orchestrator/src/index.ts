import { config } from "./config.js";
import { createWsServer, startHeartbeatMonitor } from "./ws/server.js";
import { registerRestApi } from "./api/rest.js";
import { startSlaMonitor, onTaskResult } from "./sla/monitor.js";
import { taskStore } from "./state/task-store.js";

/**
 * ANTP Orchestrator — Main Entry Point
 *
 * Boots:
 * 1. uWebSockets.js server (WebSocket + HTTP)
 * 2. SLA monitoring loop (100ms poll)
 * 3. Heartbeat monitor (detects dead nodes)
 * 4. Periodic task store purge (memory management)
 */

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║          ANTP Orchestrator v0.1.0                    ║
║     Decentralized Edge-Compute Orchestration         ║
╠══════════════════════════════════════════════════════╣
║  WebSocket: ws://${config.host}:${config.port}${config.wsPath}
║  REST API:  http://${config.host}:${config.port}/api
║  SLA:       ${config.slaTimeoutMs}ms timeout
║  Cloud:     ${config.cloudFallbackUrl}
║  Tiers:     T1=$${config.payoutRates.TIER_1} T2=$${config.payoutRates.TIER_2} T3=$${config.payoutRates.TIER_3}
╚══════════════════════════════════════════════════════╝
  `);

  // Create uWebSockets app
  const app = createWsServer();

  // Register REST API endpoints
  registerRestApi(app);

  // Start listening
  app.listen(config.host, config.port, (listenSocket) => {
    if (listenSocket) {
      console.log(
        `✅ Orchestrator listening on ${config.host}:${config.port}`
      );

      // Start SLA monitoring loop
      startSlaMonitor();

      // Start heartbeat monitor
      const heartbeatTimer = startHeartbeatMonitor();

      // Periodic task store purge (every 5 minutes)
      const purgeTimer = setInterval(() => {
        const purged = taskStore.purgeOld(3600_000); // Purge tasks older than 1 hour
        if (purged > 0) {
          console.log(`[GC] Purged ${purged} old tasks from in-memory store`);
        }
      }, 300_000);

      // Log store stats every 30 seconds
      const statsTimer = setInterval(() => {
        const stats = taskStore.getStats();
        console.log(
          `[Stats] Tasks: total=${stats.total} queued=${stats.queued} ` +
            `inProgress=${stats.inProgress} completed=${stats.completed} ` +
            `failed=${stats.failed} cloud=${stats.cloudFallback} | ` +
            `Nodes: ${stats.activeNodes} active`
        );
      }, 30_000);

      // Graceful shutdown
      const shutdown = () => {
        console.log("\n🛑 Shutting down orchestrator...");

        clearInterval(heartbeatTimer);
        clearInterval(purgeTimer);
        clearInterval(statsTimer);

        // Import and stop SLA monitor
        import("./sla/monitor.js").then((m) => m.stopSlaMonitor());

        app.close();
        console.log("👋 Orchestrator shut down cleanly.");
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } else {
      console.error(
        `❌ Failed to listen on ${config.host}:${config.port}. ` +
          `Is the port already in use?`
      );
      process.exit(1);
    }
  });
}

// Run
main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
