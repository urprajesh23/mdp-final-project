from neo4j import GraphDatabase

# Hardcoding these just for the test to bypass .env parsing issues
URI = "neo4j+ssc://181bdb7a.databases.neo4j.io"
USERNAME = "181bdb7a"
PASSWORD = "FQnKDAbcTZJedvLXwiRrdSqDOvjCB4ApSuDdQzn5i_A" 

print("Attempting to connect to Neo4j...")

try:
    # Attempt to create a driver and verify connectivity
    driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))
    driver.verify_connectivity()
    print("✅ SUCCESS: Connected to Neo4j Aura successfully!")
    driver.close()
except Exception as e:
    print(f"❌ FAILED to connect. Error details:\n{e}")