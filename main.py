import os
import sys
import time
import uuid
import asyncio
import logging
import subprocess
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase, exceptions
from dotenv import load_dotenv
from pydantic import BaseModel
from typing import Dict, List, Optional, Set

# Set up logging for production-ready observability
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

print("--- DEBUG INFO ---")
print(f"Loaded URI: {os.getenv('NEO4J_URI')}")
print(f"Loaded User: {os.getenv('NEO4J_USERNAME')}")
print("------------------")

# ==========================================
# Database Architecture & Connection Manager
# ==========================================
class Neo4jConnectionManager:
    def __init__(self):
        self.uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
        self.user = os.getenv("NEO4J_USERNAME", "neo4j")
        self.password = os.getenv("NEO4J_PASSWORD", "password")
        self.driver = None

    def connect(self):
        try:
            self.driver = GraphDatabase.driver(self.uri, auth=(self.user, self.password))
            self.driver.verify_connectivity()
            logger.info("Successfully connected to the Neo4j database.")
            return True
        except Exception as e:
            self.driver = None
            logger.error(f"Failed to connect to Neo4j: {e}")
            return False

    def is_connected(self):
        if self.driver is None:
            return False
        try:
            self.driver.verify_connectivity()
            return True
        except Exception:
            return False

    def ensure_connected(self):
        if self.is_connected():
            return True
        self.close()
        return self.connect()

    def close(self):
        if self.driver is not None:
            self.driver.close()
            logger.info("Neo4j connection closed.")

    def execute_transaction(self, queries_with_params: list):
        if not self.driver:
            raise Exception("Driver not initialized.")
        with self.driver.session() as session:
            try:
                def _tx_logic(tx):
                    results = []
                    for query_dict in queries_with_params:
                        query = query_dict.get("query")
                        params = query_dict.get("params", {})
                        result = tx.run(query, params)
                        results.append(result.consume()) 
                    return results
                return session.execute_write(_tx_logic)
            except exceptions.Neo4jError as e:
                logger.error(f"Transaction failed: {e}")
                raise e

db_manager = Neo4jConnectionManager()


def ensure_db_or_503():
    if db_manager.ensure_connected():
        return

    raise HTTPException(
        status_code=503,
        detail=(
            "Neo4j is unavailable. Check NEO4J_URI/NEO4J_USERNAME/NEO4J_PASSWORD in .env "
            "and ensure the database is reachable."
        )
    )

# ==========================================
# FastAPI Application & Lifecycle Setup
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global smart_mode_task
    try:
        db_manager.connect()
        smart_mode_task = asyncio.create_task(smart_mode_monitor_loop())
        add_event("Backend service started.", level="success", source="system")
    except Exception as e:
        logger.critical(f"Could not establish database connection on startup: {e}")
        add_event(f"Startup database connection failed: {e}", level="error", source="system")
    yield 
    if smart_mode_task is not None:
        smart_mode_task.cancel()
        try:
            await smart_mode_task
        except asyncio.CancelledError:
            pass
    db_manager.close()

app = FastAPI(
    title="Smart Infrastructure Asset Relationship Analytics Platform",
    description="API for managing and analyzing cascading power grid failures.",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from fastapi.responses import JSONResponse
import traceback

@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"detail": f"Backend Error: {str(exc)}"},
        headers={"Access-Control-Allow-Origin": "*"}
    )

# ==========================================
# Data Models
# ==========================================
class SpikeRequest(BaseModel):
    target_name: str
    added_load: float

class TelemetryData(BaseModel):
    transformer_id: str
    load_kw: float

class TelemetryPayload(BaseModel):
    data: List[TelemetryData]


class SmartModeRequest(BaseModel):
    enabled: bool

class WeatherRequest(BaseModel):
    lat: Optional[float] = None
    lon: Optional[float] = None
    city: str
    temperature: Optional[float] = None

class AddTransformerRequest(BaseModel):
    name: str
    max_capacity: float
    connect_to: Optional[str] = None
    lat: float
    lon: float

