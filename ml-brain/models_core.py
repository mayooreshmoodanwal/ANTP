"""
ANTP ML Control Plane — Core ML Models

Four models that govern the network:
1. Dynamic Spot Pricing (XGBoost / Gradient Boosting)
2. Fraud Detection (Isolation Forest)
3. Smart Hardware Clustering (K-Means)
4. Predictive Pre-Fetching (Time-Series — hour-of-day patterns)
"""

import os
import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import GradientBoostingRegressor, IsolationForest
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from datetime import datetime

MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")
os.makedirs(MODELS_DIR, exist_ok=True)


# ─────────────────────────────────────────────
# 1. Dynamic Spot Pricing
# ─────────────────────────────────────────────

class SpotPricingModel:
    """
    Predicts the optimal USD price per task based on:
    - Current queue depth (demand)
    - Active node count (supply)
    - Hour of day (time patterns)
    - Tier requested

    Uses Gradient Boosted Trees for robust non-linear regression.
    """

    def __init__(self):
        self.model = None
        self.scaler = StandardScaler()
        self.base_rates = {"TIER_1": 0.001, "TIER_2": 0.02, "TIER_3": 0.5}

    def train(self, df: pd.DataFrame):
        """Train on historical task data with known outcomes."""
        if df.empty or len(df) < 10:
            print("[Pricing] Not enough data to train. Using static rates.")
            return

        features = df[["queue_depth", "active_nodes", "hour", "tier_num"]].fillna(0)
        targets = df["actual_price"].fillna(0.001)

        X = self.scaler.fit_transform(features)
        self.model = GradientBoostingRegressor(
            n_estimators=100, max_depth=4, learning_rate=0.1, random_state=42
        )
        self.model.fit(X, targets)
        joblib.dump(self.model, os.path.join(MODELS_DIR, "pricing_model.pkl"))
        joblib.dump(self.scaler, os.path.join(MODELS_DIR, "pricing_scaler.pkl"))
        print(f"[Pricing] Model trained on {len(df)} samples.")

    def predict(self, queue_depth: int, active_nodes: int, tier: str) -> float:
        """Predict optimal price. Falls back to static rates if untrained."""
        if self.model is None:
            return self.base_rates.get(tier, 0.001)

        hour = datetime.utcnow().hour
        tier_num = {"TIER_1": 1, "TIER_2": 2, "TIER_3": 3}.get(tier, 1)
        X = self.scaler.transform([[queue_depth, active_nodes, hour, tier_num]])
        price = float(self.model.predict(X)[0])

        # Clamp to reasonable bounds
        min_price = self.base_rates.get(tier, 0.001) * 0.5
        max_price = self.base_rates.get(tier, 0.001) * 10.0
        return round(max(min_price, min(price, max_price)), 6)

    def load(self):
        """Load pre-trained model from disk."""
        model_path = os.path.join(MODELS_DIR, "pricing_model.pkl")
        scaler_path = os.path.join(MODELS_DIR, "pricing_scaler.pkl")
        if os.path.exists(model_path) and os.path.exists(scaler_path):
            self.model = joblib.load(model_path)
            self.scaler = joblib.load(scaler_path)
            print("[Pricing] Model loaded from disk.")


# ─────────────────────────────────────────────
# 2. Fraud Detection (Isolation Forest)
# ─────────────────────────────────────────────

class FraudDetector:
    """
    Detects anomalous node behavior using Isolation Forest.

    Flags nodes that:
    - Complete tasks suspiciously fast (probably returning garbage)
    - Have abnormally high failure rates
    - Show inconsistent hardware vs. performance profiles
    """

    def __init__(self):
        self.model = None
        self.scaler = StandardScaler()

    def train(self, df: pd.DataFrame):
        """Train on node performance data."""
        if df.empty or len(df) < 10:
            print("[Fraud] Not enough data to train.")
            return

        features = df[[
            "avg_exec_ms", "total_results", "ok_count",
            "fail_count", "cpu_cores", "total_ram_mb"
        ]].fillna(0)

        X = self.scaler.fit_transform(features)
        self.model = IsolationForest(
            n_estimators=100, contamination=0.05, random_state=42
        )
        self.model.fit(X)
        joblib.dump(self.model, os.path.join(MODELS_DIR, "fraud_model.pkl"))
        joblib.dump(self.scaler, os.path.join(MODELS_DIR, "fraud_scaler.pkl"))
        print(f"[Fraud] Model trained on {len(df)} nodes.")

    def predict(self, node_stats: dict) -> dict:
        """
        Returns {"is_anomalous": bool, "score": float}.
        Score closer to -1 = more anomalous.
        """
        if self.model is None:
            return {"is_anomalous": False, "score": 0.0, "action": "NONE"}

        features = [[
            node_stats.get("avg_exec_ms", 100),
            node_stats.get("total_results", 0),
            node_stats.get("ok_count", 0),
            node_stats.get("fail_count", 0),
            node_stats.get("cpu_cores", 4),
            node_stats.get("total_ram_mb", 8192),
        ]]

        X = self.scaler.transform(features)
        prediction = self.model.predict(X)[0]  # 1 = normal, -1 = anomaly
        score = float(self.model.score_samples(X)[0])

        is_anomalous = prediction == -1
        action = "SHADOW_BAN" if is_anomalous else "NONE"

        return {
            "is_anomalous": is_anomalous,
            "score": round(score, 4),
            "action": action,
        }

    def load(self):
        model_path = os.path.join(MODELS_DIR, "fraud_model.pkl")
        scaler_path = os.path.join(MODELS_DIR, "fraud_scaler.pkl")
        if os.path.exists(model_path) and os.path.exists(scaler_path):
            self.model = joblib.load(model_path)
            self.scaler = joblib.load(scaler_path)
            print("[Fraud] Model loaded from disk.")


