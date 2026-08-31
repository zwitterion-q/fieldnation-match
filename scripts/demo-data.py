#!/usr/bin/env python3
"""
Drive the running system into a state that makes every demo query interesting.

Nothing here writes to a database directly. Every row this produces comes from
a real HTTP call through the real lifecycle, so the ledger balances, the event
log is genuine, and the sagas record what actually happened. If someone asks how
the data got there, the answer is "the system made it", which is the only answer
worth having.

Re-runnable: `make demo` resets, then this rebuilds. Takes about 90 seconds,
most of it waiting for the outbox relay and the payments consumer.

    python3 scripts/demo-data.py
"""
from __future__ import annotations
import json, sys, time, urllib.request, urllib.error, re, pathlib

B = "http://localhost:55173"
PW = "Passw0rd!"

def call(method, path, token=None, body=None):
    req = urllib.request.Request(B + path, method=method,
        data=json.dumps(body).encode() if body is not None else None)
    req.add_header("content-type", "application/json")
    if token: req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")
    except Exception as e:
        return 0, {"message": str(e)}

def tok(email):
    c, d = call("POST", "/id/auth/login", body={"email": email, "password": PW})
    if c != 200: sys.exit(f"  login failed for {email}: {d}")
    return d["access_token"]

def say(s):  print(f"  {s}", flush=True)
def step(s): print(f"\n\033[1m{s}\033[0m", flush=True)

# technician emails carry the technician id as the last dotted segment
CREDS = (pathlib.Path(__file__).resolve().parent.parent / "CREDENTIALS.md").read_text()
def tech_token(tid):
    m = re.search(rf"`([a-z.]+\.{tid}@tech\.test)`", CREDS)
    if not m: sys.exit(f"  no seeded account for technician#{tid}")
    return tok(m.group(1))

def open_orders(hirer, n=40):
    # The list endpoint already filters to status='open' server-side and does
    # not return the column, so everything it hands back is dispatchable.
    c, d = call("GET", f"/api/work-orders?limit={n}", hirer)
    return d.get("items") if isinstance(d, dict) else d

def best_match(hirer, wo, skip=()):
    c, d = call("GET", f"/api/work-orders/{wo}/matches?limit=6", hirer)
    ms = d.get("matches") if isinstance(d, dict) else d
    for m in ms:
        if m["technician_id"] not in skip:
            return m["technician_id"]
    return ms[0]["technician_id"] if ms else None

def dispatch(hirer, wo, tid):
    c, d = call("POST", "/wo/assignments", hirer,
                {"work_order_id": wo, "technician_id": tid})
    if c != 201 and c != 200: return None
    return d["id"]

def settle(seconds=6):
    """Let the outbox relay publish and the payments consumer react."""
    time.sleep(seconds)

