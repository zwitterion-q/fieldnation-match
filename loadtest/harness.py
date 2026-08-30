"""
RabbitMQ load harness.

Each scenario is designed to move a specific Grafana panel. Publishing into a
dashboard that stays flat proves nothing; these make the retry ladder fill, the
parking lot alert fire, and backpressure show up as a latency distribution.

Volume scenarios use dedicated `lt.*` queues so production topology is not
polluted. Retry and poison scenarios deliberately use the REAL matching-service
queues, because the point is to watch the real ladder work -- nothing consumes
those in this build, so it is safe.
"""
from __future__ import annotations
import argparse, json, os, statistics, sys, threading, time, uuid
from collections import defaultdict

import pika

URL = os.getenv("RABBIT_URL", "amqp://fn:fn@localhost:55672/%2F")
MGMT = os.getenv("RABBIT_MGMT", "http://localhost:45672")

LT_EXCHANGE = "lt.load"
LT_QUEUE = "lt.work"


# ----------------------------------------------------------------- helpers --
def conn():
    p = pika.URLParameters(URL)
    p.heartbeat = 60
    p.blocked_connection_timeout = 60
    return pika.BlockingConnection(p)


def declare_loadtest(ch):
    """Isolated topology for the volume scenarios."""
    ch.exchange_declare(LT_EXCHANGE, exchange_type="direct", durable=True)
    ch.queue_declare(LT_QUEUE, durable=True, arguments={"x-queue-type": "quorum"})
    ch.queue_bind(LT_QUEUE, LT_EXCHANGE, "work")


_depth_conn = None

def depth(queue: str) -> int:
    """Live queue depth via a passive declare.

    The management API is backed by a stats database that updates on an interval,
    so it lags by seconds -- long enough that a drain loop polling it exits
    immediately against a queue holding 50,000 messages. A passive declare asks
    the broker directly and is exact.
    """
    global _depth_conn
    try:
        if _depth_conn is None or _depth_conn.is_closed:
            _depth_conn = conn()
        ch = _depth_conn.channel()
        n = ch.queue_declare(queue, passive=True).method.message_count
        ch.close()
        return n
    except Exception:
        _depth_conn = None
        return 0


def envelope(i: int, fail: bool = False) -> bytes:
    return json.dumps({
        "id": str(uuid.uuid4()), "type": "workorder.dispatched", "version": 1,
        "occurred_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "correlation_id": str(uuid.uuid4()), "causation_id": None,
        "actor": {"id": 0, "role": "loadtest"},
        "payload": {"work_order_id": 900000 + i, "technician_id": 1,
                    "assignment_id": 900000 + i, "hirer_id": 6,
                    "pay_rate": 50, "duration_hours": 1,
                    "_loadtest": True, "_fail": fail},
    }, separators=(",", ":")).encode()


def human(n: float) -> str:
    return f"{n:,.0f}" if n >= 1000 else f"{n:,.1f}"


def summarise(name: str, published: int, elapsed: float, latencies: list[float] | None = None,
              consumed: int | None = None, extra: dict | None = None):
    print(f"\n  {'─' * 62}")
    print(f"  {name}")
    print(f"  {'─' * 62}")
    print(f"    published        {published:,} messages in {elapsed:.1f}s")
    print(f"    publish rate     {human(published / max(elapsed, 0.001))} msg/s")
    if consumed is not None:
        print(f"    consumed         {consumed:,}")
    if latencies:
        s = sorted(latencies)
        p = lambda q: s[min(int(len(s) * q), len(s) - 1)] * 1000
        print(f"    latency p50      {p(0.50):.1f} ms")
        print(f"    latency p95      {p(0.95):.1f} ms")
        print(f"    latency p99      {p(0.99):.1f} ms")
        print(f"    latency max      {max(s) * 1000:.1f} ms")
    for k, v in (extra or {}).items():
        print(f"    {k:<16} {v}")


# ---------------------------------------------------------------- publisher --
def publish_burst(count: int, confirms: bool, queue_exchange=LT_EXCHANGE,
                  routing="work", fail=False, batch_log=True):
    c = conn(); ch = c.channel()
    if queue_exchange == LT_EXCHANGE:
        declare_loadtest(ch)
    if confirms:
        ch.confirm_delivery()
    props = pika.BasicProperties(delivery_mode=2, content_type="application/json",
                                 headers={"x-fn-attempt": 0})
    t0 = time.time()
    for i in range(count):
        ch.basic_publish(queue_exchange, routing, envelope(i, fail), properties=props)
        if batch_log and (i + 1) % 10000 == 0:
            print(f"      …{i + 1:,} published ({human((i + 1) / (time.time() - t0))}/s)")
    elapsed = time.time() - t0
    c.close()
    return elapsed