class ConnectTransformersRequest(BaseModel):
    source_id: str
    target_id: str

BASE_DIR = Path(__file__).resolve().parent
SIMULATOR_SCRIPT = BASE_DIR / "simulator.py"
simulator_process = None
smart_mode_enabled = False
smart_mode_task: Optional[asyncio.Task] = None
total_curtailed_kw: float = 0.0

SHED_THRESHOLD_RATIO = 0.90
SHED_REDUCTION_RATIO = 0.85
EMERGENCY_SHED_REDUCTION_RATIO = 0.70
MAX_SMART_INTERVENTION_ROUNDS = 3
SMART_MONITOR_INTERVAL_SECONDS = 2
SMART_SHED_COOLDOWN_SECONDS = 10

recent_events: deque = deque(maxlen=250)
last_shed_times: Dict[str, float] = {}

# --- PREDICTIVE ANALYTICS ---
load_history: Dict[str, deque] = {}
HISTORY_MAX_LEN = 15
PREDICTIVE_SHED_THRESHOLD_SECONDS = 30


def record_load_history(tx_id: str, load: float):
    if tx_id not in load_history:
        load_history[tx_id] = deque(maxlen=HISTORY_MAX_LEN)
    load_history[tx_id].append((time.monotonic(), load))


def get_prediction(tx_id: str, current_load: float, max_capacity: float):
    history = load_history.get(tx_id, [])
    if len(history) < 3:
        return {"slope": 0.0, "ttf": None}
    
    t0 = history[0][0]
    n = len(history)
    sum_t = sum(t - t0 for t, _ in history)
    sum_y = sum(y for _, y in history)
    sum_ty = sum((t - t0) * y for t, y in history)
    sum_tt = sum((t - t0) * (t - t0) for t, _ in history)
    
    denominator = (n * sum_tt - sum_t * sum_t)
    if denominator == 0:
        return {"slope": 0.0, "ttf": None}
        
    slope = (n * sum_ty - sum_t * sum_y) / denominator
    
    ttf = None
    if slope > 0.5: # Only predict if load is rising > 0.5 kW/s
        if current_load < max_capacity:
            ttf = (max_capacity - current_load) / slope
        else:
            ttf = 0.0
            
    return {"slope": slope, "ttf": ttf}


def add_event(message: str, level: str = "info", source: str = "system"):
    now = datetime.now(timezone.utc)
    recent_events.appendleft({
        "id": str(uuid.uuid4()),
        "timestamp": now.isoformat(),
        "epoch_ms": int(now.timestamp() * 1000),
        "level": level,
        "source": source,
        "message": message
    })


def get_online_transformers(session):
    return session.run("""
        MATCH (t:Transformer)
        WHERE t.status = 'ONLINE'
        RETURN t.name AS id, t.current_load AS load, t.max_capacity AS max
    """).data()


def get_overloaded_nodes(session, fail_at_capacity: bool = False):
    comparator = ">=" if fail_at_capacity else ">"
    query = f"""
        MATCH (t:Transformer)
        WHERE t.status = 'ONLINE' AND t.current_load {comparator} t.max_capacity
        RETURN t.name AS id, t.current_load AS load, t.max_capacity AS max
    """
    return session.run(query).data()


