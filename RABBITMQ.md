# RabbitMQ — where each concept lives

Every item below is load-bearing in the running system, not a sample. The file
and line is where it actually does its job.

---

## Phase 1 — Core mechanics

### The AMQP model

Publishers never address a queue. They publish to an **exchange**, which routes
to **queues** via **bindings**. The whole topology is declared in
`infra/rabbitmq/definitions.json` and loaded at broker boot — not created in
application bootstrap, so it is reviewable and diffable on its own.

**7 exchanges · 45 queues · 65 bindings.**

### Exchange types — one per job

| Exchange | Type | What it carries | Why this type |
|---|---|---|---|
| `fieldnation.events` | **topic** | domain events | Many consumers, pattern-matched (`workorder.*`). An event is a fact anyone may care about. |
| `fieldnation.commands` | **direct** | `payout.execute`, `taxonomy.reindex` | Exact match, exactly one recipient. A command *fails* if nobody carries it out — published `mandatory: true` so the broker returns it rather than dropping it silently. |
| `fieldnation.broadcast` | **fanout** | `platform.taxonomy_reload` | Every service needs a copy. Routing key ignored entirely. |
| `fieldnation.priority` | **headers** | urgent / same-day dispatch | Routes on message **attributes**. Urgency is a property of a work order, not a kind of event — putting it in the routing key would multiply the key space by every SLA. |
| `fieldnation.retry` / `.requeue` / `.parking` | topic | the retry ladder | see below |

**The events-vs-commands split is the point.** An event is a statement that
something happened; a command is an instruction that must be executed. Different
semantics deserve different exchange types.

`make exchanges` lists them live.

**Headers routing, `all` vs `any` — verified on live data:**

```
q.dispatch.urgent    x-match=all   {priority: urgent}                → 1 msg
q.dispatch.same_day  x-match=any   {sla: same_day, priority: urgent} → 2 msgs
```

Publishing `{priority: normal, sla: same_day}` correctly misses the first and
matches the second.

### Channels vs connections

`libs/tsevents/src/bus.ts` — one TCP connection per service, **two channels**:
a `ConfirmChannel` for publishing and a plain channel for consuming. Channels
are cheap and multiplexed; connections are not. Publishing and consuming are
separated because confirm-mode changes channel semantics and you do not want
that on your consumer.

### Acknowledgements

Manual throughout — auto-ack is never enabled. `ack` happens only **after** the
handler and its database transaction have committed
(`libs/tsevents/src/bus.ts`, `libs/pyevents/pyevents/consumer.py`).

---

## Phase 2 — scenarios

### 1. Fault tolerance

- **Manual acks after commit.** A consumer crash mid-handler leaves the message
  unacked, and the broker redelivers it.
- **DLX on 12 queues** (`x-dead-letter-exchange`), feeding the retry ladder.
- `consumer_timeout = 300000` in `rabbitmq.conf` — how long a message may stay
  unacked before the broker assumes the consumer has stalled.

### 2. Poison pills and retry

**Three defences, deliberately layered:**

1. **Application retry ladder** — on failure the consumer republishes itself to
   the next tier and acks the original. It does *not* nack, because
   nack-driven dead-lettering can only route to one fixed destination and
   therefore cannot choose a tier.
   ```
   attempt 1 → r1 (5s) → attempt 2 → r2 (30s) → attempt 3 → r3 (5m) → parking lot
   ```
   Verified live: t+0s, t+5s, t+35s, then parked.

2. **`x-death` awareness** — `deathCount()` in `libs/tsevents/src/topology.ts`
   reads the broker's own death record. The consumer takes
   `max(our header, x-death)`, so a message dead-lettered by TTL or a queue
   length limit — which our header never sees — still counts toward the limit.

3. **Broker-level `delivery-limit: 5`** policy on every `q.*` queue. Even a
   consumer that ignores both counters cannot loop forever.

**Tiered queues rather than per-message TTL.** RabbitMQ only expires messages at
the *head* of a queue, so one 5-minute message blocks a 5-second message behind
it. Head-of-line blocking is not tunable; it is how the broker works.

### 3. Guaranteed delivery

- **Publisher confirms** — `createConfirmChannel()`; a publish that is not
  acked by the broker rejects, so the outbox relay leaves the row unsent and
  retries rather than losing the event.
- **Durable exchanges and queues** — `durable: true` on all 45.
- **Persistent messages** — `persistent: true` / `delivery_mode: 2` on every
  publish.
- **Transactional outbox** — `services/*/src/outbox/`. The state change and the
  intent to publish commit in one database transaction; a relay publishes
  afterwards. This is what removes the dual-write problem, which no broker
  feature can solve for you.

### 4. Idempotency

At-least-once delivery means duplicates are normal, not exceptional. Every
service keeps a `processed_messages` table keyed on the envelope `id` and
short-circuits on replay (`services/*/src/inbox/`).

**Why it is not optional here:** the outbox relay may publish and then crash
before marking the row sent, so it will republish. That is a deliberate choice —
duplicating is recoverable, losing is not.

