# Runbook — driving the demo, command by command

Every step: **what to run**, **what you should see**, and **where in the monorepo
that work happens**. Read the file reference out loud when you run the command —
that pairing is what makes it a walkthrough rather than a slideshow.

Shell assumption: you are in `~/fieldnation-match`.

---

# PART 0 · Bring it up

```bash
make up          # 16 containers: 4 Postgres, Qdrant, RabbitMQ, 6 services, 2 apps, Prometheus, Grafana
make status      # all healthy + matching API health
```

If it's a cold start and there's no data yet:

```bash
make seed        # ingest pipeline + 71 logins + hirer funding. ~2 minutes.
```

Reset between rehearsals (fast, keeps work orders and accounts):

```bash
make demo
```

| What | Where |
|---|---|
| Every service, port, healthcheck | `docker-compose.yml` |
| Every target | `Makefile` |

---

# PART 1 · The data pipeline

> This is the CareerOne architecture retargeted. Say that first.

### 1.1 Run the pipeline and watch the stages

```bash
make ingest
```

You should see, in order: taxonomy indexed → sources fetched → per-batch progress
→ a final line like
`fetched=232 inserted=217 hash-dupes=14 vector-dupes=9 indexed=208`.

| Stage | Where |
|---|---|
| Orchestration of all stages | `ingest/pipeline.py` → `main()` |
| Live API adapters | `ingest/sources/live_apis.py` |
| Field-service generator | `ingest/sources/synthetic.py` → `fetch_synthetic()` |

### 1.2 Provenance — is any of this real?

```bash
curl -s localhost:55173/api/stats | python3 -m json.tool | head -30
```

Three live public APIs plus a generator. **Every row carries `source_type`.**

> "Open job APIs are remote-work boards — I measured 22 loosely field-ish hits
> out of 290. So live APIs for real, messy, HTML-laden data, and a generator for
> domain-realistic volume. Adzuna and USAJobs adapters activate if keys exist."

| What | Where |
|---|---|
| `source_type` column | `db/workorders/01-schema.sql` → `work_orders` |
| Stats endpoint | `api/main.py` → `stats()` |

### 1.3 HTML stripping — before anything is hashed or embedded

```bash
make psql-wo
```
```sql
SELECT left(body_raw, 110) AS raw FROM work_orders WHERE source_type='synthetic' LIMIT 1;
SELECT left(body_clean, 110) AS clean FROM work_orders WHERE source_type='synthetic' LIMIT 1;
\q
```

> "Markup noise otherwise leaks into both the dedup hash and the vector — two
> identical jobs in different templates would look like different jobs."

| What | Where |
|---|---|
| `strip_html()` | `ingest/cleaning.py:15` |
| `content_hash()` | `ingest/cleaning.py:42` |

### 1.4 Two dedup layers

```bash
make psql-wo
```
```sql
SELECT method, count(*), round(avg(score)::numeric,4) AS avg_score
  FROM dedupe_links GROUP BY method;

-- the ones only the vector layer could catch
SELECT d.score, a.title AS kept, b.title AS duplicate, a.company, a.city
  FROM dedupe_links d
  JOIN work_orders b ON b.work_order_id = d.work_order_id
  JOIN work_orders a ON a.work_order_id = d.duplicate_of
 WHERE d.method='vector_knn' ORDER BY d.score DESC LIMIT 5;
\q
```

> "Hash catches byte-identical reposts. The vector layer catches the same job
> reworded across channels, which hashing cannot see."

**The bug worth telling:** vector similarity alone flagged **99 of 226** as
duplicates — two POS installs for different retailers in different cities are
near-identical in feature space and are still two separate jobs someone drives
to. Scoping to same buyer + same site took it to 9.

| What | Where |
|---|---|
| Both layers | `ingest/dedupe.py` → `hash_duplicate()`, `vector_duplicate():23` |
| The buyer+site scoping fix | `ingest/dedupe.py` → the `Filter` in `vector_duplicate` |

### 1.5 Normalisation — the LLM pass

```bash
curl -s localhost:55173/api/work-orders/212 | python3 -m json.tool | head -40
```

Look at `attributes` and `body_clean`.

> "The description is the only field left unstructured. Everything else is
> extracted into typed features and resolved to a canonical id."

| What | Where |
|---|---|
| Same contract, two implementations | `ingest/extraction.py` → `RuleExtractor:65`, `LLMExtractor:117` |
| Feature shape | `ingest/extraction.py` → `ExtractedFeatures.as_pairs()` |

> "With an OpenAI key it's a schema-constrained LLM pass; without one,
> deterministic alias matching. Same output contract, so the pipeline never
> branches and the demo runs offline. The LLM path falls back to rules on any
> error — a rate limit degrades quality instead of breaking ingestion."

