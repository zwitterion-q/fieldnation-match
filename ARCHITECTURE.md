# Architecture

How the system is put together, what every datastore and table is for, and how a
dispatch actually flows through it.

---

## 1. The shape of the system

Five deployed services, four Postgres databases, one vector store, one broker.
Services never call each other synchronously for business events — they publish
to RabbitMQ and react.

```
                    ┌──────────────┐        ┌──────────────┐
   hirer console →  │  web-buyer   │        │  web-tech    │  ← technician app
      (React)       └──────┬───────┘        └──────┬───────┘      (React)
                           │                       │
                           └──────── nginx ────────┘
                                       │
        ┌───────────────┬──────────────┼───────────────┬──────────────┐
        ▼               ▼              ▼               ▼              ▼
   ┌─────────┐    ┌───────────┐  ┌──────────┐    ┌──────────┐   ┌──────────┐
   │identity │    │work-orders│  │ payments │    │   api    │   │  ingest  │
   │ NestJS  │    │  NestJS   │  │  NestJS  │    │ FastAPI  │   │  Python  │
   │  x1     │    │    x3     │  │   x1+2   │    │   x2     │   │  batch   │
   └────┬────┘    └─────┬─────┘  └────┬─────┘    └────┬─────┘   └────┬─────┘
        │               │             │               │              │
        └───────────────┴─────────────┼───────────────┴──────────────┘
                                      ▼
                     ┌────────────────────────────────────┐
                     │  RabbitMQ   fieldnation.*          │
                     │  7 exchanges · 45 queues           │
                     │  65 bindings · all quorum          │
                     └────────────────────────────────────┘

   datastores:  db-workorders · db-technicians · db-identity · db-payments
                (Postgres)                                    + Qdrant (vectors)
```

`work-orders` runs three replicas as **competing consumers** on the same queues.
`payments` runs one active consumer plus two hot standbys — its lifecycle queues
are Single Active Consumer, so extra replicas serve HTTP and provide failover
but do not add consumer parallelism. That is deliberate; see §2.4.

> **`notifications` is topology, not a service.** Fourteen queues and their
> bindings are declared for a notifications consumer that is not built. They
> receive their fan-out copies and sit at depth. This is not an oversight left
> in the diagram — it is the extensibility claim being demonstrated rather than
> asserted: a consumer can be added later with **no change to any producer**,
> and the routing is already proven because the messages are already arriving.

### Why each service uses the stack it does

Stack is chosen per **workload characteristic**, not preference.

> **A note on PHP.** `identity` and `payments` were originally specified as
> Laravel — Field Nation's own backend is PHP, so demonstrating it there was
> deliberate. That was dropped after measurement: `composer create-project`
> alone took **502 seconds**, before any packages, before the image build's own
> `composer install`, and before PHP-FPM and nginx configuration. With a fixed
> deadline, spending that on toolchain setup rather than on the event platform
> was the wrong trade. The architectural argument for polyglot stands; the
> demo consolidates on Node and Python. See ADR-10.

| Service | Stack | Reasoning |
|---|---|---|
| `identity` | NestJS | Auth is request/response, not data-heavy. Guards and decorators make RBAC declarative at the route level. |
| `payments` | NestJS | Money wants ACID transactions and migrations, which TypeORM provides. Double-entry ledger invariants are enforced at the database level regardless of language. |
| `work-orders` | NestJS | The transactional core: frequent state transitions, I/O bound. NestJS gives DI, modules and guards — structure that survives growth. |
| `api` | Python / FastAPI | Embeddings, vector search, ranking, explainability. The ML ecosystem lives here, and this is the compute-bound path. |
| `ingest` | Python | Scraping, LLM extraction, dataframe-shaped work. Batch, not long-running. |
| `notifications` | — | **Not built.** Its queues and bindings exist; see §1. |

---

## 2. Datastores

### 2.1 `db-workorders` — Postgres, port **55432**

