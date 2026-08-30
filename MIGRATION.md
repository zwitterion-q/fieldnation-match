# Migrating a monolith — the strangler fig, implemented

Field Nation is moving a PHP/MySQL monolith to Node microservices. This is how
that migration runs safely, demonstrated on a real boundary in this codebase
rather than described in the abstract.

---

## The boundary being strangled

The Python `api` service still reads work orders **directly from the database**.
The NestJS `work-orders` service now owns the work-order domain — its lifecycle,
its state machine, its events. That is a genuine boundary violation of exactly
the kind a monolith leaves behind: the old code still serves reads that the new
service should own.

Rewriting it in one cutover means a single moment where everything either works
or does not. The strangler fig instead grows the new implementation around the
old one until the old one can be removed without anyone noticing it has gone.

---

## Four stages, and the one people skip

| Stage | Who serves the user | Purpose |
|---|---|---|
| `legacy` | old | Baseline. New path is dark. |
| **`shadow`** | **old** | **Both run. New response compared and discarded.** |
| `canary` | a deterministic % on new | Controlled exposure. |
| `new` | new | Legacy is dead code. |

Move between them at runtime, no redeploy:

```bash
make strangler                       # current stage and divergence rate
curl -X POST localhost:55173/wo/strangler/config \
     -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
     -d '{"mode":"canary","canary_percent":10}'
```

### Shadow is the stage that earns the right to shift traffic

Every request runs through **both** implementations. The legacy response is
returned to the user; the new one is compared against it and thrown away.

You are testing the new code against **real production traffic** — real data
shapes, real edge cases, real volume — with **zero user exposure**. No synthetic
test suite reproduces the inputs production actually sends.

Measured here: **25 requests, 25 compared, 0 diverged.**

Three implementation details that make it safe rather than theatrical:

**The comparison is not awaited.** It runs off the request path in a microtask,
so it can never add latency to a user request or fail one. If the new code
throws, the user is unaffected and the divergence is exactly what you wanted to
learn.

**Comparison is on load-bearing fields, not whole payloads.** Timestamps
serialise differently, key order differs, floats format differently. Comparing
everything produces noise that trains people to ignore the alarm.

**Routing is deterministic on the entity id** (Knuth multiplicative hash). One
work order never flips between implementations on refresh. A user seeing two
different answers is worse than a user seeing the old one.

---

## The evidence

A toggle is not proof. `tests/test_strangler.py` is:

```
✓ both implementations return identical data       (25 entities, every field + attribute ids)
✓ shadow serves legacy and reports zero divergence
✓ routing is deterministic per entity              (4 requests, same answer)
✓ canary percentage is honoured                    (0% and 100% exact)
✓ rollback is immediate and needs no deploy
✓ only an admin can move the migration
```

`make test-strangler`

The last one matters more than it looks: shifting production traffic between
implementations is a privileged operation, so it sits behind `platform:admin`.
A migration control anyone can flip is an outage waiting for a curious engineer.

---

## Watching it

Four Prometheus series, so a migration can be graphed rather than guessed at:

```
strangler_stage                        0 legacy · 1 shadow · 2 canary · 3 new
strangler_canary_percent               traffic on the new path
strangler_requests_total{implementation}   split by implementation
strangler_shadow_comparisons_total{outcome}  matched vs diverged
```

**Advance a stage on numbers, not on confidence.** The rule I would hold to:
stay in shadow until divergence is zero across a full traffic cycle — a day,
including whatever batch jobs and edge cases only appear at 3am — then 10%,
then 50%, watching error rate and latency at each step.

---

## Why this is the right approach for a monolith

**It is incremental.** One endpoint, one service, one bounded context at a time.
The monolith keeps running throughout. There is no date in the calendar where
everything must work.

**It is reversible at every point.** Rollback is a config change, not a deploy,
not a database restore. That is what makes it safe to *attempt* — and a
migration nobody dares attempt does not happen.

**It de-risks with evidence.** Shadow mode replaces "we think the new code is
equivalent" with a measured divergence rate.

**It has a finish line.** When a route reaches `new` and stays there, the legacy
code path is provably dead and can be deleted. Migrations that never delete
anything are just systems with two implementations of everything.

### What it costs, honestly

- **Both implementations exist at once**, so for a period you maintain two.
  Bounded by finishing, which is the argument for driving each route to `new`
  rather than leaving a half-migration.
- **Shadow doubles read load** on whatever both paths query. Fine for reads,
  and the reason this pattern applies most naturally to read paths first.
- **Writes are harder.** A shadow write must not actually write, so you either
  compare a dry run or migrate writes only after the reads are proven. The
  read path is deliberately where this starts.
- **The facade is a new component** that can itself fail. It is deliberately
  thin: route, compare, count. No business logic lives in it.

---

## The order I would migrate in

1. **Reads first**, behind shadow. Cheapest to prove, safest to be wrong about.
2. **Then writes**, once the read model is proven equivalent and the new service
   already owns the domain.
3. **Then the data**, last. Moving a table before the code that reads it is how
   migrations become irreversible.

Strangle a boundary, not a technology. The goal is never "replace PHP" — it is
"this bounded context now has one owner". Whether that owner is Node, Python or
PHP is a workload question, answered per service.