### 1.6 The taxonomy — resolving to IDs in the database

```bash
make psql-wo
```
```sql
SELECT attribute_type, count(*) AS n FROM core_job_attributes
 GROUP BY attribute_type ORDER BY n DESC;

SELECT resolved_by, count(*) FROM work_order_attributes GROUP BY resolved_by;

-- DISTINCT matters: the same phrase resolves on many work orders
SELECT DISTINCT wa.raw_value, a.canonical_name, round(wa.confidence::numeric,3) AS score
  FROM work_order_attributes wa
  JOIN core_job_attributes a ON a.attribute_id = wa.attribute_id
 WHERE wa.resolved_by='vector_knn' ORDER BY score DESC LIMIT 15;
\q
```

| What | Where |
|---|---|
| Two-layer resolver (alias → kNN) | `ingest/resolver.py:37` → `resolve()` |
| Taxonomy source of truth | `taxonomy/taxonomy.json` — 70 attributes, 325 aliases |
| Replicated into both DBs | `ingest/db.py` → `seed_taxonomy()` |

### 1.7 **The set-piece — live taxonomy resolution**

Open http://localhost:55173, scroll to *Live taxonomy resolution*.
**Ask them for a phrase.** Or:

```bash
curl -s "localhost:55173/api/resolve?q=ran%20cat6%20above%20the%20ceiling%20grid&attribute_type=skill" \
  | python3 -m json.tool
```

```
#3  Structured Cabling  0.604  matched_form: "cat6"
```

> "That phrase exists nowhere in the taxonomy. It's embedded and kNN'd against
> the skill collection, and it tells you which surface form caught it."

**The bug worth telling:** first version embedded each attribute as one blob of
label-plus-aliases and scored **0.39** on phrases it got right — below threshold,
so correct matches were being rejected. One vector **per surface form** took it
to 0.60–0.67 and doubled vector resolutions from 67 to 141.

| What | Where |
|---|---|
| Per-surface-form indexing | `ingest/pipeline.py:32` → `index_taxonomy()` |
| Live endpoint | `api/main.py` → `resolve()` |

### 1.8 The weighted centroid

```bash
make psql-wo
```
```sql
SELECT feature_type, weight, left(feature_text,70) AS feature
  FROM work_order_features WHERE work_order_id=212 ORDER BY weight DESC;
\q
```
```bash
curl -s localhost:56333/collections | python3 -m json.tool
```

Eight Qdrant collections: 2 entity + 6 taxonomy.

> "Every feature is embedded on its own, then combined by weight into one vector
> per entity. Weights are renormalised over whichever features exist, so a work
> order with no stated industry isn't pushed into a different region of the
> space. Because each feature also stays indexed in its taxonomy collection, a
> match can be decomposed afterwards."

| What | Where |
|---|---|
| Centroid construction | `ingest/embedding.py:33` → `weighted_centroid()` |
| Weights (the tuning surface) | `ingest/config.py` → `FEATURE_WEIGHTS` |
| Qdrant collections | `ingest/vectorstore.py` → `ensure_collections()` |

---

# PART 2 · Matching and explainability

```bash
curl -s "localhost:55173/api/work-orders/212/matches?limit=2" | python3 -m json.tool | head -50
```

Or in the UI: pick a work order, look at *Ranked technicians*.

> "Ranking is one kNN query against the centroid. But a cosine score isn't
> something you can show a buyer, so every match decomposes into which features
> agreed — three of four skills, work type matched, industry didn't."

| What | Where |
|---|---|
| Per-feature breakdown | `api/matching.py:23` → `explain()` |
| Rank blending | `api/matching.py` → `blend()` |
| Both directions | `api/main.py` → `match_technicians()`, `match_work_orders()` |

---

# PART 3 · The event backbone

### 3.1 Topology as code

```bash
make exchanges     # four exchange types
make topology      # 45 queues with depths
```

| Exchange | Type | Carries |
|---|---|---|
| `fieldnation.events` | topic | domain events, many consumers |
| `fieldnation.commands` | direct | one recipient, `mandatory:true` |
| `fieldnation.broadcast` | fanout | every service gets a copy |
| `fieldnation.priority` | headers | routes on attributes, not event type |

> "Declared as JSON and loaded at broker boot, not created in application
> bootstrap — reviewable independently of any service."

| What | Where |
|---|---|
| Whole topology | `infra/rabbitmq/definitions.json` |
| Names referenced by code | `libs/tsevents/src/topology.ts` |

### 3.2 The retry ladder

```bash
make load-retry    # 300 messages that always fail
```

