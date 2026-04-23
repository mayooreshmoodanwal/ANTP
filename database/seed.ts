import { db } from "./db.js";
import { nodes, tasks, taskClones, ragDocuments } from "./schema.js";
import { createClones } from "./queries.js";
import { randomUUID } from "crypto";

/**
 * Seed script — inserts deterministic test data across all three tiers.
 * Run: npm run db:seed (or npx tsx seed.ts)
 */
async function seed() {
  console.log("🌱 Seeding ANTP database...\n");

  // ── Seed Nodes (2 per tier + 1 pending) ──
  const testNodes = [
    {
      nodeId: "node-tier1-alpha-" + randomUUID().slice(0, 8),
      tier: "TIER_1" as const,
      status: "ONLINE" as const,
      cpuCores: 2,
      cpuModel: "Intel Celeron N4020",
      cpuFreqMhz: 1100,
      cpuArch: "x86_64",
      totalRamMb: 3072,
      availableRamMb: 2048,
      allocatedRamMb: 1024,
      osName: "linux",
      osVersion: "6.1.0",
      reputationScore: 95.0,
    },
    {
      nodeId: "node-tier1-beta-" + randomUUID().slice(0, 8),
      tier: "TIER_1" as const,
      status: "ONLINE" as const,
      cpuCores: 4,
      cpuModel: "ARM Cortex-A53",
      cpuFreqMhz: 1400,
      cpuArch: "aarch64",
      totalRamMb: 2048,
      availableRamMb: 1536,
      allocatedRamMb: 512,
      osName: "linux",
      osVersion: "5.15.0",
      reputationScore: 88.0,
    },
    {
      nodeId: "node-tier2-gamma-" + randomUUID().slice(0, 8),
      tier: "TIER_2" as const,
      status: "ONLINE" as const,
      cpuCores: 8,
      cpuModel: "Apple M2",
      cpuFreqMhz: 3500,
      cpuArch: "aarch64",
      gpuModel: "Apple M2 GPU",
      gpuVramMb: 8192,
      gpuComputeUnits: 10,
      hasMetal: true,
      totalRamMb: 16384,
      availableRamMb: 12288,
      allocatedRamMb: 8192,
      osName: "darwin",
      osVersion: "14.2.0",
      reputationScore: 100.0,
    },
    {
      nodeId: "node-tier2-delta-" + randomUUID().slice(0, 8),
      tier: "TIER_2" as const,
      status: "ONLINE" as const,
      cpuCores: 12,
      cpuModel: "AMD Ryzen 5 5600X",
      cpuFreqMhz: 3700,
      cpuArch: "x86_64",
      gpuModel: "NVIDIA RTX 3060",
      gpuVramMb: 12288,
      gpuComputeUnits: 3584,
      hasCuda: true,
      totalRamMb: 16384,
      availableRamMb: 10240,
      allocatedRamMb: 8192,
      osName: "linux",
      osVersion: "6.5.0",
      reputationScore: 97.5,
    },
    {
      nodeId: "node-tier3-epsilon-" + randomUUID().slice(0, 8),
      tier: "TIER_3" as const,
      status: "ONLINE" as const,
      cpuCores: 16,
      cpuModel: "AMD Ryzen 9 7950X",
      cpuFreqMhz: 4500,
      cpuArch: "x86_64",
      gpuModel: "NVIDIA RTX 4090",
      gpuVramMb: 24576,
      gpuComputeUnits: 16384,
      hasCuda: true,
      totalRamMb: 65536,
      availableRamMb: 55000,
      allocatedRamMb: 32768,
      osName: "linux",
      osVersion: "6.6.0",
      reputationScore: 100.0,
    },
    {
      nodeId: "node-tier3-zeta-" + randomUUID().slice(0, 8),
      tier: "TIER_3" as const,
      status: "ONLINE" as const,
      cpuCores: 24,
      cpuModel: "Intel Xeon W-3375",
      cpuFreqMhz: 2500,
      cpuArch: "x86_64",
      gpuModel: "NVIDIA A100",
      gpuVramMb: 81920,
      gpuComputeUnits: 6912,
      hasCuda: true,
      totalRamMb: 131072,
      availableRamMb: 100000,
      allocatedRamMb: 65536,
      osName: "linux",
      osVersion: "6.1.0",
      reputationScore: 100.0,
    },
    {
      nodeId: "node-pending-eta-" + randomUUID().slice(0, 8),
      tier: "PENDING_PROFILE" as const,
      status: "OFFLINE" as const,
      cpuCores: 1,
      cpuModel: "Unknown",
      totalRamMb: 512,
      availableRamMb: 256,
      reputationScore: 100.0,
    },
  ];

  const insertedNodes = await db.insert(nodes).values(testNodes).returning();
  console.log(`✅ Inserted ${insertedNodes.length} test nodes:`);
  for (const n of insertedNodes) {
    console.log(
      `   ${n.tier.padEnd(16)} ${n.nodeId.slice(0, 30)}... (rep: ${n.reputationScore})`
    );
  }

  // ── Seed Tasks (1 per tier with clones) ──
  const familyIds = [randomUUID(), randomUUID(), randomUUID()];
  const testTasks = [
    {
      familyId: familyIds[0],
      type: "COMPUTE" as const,
      status: "CLONED" as const,
      tier: "TIER_1" as const,
      wasmBytesHash:
        "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      inputHash:
        "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
      payloadSizeBytes: 1024,
      slaTimeoutMs: 2000,
      slaDeadlineAt: new Date(Date.now() + 60000),
    },
    {
      familyId: familyIds[1],
      type: "COMPUTE" as const,
      status: "CLONED" as const,
      tier: "TIER_2" as const,
      wasmBytesHash:
        "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
      inputHash:
        "e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4",
      payloadSizeBytes: 5242880,
      slaTimeoutMs: 2000,
      slaDeadlineAt: new Date(Date.now() + 60000),
    },
    {
      familyId: familyIds[2],
      type: "COMPUTE" as const,
      status: "CLONED" as const,
      tier: "TIER_3" as const,
      wasmBytesHash:
        "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      inputHash:
        "d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3",
      payloadSizeBytes: 104857600,
      slaTimeoutMs: 2000,
      slaDeadlineAt: new Date(Date.now() + 120000),
    },
  ];

  const insertedTasks = await db.insert(tasks).values(testTasks).returning();
  console.log(`\n✅ Inserted ${insertedTasks.length} test tasks:`);

  for (let i = 0; i < insertedTasks.length; i++) {
    const t = insertedTasks[i];
    console.log(
      `   ${t.tier.padEnd(16)} family=${t.familyId.slice(0, 8)}... payload=${t.payloadSizeBytes}B`
    );

    // Create 3 clones per task
    const clones = await createClones(t.id, t.familyId);
    console.log(`   └── Created ${clones.length} clones`);
  }

  // ── Seed RAG Document Chunks ──
  const ragDocId = randomUUID();
  const ragChunks = [
    {
      documentId: ragDocId,
      chunkIndex: 0,
      content:
        "The ANTP protocol leverages idle compute across distributed edge nodes to provide enterprise-grade processing without cloud dependency.",
      tokenCount: 22,
      isVectorized: false,
      metadata: { source: "whitepaper.pdf", page: 1 },
    },
    {
      documentId: ragDocId,
      chunkIndex: 1,
      content:
        "Work stealing queues ensure natural load balancing. Nodes independently fetch tasks when idle, preventing centralized scheduling bottlenecks.",
      tokenCount: 20,
      isVectorized: false,
      metadata: { source: "whitepaper.pdf", page: 2 },
    },
    {
      documentId: ragDocId,
      chunkIndex: 2,
      content:
        "The 2-of-3 consensus mechanism guarantees mathematical accuracy. Each task is independently executed by three nodes before result verification.",
      tokenCount: 23,
      isVectorized: false,
      metadata: { source: "whitepaper.pdf", page: 3 },
    },
  ];

  await db.insert(ragDocuments).values(ragChunks);
  console.log(`\n✅ Inserted ${ragChunks.length} RAG document chunks (doc=${ragDocId.slice(0, 8)}...)`);

  console.log("\n🎉 Seed complete!\n");
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
