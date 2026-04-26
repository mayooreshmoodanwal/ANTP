import { taskStore, type TaskState } from "../state/task-store.js";
import { queueManager } from "../queue/manager.js";
import { config } from "../config.js";
import * as dbQueries from "../../../database/queries.js";

/**
 * Consensus Engine (REQ-ORC-03).
 *
 * "The Orchestrator holds the client response until all three clones are
 *  processed. It performs a string/hash comparison. If two nodes return
 *  Result X and one returns Result Y, the Orchestrator accepts Result X,
 *  pays the two correct nodes, and slashes the Reputation Score of the
 *  dissenting node."
 *
 * This module reads results from the TaskStore and triggers consensus
 * when all 3 clone results arrive.
 */

export interface ConsensusResult {
  taskId: string;
  familyId: string;
  accepted: boolean;
  majorityHash: string | null;
  majorityOutput: Uint8Array | null;
  majorityNodeIds: string[];
  dissenterNodeIds: string[];
  allDisagree: boolean;
}

/**
 * Called when a clone result arrives. Checks if consensus can be reached.
 * Returns a ConsensusResult if all clones have reported; null otherwise.
 */
export async function onCloneResult(
  taskId: string,
  cloneId: string,
  result: {
    nodeId: string;
    resultHash: string;
    output: Uint8Array;
    execTimeMs: number;
    status: string;
  }
): Promise<ConsensusResult | null> {
  // Record result in TaskStore
  const resultCount = taskStore.addResult(taskId, cloneId, result);

  // Record result in DB
  const task = taskStore.getTask(taskId);
  if (task) {
    try {
      await dbQueries.recordResult({
        cloneId,
        taskId,
        familyId: task.familyId,
        nodeId: result.nodeId,
        resultHash: result.resultHash,
        outputSizeBytes: result.output.byteLength,
        execTimeMs: result.execTimeMs,
        status: result.status,
      });

      await dbQueries.completeClone(
        cloneId,
        result.resultHash,
        result.execTimeMs,
        result.output.byteLength
      );
    } catch (err) {
      console.error(`[Consensus] DB error recording result:`, err);
    }
  }

  // Check if we have all 3 results
  if (resultCount < config.clonesPerTask) {
    console.log(
      `[Consensus] Task ${taskId.slice(0, 8)}... — ${resultCount}/${config.clonesPerTask} results received`
    );
    return null;
  }

  // All 3 results in — run consensus
  return runConsensus(taskId);
}

/**
 * Execute 2-of-3 majority consensus.
 */