# ---------------------------------------------------------------- consumer --
class Worker(threading.Thread):
    """Consumer with tunable prefetch and simulated handler cost."""

    def __init__(self, queue: str, prefetch: int, work_ms: float, stop: threading.Event,
                 fail_always: bool = False):
        super().__init__(daemon=True)
        self.queue, self.prefetch, self.work_ms = queue, prefetch, work_ms
        self.stop, self.fail_always = stop, fail_always
        self.consumed = 0
        self.latencies: list[float] = []

    def run(self):
        c = conn(); ch = c.channel()
        ch.basic_qos(prefetch_count=self.prefetch)
        for method, props, body in ch.consume(self.queue, inactivity_timeout=1):
            if self.stop.is_set():
                break
            if method is None:
                continue
            t0 = time.time()
            if self.work_ms:
                time.sleep(self.work_ms / 1000.0)
            if self.fail_always:
                ch.basic_nack(method.delivery_tag, requeue=False)   # → DLX
            else:
                ch.basic_ack(method.delivery_tag)
            self.consumed += 1
            self.latencies.append(time.time() - t0)
        try:
            ch.cancel(); c.close()
        except Exception:
            pass


# ---------------------------------------------------------------- scenarios --
def scn_burst(a):
    """Publish hard with no consumer. Grafana: queue depth spikes, then drains."""
    print(f"\n  Publishing {a.count:,} messages with no consumer attached.")
    print("  Watch: 'Queue depth by consumer service' and 'Publish / deliver rate'.")
    elapsed = publish_burst(a.count, confirms=a.confirms)
    time.sleep(2)
    d = depth(LT_QUEUE)
    summarise("BURST — publisher confirms " + ("ON" if a.confirms else "OFF"),
              a.count, elapsed, extra={"queue depth": f"{d:,}"})
    if a.drain:
        print("\n  Draining with 4 workers, prefetch 50…")
        stop = threading.Event()
        ws = [Worker(LT_QUEUE, 50, a.work_ms, stop) for _ in range(4)]
        [w.start() for w in ws]
        t0 = time.time()
        while depth(LT_QUEUE) > 0 and time.time() - t0 < a.timeout:
            time.sleep(1)
        stop.set(); [w.join(timeout=3) for w in ws]
        total = sum(w.consumed for w in ws)
        lat = [x for w in ws for x in w.latencies]
        summarise("DRAIN — 4 competing consumers", total, time.time() - t0, lat, total)


def scn_backpressure(a):
    """Same load, two prefetch settings. Grafana: unacked count differs sharply."""
    results = {}
    for prefetch in (1, a.prefetch):
        print(f"\n  ── prefetch = {prefetch}")
        c = conn(); ch = c.channel(); declare_loadtest(ch)
        ch.queue_purge(LT_QUEUE); c.close()
        publish_burst(a.count, confirms=False, batch_log=False)
        stop = threading.Event()
        ws = [Worker(LT_QUEUE, prefetch, a.work_ms, stop) for _ in range(a.workers)]
        [w.start() for w in ws]
        t0 = time.time()
        peak_unacked = 0
        while depth(LT_QUEUE) > 0 and time.time() - t0 < a.timeout:
            time.sleep(0.5)
        elapsed = time.time() - t0
        stop.set(); [w.join(timeout=3) for w in ws]
        total = sum(w.consumed for w in ws)
        lat = [x for w in ws for x in w.latencies]
        results[prefetch] = (total, elapsed, lat)
        summarise(f"PREFETCH {prefetch} — {a.workers} workers, {a.work_ms}ms handler",
                  a.count, elapsed, lat, total,
                  {"throughput": f"{human(total / max(elapsed, .001))} msg/s"})

    lo, hi = results[1], results[a.prefetch]
    speedup = (hi[0] / max(hi[1], .001)) / max(lo[0] / max(lo[1], .001), .001)
    print(f"\n  → prefetch {a.prefetch} was {speedup:.1f}x the throughput of prefetch 1.")
    print("    Prefetch 1 means a consumer waits a full network round trip between")
    print("    every message. Too high and one consumer hoards the backlog while")
    print("    its peers idle -- and holds it all in memory.")