def run_smart_intervention(
    session,
    include_overloaded: bool = False,
    trigger_source: str = "smart-mode",
    only_ids: Optional[Set[str]] = None,
):
    now_monotonic = time.monotonic()
    interventions = 0

    for tx in get_online_transformers(session):
        tx_id = tx["id"]
        if only_ids and tx_id not in only_ids:
            continue

        current_load = float(tx["load"])
        max_capacity = float(tx["max"])
        if max_capacity <= 0:
            continue

        utilization = current_load / max_capacity
        reduction_ratio = None
        reason = None

        pred = get_prediction(tx_id, current_load, max_capacity)
        ttf = pred["ttf"]

        last_shed = last_shed_times.get(tx_id, 0.0)
        cooldown_passed = (now_monotonic - last_shed) >= SMART_SHED_COOLDOWN_SECONDS

        if include_overloaded and utilization >= 1.0:
            reduction_ratio = EMERGENCY_SHED_REDUCTION_RATIO
            reason = "emergency"
        elif cooldown_passed and ttf is not None and ttf < PREDICTIVE_SHED_THRESHOLD_SECONDS:
            reduction_ratio = SHED_REDUCTION_RATIO
            reason = f"predictive (AI predicted failure in {ttf:.1f}s)"
        elif cooldown_passed and SHED_THRESHOLD_RATIO <= utilization < 1.0:
            reduction_ratio = SHED_REDUCTION_RATIO
            reason = "preventive"

        if reduction_ratio is None:
            continue

        reduced_load = round(current_load * reduction_ratio, 2)
        session.run("""
            MATCH (t:Transformer {name: $id})
            SET t.current_load = $new_load
        """, id=tx_id, new_load=reduced_load)

        last_shed_times[tx_id] = now_monotonic
        load_history[tx_id] = deque(maxlen=HISTORY_MAX_LEN) # Reset history after intervention
        record_load_history(tx_id, reduced_load)
        interventions += 1
        add_event(
            f"Smart Mode {reason} shedding on {tx_id}: {current_load:.2f} -> {reduced_load:.2f} kW",
            level="success",
            source=trigger_source,
        )

    return interventions


def run_cascade_algorithm(
    session,
    smart_mode_guard: bool = False,
    trigger_source: str = "cascade",
    fail_at_capacity: bool = False,
    aggressive_domino: bool = False,
):
    """Executes cascading failure logic until no overloaded ONLINE transformers remain."""
    global total_curtailed_kw
    while True:
        overloaded_nodes = get_overloaded_nodes(session, fail_at_capacity=fail_at_capacity)
        if not overloaded_nodes:
            break

        for node in overloaded_nodes:
            failing_id = node["id"]

            if smart_mode_guard:
                rescued = run_smart_intervention(
                    session,
                    include_overloaded=True,
                    trigger_source=trigger_source,
                    only_ids={failing_id},
                )
                if rescued > 0:
                    rescue_comparator = ">=" if fail_at_capacity else ">"
                    query = (
                        "MATCH (t:Transformer {name: $id}) "
                        f"RETURN t.current_load {rescue_comparator} t.max_capacity AS overloaded"
                    )
                    still_overloaded = session.run(query, id=failing_id).single()
                    if still_overloaded and not still_overloaded["overloaded"]:
                        add_event(
                            f"Smart Mode prevented shutdown of {failing_id}.",
                            level="success",
                            source="smart-mode",
                        )
                        continue

            failed_row = session.run("""
                MATCH (t:Transformer {name: $id})
                SET t.status = 'OFFLINE'
                RETURN t.current_load AS load
            """, id=failing_id).single()

            if not failed_row:
                continue

            orphaned_load = float(failed_row["load"])

            neighbors = session.run("""
                MATCH (t:Transformer {name: $id})-[:CONNECTED_TO]-(neighbor:Transformer)
                WHERE neighbor.status = 'ONLINE'
                RETURN neighbor.name AS id, neighbor.current_load AS load, neighbor.max_capacity AS max
            """, id=failing_id).data()

            if not neighbors:
                total_curtailed_kw += orphaned_load
                add_event(
                    f"{orphaned_load:.2f} kW curtailed after {failing_id} failed (no online neighbors).",
                    level="info",
                    source="cascade",
                )
                continue

            # --- FEATURE 4: Self-Healing Microgrid Islanding ---
            if len(neighbors) >= 2:
                n1 = neighbors[0]["id"]
                n2 = neighbors[1]["id"]
                already_connected = session.run("""
                    MATCH (a:Transformer {name: $n1})-[:CONNECTED_TO]-(b:Transformer {name: $n2})
                    RETURN a
                """, n1=n1, n2=n2).single()
                
                if not already_connected:
                    session.run("""
                        MATCH (a:Transformer {name: $n1}), (b:Transformer {name: $n2})
                        MERGE (a)-[:CONNECTED_TO]->(b)
                    """, n1=n1, n2=n2)
                    add_event(f"Self-Healing: Microgrid tie-line established between {n1} and {n2} to bypass {failing_id}.", level="success", source="system")
            # ---------------------------------------------------

            if aggressive_domino:
                split_load = orphaned_load / len(neighbors)
                for neighbor in neighbors:
                    session.run("""
                        MATCH (n:Transformer {name: $id})
                        SET n.current_load = n.current_load + $extra_load
                    """, id=neighbor["id"], extra_load=split_load)
                continue

            headrooms = []
            for neighbor in neighbors:
                headroom = max(0.0, float(neighbor["max"]) - float(neighbor["load"]))
                headrooms.append((neighbor["id"], headroom))

            total_headroom = sum(headroom for _, headroom in headrooms)
            if total_headroom <= 0:
                total_curtailed_kw += orphaned_load
                add_event(
                    f"{orphaned_load:.2f} kW curtailed after {failing_id} failed (neighbors full).",
                    level="info",
                    source="cascade",
                )
                continue

            distributed = 0.0
            for neighbor_id, headroom in headrooms:
                if headroom <= 0:
                    continue
                proposed = orphaned_load * (headroom / total_headroom)
                alloc = round(min(proposed, headroom), 2)
                if alloc <= 0:
                    continue

                session.run("""
                    MATCH (n:Transformer {name: $id})
                    SET n.current_load = n.current_load + $extra_load
                """, id=neighbor_id, extra_load=alloc)
                distributed += alloc

            curtailed = round(max(0.0, orphaned_load - distributed), 2)
            if curtailed > 0:
                total_curtailed_kw += curtailed
                add_event(
                    f"{curtailed:.2f} kW curtailed during redistribution from {failing_id}.",
                    level="info",
                    source="cascade",
                )


