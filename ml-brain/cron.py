"""
ANTP ML Control Plane — Cron Retraining Job

The "Flywheel": Runs every 24 hours to:
1. Pull the latest task/node data from PostgreSQL
2. Retrain all 4 ML models on fresh data
3. Hot-swap the new models into the running FastAPI server

Can be run standalone or scheduled via APScheduler.
"""

import os
import sys
import time
import requests
from datetime import datetime

# Add parent to path
sys.path.insert(0, os.path.dirname(__file__))

ML_BRAIN_URL = os.getenv("ML_BRAIN_URL", "http://localhost:8090")
RETRAIN_INTERVAL_HOURS = 24


def retrain_models():
    """Trigger retraining via the FastAPI /retrain endpoint."""
    timestamp = datetime.utcnow().isoformat()
    print(f"\n[Cron] {timestamp} — Starting scheduled model retraining...")

    try:
        response = requests.post(f"{ML_BRAIN_URL}/retrain", timeout=300)
        if response.status_code == 200:
            result = response.json()
            print(f"[Cron] ✅ Retraining complete: {result['message']}")
        else:
            print(f"[Cron] ❌ Retraining failed: {response.status_code} — {response.text}")
    except requests.ConnectionError:
        # Server not running — train locally
        print("[Cron] FastAPI server not reachable. Training locally...")
        from train import train_from_db
        train_from_db()
        print("[Cron] ✅ Local retraining complete.")
    except Exception as e:
        print(f"[Cron] ❌ Error: {e}")


def run_scheduler():
    """Run the retraining job on a schedule using APScheduler."""
    try:
        from apscheduler.schedulers.blocking import BlockingScheduler

        scheduler = BlockingScheduler()
        scheduler.add_job(
            retrain_models,
            "interval",
            hours=RETRAIN_INTERVAL_HOURS,
            next_run_time=datetime.utcnow(),  # Run immediately on start
        )

        print(f"[Cron] Scheduler started. Retraining every {RETRAIN_INTERVAL_HOURS} hours.")
        scheduler.start()

    except ImportError:
        # Fallback: simple sleep loop
        print(f"[Cron] APScheduler not available. Using simple loop.")
        while True:
            retrain_models()
            print(f"[Cron] Sleeping for {RETRAIN_INTERVAL_HOURS} hours...")
            time.sleep(RETRAIN_INTERVAL_HOURS * 3600)


if __name__ == "__main__":
    if "--once" in sys.argv:
        retrain_models()
    else:
        run_scheduler()