Owns work orders and the canonical feature taxonomy.

| Table | Purpose |
|---|---|
| `core_job_attributes` | **The canonical vocabulary.** Every normalised feature resolves to a row here. `attribute_type` (`skill`, `experience`, `experience_level`, `industry`, `experience_type`, `certification`) is what separates a skill from an industry, so one table backs all six taxonomy vector collections. |
| `attribute_aliases` | Surface forms mapping onto a canonical attribute. Checked before the vector resolver, so obvious hits never cost an embedding call. |
| `work_orders` | The job itself. `body_raw` keeps source HTML; `body_clean` is what gets indexed. `content_hash` powers exact-duplicate detection. `source_type` records `live_api` vs `synthetic` provenance. |
| `work_order_features` | One row per (work order, feature type). The structured half of the enrichment pass. `weight` is what drives the centroid. |
| `work_order_attributes` | Extracted values resolved to taxonomy ids. `resolved_by` records whether the alias table or the vector kNN made the call — this is what lets you audit normalisation quality. |
| `dedupe_links` | Why a work order was judged duplicate, by which layer (`content_hash` or `vector_knn`), and at what score. |
| `ingestion_runs` | Per-run counters: fetched, inserted, duplicates, normalised, indexed. |
| `vector_index_state` | Bookkeeping of what is in Qdrant, so Postgres stays the source of truth about the vector store. |
| `v_work_order_full` | View joining a work order to its resolved attributes as JSON. |

### 2.2 `db-technicians` — Postgres, port **55433**

Separate database, separate service, own schema.

| Table | Purpose |
|---|---|
| `core_job_attributes` | **Replicated**, not foreign-keyed. Ids mirror the work-order side exactly. |
| `technicians` | Profile, location, travel radius, rate, rating, jobs completed. |
| `technician_features` | Same feature contract as work orders — this is what makes the two centroids comparable. |
| `technician_attributes` | Resolved taxonomy ids plus years and proficiency. |
| `vector_index_state` | As above. |
| `v_technician_full` | View joining a technician to their attributes. |

> **Why replicate the taxonomy instead of sharing it?** You cannot foreign-key
> across a service boundary. Each service owns its schema and can be deployed,
> migrated and scaled independently. Both are seeded from the single source of
> truth, `taxonomy/taxonomy.json`, so ids stay aligned. The cost is that a
> taxonomy change requires a coordinated reseed — accepted deliberately, because
> the alternative is a shared database, which is the classic microservices
> anti-pattern.

### 2.3 Qdrant — port **56333**

Eight collections, all 384-dimensional cosine.

| Collection | Contents |
|---|---|
| `work_orders` | One **weighted centroid** per work order. |
| `technicians` | One weighted centroid per technician. Same space as above. |
| `tax_skill` · `tax_experience` · `tax_experience_level` · `tax_industry` · `tax_experience_type` · `tax_certification` | **One vector per surface form**, all carrying the same `attribute_id`. This is what resolves unseen phrasing to a canonical id. |

### 2.4 RabbitMQ — AMQP **55672**, management **45672** (`fn`/`fn`), metrics **45692**

Seven exchanges. Four carry traffic, three implement the reliability path. Each
of the four is a different **routing semantic**, not a different topic — the
whole point is that using one topic exchange for everything throws away
distinctions the broker can enforce for you.

| Exchange | Type | Semantics | Carries |
|---|---|---|---|
| `fieldnation.events` | **topic** | A fact that already happened. Many consumers, pattern-matched keys. Nobody consuming is fine. | `workorder.*`, `payment.*` |
| `fieldnation.commands` | **direct** | An instruction to exactly one service. Exact-match key, published `mandatory:true` so the broker returns it rather than dropping it. Nobody consuming is an *error*. | `payout` |
| `fieldnation.broadcast` | **fanout** | Every bound queue gets a copy; the routing key is ignored entirely. | taxonomy reload |
| `fieldnation.priority` | **headers** | Routes on message *attributes*, not the key. Urgency is a property of a work order, not a kind of event — encoding it in the key would multiply the key space by every SLA tier. | urgency, SLA |
| `fieldnation.retry` | topic | Holds the three delay queues. |
| `fieldnation.requeue` | topic | Return path from a delay queue to the main queue. |
| `fieldnation.parking` | topic | Terminal. Nothing consumes it; failures stay visible and replayable. |

