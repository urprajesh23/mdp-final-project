import traceback
from main import app, db_manager, SpikeRequest, trigger_domino
from neo4j import GraphDatabase

def test():
    try:
        db_manager.driver = GraphDatabase.driver(db_manager.uri, auth=(db_manager.user, db_manager.password))
        req = SpikeRequest(target_name='TX-A', added_load=300)
        res = trigger_domino(req)
        print("Success:", res)
    except Exception as e:
        print("Exception caught!")
        traceback.print_exc()

if __name__ == "__main__":
    test()
