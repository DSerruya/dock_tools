import time
import datetime

print("Python example script started", flush=True)

while True:
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] Hello from Python — version 1.0", flush=True)
    time.sleep(10)
