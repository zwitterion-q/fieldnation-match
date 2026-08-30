# Architecture

How the system is put together, what every datastore and table is for, and how a
dispatch actually flows through it.

---

## 1. The shape of the system

Six services, four datastores, one message broker. Services never call each other
synchronously for business events — they publish to RabbitMQ and react.

```
                    ┌──────────────┐        ┌──────────────┐
   buyer console →  │  web-buyer   │        │  web-tech    │  ← technician app
      (React)       └──────┬───────┘        └──────┬───────┘      (React)
                           │                       │
                           └───────── nginx ───────┘
                                       │
        ┌───────────────┬──────────────┼──────────────┬───────────────┐
        ▼               ▼              ▼              ▼               ▼
   ┌─────────┐    ┌───────────┐  ┌──────────┐   ┌──────────┐   ┌──────────────┐
   │identity │    │work-orders│  │ payments │   │ matching │   │notifications │
   │ NestJS  │    │  NestJS   │  │  NestJS  │   │ FastAPI  │   │   NestJS     │
   └────┬────┘    └─────┬─────┘  └────┬─────┘   └────┬─────┘   └──────┬───────┘
        │               │             │              │                │
        └───────────────┴─────────────┼──────────────┴────────────────┘
                                      ▼
                        ┌───────────────────────────┐
                        │  RabbitMQ  fieldnation.*  │
                        │  4 exchanges · 36 queues  │
                        └───────────────────────────┘

   datastores:  db-workorders (Postgres) · db-technicians (Postgres) · Qdrant
```

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
| `notifications` | NestJS | Real-time fan-out over WebSocket to two frontends. Node's strength; kept out of the domain service on purpose. |
| `matching` | Python / FastAPI | Embeddings, vector search, ranking. The ML ecosystem lives here. |
| `ingestion` | Python | Scraping, LLM extraction, dataframe-shaped work. |

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

### 2.4 RabbitMQ — AMQP **55672**, management UI **45672** (`fn`/`fn`)

| Exchange | Type | Role |
|---|---|---|
| `fieldnation.events` | topic | Normal delivery. Producers publish here. |
| `fieldnation.retry` | topic | Holds the delay queues. |
| `fieldnation.requeue` | topic | Return path from a delay queue back to the main queue. |
| `fieldnation.parking` | topic | Terminal. Nothing consumes it; failures stay visible and replayable. |

36 quorum queues: **20 main** (one per service/event pair), **12 retry**
(3 tiers × 4 services), **4 parking lots**.

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
  └─► work-orders:  OPEN → DISPATCHED        (written with a transactional outbox)
        └─ publishes workorder.dispatched
             ├─► payments      place escrow hold ─► payment.hold_placed
             ├─► notifications push to technician
             └─► matching      mark provisionally engaged

technician ACCEPTS                        technician REJECTS / window expires
  └─ workorder.accepted                     └─ workorder.rejected
      ├─► payments      confirm hold            ├─► payments      release hold
      ├─► notifications tell hirer              ├─► matching      re-rank, next candidate
      └─► matching      remove from pool        └─► work-orders   DISPATCHED → OPEN
```

**Choreography, not orchestration.** Services react to events rather than a
central coordinator sequencing them. Each service stays autonomous; adding a
consumer requires no change to the producer.

---

## 5. Ports

| Port | Service |
|---|---|
| 55173 | buyer console (React) |
| 55174 | technician app (React) |
| 58000 | matching API (FastAPI) |
| 58001 | identity (NestJS) |
| 58002 | work-orders (NestJS) |
| 58003 | payments (NestJS) |
| 55432 | db-workorders |
| 55433 | db-technicians |
| 55434 | db-identity |
| 55435 | db-payments |
| 56333 | Qdrant |
| 55672 | RabbitMQ AMQP |
| 45672 | RabbitMQ management UI (fn/fn) |

Both frontends proxy to every service through their own nginx, so the browser
only ever sees one origin and CORS never enters the picture:

| Path | Service |
|---|---|
| `/api/*` | matching |
| `/id/*` | identity |
| `/wo/*` | work-orders |
| `/pay/*` | payments |

## 5b. Payments — the ledger

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

## 5c. Identity and RBAC

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

71 seeded accounts; see `CREDENTIALS.md`.

All deliberately on high ports so nothing collides with local Postgres, MySQL or
other project stacks.

---

## 6. Running it

```bash
make help      # all targets
make up        # infrastructure + apps
make ingest    # build the data
make topology  # inspect the declared RabbitMQ topology
make open      # open both frontends and the API docs
make reset     # destroy everything and rebuild
```