**45 queues, 65 bindings, all quorum** (Raft-replicated, so a broker node loss
does not lose messages):

| Kind | Count | Notes |
|---|---|---|
| main | 22 | one per service/event pair |
| retry | 12 | 3 tiers × 4 consumer groups |
| broadcast | 5 | one fanout sink per service |
| parking | 4 | one terminal lot per consumer group |
| command | 2 | direct, point-to-point |

**The retry ladder.** On failure a consumer does *not* nack — it republishes
itself to the next tier and acks the original. A queue's dead-letter exchange is
fixed configuration and can only route to one destination, so it cannot choose a
tier based on how many times this message has already failed. The consumer can.

| Tier | TTL | Then |
|---|---|---|
| `r1` | 5 s | dead-letters via `fieldnation.requeue` back to the main queue |
| `r2` | 30 s | as above |
| `r3` | 300 s | as above |
| — | — | after 3 attempts → **parking lot**, retained as evidence, never discarded |

The attempt count is `max(our header, broker x-death)`. `x-death` is written by
RabbitMQ itself, so it survives a consumer that forgets to propagate application
headers and catches messages dead-lettered by TTL or queue-length limits that our
own counter never sees.

**Single Active Consumer on the five `q.payments.workorder.*` queues.** Only one
consumer receives at a time; the others connect and wait as hot standbys, taking
over instantly on failure. This buys strict per-queue ordering on the service
that moves money, at the cost of consumer parallelism there.

> **The limit worth stating precisely:** SAC orders messages *within* a queue and
> guarantees nothing *across* queues — and `workorder.dispatched` and
> `workorder.rejected` are on different queues. That is exactly why a rejection
> can overtake its own dispatch, and why the fix is the retry ladder plus
> handlers that commute, not an ordering guarantee. SAC is not a substitute for
> designing the race out.

---

## 3. The ingestion pipeline

```
sources ─► strip_html ─► content_hash ─► [dedupe layer 1: exact]
   │                                              │
   │  arbeitnow · remotive · jobicy  (live APIs)  ▼
   │  synthetic generator                    extraction
   │  adzuna · usajobs (key-gated)      LLM if key, else rules
   │                                          (same contract)
   │                                              │
   │                                              ▼
   │                                     TaxonomyResolver
   │                              alias exact-match ─► attribute_id
   │                              vector kNN ────────► attribute_id
   │                                              │
   │                                              ▼
   └────────────────────────► per-feature embeddings ─► weighted centroid
                                                          │
                                            [dedupe layer 2: vector kNN]
                                                          │
                                                          ▼
                                                   Qdrant + Postgres
```

**The weighted centroid.** Each normalised feature is embedded on its own, then
combined by weight into one vector per entity. Weights live in
`ingest/config.py` and are renormalised across whichever features an entity
actually has, so a work order with no stated industry is not pushed into a
different region of the space. Because each feature also stays indexed in its
taxonomy collection, a match can be decomposed afterwards — which is what the
`/matches` endpoints return.

---

## 4. The dispatch flow

