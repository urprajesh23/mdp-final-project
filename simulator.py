import time
import urllib.request
import json
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

    # 2. THE EVENT: Simulate a gradual EV charging spike starting at iteration 5!
    if iteration >= 5:
        # Gradually ramp up load by 8kW per iteration to let the Predictive AI catch the trend
        spike = min(120.0, 50.0 + (iteration - 4) * 8.0)
        print(f"\n[WARNING] EV charging spike ramping up on TX-A! Current: {spike:.1f} kW")
        payload["data"][0]["load_kw"] = round(spike, 2)

    # 3. Send the JSON payload to the FastAPI backend
    try:
        req = urllib.request.Request(API_URL, method="POST")
        req.add_header("Content-Type", "application/json")
        data = json.dumps(payload).encode("utf-8")
        
        with urllib.request.urlopen(req, data=data) as response:
            if response.status == 200:
                print(f"Iteration {iteration}: IoT Telemetry sent successfully.")
            else:
                print(f"Iteration {iteration}: Failed. Server returned {response.status}")
    except Exception as e:
        print(f"[ERROR] Error connecting to server. Is your Uvicorn server running? Details: {e}")

if __name__ == "__main__":
    print("Starting Smart Grid IoT Simulator...")
    print("Sending baseline telemetry every 3 seconds. The spike will trigger at Iteration 5.\n")
    
    iteration = 1
    try:
        # Create an infinite loop that pings the server every 3 seconds
        while True:
            send_telemetry(iteration)
            iteration += 1
            time.sleep(3) 
    except KeyboardInterrupt:
        print("\nSimulator stopped manually.")