# ─────────────────────────────────────────────
# 3. Smart Hardware Clustering (K-Means)
# ─────────────────────────────────────────────

class HardwareClusterer:
    """
    Groups nodes into performance clusters based on actual execution speed,
    not just reported RAM/CPU specs.

    A "Tier 1" laptop that consistently outperforms its tier gets promoted
    to receive higher-paying tasks.
    """

    def __init__(self, n_clusters: int = 4):
        self.model = None
        self.scaler = StandardScaler()
        self.n_clusters = n_clusters
        self.cluster_labels = {}  # node_id -> cluster_id

    def train(self, df: pd.DataFrame):
        """Train on node performance history."""
        if df.empty or len(df) < self.n_clusters:
            print("[Cluster] Not enough nodes to cluster.")
            return

        features = df[[
            "avg_exec_ms", "cpu_cores", "cpu_freq_mhz",
            "total_ram_mb", "ok_count", "total_results"
        ]].fillna(0)

        X = self.scaler.fit_transform(features)
        self.model = KMeans(n_clusters=self.n_clusters, random_state=42, n_init=10)
        self.model.fit(X)

        # Map node_ids to their clusters
        self.cluster_labels = {}
        for i, node_id in enumerate(df["node_id"].values):
            self.cluster_labels[node_id] = int(self.model.labels_[i])

        joblib.dump(self.model, os.path.join(MODELS_DIR, "cluster_model.pkl"))
        joblib.dump(self.scaler, os.path.join(MODELS_DIR, "cluster_scaler.pkl"))
        joblib.dump(self.cluster_labels, os.path.join(MODELS_DIR, "cluster_labels.pkl"))
        print(f"[Cluster] {len(df)} nodes grouped into {self.n_clusters} clusters.")

    def get_cluster(self, node_id: str) -> dict:
        """Get the cluster assignment for a node."""
        cluster_id = self.cluster_labels.get(node_id, -1)
        # Higher cluster = better performance (sorted by avg_exec_ms ascending)
        tier_suggestion = {0: "TIER_3", 1: "TIER_2", 2: "TIER_1", 3: "TIER_1"}.get(cluster_id, "TIER_1")

        return {
            "cluster_id": cluster_id,
            "suggested_tier": tier_suggestion,
            "total_nodes_in_cluster": sum(1 for v in self.cluster_labels.values() if v == cluster_id),
        }

    def load(self):
        model_path = os.path.join(MODELS_DIR, "cluster_model.pkl")
        scaler_path = os.path.join(MODELS_DIR, "cluster_scaler.pkl")
        labels_path = os.path.join(MODELS_DIR, "cluster_labels.pkl")
        if os.path.exists(model_path):
            self.model = joblib.load(model_path)
            self.scaler = joblib.load(scaler_path)
            self.cluster_labels = joblib.load(labels_path) if os.path.exists(labels_path) else {}
            print("[Cluster] Model loaded from disk.")


# ─────────────────────────────────────────────
# 4. Traffic Prediction (Hour-of-Day Patterns)
# ─────────────────────────────────────────────

class TrafficPredictor:
    """
    Predicts traffic volume by hour-of-day using historical averages.
    Used to instruct the Orchestrator to pre-fetch models to idle nodes.
    """

    def __init__(self):
        self.hourly_avg = np.zeros(24)  # Average tasks per hour (0-23)

    def train(self, df: pd.DataFrame):
        """Train on historical task timestamps."""
        if df.empty:
            print("[Traffic] No data for traffic prediction.")
            return

        if "created_at" not in df.columns:
            return

        df = df.copy()
        df["hour"] = pd.to_datetime(df["created_at"]).dt.hour
        hourly = df.groupby("hour").size()

        for h in range(24):
            self.hourly_avg[h] = hourly.get(h, 0)

        # Normalize to relative load (0.0 - 1.0)
        max_val = self.hourly_avg.max()
        if max_val > 0:
            self.hourly_avg = self.hourly_avg / max_val

        joblib.dump(self.hourly_avg, os.path.join(MODELS_DIR, "traffic_hourly.pkl"))
        print("[Traffic] Hourly traffic pattern learned.")

    def predict_next_hour(self) -> dict:
        """Predict traffic for the upcoming hour."""
        current_hour = datetime.utcnow().hour
        next_hour = (current_hour + 1) % 24

        current_load = float(self.hourly_avg[current_hour])
        next_load = float(self.hourly_avg[next_hour])

        spike = next_load > current_load * 1.5
        should_prefetch = next_load > 0.7  # Pre-fetch if upcoming hour is >70% of peak

        return {
            "current_hour": current_hour,
            "next_hour": next_hour,
            "current_load": round(current_load, 3),
            "predicted_load": round(next_load, 3),
            "spike_incoming": spike,
            "should_prefetch": should_prefetch,
        }

    def load(self):
        path = os.path.join(MODELS_DIR, "traffic_hourly.pkl")
        if os.path.exists(path):
            self.hourly_avg = joblib.load(path)
            print("[Traffic] Hourly pattern loaded from disk.")