async function runConsensus(taskId: string): Promise<ConsensusResult> {
  const task = taskStore.getTask(taskId);
  if (!task) {
    throw new Error(`[Consensus] Task ${taskId} not found in store`);
  }

  console.log(
    `[Consensus] Running 2-of-3 consensus for task ${taskId.slice(0, 8)}...`
  );

  // Collect all result hashes
  const hashGroups = new Map<
    string,
    Array<{ cloneId: string; nodeId: string; output: Uint8Array }>
  >();

  for (const [cloneId, result] of task.results) {
    const group = hashGroups.get(result.resultHash) || [];
    group.push({
      cloneId,
      nodeId: result.nodeId,
      output: result.output,
    });
    hashGroups.set(result.resultHash, group);
  }

  // Find majority (≥2 matching hashes or fuzzy match)
  let majorityHash: string | null = null;
  let majorityEntries: Array<{
    cloneId: string;
    nodeId: string;
    output: Uint8Array;
  }> = [];
  let dissenterEntries: Array<{ cloneId: string; nodeId: string }> = [];
  let allDisagree = false;

  // First, attempt numerical fuzzy match (Flaw 3: Wasm Non-Determinism)
  const parsedResults = Array.from(task.results.entries()).map(([cloneId, result]) => {
    let numVal: number | null = null;
    try {
      const str = Buffer.from(result.output).toString("utf-8");
      const parsed = JSON.parse(str);
      if (typeof parsed === "number") numVal = parsed;
      else if (typeof parsed === "string" && !isNaN(parseFloat(parsed))) numVal = parseFloat(parsed);
    } catch {
      try {
        const str = Buffer.from(result.output).toString("utf-8").trim();
        if (str && !isNaN(parseFloat(str))) numVal = parseFloat(str);
      } catch {}
    }
    return { cloneId, result, numVal };
  });

  const validNumbers = parsedResults.filter((r) => r.numVal !== null);

  if (validNumbers.length >= config.consensusMajority) {
    for (const target of validNumbers) {
      const matches = validNumbers.filter(
        (r) => Math.abs(r.numVal! - target.numVal!) < 0.00001
      );
      if (matches.length >= config.consensusMajority) {
        majorityHash = target.result.resultHash; // Use the target's hash as the "accepted" hash
        majorityEntries = matches.map((m) => ({
          cloneId: m.cloneId,
          nodeId: m.result.nodeId,
          output: m.result.output,
        }));
        break;
      }
    }
  }

  // Fallback to strict hash comparison if fuzzy match failed or wasn't numerical
  if (!majorityHash) {
    for (const [hash, entries] of hashGroups) {
      if (entries.length >= config.consensusMajority) {
        majorityHash = hash;
        majorityEntries = entries;
        break;
      }
    }
  }

  if (majorityHash) {
    // Identify dissenters
    for (const [cloneId, result] of task.results) {
      const isMajority = majorityEntries.some((e) => e.cloneId === cloneId);
      if (!isMajority) {
        dissenterEntries.push({ cloneId, nodeId: result.nodeId });
      }
    }
  } else {
    // All 3 disagree — no consensus
    allDisagree = true;
    console.warn(
      `[Consensus] Task ${taskId.slice(0, 8)}... — ALL 3 DISAGREE, no consensus`
    );
  }

  const consensusResult: ConsensusResult = {
    taskId,
    familyId: task.familyId,
    accepted: majorityHash !== null,
    majorityHash,
    majorityOutput:
      majorityEntries.length > 0 ? majorityEntries[0].output : null,
    majorityNodeIds: majorityEntries.map((e) => e.nodeId),
    dissenterNodeIds: dissenterEntries.map((e) => e.nodeId),
    allDisagree,
  };

  // Apply economic consequences
  await applyConsensusEconomics(task, consensusResult);

  // Update task status
  if (consensusResult.accepted) {
    taskStore.completeTask(taskId);

    try {
      await dbQueries.updateTaskStatus(taskId, "COMPLETED", {
        acceptedResultHash: majorityHash!,
        consensusReachedAt: new Date(),
        dissentingNodeId:
          dissenterEntries.length > 0
            ? dissenterEntries[0].nodeId
            : null,
        completedAt: new Date(),
      });
    } catch (err) {
      console.error(`[Consensus] DB error updating task status:`, err);
    }

    // Clean up queue anti-affinity data
    queueManager.cleanupFamily(task.familyId);

    console.log(
      `[Consensus] ✅ Task ${taskId.slice(0, 8)}... ACCEPTED — hash=${majorityHash?.slice(0, 12)}... ` +
        `majority=[${consensusResult.majorityNodeIds.map((n) => n.slice(0, 8)).join(",")}] ` +
        `dissenters=[${consensusResult.dissenterNodeIds.map((n) => n.slice(0, 8)).join(",")}]`
    );
  } else {
    taskStore.updateStatus(taskId, "FAILED");

    try {
      await dbQueries.updateTaskStatus(taskId, "FAILED", {
        completedAt: new Date(),
      });
    } catch (err) {
      console.error(`[Consensus] DB error updating failed task:`, err);
    }

    console.log(
      `[Consensus] ❌ Task ${taskId.slice(0, 8)}... FAILED — no majority consensus`
    );
  }

  return consensusResult;
}

/**
 * Apply economic consequences of consensus (Section 5, REQ-ORC-03).
 *
 * - Correct nodes: receive payout = Base_Rate[Tier]
 * - Dissenting nodes: reputation slash (5% compounding)
 */
async function applyConsensusEconomics(
  task: TaskState,
  consensus: ConsensusResult
): Promise<void> {
  if (!consensus.accepted) return;

  const baseRate =
    config.payoutRates[task.tier] ?? config.payoutRates.TIER_1;

  // Pay correct nodes
  for (const nodeId of consensus.majorityNodeIds) {
    try {
      // Find the clone this node was assigned to
      let cloneId: string | undefined;
      for (const [cId, assignedNode] of task.assignedNodes) {
        if (assignedNode === nodeId) {
          cloneId = cId;
          break;
        }
      }

      if (cloneId) {
        await dbQueries.recordPayout({
          nodeId,
          taskId: task.taskId,
          cloneId,
          tier: task.tier,
          baseRate,
          amount: baseRate, // 1 task * base rate
        });

        await dbQueries.incrementNodeStats(nodeId, baseRate);
        await dbQueries.boostReputation(nodeId);
      }
    } catch (err) {
      console.error(
        `[Economics] Error paying node ${nodeId.slice(0, 8)}:`,
        err
      );
    }
  }

  // Slash dissenting nodes
  for (const nodeId of consensus.dissenterNodeIds) {
    try {
      await dbQueries.slashReputation(nodeId);
      console.log(
        `[Economics] Slashed reputation for dissenter ${nodeId.slice(0, 8)}...`
      );
    } catch (err) {
      console.error(
        `[Economics] Error slashing node ${nodeId.slice(0, 8)}:`,
        err
      );
    }
  }
}