async def smart_mode_monitor_loop():
    while True:
        try:
            if smart_mode_enabled and db_manager.driver is not None:
                with db_manager.driver.session() as session:
                    changed = run_smart_intervention(
                        session,
                        include_overloaded=False,
                        trigger_source="smart-mode",
                    )
                    if changed > 0:
                        run_cascade_algorithm(
                            session,
                            smart_mode_guard=False,
                            trigger_source="smart-mode",
                        )
        except Exception as exc:
            logger.error(f"Smart Mode monitor loop error: {exc}")
            add_event(f"Smart Mode monitor error: {exc}", level="error", source="smart-mode")
        await asyncio.sleep(SMART_MONITOR_INTERVAL_SECONDS)


# ==========================================
# Core Endpoints
# ==========================================
@app.post("/api/seed-grid", status_code=status.HTTP_201_CREATED)
async def seed_grid():
    """Wipes the database and seeds a new 5-node transformer ring topology."""
    global total_curtailed_kw
    total_curtailed_kw = 0.0
    ensure_db_or_503()
    clear_query = "MATCH (n) DETACH DELETE n"
    seed_query = """
    CREATE
            (a:Transformer {name: 'TX-A', max_capacity: 100.0, base_capacity: 100.0, current_load: 40.0, status: 'ONLINE', lat: 11.0168, lon: 76.9558}),
            (b:Transformer {name: 'TX-B', max_capacity: 250.0, base_capacity: 250.0, current_load: 40.0, status: 'ONLINE', lat: 11.0200, lon: 76.9500}),
            (c:Transformer {name: 'TX-C', max_capacity: 100.0, base_capacity: 100.0, current_load: 40.0, status: 'ONLINE', lat: 11.0250, lon: 76.9600}),
            (d:Transformer {name: 'TX-D', max_capacity: 100.0, base_capacity: 100.0, current_load: 40.0, status: 'ONLINE', lat: 11.0100, lon: 76.9650}),
            (e:Transformer {name: 'TX-E', max_capacity: 100.0, base_capacity: 100.0, current_load: 40.0, status: 'ONLINE', lat: 11.0120, lon: 76.9500}),
      (a)-[:CONNECTED_TO]->(b),
      (b)-[:CONNECTED_TO]->(c),
      (c)-[:CONNECTED_TO]->(d),
      (d)-[:CONNECTED_TO]->(e),
      (e)-[:CONNECTED_TO]->(a)
    """
    try:
        db_manager.execute_transaction([{"query": clear_query}, {"query": seed_query}])
        load_history.clear() # Clear AI memory on reset
        add_event("Grid topology seeded (5-node ring).", level="success", source="manual")
        return {"message": "Grid seeded successfully. 5 Transformers created in a ring topology."}
    except Exception as e:
        add_event(f"Grid seeding failed: {e}", level="error", source="manual")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/grid-state")
