import os
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase, exceptions
from dotenv import load_dotenv
from pydantic import BaseModel
from typing import List

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
        except exceptions.Neo4jError as e:
            logger.error(f"Failed to connect to Neo4j: {e}")
            raise e

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

# ==========================================
# FastAPI Application & Lifecycle Setup
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        db_manager.connect()
    except Exception as e:
        logger.critical(f"Could not establish database connection on startup: {e}")
    yield 
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


# ==========================================
# Core Endpoints
# ==========================================
@app.post("/api/seed-grid", status_code=status.HTTP_201_CREATED)
async def seed_grid():
    """Wipes the database and seeds a new 5-node transformer ring topology."""
    clear_query = "MATCH (n) DETACH DELETE n"
    seed_query = """
    CREATE
      (a:Transformer {name: 'TX-A', max_capacity: 100.0, current_load: 40.0, status: 'ONLINE'}),
      (b:Transformer {name: 'TX-B', max_capacity: 100.0, current_load: 40.0, status: 'ONLINE'}),
      (c:Transformer {name: 'TX-C', max_capacity: 100.0, current_load: 40.0, status: 'ONLINE'}),
      (d:Transformer {name: 'TX-D', max_capacity: 100.0, current_load: 40.0, status: 'ONLINE'}),
      (e:Transformer {name: 'TX-E', max_capacity: 100.0, current_load: 40.0, status: 'ONLINE'}),
      (a)-[:CONNECTED_TO]->(b),
      (b)-[:CONNECTED_TO]->(c),
      (c)-[:CONNECTED_TO]->(d),
      (d)-[:CONNECTED_TO]->(e),
      (e)-[:CONNECTED_TO]->(a)
    """
    try:
        db_manager.execute_transaction([{"query": clear_query}, {"query": seed_query}])
        return {"message": "Grid seeded successfully. 5 Transformers created in a ring topology."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/grid-state")
def get_grid_state():
    """Fetches the current state of the grid for the React/Cytoscape frontend."""
    with db_manager.driver.session() as session:
        # Get all transformers (Mapped to 'name' property based on your seed query)
        node_result = session.run("""
            MATCH (n:Transformer) 
            RETURN n.name AS id, n.status AS status, n.current_load AS load, n.max_capacity AS max
        """)
        nodes = [
            {"data": {"id": record["id"], "label": record["id"], "status": record["status"], "load": round(record["load"], 2), "max": record["max"]}} 
            for record in node_result
        ]

        # Get all connections
        edge_result = session.run("""
            MATCH (a:Transformer)-[:CONNECTED_TO]->(b:Transformer) 
            RETURN a.name AS source, b.name AS target
        """)
        edges = [
            {"data": {"source": record["source"], "target": record["target"]}} 
            for record in edge_result
        ]

    return {"elements": {"nodes": nodes, "edges": edges}}

@app.post("/api/telemetry")
def process_telemetry(payload: TelemetryPayload):
    """The Cascade Engine: Receives EV spikes, updates loads, and recursively calculates cascading failures."""
    with db_manager.driver.session() as session:
        # STEP 1: Apply incoming loads
        for item in payload.data:
            session.run("""
                MATCH (t:Transformer {name: $id}) 
                SET t.current_load = $load
            """, id=item.transformer_id, load=item.load_kw)

        # STEP 2: The Domino Effect Loop
        cascade_in_progress = True
        
        while cascade_in_progress:
            # Find any ONLINE transformer currently overloaded
            overloaded_nodes = session.run("""
                MATCH (t:Transformer) 
                WHERE t.status = 'ONLINE' AND t.current_load > t.max_capacity 
                RETURN t.name AS id, t.current_load AS load
            """).data()

            # If grid stabilized, break loop
            if len(overloaded_nodes) == 0:
                cascade_in_progress = False
                break

            for node in overloaded_nodes:
                failing_id = node['id']
                orphaned_load = node['load']

                # 1. Kill the overloaded transformer
                session.run("MATCH (t:Transformer {name: $id}) SET t.status = 'OFFLINE'", id=failing_id)

                # 2. Find surviving neighbors
                surviving_neighbors = session.run("""
                    MATCH (t:Transformer {name: $id})-[:CONNECTED_TO]-(neighbor:Transformer) 
                    WHERE neighbor.status = 'ONLINE' 
                    RETURN neighbor.name AS id
                """, id=failing_id).data()

                # 3. Shift the load
                if surviving_neighbors:
                    split_load = orphaned_load / len(surviving_neighbors)
                    for neighbor in surviving_neighbors:
                        session.run("""
                            MATCH (n:Transformer {name: $id}) 
                            SET n.current_load = n.current_load + $extra_load
                        """, id=neighbor['id'], extra_load=split_load)

    return {"message": "Telemetry processed. Cascade algorithms executed."}

@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "service": "Smart Infrastructure API"}