```
t+2s   r1=300
t+8s   r2=300
t+40s  r3=300
```

> "Tiered queues, not per-message TTL. RabbitMQ only expires messages at the
> head of a queue, so a 5-minute message blocks a 5-second one behind it.
> Head-of-line blocking isn't tunable — it's how the broker works."

| What | Where |
|---|---|
| Consumer contract | `libs/tsevents/src/bus.ts:6` → `subscribe()` |
| Tiers and routing keys | `libs/tsevents/src/topology.ts` → `retryRoutingKey()` |
| `x-death` handling | `libs/tsevents/src/topology.ts` → `deathCount()` |

---

# PART 4 · The dispatch saga — **both windows on screen**

> **Always pick an OPEN work order.** A fixed id will be `assigned` the second
> time you rehearse, and dispatch correctly refuses it with
> `400 work order is assigned, not open`. Set these first:
>
> ```bash
> GW=http://localhost:55173
> H=$(curl -s -X POST $GW/id/auth/login -H 'content-type: application/json' \
>      -d '{"email":"hirer@northwind.retail.group.test","password":"Passw0rd!"}' \
>      | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])")
> WO=$(curl -s "$GW/api/work-orders?limit=1" \
>      | python3 -c "import json,sys;print(json.load(sys.stdin)['items'][0]['work_order_id'])")
> T=$(curl -s "$GW/api/work-orders/$WO/matches?limit=1" \
>      | python3 -c "import json,sys;print(json.load(sys.stdin)['matches'][0]['technician_id'])")
> echo "work order $WO → technician $T"
> ```
>
> `/api/work-orders` only returns `status='open'`, so this is always safe.

Buyer http://localhost:55173 · Technician http://localhost:55174 · password `Passw0rd!`

1. Buyer: note the balance. **Dispatch** to the top match.
2. Balance drops — escrow reserved.
3. Technician: offer appears in ~3s with *why this matched you*.
4. **Decline.** Buyer shows rejected, balance returns, work order reopens.
5. Re-dispatch to next candidate. **Accept.**
6. Technician: **Mark work complete.** Buyer: **Approve & release payment.**

> "None of that was a direct call. The click wrote a state change and an event to
> an outbox in one transaction; a relay published it; payments, notifications and
> matching each reacted independently."

**Then prove it rather than asserting it:**

```bash
docker compose stop payments
# dispatch again in the UI — succeeds, no hold appears
docker compose start payments
# the hold lands within seconds
```

| What | Where |
|---|---|
| Dispatch + outbox in one transaction | `services/work-orders/src/assignments/assignments.service.ts:29` |
| Relay | `services/work-orders/src/outbox/outbox.relay.ts:40` → `drain()` |
| Legal transitions | `services/work-orders/src/assignments/state-machine.ts` |
| Escrow reaction | `services/payments/src/holds/holds.service.ts:26` |

---

# PART 5 · Money

```bash
make psql-tech    # (or use the Ledger tab as finance@fieldnation.test)
```
```bash
curl -s localhost:55173/pay/ledger/trial-balance \
  -H "Authorization: Bearer $ADMIN" | python3 -m json.tool
```

```
hold      DR hirer_funds        / CR escrow
capture   DR escrow             / CR technician_payable + platform_revenue (15%)
payout    DR technician_payable / CR cash
```

> "Double entry. Balances are derived from append-only entries, never stored, so
> a balance is always explainable. Amounts are integer cents — floats have no
> place in money."

**Separation of duty — do this in the terminal, not the UI:**

```bash
# technician approving their own work
curl -s -X POST localhost:55173/wo/assignments/<ID>/approve -H "Authorization: Bearer $TECH"
# → 403 missing permission(s): workorder:approve

# hirer paying a technician
curl -s -X POST localhost:55173/pay/payouts -H "Authorization: Bearer $HIRER" \
     -H 'content-type: application/json' -d '{"technician_id":47}'
# → 403 missing permission(s): payment:release
```

> "The button is hidden AND the API refuses. Those are different claims."

| What | Where |
|---|---|
| Balanced posting invariant | `services/payments/src/ledger/ledger.service.ts:26` → `post()` |
| Escrow lifecycle | `services/payments/src/holds/holds.service.ts` |
| Permission matrix | `services/identity/src/rbac/permissions.ts` → `ROLE_MATRIX` |

---

# PART 6 · Event sourcing and CQRS

```bash
curl -s "localhost:55173/wo/events?limit=8" | python3 -m json.tool
curl -s "localhost:55173/wo/projections/assignments?limit=1" | python3 -m json.tool
curl -s "localhost:55173/wo/events/replay/assignment/<ID>" | python3 -m json.tool
```