def get_grid_state():
    """Fetches the current state of the grid for the React/Cytoscape frontend."""
    ensure_db_or_503()
    with db_manager.driver.session() as session:
        # Get all transformers (Mapped to 'name' property based on your seed query)
        node_result = session.run("""
            MATCH (n:Transformer) 
            RETURN
                n.name AS id,
                coalesce(n.status, 'OFFLINE') AS status,
                coalesce(toFloat(n.current_load), 0.0) AS load,
                coalesce(toFloat(n.max_capacity), 0.0) AS max,
                coalesce(toFloat(n.lat), 0.0) AS lat,
                coalesce(toFloat(n.lon), 0.0) AS lon
        """)
        nodes = []
        for record in node_result:
            tx_id = record.get("id") or "UNKNOWN"
            load = float(record.get("load") or 0.0)
            max_capacity = float(record.get("max") or 0.0)
            lat = float(record.get("lat") or 0.0)
            lon = float(record.get("lon") or 0.0)
            
            pred = get_prediction(tx_id, load, max_capacity)

            nodes.append({
                "data": {
                    "id": tx_id,
                    "label": tx_id,
                    "status": record.get("status") or "OFFLINE",
                    "load": round(load, 2),
                    "max": max_capacity,
                    "ttf": round(pred["ttf"], 1) if pred["ttf"] is not None else None,
                    "slope": round(pred["slope"], 3),
                    "lat": lat,
                    "lon": lon
                }
            })

        # Get all connections
        edge_result = session.run("""
            MATCH (a:Transformer)-[:CONNECTED_TO]->(b:Transformer) 
            RETURN a.name AS source, b.name AS target
        """)
        edges = [
            {"data": {"source": record["source"], "target": record["target"]}} 
            for record in edge_result
        ]
        
        total_load = sum([node["data"]["load"] for node in nodes])
        total_max = sum([node["data"]["max"] for node in nodes])
        
        # Assume $0.15 per kW economic cost of curtailed power
        economic_loss = round(total_curtailed_kw * 0.15, 2)

    return {
        "elements": {"nodes": nodes, "edges": edges},
        "metrics": {
            "total_load": round(total_load, 2),
            "total_capacity": round(total_max, 2),
            "total_curtailed_kw": round(total_curtailed_kw, 2),
            "economic_loss": economic_loss
        }
    }


@app.post("/api/add-transformer")
def add_transformer(req: AddTransformerRequest):
    """Dynamically adds a new transformer to the grid and connects it to an existing one."""
    ensure_db_or_503()
    try:
        with db_manager.driver.session() as session:
            # Check if name already exists
            existing = session.run("MATCH (t:Transformer {name: $name}) RETURN t", name=req.name).single()
            if existing:
                raise HTTPException(status_code=400, detail="Transformer name already exists.")
            
            # Check if parent exists only if connect_to is provided
            if req.connect_to:
                parent = session.run("MATCH (t:Transformer {name: $parent}) RETURN t", parent=req.connect_to).single()
                if not parent:
                    raise HTTPException(status_code=404, detail="Target connection transformer not found.")

            # Create node
            session.run("""
                CREATE (t:Transformer {
                    name: $name, 
                    max_capacity: $cap, 
                    base_capacity: $cap, 
                    current_load: 0.0, 
                    status: 'ONLINE', 
                    lat: $lat, 
                    lon: $lon
                })
            """, name=req.name, cap=req.max_capacity, lat=req.lat, lon=req.lon)
            
            # Create edge if connect_to provided
            if req.connect_to:
                session.run("""
                    MATCH (parent:Transformer {name: $parent}), (t:Transformer {name: $name})
                    MERGE (t)-[:CONNECTED_TO]-(parent)
                """, parent=req.connect_to, name=req.name)
                add_event(f"Grid Expansion: {req.name} deployed and connected to {req.connect_to}.", level="success", source="manual")
            else:
                add_event(f"Grid Expansion: {req.name} deployed as a standalone microgrid.", level="success", source="manual")
                
            return {"message": f"Transformer {req.name} added successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/connect-transformers")