```
hirer picks a technician
  └─► work-orders   ONE TRANSACTION:
        ├─ SELECT … FOR UPDATE on the work order   (serialise racing dispatchers)
        ├─ INSERT assignment, 30-minute offer window
        ├─ UPDATE work_orders → assigned
        ├─ APPEND to event_store                   (the immutable record)
        ├─ INSERT outbox row                       (the intent to tell anyone)
        └─ START saga instance
              │
   relay (1s) └─► publishes workorder.dispatched → fieldnation.events
                    │
                    ├─► payments      place escrow hold ─► payment.hold_placed
                    │                 (or payment.failed if underfunded)
                    ├─► work-orders   mirror hold_state, advance saga
                    └─► notifications [queues declared, no consumer]

technician ACCEPTS                      technician REJECTS / window expires
  └─ workorder.accepted                   └─ workorder.rejected
      ├─► payments   confirm hold             ├─► payments    release hold
      └─► saga       await_response ✓         ├─► saga        record compensation
          confirm_funds ✓ → settle            └─► work-orders → open, next candidate

technician SUBMITS                      hirer APPROVES
  └─ no event published, by design        └─ workorder.completed
     (nothing consumes it yet)                └─► payments  capture:
                                                    escrow → payable + revenue

finance requests PAYOUT
  └─ POST /commands/payout → fieldnation.commands (direct) → payments
```

Two things in that diagram are the whole argument.

**The single transaction.** The state change, the event-store append and the
outbox row commit together or not at all. This is the answer to the **dual-write
problem**: committing to Postgres and publishing to RabbitMQ are two operations
with no shared transaction, and *no ordering between them is safe*.
Commit-then-publish loses the event on a crash; publish-then-commit reserves
money against an assignment that does not exist. Writing the event as a row in
the same transaction makes the only reachable failure state "written but not yet
published", which the relay repairs one second later.

**Submit publishes nothing.** Deliberate. Nothing outside `work-orders` reacts
to a submission, and an event no consumer subscribes to is pure cost — a queue,
a contract, a schema to version. Every event is a public API you then have to
keep.

---

## 5. The event platform

The patterns layered on top of the flow above, and where each lives.

| Pattern | What it solves | Where |
|---|---|---|
| **Transactional outbox** | Dual-write. Event and state commit atomically; a relay publishes with `FOR UPDATE SKIP LOCKED` so all three replicas can drain concurrently, and publisher confirms so a row is marked sent only after the broker takes responsibility. | `work-orders/src/outbox/outbox.relay.ts` · `drain()` |
| **Idempotent consumers** | At-least-once delivery makes duplicates normal traffic, not an exception. Dedup on `processed_messages` keyed by envelope id, *plus* natural idempotency — `placeHold` looks up by `assignment_id` first, so it is safe even if the dedup table is wrong. | `libs/tsevents/src/bus.ts` · `subscribe()` |
| **Saga** | No `ROLLBACK` reaches across four services. Four steps, each marked compensatable or not; compensations run in **reverse order**, and irreversible steps are forced **last**. | `work-orders/src/saga/dispatch.saga.ts` |
| **Event sourcing** | The append-only log is the record; state is a fold. `rebuild()` truncates the projection, replays from sequence zero and returns `identical: true`. | `work-orders/src/eventstore/projector.service.ts` |
| **CQRS** | Write model enforces invariants; read model is denormalised with the timeline pre-joined. The projector polls the **log**, not the bus — so it cannot miss an event published while it was restarting. | same file · `project()` |
| **Strangler fig** | `legacy → shadow → canary → new`. Routing is **deterministic** on entity id (Knuth multiplicative hash) so one work order never flips between implementations; comparison is on the fields a caller depends on, not whole payloads, because whole-payload diffing is noise. | `work-orders/src/strangler/strangler.service.ts` |
| **Circuit breaker** | Fail fast rather than burn a thread per request on a dead dependency. Only 5xx and timeouts trip it — a **404 is a legitimate answer**, and counting 4xx would trip the breaker on correct behaviour. | `work-orders/src/resilience/circuit-breaker.ts` |
| **Bulkhead** | Caps concurrent calls per dependency, so one slow path cannot saturate the pool and take down unrelated paths. | `work-orders/src/resilience/bulkhead.ts` |

