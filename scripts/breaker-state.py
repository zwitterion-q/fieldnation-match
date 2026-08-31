#!/usr/bin/env python3
"""Print the circuit breaker's current state in one line. Used by breaker-drill.sh."""
import json, sys, urllib.request
try:
    with urllib.request.urlopen("http://localhost:55173/wo/strangler/status", timeout=5) as r:
        d = json.loads(r.read())
except Exception as e:
    print(f"unreachable ({e})"); sys.exit(0)
b = d.get("resilience", {}).get("breaker", {})
if not b:
    print("no breaker in /strangler/status"); sys.exit(0)
state = b.get("state", "?")
colour = {"closed": "\033[32m", "half_open": "\033[33m", "open": "\033[31m"}.get(state, "")
print(f"{colour}{state:<10}\033[0m "
      f"calls={b.get('calls', 0):<4} "
      f"failures={b.get('failures', 0):<3} "
      f"short_circuited={b.get('short_circuited', 0):<3} "
      f"consecutive={b.get('consecutive_failures', 0)}")