### 5. Ordering and race conditions

**This one bit, in production-shaped conditions.** One queue per event type means
RabbitMQ delivers them **concurrently** — ordering is guaranteed only *within* a
single queue. A rejection and a re-dispatch raced, both handlers read "no
existing hold", and a hirer was escrowed twice: **$1,183 held for a $591 job**.

Two fixes, both now in the system:

**a. Make the handlers commute (preferred).** Holds are scoped to the
`assignment_id`, not the work order, with a **unique database constraint**.
Two dispatches racing cannot both create a hold regardless of arrival order.
Order stops mattering rather than being enforced.

**b. Single Active Consumer where order genuinely cannot be given up.**
The five `q.payments.*` queues carry `x-single-active-consumer: true`. Scale
payments to three replicas and all three attach, but **exactly one drains a
queue at a time** — strict ordering, at the cost of per-queue throughput.

```
$ make sac
q.payments.workorder.dispatched  [{"x-single-active-consumer",true}]  consumers: 1
```

*(The third option — a consistent-hash exchange partitioning by
`work_order_id` — keeps ordering per entity while scaling out. It needs a
plugin, which is why it was not used here; the trade is the same one made
against the delayed-message plugin.)*

### 6. Backpressure and competing consumers

- **Prefetch is set per consumer, never globally.** 10 for event consumers,
  **1 for the command consumer** — commands mutate money, are low volume, and a
  smaller in-flight window means less to redeliver if the instance dies.
  `rabbitmq.conf` deliberately does *not* set a global prefetch: it belongs on
  the channel, where each service can tune it to its own workload.

- **Competing consumers, verified:**
  ```
  make scale-up      3 replicas → 3 consumers on each queue
  make kill-one      kill one   → 2 consumers, broker redistributes, nothing lost
  make scale-down
  ```

  A fixed host port caps a service at one replica; `work-orders` and `payments`
  publish **port ranges** (`58002-58004`, `58013-58015`) so they can actually
  scale.

---

## Phase 3 — Topology and operations

- **Quorum queues — all 45.** Raft-replicated, and the type that supports
  `delivery-limit`.
- **Topology as code.** `definitions.json` is generated and loaded at boot. A
  broker can be rebuilt from scratch identically.
- **Monitoring.** `rabbitmq_prometheus` → Prometheus → Grafana, with a panel per
  retry tier and a dedicated parking-lot panel. Alerts fire on **symptoms**:
  parking lot non-empty, messages reaching the 5-minute tier, a queue with zero
  consumers.
- **Not done:** sharded queues and blue-green cluster upgrades — both need a
  real multi-node cluster, which a single-node demo cannot honestly show.

---

## Try it

```bash
make exchanges    # all four exchange types
make sac          # queues enforcing ordering
make scale-up     # competing consumers
make kill-one     # failover
make topology     # every queue and its depth
make grafana      # watch the retry ladder fill and drain
```

---

## Load testing

`loadtest/harness.py` — scenarios designed to move specific Grafana panels.
A dashboard with flat lines proves nothing.

```bash
make load-burst          # 50k messages, then drain with 4 competing consumers
make load-heavy          # 200k — sustained depth for the panels
make load-backpressure   # prefetch 1 vs 100, same load
make load-retry          # watch r1 -> r2 -> r3 escalate
make load-sustained      # steady 400/s for 90s
make load-purge          # clean up
```

### Measured on this machine

| Scenario | Result |
|---|---|
| Publish, confirms off | **22,837 msg/s** |
| Drain, 4 consumers, prefetch 50 | **5,113 msg/s**, p50 0.7ms · p95 0.8ms · p99 0.9ms |
| Prefetch 1, 4 workers, 1ms handler | 1,584 msg/s, p99 1.5ms, max 2.0ms |
| Prefetch 100, same load | **2,642 msg/s** (1.7×), p99 1.7ms, **max 5.1ms** |

**The prefetch result is the interesting one.** Throughput rose 1.7× and tail
latency got *worse* — max more than doubled. Prefetch 1 makes a consumer wait a
network round trip between every message; prefetch too high lets one consumer
hoard the backlog while its peers idle, holding it all in memory. The number is
a trade, not a setting to maximise.

### Retry ladder under load

300 messages that always fail, marching through the tiers together:

```
t+2s    r1=300   r2=0     r3=0
t+8s    r1=0     r2=300   r3=0     (r1 TTL 5s expired)
t+40s   r1=0     r2=0     r3=300   (r2 TTL 30s expired)
```

### A finding from writing the harness

The first version of the retry scenario used `basic_nack(requeue=False)` and
nothing happened — all tiers stayed at zero.

**Main queues deliberately have no dead-letter exchange.** Retry here is
application-driven: the consumer republishes itself to the chosen tier and acks
the original, because nack-driven dead-lettering can only route to one fixed
destination and cannot pick a tier. A naive nack against these queues does not
retry anything — it silently discards the message.

That is worth knowing before someone adds a consumer that "just nacks on error".
The `delivery-limit: 5` policy is the backstop, but the contract is the thing.
