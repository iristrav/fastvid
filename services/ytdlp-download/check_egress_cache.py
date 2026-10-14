"""Run with the service requirements installed:  python check_egress_cache.py

VIDEO 656 — /health/egress answers at once with the last measured verdict. The pipeline asks with a
3 s budget and a live probe through the proxy takes 5–25 s, so every render-time ask used to come
back `no_answer`. The probe is replaced by a slow stand-in; nothing touches YouTube.
"""
import os, sys, time, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["SERVICE_TOKEN"] = ""
os.environ["EGRESS_FRESH_SEC"] = "1"
import main
from fastapi.testclient import TestClient

probes = []
verdict = {"ok": True}

def slow_probe():
    probes.append(time.monotonic())
    time.sleep(2.0)
    result = {"ok": verdict["ok"], "reason": None if verdict["ok"] else "bot_check"}
    main._last_egress = result
    main._last_egress_at = time.monotonic()
    return result

main._probe_egress = slow_probe
main._probe_on_boot = lambda: None
main.EGRESS_FRESH_SEC = 1.0
c = TestClient(main.app)

# 1. Nothing measured yet: the first ask waits for a live probe (there is nothing else to say).
t = time.monotonic(); r = c.get("/health/egress"); took = time.monotonic() - t
assert r.status_code == 200 and r.json()["ok"] is True, r.text
assert took >= 1.9, took
assert len(probes) == 1

# 2. A fresh answer comes back at once, with its age, and starts no probe.
t = time.monotonic(); r = c.get("/health/egress"); took = time.monotonic() - t
assert took < 0.5, f"a fresh answer must not wait: {took:.2f}s"
assert "ageSec" in r.json() and r.json()["ageSec"] < 1.0, r.json()
assert len(probes) == 1

# 3. A stale answer still comes back at once; one background probe starts, not one per ask.
time.sleep(1.2)
verdict["ok"] = False
asks = []
def ask():
    s = time.monotonic(); resp = c.get("/health/egress"); asks.append((time.monotonic() - s, resp))
threads = [threading.Thread(target=ask) for _ in range(5)]
[th.start() for th in threads]; [th.join() for th in threads]
assert all(took < 0.5 for took, _ in asks), [round(took, 2) for took, _ in asks]
assert all(resp.json()["ok"] is True for _, resp in asks), "the last measured answer, until the new one is in"
time.sleep(0.2)
assert len(probes) == 2, f"one background refresh for five stale asks, got {len(probes) - 1}"

# 4. Once the background probe is in, its verdict is what the next ask hears — 503 for blocked.
time.sleep(2.2)
r = c.get("/health/egress")
assert r.status_code == 503 and r.json()["ok"] is False and r.json()["reason"] == "bot_check", r.text

print("check_egress_cache: OK")