**Choreography *and* orchestration, under one rule.** Services react to events
(choreography) *and* a saga records the transaction (orchestration). Running both
caused a real bug — on rejection the choreographed path released the hold and the
saga issued a cancel that released it again. The rule that resolves it:

> **Only one coordinator may act on any given state.** The orchestrator
> *observes and records* where choreography already acts, and *issues commands*
> only for failures nothing else handles — e.g. `payment.failed`, which the
> choreography does not unwind.

What the saga buys, given choreography already does the work, is the one thing
pure choreography cannot give you: a queryable answer to *where is this
transaction right now*. `GET /wo/sagas` returns every instance, its current step,
and each step's status.

---

## 6. Payments — the ledger

`db-payments` (port 55435) holds a double-entry ledger. Balances are **derived
from append-only entries, never stored**, and amounts are `bigint` minor units —
floating point has no place in money.

| Table | Purpose |
|---|---|
| `accounts` | `hirer_funds`, `escrow`, `technician_payable`, `platform_revenue`, `cash`. Held from the platform's perspective. |
| `ledger_transactions` | A balanced set of entries with a description and correlation id. |
| `ledger_entries` | Debit/credit rows. Debits must equal credits per transaction. |
| `holds` | One escrow reservation **per assignment**, with a unique constraint. |
| `outbox` / `processed_messages` | Reliable publish and idempotent consume. |

```
dispatched  DR hirer_funds  / CR escrow                       reserve
rejected    DR escrow       / CR hirer_funds                  release
accepted    hold -> confirmed
completed   DR escrow / CR technician_payable + platform_revenue   capture (15% fee)
```

`GET /pay/ledger/trial-balance` proves debits equal credits across the system.

## 7. Identity and RBAC

`db-identity` (55434). Permissions are **flattened into the JWT**, so downstream
services never call identity to authorise a request — identity being down cannot
take the platform down with it. The cost is staleness, which is why tokens are
short-lived.

Services check **permissions, never roles** (`workorder:dispatch`, not
`role === 'hirer'`), so adding a role never requires touching authorisation
logic anywhere downstream. The guard is registered globally and routes opt out
via `@Public()` — fail-closed by default.

Roles: `admin`, `dispatcher`, `hirer`, `technician`, `finance`. A hirer can
approve work but **cannot release funds** — separation of duty encoded in the
permission matrix rather than in a code comment.

71 seeded accounts across all five roles; see
**[CREDENTIALS.md](CREDENTIALS.md)**. The seeder is idempotent and reconciles
stale subject-linked accounts — an earlier version upserted on email alone and
produced 80 technicians for 60 rows.

---

## 8. Observability

Four services expose `/metrics`. Prometheus scrapes them plus RabbitMQ and the
Postgres exporters; Grafana renders 14 panels.

| Target | Job | What it answers |
|---|---|---|
| `identity`, `work-orders`, `payments`, `api` | `services` | RED — rate, errors, duration, per service |
| RabbitMQ `:15692` | `rabbitmq` | Broker-wide throughput, connections, memory |
| RabbitMQ `/metrics/detailed` | `rabbitmq-detailed` | **Per-queue depth and consumer count** — the default endpoint does not expose queue-level series, so the panels that make the retry ladder visible do not exist without this |
| `pg-exporter-*` | `postgres` | Connection counts, transaction rates on the two stateful services |

Three decisions worth defending:

- **The `api` service was the last one instrumented, and it was the wrong one to
  miss** — it does the expensive work (embedding lookup, kNN against Qdrant), so
  it is where latency actually lives. It now exposes RED metrics via
  `prometheus-fastapi-instrumentator`.
- **Status codes are deliberately not grouped** into `4xx`/`5xx`. The circuit
  breaker treats a 404 as a legitimate answer and a 500 as a dependency failure;
  a dashboard that collapses them hides the exact signal the breaker is built on.