**Then the one that matters:**

```bash
curl -s -X POST localhost:55173/wo/projections/rebuild \
     -H "Authorization: Bearer $ADMIN" | python3 -m json.tool
# → rows_before 1 → rows_after 1, identical=true, took 15ms
```

> "Truncate the read model, replay from the log, identical result. The
> projection holds no information that isn't derivable from the events — which
> is what makes a read model something you can change your mind about."

| What | Where |
|---|---|
| Append (same txn as outbox) | `services/work-orders/src/eventstore/projector.service.ts:41` |
| The fold | `.../projector.service.ts` → `apply()` |
| Rebuild | `.../projector.service.ts:160` → `rebuild()` |
| Log + read model schema | `.../eventstore/eventstore.entity.ts` |

---

# PART 7 · Resilience

```bash
curl -s localhost:55173/wo/strangler/status | python3 -m json.tool   # breaker + bulkhead

docker compose stop api
for i in 1 2 3 4 5; do curl -s -D- -o /dev/null localhost:55173/wo/strangler/work-orders/21$i \
  | grep -i "x-served-by\|x-fallback"; done
# → breaker opens after 3 failures, falls back to the new implementation

docker compose start api
# wait ~12s, then a few more requests → half_open → closed
```

> "Half-open is the part people leave out. Without it you either stay open
> forever or slam a recovering dependency with full traffic."

**And the flaw I fixed:** it used to count 404s as dependency failures. A 4xx
means the dependency is *healthy and answering correctly* — counting client
errors means one bad request pattern trips the breaker for everyone.

| What | Where |
|---|---|
| Breaker | `services/work-orders/src/resilience/circuit-breaker.ts:21` |
| Bulkhead | `services/work-orders/src/resilience/bulkhead.ts` |
| 4xx handling | `services/work-orders/src/strangler/strangler.controller.ts` |

---

# PART 8 · Strangler migration

```bash
make strangler                    # current stage + divergence rate
make test-strangler               # 6 tests: equivalence, determinism, rollback
```

```bash
curl -X POST localhost:55173/wo/strangler/config -H "Authorization: Bearer $ADMIN" \
     -H 'content-type: application/json' -d '{"mode":"canary","canary_percent":50}'
# watch x-served-by flip between legacy-api and work-orders
# then {"mode":"new"}, then {"mode":"legacy"} to roll back instantly
```

> "Field Nation is migrating a PHP monolith to Node microservices. This is that
> migration, on a real boundary here: the Python service still reads work orders
> straight from the database while the Node service owns the domain."

| What | Where |
|---|---|
| Stages + deterministic routing | `services/work-orders/src/strangler/strangler.service.ts:90` |
| Facade + shadow comparison | `.../strangler/strangler.controller.ts` |
| The playbook | `MIGRATION.md` |

---

# PART 9 · Observability under load

**Grafana on screen first:** http://localhost:43000 (`fn`/`fn`)

```bash
make load-heavy          # 200k messages: ~21k/s in, drained at ~9.4k/s
make load-backpressure   # prefetch 1 vs 100 → 1.7x throughput, worse tail latency
make load-purge
```

> "The reason to load-test isn't only to test the system. Two of my dashboard
> panels were querying metric names that don't exist — flat zeros while the
> broker did 21,000 a second. A panel showing zero looks exactly like a system
> doing nothing."

| What | Where |
|---|---|
| Scenarios | `loadtest/harness.py` |
| RED metrics | `services/*/src/auth/metrics.ts` |
| SLO rules + alerts | `infra/prometheus/rules/slo.yml` |
| Dashboard | `infra/grafana/dashboards/platform.json` |

---

# PART 10 · Tests

```bash
make test          # 42: unit + integration + regression + strangler
make test-chaos    # kills containers, asserts recovery
```

| Suite | Where |
|---|---|
| State machine, envelope | `services/work-orders/test/` |
| Ledger invariants + property tests | `services/payments/test/ledger.spec.ts` |
| The bugs that actually happened | `tests/test_regressions.py` |
| Separation of duty | `tests/test_authorization.py` |
| Migration safety | `tests/test_strangler.py` |

---

# If something breaks live

| Symptom | Fix |
|---|---|
| A service is unhealthy | `docker compose up -d --force-recreate <svc>` — **not** `restart`, which reuses the old image |
| Gateway routing oddly | 10s DNS TTL; wait, or recreate the web container |
| Demo state messy | `make demo` — 10s |
| Total rebuild | `make reset` — minutes. **Never live.** |

**If a live demo fails, do not debug on camera.** Say what should have happened,
move to the architecture and the bugs, offer the repo. The bug stories need no
running system and are the stronger material.
