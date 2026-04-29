"""
ANTP ML Control Plane — FastAPI Server

The "Brain" of the ANTP network. Exposes internal HTTP endpoints
that the Node.js Orchestrator queries for intelligent decisions:

- GET  /predict/price       → Dynamic spot pricing
- POST /predict/fraud       → Fraud/Sybil detection for a node
- GET  /predict/cluster/:id → Hardware cluster for a node
- GET  /predict/traffic     → Upcoming traffic prediction
- GET  /health              → Health check
- POST /retrain             → Trigger model retraining
"""

import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from contextlib import asynccontextmanager

from models_core import SpotPricingModel, FraudDetector, HardwareClusterer, TrafficPredictor

# ─────────────────────────────────────────────
# Global Model Instances
# ─────────────────────────────────────────────
pricing_model = SpotPricingModel()
fraud_detector = FraudDetector()
hardware_clusterer = HardwareClusterer()
traffic_predictor = TrafficPredictor()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup."""
    print("=" * 60)
    print("[Brain] ANTP ML Control Plane starting...")
    print("=" * 60)

    pricing_model.load()
    fraud_detector.load()
    hardware_clusterer.load()
    traffic_predictor.load()

    print("[Brain] All models loaded. Ready for predictions.")
    yield
    print("[Brain] Shutting down.")


app = FastAPI(
    title="ANTP ML Control Plane",
    description="The AI Brain governing the ANTP Decentralized Compute Network",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────
# Request / Response Models
# ─────────────────────────────────────────────

class PricingRequest(BaseModel):
    queue_depth: int
    active_nodes: int
    tier: str


class FraudRequest(BaseModel):
    node_id: str
    avg_exec_ms: float
    total_results: int
    ok_count: int
    fail_count: int
    cpu_cores: int
    total_ram_mb: int


# ─────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "ml-brain",
        "models_loaded": {
            "pricing": pricing_model.model is not None,
            "fraud": fraud_detector.model is not None,
            "clustering": hardware_clusterer.model is not None,
            "traffic": len(traffic_predictor.hourly_avg) > 0,
        },
    }


@app.post("/predict/price")
async def predict_price(req: PricingRequest):
    """
    Dynamic Spot Pricing.
    
    The Node.js Orchestrator calls this before dispatching a task
    to determine the optimal USD price based on supply/demand.
    """
    price = pricing_model.predict(req.queue_depth, req.active_nodes, req.tier)
    return {
        "tier": req.tier,
        "predicted_price_usd": price,
        "queue_depth": req.queue_depth,
        "active_nodes": req.active_nodes,
        "model_active": pricing_model.model is not None,
    }


@app.post("/predict/fraud")
async def predict_fraud(req: FraudRequest):
    """
    Fraud / Sybil Detection.
    
    Called when a node submits suspicious results. If flagged,
    the Orchestrator shadow-bans the node (sends decoy tasks).
    """
    result = fraud_detector.predict({
        "avg_exec_ms": req.avg_exec_ms,
        "total_results": req.total_results,
        "ok_count": req.ok_count,
        "fail_count": req.fail_count,
        "cpu_cores": req.cpu_cores,
        "total_ram_mb": req.total_ram_mb,
    })
    result["node_id"] = req.node_id
    return result


@app.get("/predict/cluster/{node_id}")
async def predict_cluster(node_id: str):
    """
    Smart Hardware Clustering.
    
    Returns the performance cluster a node belongs to,
    plus a suggested tier override if the node outperforms its tier.
    """
    result = hardware_clusterer.get_cluster(node_id)
    result["node_id"] = node_id
    return result


@app.get("/predict/traffic")
async def predict_traffic():
    """
    Traffic Prediction.
    
    Returns the predicted load for the next hour. If a spike is
    incoming, the Orchestrator pre-fetches models to idle nodes.
    """
    return traffic_predictor.predict_next_hour()


@app.post("/retrain")
async def retrain():
    """
    Trigger model retraining from live database data.
    Called by cron.py every 24 hours.
    """
    try:
        from train import train_from_db
        train_from_db()

        # Reload models
        pricing_model.load()
        fraud_detector.load()
        hardware_clusterer.load()
        traffic_predictor.load()

        return {"status": "ok", "message": "All models retrained and reloaded."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("ML_BRAIN_PORT", "8090"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