- **Symptom-based alerting on SLOs**, not cause-based alerting on resources.
  `infra/prometheus/rules/slo.yml` alerts on error rate and latency, not CPU.
  Nobody is woken because a number is high; they are woken because users are
  affected.

Scrape interval is 5s — at 30s you would miss the 5-second retry tier entirely,
and watching the ladder fill and drain in real time is the point.

**Load tested** via `loadtest/harness.py`: 21,186 msg/s published against
9,425 msg/s drained. The constraint is the consumers, not the broker — which is
precisely the signal KEDA scales on in the AWS deployment. Prefetch 1 → 100
measured **1.7× throughput at the cost of worse tail latency**, the classic
batching trade made visible.

---

## 9. Ports

Everything on high ports so nothing collides with a local Postgres, MySQL or
another project stack.

| Port | Service | Note |
|---|---|---|
| 55173 | hirer console (React + nginx) | container listens on **8080**, not 80 |
| 55174 | technician app (React + nginx) | same |
| 58000 | `api` — matching (FastAPI) | |
| 58001 | `identity` (NestJS) | |
| **58002–58004** | `work-orders` (NestJS) | a **range**, not one port — three competing-consumer replicas |
| **58013–58015** | `payments` (NestJS) | one active consumer + two hot standbys |
| 55432 | `db-workorders` | |
| 55433 | `db-technicians` | |
| 55434 | `db-identity` | |
| 55435 | `db-payments` | |
| 56333 | Qdrant | |
| 55672 | RabbitMQ AMQP | |
| 45672 | RabbitMQ management UI (`fn`/`fn`) | |
| 45692 | RabbitMQ Prometheus metrics | |
| 49090 | Prometheus | |
| 43000 | Grafana (`fn`/`fn`, anonymous viewer enabled) | |

> **A fixed host port caps a service at one replica.** `work-orders` and
> `payments` publish ranges precisely so `docker compose up --scale` works —
> this was a real constraint discovered when scaling to demonstrate competing
> consumers.

**Why the web containers moved to 8080.** Ports below 1024 need
`CAP_NET_BIND_SERVICE`, so serving on 80 means running as root or carrying that
capability. The Kubernetes namespace enforces the `restricted` Pod Security
Standard, which forbids both — so both images build on `nginx-unprivileged`,
listen on 8080 and run as uid 101. The published ports on a laptop are unchanged.

Both frontends proxy to every service through their own nginx, so the browser
only ever sees one origin and CORS never enters the picture:

| Path | Service |
|---|---|
| `/api/*` | `api` — matching |
| `/id/*` | `identity` |
| `/wo/*` | `work-orders` |
| `/pay/*` | `payments` |

> **nginx caches upstream DNS forever** unless told otherwise — after a container
> is recreated the gateway silently routes to whichever service now holds that
> IP. Both configs set `resolver 127.0.0.11 valid=10s` and use a *variable* in
> `proxy_pass` to force per-request resolution. The catch: once `proxy_pass`
> contains a variable, nginx stops stripping the location prefix automatically,
> so each route rewrites the path explicitly.

---

## 10. Deployment — two targets

The same application code runs on both. They are two Makefiles rather than one
with an environment flag, because a flag would imply they are the same deployment
configured differently. They are not: local trades durability for speed, AWS
trades speed for the properties you need when other people depend on it.

```bash
make up          # local — docker compose, ~3 min, free
make aws-up      # aws   — EKS + RDS + Amazon MQ, ~25 min, ~USD 0.27/hour
make aws-down    # destroys it and proves nothing is left billing
make aws-validate  # validates all IaC offline — no AWS account needed
```

