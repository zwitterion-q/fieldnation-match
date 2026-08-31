#!/usr/bin/env python3
"""Print the live host port for every running service.

`work-orders` and `payments` publish port RANGES so they can scale past one
replica -- and Docker picks freely within the range. A port that was 58013 on
Monday can be 58015 on Tuesday, so anything with a hardcoded service port is a
demo waiting to fail as connection-refused rather than as the answer you meant
to show. Read the live value from here instead.
"""
import re, subprocess, sys

out = subprocess.run(
    ["docker", "compose", "ps", "--format", "{{.Service}}|{{.Publishers}}"],
    capture_output=True, text=True).stdout

rows = []
for line in out.splitlines():
    if "|" not in line:
        continue
    name, pub = line.split("|", 1)
    # {0.0.0.0 8000 58000 tcp} -> container port 8000, host port 58000
    ports = sorted({int(h) for _, h in re.findall(r"\{\S+ (\d+) (\d+) tcp\}", pub)})
    if ports:
        rows.append((name, ", ".join(str(p) for p in ports)))

if not rows:
    print("  nothing running — `make up` first")
    sys.exit(0)

print(f"\n  {'SERVICE':<18}HOST PORT")
for name, ports in sorted(rows):
    print(f"  {name:<18}{ports}")
print("""
  Stable regardless of the above — both consoles proxy every service,
  which is what the frontends themselves use:

    http://localhost:55173/api/*   matching
    http://localhost:55173/id/*    identity
    http://localhost:55173/wo/*    work-orders
    http://localhost:55173/pay/*   payments
""")
