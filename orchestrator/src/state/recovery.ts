import * as dbQueries from "../../../database/queries.js";

/**
 * Recovers the orchestrator state on boot.
 * If the Node.js server crashed or was restarted (e.g., by Render), 
 * the in-memory WebSocket connections and task store payloads are lost.
 * 
 * This protocol sweeps the PostgreSQL database for any tasks that were 
 * abandoned mid-execution and gracefully fails them to prevent them from 
 * being stuck in an infinite "IN_PROGRESS" limbo.
 */
export async function recoverStateOnBoot(): Promise<void> {
  console.log("======================================================");
  console.log("[Recovery] Running Orchestrator State Recovery Protocol...");
  
  try {
    const abandonedTasks = await dbQueries.getAbandonedTasks();
    
    if (abandonedTasks.length === 0) {
      console.log("[Recovery] No abandoned tasks found. State is clean.");
      console.log("======================================================");
      return;
    }

    console.warn(`[Recovery] ⚠️ Found ${abandonedTasks.length} orphaned tasks due to server restart.`);
    console.warn(`[Recovery] Marking all as FAILED since WebSocket and RAM payload state is lost.`);

    for (const task of abandonedTasks) {
      await dbQueries.updateTaskStatus(task.id, "FAILED", {
        completedAt: new Date()
      });
    }

    console.log(`[Recovery] ✅ Successfully failed ${abandonedTasks.length} orphaned tasks.`);
  } catch (err) {
    console.error("[Recovery] ❌ Failed to run recovery protocol:", err);
  }

  console.log("======================================================");
}