| | local | aws | why they differ |
|---|---|---|---|
| Postgres | 4 containers | 1 RDS instance, 4 logical databases | Four instances would be 4× the bill for isolation the code already enforces |
| RabbitMQ | container, `amqp://` :5672 | Amazon MQ, `amqps://` :5671 | Amazon MQ refuses plaintext AMQP — the one genuine code difference, handled in `libs/tsevents/src/bus.ts` |
| Topology | `definitions.json` imported at boot | declared by the app on connect | Amazon MQ has no definitions import; `assertTopology()` is idempotent and survives a broker replacement, which is the better pattern anyway |
| Secrets | `fn:fn`, `fn-dev-secret-change-me` | Terraform → Secrets Manager → IRSA → External Secrets → pod env | Correct for a laptop; a critical finding anywhere else |
| Scaling | `--scale` | **KEDA on RabbitMQ queue depth** | An I/O-blocked consumer shows flat CPU while the backlog climbs, so an HPA scales nothing. `api` keeps a CPU HPA — that path really is compute-bound |
| Storage | docker volumes | gp3, `reclaimPolicy: Delete` | `Retain` is the safer production default and the wrong one here — "keeps the volume" means "keeps billing" |

**Teardown is designed before standup.** `terraform destroy` on an EKS stack
reliably fails with `DependencyViolation` on the VPC, because the ALB the
controller created in response to an Ingress still holds ENIs — and Terraform
never knew it existed. So `make aws-down` is three steps: `pre-destroy.sh`
deletes the Kubernetes objects that own AWS resources and waits for AWS to
reclaim them; then `terraform destroy`; then `verify-destroyed.sh`, which
searches **by tag, not by state**, so it can find exactly the orphans Terraform
cannot see.

Full comparison, the nine destroyability settings, and the cost breakdown:
**[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## 11. Known gaps

Stated because an architecture document that only lists strengths is marketing.

| Gap | Impact | The fix |
|---|---|---|
| **`db-workorders` has two writers** — `ingest` inserts and marks duplicates, `work-orders` updates status, `api` reads. One schema, three services, no contract. | A schema change breaks services that never agreed to it, and nothing catches it until runtime. The bounded context here is nominal, not enforced. | `work-orders` owns the transactional tables; `ingest` publishes `workorder.ingested`; `api` builds its own projection — the CQRS machinery already built for assignments, applied one level up. |
| **Contracts documented, not enforced.** `contracts/events/` holds ten hand-written contracts — but they are not JSON Schema, nothing validates against them, and nothing in CI checks drift. `libs/pyevents` reimplements the same contract in Python by hand. | Event sourcing makes drift permanent: malformed events sit in the log forever and replay on every rebuild. This is the largest architectural gap and it grows with every event written. | JSON Schema or Avro as the source of truth, generated for both languages, with a compatibility check in CI. |
| **No distributed tracing.** `correlation_id` propagation gives log correlation. | Answers "what happened", cannot answer "where did the 400ms go". | OpenTelemetry span propagation through the envelope. |
| **Outbox relay polls at 1 s.** | A latency floor nothing else in the system needs. | Change-data-capture via logical replication removes the poll and the floor together. |
| **Parking lot has no operator UI.** | Replaying a parked message is manual, and a recovery path that depends on someone remembering it is not a recovery path. | An admin surface over `fieldnation.parking`. |

---

## 12. Running it

```bash
make help          # all targets
make up            # infrastructure + apps + observability
make seed          # ingest + 71 logins + funded accounts
make demo          # reset transactional state for a clean run
make topology      # inspect the declared RabbitMQ topology
make sagas         # every saga instance and its steps
make strangler     # current migration stage and divergence rate
make test          # 42 tests: unit, integration, authz, regression, strangler
make load-all      # the RabbitMQ load-test suite
make open          # open both frontends and the API docs
```

Further reading in this repo: **[DEPLOYMENT.md](DEPLOYMENT.md)** ·
**[RABBITMQ.md](RABBITMQ.md)** · **[MIGRATION.md](MIGRATION.md)** ·
**[RUNBOOK.md](RUNBOOK.md)** · **[DEMO.md](DEMO.md)** ·
**[CREDENTIALS.md](CREDENTIALS.md)**
