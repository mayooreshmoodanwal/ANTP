"""
ANTP ML Control Plane — Synthetic Data Seeder

Generates realistic simulated network traffic data for cold-start
ML model training. Creates:
- 100K task execution records with realistic latency distributions
- Simulated traffic spikes at peak hours
- A handful of "malicious" nodes with suspiciously fast execution times
"""

import os
import random
import uuid
import numpy as np
import psycopg2
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))

DATABASE_URL = os.getenv("DATABASE_URL", "")

# Synthetic constants
NUM_NODES = 200
NUM_TASKS = 100_000
MALICIOUS_NODE_RATIO = 0.03  # 3% of nodes are malicious
TIERS = ["TIER_1", "TIER_2", "TIER_3"]
TIER_EXEC_MS = {"TIER_1": (50, 200), "TIER_2": (200, 800), "TIER_3": (800, 3000)}
PEAK_HOURS = [9, 10, 11, 14, 15, 16]  # Simulated traffic spikes


def generate_synthetic_data():
    """Generate synthetic training data and write to CSV files."""
    print("=" * 60)
    print("[Seed] Generating synthetic ANTP network data...")
    print("=" * 60)

    # ── Generate Nodes ──
    nodes = []
    for i in range(NUM_NODES):
        tier = random.choice(TIERS)
        is_malicious = i < int(NUM_NODES * MALICIOUS_NODE_RATIO)

        ram = {"TIER_1": random.randint(2048, 4096),
               "TIER_2": random.randint(8192, 16384),
               "TIER_3": random.randint(32768, 65536)}[tier]

        nodes.append({
            "node_id": f"synthetic-node-{uuid.uuid4().hex[:12]}",
            "tier": tier,
            "cpu_cores": random.choice([2, 4, 6, 8, 12, 16]),
            "cpu_freq_mhz": random.randint(1800, 4500),
            "total_ram_mb": ram,
            "is_malicious": is_malicious,
            "reputation_score": random.uniform(60, 100) if not is_malicious else random.uniform(20, 50),
        })

    print(f"[Seed] Generated {NUM_NODES} synthetic nodes ({int(NUM_NODES * MALICIOUS_NODE_RATIO)} malicious)")

    # ── Generate Tasks & Results ──
    task_rows = []
    result_rows = []
    base_time = datetime.utcnow() - timedelta(days=30)

    for i in range(NUM_TASKS):
        tier = random.choice(TIERS)
        # Simulate traffic spikes at peak hours
        hour = random.choices(
            range(24),
            weights=[3 if h in PEAK_HOURS else 1 for h in range(24)],
            k=1
        )[0]

        created_at = base_time + timedelta(
            days=random.randint(0, 29),
            hours=hour,
            minutes=random.randint(0, 59),
        )

        # Pick 3 random nodes for consensus
        selected_nodes = random.sample(nodes, min(3, len(nodes)))
        task_id = str(uuid.uuid4())

        status = random.choices(
            ["COMPLETED", "FAILED", "CLOUD_FALLBACK"],
            weights=[85, 10, 5],
            k=1
        )[0]

        queue_depth = random.randint(0, 500) + (200 if hour in PEAK_HOURS else 0)
        active_nodes_count = random.randint(20, NUM_NODES)

        # Pricing: base_rate * surge multiplier
        base_rate = {"TIER_1": 0.001, "TIER_2": 0.02, "TIER_3": 0.5}[tier]
        surge = 1.0 + (queue_depth / (active_nodes_count + 1)) * 0.5
        actual_price = round(base_rate * surge, 6)

        task_rows.append({
            "id": task_id,
            "tier": tier,
            "status": status,
            "created_at": created_at.isoformat(),
            "hour": hour,
            "queue_depth": queue_depth,
            "active_nodes": active_nodes_count,
            "actual_price": actual_price,
            "used_cloud_fallback": status == "CLOUD_FALLBACK",
        })

        # Generate results for each clone
        for node in selected_nodes:
            min_ms, max_ms = TIER_EXEC_MS[tier]
            if node["is_malicious"]:
                exec_ms = random.randint(1, 10)  # Suspiciously fast
                result_status = random.choice(["OK", "OK", "ERROR"])
            else:
                exec_ms = random.randint(min_ms, max_ms)
                result_status = "OK" if random.random() > 0.05 else "ERROR"

            result_rows.append({
                "task_id": task_id,
                "node_id": node["node_id"],
                "exec_time_ms": exec_ms,
                "status": result_status,
                "tier": tier,
                "cpu_cores": node["cpu_cores"],
                "cpu_freq_mhz": node["cpu_freq_mhz"],
                "total_ram_mb": node["total_ram_mb"],
                "ok_count": 1 if result_status == "OK" else 0,
                "fail_count": 0 if result_status == "OK" else 1,
            })

        if (i + 1) % 10000 == 0:
            print(f"[Seed] Generated {i + 1}/{NUM_TASKS} tasks...")

    print(f"[Seed] ✅ Generated {NUM_TASKS} tasks with {len(result_rows)} result records.")

    import pandas as pd
    tasks_df = pd.DataFrame(task_rows)
    results_df = pd.DataFrame(result_rows)
    nodes_df = pd.DataFrame(nodes)

    data_dir = os.path.join(os.path.dirname(__file__), "seed_data")
    os.makedirs(data_dir, exist_ok=True)

    tasks_df.to_csv(os.path.join(data_dir, "tasks.csv"), index=False)
    results_df.to_csv(os.path.join(data_dir, "results.csv"), index=False)
    nodes_df.to_csv(os.path.join(data_dir, "nodes.csv"), index=False)

    print(f"[Seed] Data saved to {data_dir}/")
    return tasks_df, results_df, nodes_df


if __name__ == "__main__":
    generate_synthetic_data()
