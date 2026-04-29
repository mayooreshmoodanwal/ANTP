"""
ANTP ML Control Plane — Training Pipeline

Trains all four ML models:
1. Spot Pricing (Gradient Boosting)
2. Fraud Detection (Isolation Forest)
3. Hardware Clustering (K-Means)
4. Traffic Prediction (Hourly averages)

Can train from:
- Synthetic seed data (CSV files for cold start)
- Live PostgreSQL data (production mode)
"""

import os
import pandas as pd
from models_core import SpotPricingModel, FraudDetector, HardwareClusterer, TrafficPredictor

SEED_DIR = os.path.join(os.path.dirname(__file__), "seed_data")


def train_from_seed():
    """Train all models from synthetic CSV seed data."""
    print("=" * 60)
    print("[Train] Training ML models from synthetic seed data...")
    print("=" * 60)

    tasks_path = os.path.join(SEED_DIR, "tasks.csv")
    results_path = os.path.join(SEED_DIR, "results.csv")
    nodes_path = os.path.join(SEED_DIR, "nodes.csv")

    if not os.path.exists(tasks_path):
        print("[Train] No seed data found. Run `python seed.py` first.")
        return

    tasks_df = pd.read_csv(tasks_path)
    results_df = pd.read_csv(results_path)
    nodes_df = pd.read_csv(nodes_path)

    # ── 1. Train Spot Pricing ──
    print("\n── Training Spot Pricing Model ──")
    pricing_model = SpotPricingModel()
    pricing_data = tasks_df[["queue_depth", "active_nodes", "hour", "tier", "actual_price"]].copy()
    pricing_data["tier_num"] = pricing_data["tier"].map({"TIER_1": 1, "TIER_2": 2, "TIER_3": 3})
    pricing_model.train(pricing_data)

    # ── 2. Train Fraud Detection ──
    print("\n── Training Fraud Detection Model ──")
    fraud_model = FraudDetector()
    # Aggregate results per node
    node_perf = results_df.groupby("node_id").agg(
        avg_exec_ms=("exec_time_ms", "mean"),
        total_results=("status", "count"),
        ok_count=("ok_count", "sum"),
        fail_count=("fail_count", "sum"),
        cpu_cores=("cpu_cores", "first"),
        total_ram_mb=("total_ram_mb", "first"),
    ).reset_index()
    fraud_model.train(node_perf)

    # ── 3. Train Hardware Clustering ──
    print("\n── Training Hardware Clustering Model ──")
    cluster_model = HardwareClusterer(n_clusters=4)
    cluster_data = node_perf.copy()
    cluster_data["cpu_freq_mhz"] = results_df.groupby("node_id")["cpu_freq_mhz"].first().values[:len(cluster_data)]
    cluster_model.train(cluster_data)

    # ── 4. Train Traffic Prediction ──
    print("\n── Training Traffic Prediction Model ──")
    traffic_model = TrafficPredictor()
    traffic_model.train(tasks_df)

    print("\n" + "=" * 60)
    print("[Train] ✅ All 4 models trained and saved to /models/")
    print("=" * 60)


def train_from_db():
    """Train from live PostgreSQL data."""
    from database import fetch_task_history, fetch_node_performance

    print("[Train] Fetching live data from PostgreSQL...")

    tasks_df = fetch_task_history(limit=100_000)
    nodes_df = fetch_node_performance()

    if tasks_df.empty:
        print("[Train] No production data yet. Falling back to seed data.")
        train_from_seed()
        return

    # Pricing
    pricing_model = SpotPricingModel()
    if "created_at" in tasks_df.columns:
        tasks_df["hour"] = pd.to_datetime(tasks_df["created_at"]).dt.hour
    else:
        tasks_df["hour"] = 12
    tasks_df["tier_num"] = tasks_df["tier"].map({"TIER_1": 1, "TIER_2": 2, "TIER_3": 3}).fillna(1)
    tasks_df["queue_depth"] = 50
    tasks_df["active_nodes"] = 10
    tasks_df["actual_price"] = tasks_df["tier_num"].map({1: 0.001, 2: 0.02, 3: 0.5})
    pricing_model.train(tasks_df)

    # Fraud
    fraud_model = FraudDetector()
    if not nodes_df.empty:
        fraud_model.train(nodes_df)

    # Clustering
    cluster_model = HardwareClusterer()
    if not nodes_df.empty and len(nodes_df) >= 4:
        cluster_model.train(nodes_df)

    # Traffic
    traffic_model = TrafficPredictor()
    traffic_model.train(tasks_df)

    print("[Train] ✅ All models retrained from live data.")


if __name__ == "__main__":
    import sys
    if "--live" in sys.argv:
        train_from_db()
    else:
        train_from_seed()