def connect_transformers(req: ConnectTransformersRequest):
    """Links two existing standalone transformers together."""
    ensure_db_or_503()
    try:
        with db_manager.driver.session() as session:
            # Check if both exist
            nodes = session.run("MATCH (t:Transformer) WHERE t.name IN [$src, $tgt] RETURN t.name AS name", src=req.source_id, tgt=req.target_id).data()
            if len(nodes) < 2:
                raise HTTPException(status_code=404, detail="One or both transformers not found.")
            
            session.run("""
                MATCH (a:Transformer {name: $src}), (b:Transformer {name: $tgt})
                MERGE (a)-[:CONNECTED_TO]-(b)
            """, src=req.source_id, tgt=req.target_id)
            
            add_event(f"Grid Link: Established physical tie-line between {req.source_id} and {req.target_id}.", level="success", source="manual")
            return {"message": "Transformers linked successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/delete-transformer/{transformer_id}")
def delete_transformer(transformer_id: str):
    """Deletes a transformer and all its connections from the grid."""
    ensure_db_or_503()
    try:
        with db_manager.driver.session() as session:
            existing = session.run("MATCH (t:Transformer {name: $id}) RETURN t", id=transformer_id).single()
            if not existing:
                raise HTTPException(status_code=404, detail="Transformer not found.")
            
            session.run("MATCH (t:Transformer {name: $id}) DETACH DELETE t", id=transformer_id)
            
            add_event(f"Grid Deletion: {transformer_id} was removed from the topology.", level="info", source="manual")
            return {"message": f"Transformer {transformer_id} deleted."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/control-power")
def control_power(payload: TelemetryPayload):
    """Sets transformer loads directly from the control panel and runs cascade checks."""
    ensure_db_or_503()
    with db_manager.driver.session() as session:
        for item in payload.data:
            session.run("""
                MATCH (t:Transformer {name: $id})
                SET t.current_load = $load
                SET t.status = CASE
                    WHEN $load <= t.max_capacity THEN 'ONLINE'
                    ELSE t.status
                END
            """, id=item.transformer_id, load=item.load_kw)
            record_load_history(item.transformer_id, item.load_kw)

        intervention_count = 0
        if smart_mode_enabled:
            for _ in range(MAX_SMART_INTERVENTION_ROUNDS):
                changed = run_smart_intervention(
                    session,
                    include_overloaded=True,
                    trigger_source="manual",
                )
                intervention_count += changed
                if changed == 0:
                    break

        run_cascade_algorithm(
            session,
            smart_mode_guard=smart_mode_enabled,
            trigger_source="manual",
        )

    add_event("Manual power controls applied.", level="success", source="manual")

    return {
        "message": "Power controls applied and cascade logic evaluated.",
        "smart_mode_applied": smart_mode_enabled,
        "interventions": intervention_count,
    }


@app.post("/api/trigger-domino")
def trigger_domino(spike: SpikeRequest):
    """Injects a load spike for a specific transformer and executes cascade logic."""
    ensure_db_or_503()
    with db_manager.driver.session() as session:
        existing = session.run(
            "MATCH (t:Transformer {name: $id}) RETURN t.name AS id",
            id=spike.target_name
        ).single()

        if not existing:
            raise HTTPException(status_code=404, detail=f"Transformer '{spike.target_name}' not found")

        new_row = session.run("""
            MATCH (t:Transformer {name: $id})
            SET t.current_load = t.current_load + $added_load
            RETURN t.current_load AS new_load
        """, id=spike.target_name, added_load=spike.added_load).single()
        if new_row:
            record_load_history(spike.target_name, float(new_row["new_load"]))

        if smart_mode_enabled:
            for _ in range(MAX_SMART_INTERVENTION_ROUNDS):
                changed = run_smart_intervention(
                    session,
                    include_overloaded=True,
                    trigger_source="manual",
                )
                if changed == 0:
                    break

        run_cascade_algorithm(
            session,
            smart_mode_guard=smart_mode_enabled,
            trigger_source="manual",
            fail_at_capacity=True,
            aggressive_domino=True,
        )

    add_event(
        f"Domino event triggered on {spike.target_name} (+{spike.added_load} kW).",
        level="success",
        source="manual"
    )

    return {
        "message": f"Domino event triggered on {spike.target_name} (+{spike.added_load} kW)."
    }

@app.post("/api/telemetry")
def process_telemetry(payload: TelemetryPayload):
    """The Cascade Engine: Receives EV spikes, updates loads, and recursively calculates cascading failures."""
    ensure_db_or_503()
    with db_manager.driver.session() as session:
        for item in payload.data:
            session.run("""
                MATCH (t:Transformer {name: $id}) 
                SET t.current_load = $load
            """, id=item.transformer_id, load=item.load_kw)
            record_load_history(item.transformer_id, item.load_kw)

        if smart_mode_enabled:
            for _ in range(MAX_SMART_INTERVENTION_ROUNDS):
                changed = run_smart_intervention(
                    session,
                    include_overloaded=True,
                    trigger_source="smart-mode",
                )
                if changed == 0:
                    break

        # STEP 2: Domino-effect cascade evaluation
        run_cascade_algorithm(
            session,
            smart_mode_guard=smart_mode_enabled,
            trigger_source="smart-mode",
        )

    return {"message": "Telemetry processed. Cascade algorithms executed."}


@app.get("/api/simulator/status")
def get_simulator_status():
    global simulator_process
    running = simulator_process is not None and simulator_process.poll() is None
    return {
        "running": running,
        "pid": simulator_process.pid if running else None
    }


@app.post("/api/simulator/start")
def start_simulator():
    global simulator_process

    if not SIMULATOR_SCRIPT.exists():
        raise HTTPException(status_code=404, detail="simulator.py not found")

    if simulator_process is not None and simulator_process.poll() is None:
        add_event("Simulator start requested but it is already running.", level="info", source="simulator")
        return {
            "message": "Simulator is already running.",
            "pid": simulator_process.pid
        }

    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    try:
        simulator_process = subprocess.Popen(
            ["python", str(SIMULATOR_SCRIPT)],
            cwd=str(BASE_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags
        )
    except Exception as exc:
        add_event(f"Simulator failed to start: {exc}", level="error", source="simulator")
        raise HTTPException(status_code=500, detail=f"Failed to start simulator: {exc}")

    add_event("Simulator started.", level="success", source="simulator")

    return {
        "message": "Simulator started successfully.",
        "pid": simulator_process.pid
    }


@app.post("/api/simulator/stop")
def stop_simulator():
    global simulator_process

    if simulator_process is None or simulator_process.poll() is not None:
        simulator_process = None
        add_event("Simulator stop requested but it was not running.", level="info", source="simulator")
        return {"message": "Simulator is not running."}

    try:
        simulator_process.terminate()
        simulator_process.wait(timeout=5)
    except Exception:
        simulator_process.kill()
    finally:
        simulator_process = None

    add_event("Simulator stopped.", level="success", source="simulator")

    return {"message": "Simulator stopped."}


@app.get("/api/smart-mode")
def get_smart_mode_status():
    return {
        "enabled": smart_mode_enabled,
        "threshold_ratio": SHED_THRESHOLD_RATIO,
        "reduction_percent": int((1 - SHED_REDUCTION_RATIO) * 100),
        "cooldown_seconds": SMART_SHED_COOLDOWN_SECONDS
    }


@app.post("/api/smart-mode")
def set_smart_mode(payload: SmartModeRequest):
    global smart_mode_enabled

    smart_mode_enabled = payload.enabled
    add_event(
        f"Smart Mode turned {'ON' if smart_mode_enabled else 'OFF'}.",
        level="success",
        source="manual"
    )

    return {
        "enabled": smart_mode_enabled,
        "message": f"Smart Mode {'enabled' if smart_mode_enabled else 'disabled'}."
    }


@app.get("/api/events")
def get_events(limit: int = Query(default=100, ge=1, le=250)):
    events = list(recent_events)[:limit]
    return {"events": events}


@app.post("/api/events/clear")
def clear_events():
    recent_events.clear()
    add_event("Event log cleared from dashboard.", level="info", source="manual")
    return {"message": "Event log cleared."}

@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "Smart Infrastructure API",
        "neo4j_connected": db_manager.is_connected()
    }

import urllib.request
import json

@app.post("/api/weather-stress")
def trigger_weather_stress(req: WeatherRequest):
    """Fetches real weather and dynamically stresses the grid based on temperature."""
    ensure_db_or_503()
    
    if req.temperature is not None:
        temp = req.temperature
    else:
        if req.lat is None or req.lon is None:
            raise HTTPException(status_code=400, detail="Must provide either temperature or both lat and lon.")
        url = f"https://api.open-meteo.com/v1/forecast?latitude={req.lat}&longitude={req.lon}&current_weather=true"
        try:
            req_obj = urllib.request.Request(url, headers={'User-Agent': 'SmartGridSim/1.0'})
            with urllib.request.urlopen(req_obj) as response:
                data = json.loads(response.read().decode('utf-8'))
                temp = data["current_weather"]["temperature"]
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to fetch weather: {e}")

    with db_manager.driver.session() as session:
        # Ensure base_capacity exists for backward compatibility
        session.run("MATCH (t:Transformer) WHERE t.base_capacity IS NULL SET t.base_capacity = t.max_capacity")
        
        if temp >= 30.0:
            # Dynamic scaling: Reduce capacity by 2.5% for every degree above 25°C, capped at 80% reduction
            reduction_factor = min(0.80, (temp - 25.0) * 0.025)
            new_capacity_multiplier = round(1.0 - reduction_factor, 3)
            reduction_percent = int(reduction_factor * 100)
            
            session.run("MATCH (t:Transformer) SET t.max_capacity = t.base_capacity * $mult", mult=new_capacity_multiplier)
            add_event(f"Extreme Heat in {req.city} ({temp}°C). Grid capacities reduced by {reduction_percent}%.", level="error", source="weather")
            
        elif temp <= 15.0:
            # Dynamic scaling: Surge load by 4% for every degree below 15°C, capped at 150% surge
            surge_factor = min(1.50, (15.0 - temp) * 0.04)
            new_load_multiplier = round(1.0 + surge_factor, 3)
            surge_percent = int(surge_factor * 100)
            
            session.run(
                "MATCH (t:Transformer) SET t.max_capacity = t.base_capacity, t.current_load = t.current_load * $mult",
                mult=new_load_multiplier
            )
            add_event(f"Cold Snap in {req.city} ({temp}°C). Baseline loads surged by {surge_percent}%.", level="warning", source="weather")
            
        else:
            session.run("MATCH (t:Transformer) SET t.max_capacity = t.base_capacity")
            add_event(f"Mild weather in {req.city} ({temp}°C). Grid operating normally.", level="info", source="weather")

        if smart_mode_enabled:
            for _ in range(MAX_SMART_INTERVENTION_ROUNDS):
                changed = run_smart_intervention(session, include_overloaded=True, trigger_source="weather")
                if changed == 0: break
        run_cascade_algorithm(session, smart_mode_guard=smart_mode_enabled, trigger_source="weather")

    return {"message": "Weather stress applied", "temperature": temp}