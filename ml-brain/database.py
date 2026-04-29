"""
ANTP ML Control Plane — Database Connection
Reads from the shared PostgreSQL database used by the Node.js Orchestrator.
"""

import os
import pandas as pd
import psycopg2
from dotenv import load_dotenv

# Load .env.local from project root
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))

DATABASE_URL = os.getenv("DATABASE_URL", "")


def get_connection():
    """Get a psycopg2 connection to the shared Neon Postgres DB."""
    return psycopg2.connect(DATABASE_URL)


def fetch_task_history(limit: int = 100_000) -> pd.DataFrame:
    """Fetch completed tasks with execution metrics for ML training."""
    conn = get_connection()
    query = """
        SELECT 
            t.id, t.type, t.tier, t.status, t.sla_timeout_ms,
            t.payload_size_bytes, t.created_at, t.completed_at,
            t.used_cloud_fallback,
            tr.node_id, tr.exec_time_ms, tr.status as result_status,
            n.cpu_cores, n.cpu_freq_mhz, n.total_ram_mb,
            n.gpu_model, n.reputation_score, n.tier as node_tier
        FROM tasks t
        LEFT JOIN task_results tr ON t.id = tr.task_id
        LEFT JOIN nodes n ON tr.node_id = n.node_id
        WHERE t.status IN ('COMPLETED', 'FAILED', 'CLOUD_FALLBACK')
        ORDER BY t.created_at DESC
        LIMIT %s
    """
    df = pd.read_sql(query, conn, params=(limit,))
    conn.close()
    return df


def fetch_queue_snapshot() -> dict:
    """Fetch current queue depth and active node count for pricing."""
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM tasks WHERE status IN ('QUEUED', 'CLONED', 'IN_PROGRESS')")
    queue_depth = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM nodes WHERE status IN ('ONLINE', 'BUSY')")
    active_nodes = cur.fetchone()[0]

    cur.close()
    conn.close()

    return {"queue_depth": queue_depth, "active_nodes": active_nodes}


def fetch_node_performance() -> pd.DataFrame:
    """Fetch node performance history for clustering and fraud detection."""
    conn = get_connection()
    query = """
        SELECT 
            n.node_id, n.tier, n.cpu_cores, n.cpu_freq_mhz,
            n.total_ram_mb, n.reputation_score,
            n.total_tasks_completed,
            AVG(tr.exec_time_ms) as avg_exec_ms,
            COUNT(tr.id) as total_results,
            SUM(CASE WHEN tr.status = 'OK' THEN 1 ELSE 0 END) as ok_count,
            SUM(CASE WHEN tr.status != 'OK' THEN 1 ELSE 0 END) as fail_count
        FROM nodes n
        LEFT JOIN task_results tr ON n.node_id = tr.node_id
        GROUP BY n.node_id, n.tier, n.cpu_cores, n.cpu_freq_mhz,
                 n.total_ram_mb, n.reputation_score, n.total_tasks_completed
        HAVING COUNT(tr.id) > 0
    """
    df = pd.read_sql(query, conn)
    conn.close()
    return df