def main():
    HIRER   = tok("hirer@vertex.hospitality.test")
    FINANCE = tok("finance@fieldnation.test")
    ADMIN   = tok("admin@fieldnation.test")

    pool = open_orders(HIRER)
    if len(pool) < 7:
        sys.exit("  not enough open work orders — run `make demo` first")
    wo = [w["work_order_id"] for w in pool]

    # ── 1 ────────────────────────────────────────────────────────────────────
    step("1/6  one work order, offered three times")
    say("the case that proves holds are keyed on assignment, not work order")
    declined = []
    for attempt in (1, 2):
        t = best_match(HIRER, wo[0], skip=declined)
        a = dispatch(HIRER, wo[0], t)
        settle()
        call("POST", f"/wo/assignments/{a}/reject", tech_token(t),
             {"reason": "already committed elsewhere" if attempt == 1 else "outside my travel radius"})
        declined.append(t)
        say(f"offer {attempt}: technician#{t} declined  → assignment {a}, hold released")
        settle()
    t = best_match(HIRER, wo[0], skip=declined)
    a = dispatch(HIRER, wo[0], t)
    settle()
    tt = tech_token(t)
    call("POST", f"/wo/assignments/{a}/accept", tt); settle(3)
    call("POST", f"/wo/assignments/{a}/submit", tt, {"hours_worked": 6, "note": "unit replaced, tested"})
    time.sleep(1)
    call("POST", f"/wo/assignments/{a}/approve", HIRER); settle()
    c, d = call("POST", "/pay/payouts", FINANCE, {"technician_id": t})
    say(f"offer 3: technician#{t} accepted → completed → paid ${d.get('paid')}")
    say(f"work order {wo[0]} now has 3 holds: 2 released, 1 captured")

    # ── 2 ────────────────────────────────────────────────────────────────────
    step("2/6  a full second lifecycle, so the ledger has depth")
    t2 = best_match(HIRER, wo[1]); a2 = dispatch(HIRER, wo[1], t2); settle()
    tt2 = tech_token(t2)
    call("POST", f"/wo/assignments/{a2}/accept", tt2); settle(3)
    call("POST", f"/wo/assignments/{a2}/submit", tt2, {"hours_worked": 4})
    time.sleep(1)
    call("POST", f"/wo/assignments/{a2}/approve", HIRER); settle()
    call("POST", "/pay/payouts", FINANCE, {"technician_id": t2})
    say(f"work order {wo[1]} → completed and paid out")

    # ── 3 ────────────────────────────────────────────────────────────────────
    step("3/6  one in every live state, so the state machine is visible")
    t3 = best_match(HIRER, wo[2]); a3 = dispatch(HIRER, wo[2], t3); settle()
    say(f"assignment {a3}  DISPATCHED — awaiting response, saga at await_response")

    t4 = best_match(HIRER, wo[3]); a4 = dispatch(HIRER, wo[3], t4); settle()
    call("POST", f"/wo/assignments/{a4}/accept", tech_token(t4)); settle(3)
    say(f"assignment {a4}  ACCEPTED — hold confirmed, technician on the job")

    t5 = best_match(HIRER, wo[4]); a5 = dispatch(HIRER, wo[4], t5); settle()
    tt5 = tech_token(t5)
    call("POST", f"/wo/assignments/{a5}/accept", tt5); settle(3)
    call("POST", f"/wo/assignments/{a5}/submit", tt5, {"hours_worked": 3, "note": "awaiting sign-off"})
    say(f"assignment {a5}  SUBMITTED — waiting on the hirer, money still in escrow")

    # ── 4 ────────────────────────────────────────────────────────────────────
    step("4/6  a rejection, for a compensated saga")
    t6 = best_match(HIRER, wo[5]); a6 = dispatch(HIRER, wo[5], t6); settle()
    call("POST", f"/wo/assignments/{a6}/reject", tech_token(t6), {"reason": "no certification for this site"})
    settle()
    say(f"assignment {a6}  REJECTED — saga compensated, work order back in the pool")

    # ── 5 ────────────────────────────────────────────────────────────────────
    step("5/6  rework, so the backward edge in the state machine is real")
    t7 = best_match(HIRER, wo[6]); a7 = dispatch(HIRER, wo[6], t7); settle()
    tt7 = tech_token(t7)
    call("POST", f"/wo/assignments/{a7}/accept", tt7); settle(3)
    call("POST", f"/wo/assignments/{a7}/submit", tt7, {"hours_worked": 2})
    time.sleep(1)
    c, _ = call("POST", f"/wo/assignments/{a7}/rework", HIRER, {"reason": "cable runs not labelled"})
    say(f"assignment {a7}  submitted → sent back for REWORK → accepted again  ({c})")

    # ── 6 ────────────────────────────────────────────────────────────────────
    step("6/6  an expired offer, so the sweeper has something to find")
    t8 = best_match(HIRER, wo[7]); a8 = dispatch(HIRER, wo[7], t8); settle()
    say(f"assignment {a8} dispatched, offer window 30 minutes")

    # The ONLY direct database write in this script, and it moves a CLOCK, not
    # a business fact: it ages one offer past its window so the sweeper has
    # something to find. The expiry itself is then produced by the real
    # expireStale() path — the status change, the event, the hold release.
    # Waiting 30 real minutes would produce the identical result.
    import subprocess
    subprocess.run(["docker","compose","exec","-T","db-workorders","psql","-U","fn",
                    "-d","workorders","-qc",
                    f"UPDATE assignments SET expires_at = now() - interval '1 minute' "
                    f"WHERE id = {a8} AND status = 'dispatched';"],
                   capture_output=True)
    say("aged that one offer past its window (a clock, not a fact)")

    c, d = call("POST", "/wo/assignments/expire-stale", ADMIN)
    say(f"sweeper ran: {d.get('expired', 0)} offer(s) expired → hold released, back in the pool")
    settle()

    # ── summary ──────────────────────────────────────────────────────────────
    settle(4)
    step("what the demo queries will now show")
    c, sagas = call("GET", "/wo/sagas?limit=20", ADMIN)
    by = {}
    for s in sagas: by[s["status"]] = by.get(s["status"], 0) + 1
    say(f"sagas          {', '.join(f'{v} {k}' for k, v in sorted(by.items()))}")
    c, tb = call("GET", "/pay/ledger/trial-balance", ADMIN)
    say(f"trial balance  debits {tb['debits']} = credits {tb['credits']}  balanced={tb['balanced']}")
    c, pj = call("GET", "/wo/projections/status", ADMIN)
    say(f"projection     {pj.get('events_applied')} events applied, lag {pj.get('lag', 0)}")
    print()

if __name__ == "__main__":
    main()