def scn_retry_storm(a):
    """Messages that always fail. Grafana: r1 → r2 → r3 fill in sequence.

    Uses the real pyevents consumer contract rather than a raw nack. That
    distinction matters: main queues deliberately have NO dead-letter exchange,
    because retry here is application-driven -- the consumer republishes itself
    to the next tier and acks the original. A naive `nack(requeue=False)` against
    these queues does not retry anything, it silently discards the message.
    """
    print(f"\n  Publishing {a.count} messages that the consumer will always reject.")
    print("  Watch 'Messages held per retry tier' — r1 fills, drains into r2 at 5s,")
    print("  r2 drains into r3 at 30s.\n")
    ch = conn().channel()
    props = pika.BasicProperties(delivery_mode=2, headers={"x-fn-attempt": 0})
    for i in range(a.count):
        ch.basic_publish("fieldnation.events", "workorder.dispatched", envelope(i, True), properties=props)
    print(f"  published {a.count} → q.matching.workorder.dispatched")

    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "libs", "pyevents"))
    from pyevents import Consumer, Envelope

    cons = Consumer(URL, service="matching", prefetch=20)

    @cons.on("workorder.dispatched")
    def always_fails(env: Envelope):
        raise RuntimeError("simulated downstream failure")

    threading.Thread(target=cons.run, daemon=True).start()
    prev = 0
    for t in (2, 8, 20, 40, 70):
        time.sleep(t - prev)
        prev = t
        tiers = {n: depth(f"q.matching.retry.{n}") for n in ("r1", "r2", "r3")}
        park = depth("q.matching.parking-lot")
        print(f"    t+{t:>2}s   r1={tiers['r1']:<4} r2={tiers['r2']:<4} r3={tiers['r3']:<4} parked={park}")


def scn_sustained(a):
    """Steady rate for N seconds with live consumers. Grafana: flat throughput line."""
    print(f"\n  Sustaining ~{a.rate}/s for {a.duration}s with {a.workers} consumers.")
    stop = threading.Event()
    ws = [Worker(LT_QUEUE, 50, a.work_ms, stop) for _ in range(a.workers)]
    c = conn(); ch = c.channel(); declare_loadtest(ch); c.close()
    [w.start() for w in ws]

    c = conn(); ch = c.channel()
    props = pika.BasicProperties(delivery_mode=2)
    t0 = time.time(); sent = 0; interval = 1.0 / a.rate
    next_at = time.time()
    while time.time() - t0 < a.duration:
        ch.basic_publish(LT_EXCHANGE, "work", envelope(sent), properties=props)
        sent += 1
        next_at += interval
        d = next_at - time.time()
        if d > 0:
            time.sleep(d)
        if sent % (a.rate * 5) == 0:
            print(f"    t+{time.time()-t0:>4.0f}s  sent={sent:,}  depth={depth(LT_QUEUE):,}")
    elapsed = time.time() - t0
    time.sleep(3); stop.set(); [w.join(timeout=3) for w in ws]
    total = sum(w.consumed for w in ws)
    lat = [x for w in ws for x in w.latencies]
    summarise("SUSTAINED", sent, elapsed, lat, total,
              {"target rate": f"{a.rate}/s", "achieved": f"{human(sent/elapsed)}/s",
               "final depth": f"{depth(LT_QUEUE):,}"})


def scn_purge(a):
    c = conn(); ch = c.channel()
    n = 0
    for q in ("lt.work", "q.matching.workorder.dispatched", "q.matching.retry.r1",
              "q.matching.retry.r2", "q.matching.retry.r3", "q.matching.parking-lot",
              "q.payments.workorder.dispatched", "q.notifications.workorder.dispatched"):
        try:
            n += ch.queue_purge(q).method.message_count
        except Exception:
            ch = conn().channel()
    print(f"  purged {n:,} messages")


SCENARIOS = {"burst": scn_burst, "backpressure": scn_backpressure,
             "retry-storm": scn_retry_storm, "sustained": scn_sustained, "purge": scn_purge}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("scenario", choices=SCENARIOS)
    ap.add_argument("--count", type=int, default=20000)
    ap.add_argument("--rate", type=int, default=400)
    ap.add_argument("--duration", type=int, default=60)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--prefetch", type=int, default=100)
    ap.add_argument("--work-ms", type=float, default=2.0)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--confirms", action="store_true")
    ap.add_argument("--drain", action="store_true")
    a = ap.parse_args()
    print(f"\n  RabbitMQ load harness → {URL}")
    print(f"  Grafana: http://localhost:43000/d/fn-platform")
    SCENARIOS[a.scenario](a)
    print()


if __name__ == "__main__":
    main()
