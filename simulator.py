import time
import requests
import random

# The URL of your local FastAPI server
API_URL = "http://127.0.0.1:8000/api/telemetry"

def send_telemetry(iteration):
    # 1. Generate normal baseline power loads (fluctuating safely around 40-60 kW)
    payload = {
        "data": [
            {"transformer_id": "TX-A", "load_kw": round(random.uniform(40.0, 60.0), 2)},
            {"transformer_id": "TX-B", "load_kw": round(random.uniform(40.0, 60.0), 2)},
            {"transformer_id": "TX-C", "load_kw": round(random.uniform(40.0, 60.0), 2)},
            {"transformer_id": "TX-D", "load_kw": round(random.uniform(40.0, 60.0), 2)},
            {"transformer_id": "TX-E", "load_kw": round(random.uniform(40.0, 60.0), 2)}
        ]
    }

    # 2. THE EVENT: Simulate a massive EV charging spike on iteration 5!
    if iteration >= 5:
        print("\n🚨 [WARNING] 6:00 PM Reached! Massive EV charging spike on TX-A detected (120 kW)!")
        payload["data"][0]["load_kw"] = 120.0  # Pushes TX-A over its 100.0 limit

    # 3. Send the JSON payload to the FastAPI backend
    try:
        response = requests.post(API_URL, json=payload)
        if response.status_code == 200:
            print(f"Iteration {iteration}: IoT Telemetry sent successfully.")
        else:
            print(f"Iteration {iteration}: Failed. Server returned {response.status_code}")
    except Exception as e:
        print(f"❌ Error connecting to server. Is your Uvicorn server running? Details: {e}")

if __name__ == "__main__":
    print("⚡ Starting Smart Grid IoT Simulator...")
    print("Sending baseline telemetry every 3 seconds. The spike will trigger at Iteration 5.\n")
    
    iteration = 1
    try:
        # Create an infinite loop that pings the server every 3 seconds
        while True:
            send_telemetry(iteration)
            iteration += 1
            time.sleep(3) 
    except KeyboardInterrupt:
        print("\n🛑 Simulator stopped manually.")