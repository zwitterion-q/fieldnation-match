# Demo script — 45 minutes

> **This is more material than 45 minutes holds.** Acts 1–4 and Act 6 are the
> core; 5, 5b and 5c are the depth to reach for if they steer technical or ask
> about infrastructure. If time is short, cut Act 5b and 5c before Act 6 —
> the bugs are the strongest thing you have.

Field Nation · Senior Software Engineer (Full stack) · Monday 31 Aug, 5:00 pm

---

## Before the call (10 minutes)

```bash
cd ~/fieldnation-match
make up            # 12 containers
make demo          # clean transactional state, hirers funded
make open          # both frontends + API docs
```

Have open, in this tab order:

| # | Tab | URL |
|---|---|---|
| 1 | Buyer console | http://localhost:55173 |
| 2 | Technician app | http://localhost:55174 |
| 3 | RabbitMQ management | http://localhost:45672 (`fn` / `fn`) |
| 4 | Grafana | http://localhost:43000 — open the *Field Nation — Platform* dashboard |
| 5 | Terminal | for the curl moments and load tests |

Log tab 1 in as `hirer@northwind.retail.group.test` and tab 2 as any technician.
Password everywhere: `Passw0rd!` — full list in `CREDENTIALS.md`.

**Sanity check before you start:** `make status` should show 16 services and
`work_orders_open` around 200. Run `make load-purge` so the queues start clean.

---

## The arc

You are not demoing a matching engine or a dispatch tool. You are demoing
**the thing Field Nation actually is** — a two-sided marketplace where work and
money move between strangers — and the reason you can build it is that you have
already built one.

Say that in the first minute. Everything after is evidence.

---

## Act 1 — Where the data comes from (5 min)

**Buyer console, work order list.**

> "Two hundred work orders. Some are genuinely fetched from live public job
> APIs, some are generated — every row carries its provenance, because the
> first question anyone asks is whether the data is real."

Click a work order. Point at **Normalised attributes**.

> "The description is the only field left unstructured. Everything else has been
> extracted and resolved to an id in a canonical taxonomy — 70 attributes across
> six types. This is exactly the CareerOne pipeline: dedupe, LLM extraction to
> schema-constrained JSON, resolve to taxonomy ids, embed per feature, combine
> into one weighted centroid in Qdrant."

**The moment worth planning for — live taxonomy resolution.** Scroll to
*Live taxonomy resolution* on the landing panel. Ask them to give you a phrase.
Type something nobody has an alias for:

```
ran cat6 above the ceiling grid
```

> "→ Structured Cabling, 0.604, matched via the surface form `cat6`. That phrase
> exists nowhere in the taxonomy."

**Let them type their own.** It is the single most convincing thing on screen.

---

## Act 2 — Matching, and why it is explainable (5 min)

Scroll to the ranked technicians.

> "Ranking is one kNN query against the centroid. But a cosine score is not
> something you can show a buyer, so every match decomposes into which features
> actually agreed — three of four skills, work type matched, industry did not."

> "That is what the per-taxonomy collections buy. Each feature stays indexed in
> its own space, so relevance can be tuned and explained feature by feature
> instead of as one opaque number."

---

## Act 3 — The dispatch loop, both screens at once (10 min)

**This is the centrepiece. Have both windows visible side by side.**

1. **Buyer:** note the available balance in the header. Click **Dispatch** on the
   top match.
2. **Buyer:** balance drops immediately — escrow reserved.
3. **Technician:** within three seconds the offer appears — pay, duration,
   expiry countdown, *why this matched you*, and `funds held in escrow`.
4. **Technician:** click **Decline**.
5. **Buyer:** status flips to rejected, balance returns, work order back in the
   pool.
6. **Buyer:** dispatch to the next candidate. **Technician:** **Accept**.

> "Nothing there was a direct call. The hirer's click wrote a state change and an
> event to an outbox in one transaction; a relay published it; payments,
> notifications and matching each reacted independently. If payments had been
> down, the dispatch would still have succeeded and the hold would have been
> placed when it came back."

**Then prove that last claim** — it is better shown than asserted:

```bash
docker compose stop payments
# dispatch again in the UI — it still works, no hold appears
docker compose start payments
# hold appears within seconds
```

---

## Act 4 — Completion and money (7 min)

7. **Technician:** **Mark work complete.**
8. **Buyer:** the assignment shows hours and the completion note, with
   **Approve & release payment**.
9. **Buyer:** approve.

Switch to the **Ledger** tab (visible because you are also logged in as finance,
or log in as `finance@fieldnation.test`).

> "Six ledger entries, double-entry throughout. Hold moved money from the
> hirer's available balance into escrow. Capture split escrow into the
> technician's payable and the platform's 15% fee. Payout discharges it to cash."

Point at **trial balance**.

> "Debits equal credits across the entire system. Balances are derived from
> append-only entries — nothing is stored as a total, so a balance is always
> explainable."

**The separation-of-duty moment.** Do this one in the terminal, because
"the button is hidden" and "the API refuses" are different claims:

```bash
# technician tries to approve their own work
curl -s -X POST localhost:58002/assignments/<ID>/approve \
  -H "Authorization: Bearer $TECH_TOKEN"
# → 403 missing permission(s): workorder:approve

# hirer tries to pay a technician
curl -s -X POST localhost:58003/payouts -H "Authorization: Bearer $HIRER_TOKEN" \
  -H 'content-type: application/json' -d '{"technician_id":47}'
# → 403 missing permission(s): payment:release
```

> "A hirer can approve work but cannot release funds. A technician cannot pay
> themselves. That is in the permission matrix, not in a code comment — and it is
> enforced by the service, not by hiding a button."

---

## Act 5 — The infrastructure they are hiring for (8 min)

**RabbitMQ management UI.**

> "Four exchanges, 36 quorum queues, 56 bindings — all declared as JSON and
> loaded at boot, not created in application bootstrap. The topology is
> reviewable independently of any service."

Walk the retry ladder in `infra/rabbitmq/definitions.json`:

> "Three delay tiers per service — 5 seconds, 30 seconds, 5 minutes — then a
> parking lot. A failing consumer republishes itself to the next tier and acks
> the original, rather than nacking, because nack-driven dead-lettering can only
> route to one fixed destination and cannot pick a tier."

**Why tiered queues rather than the obvious option:**

> "Per-message TTL in one queue is simpler and wrong. RabbitMQ only expires
> messages at the head, so a 5-minute message parked at the front holds up a
> 5-second message behind it. Head-of-line blocking. There is also a
> delayed-message plugin that solves it cleanly, but most managed brokers won't
> run plugins, and it keeps delayed messages in a less durable store — a bad
> trade for messages that move money."

**Accept the weakness before they find it:**

> "The cost is no jitter. Five hundred failures all retry at exactly five
> seconds. If that mattered I would randomise the tier or move to the plugin."

---

## Act 5b — Load, live, with Grafana on screen (5 min)

**Put Grafana on the main screen before you start this.** The panels only mean
something while they are moving.

```bash
make load-heavy      # 200,000 messages
```

Narrate while it runs:

> "Two hundred thousand messages, published in about nine seconds — roughly
> twenty-one thousand a second. Nothing is consuming yet, so watch the queue
> depth panel climb to two hundred thousand."

> "Now four competing consumers attach and drain it in about twenty-one seconds.
> p50 latency 0.4 milliseconds, p99 0.9."

Then the trade-off, which is the part worth their time:

```bash
make load-backpressure    # identical load at prefetch 1 vs 100
```

> "Same load, only prefetch changes. Prefetch 100 gives 1.7 times the throughput
> — but tail latency gets *worse*: p99 goes from 1.5 to 1.7 milliseconds and the
> maximum more than doubles, 2 to 5 milliseconds."

> "Prefetch 1 makes a consumer wait a full network round trip between every
> message. Too high and one consumer hoards the backlog while its peers sit
> idle, holding it all in memory. It is a number you tune to a workload, not one
> you maximise."

Finish on the retry ladder, which is the best-looking panel:

```bash
make load-retry           # 300 messages that always fail
```

> "Three hundred messages that fail every time. Watch them march across the
> tiers — r1 at two seconds, r2 at eight, r3 at forty. Three stacked series
> handing off to each other."

**The point to land, and it is not the throughput number:**

> "The reason to load-test is not only to test the system. Two of my dashboard
> panels were querying metric names that do not exist — they rendered as flat
> zeros while the broker was doing twenty-one thousand a second. A panel showing
> zero looks exactly like a system doing nothing. Load is how you find out your
> monitoring is lying to you."

Reset afterwards: `make load-purge`

---

## Act 5c — Two patterns they will care about (6 min)

### The strangler fig — this is their actual migration

**Lead with why it is relevant, not what it is.**

> "Field Nation is migrating a PHP monolith to Node microservices. That is the
> strangler fig pattern, and it is happening right now at your company. I had a
> genuine version of the same problem here: the Python service still reads work
> orders straight from the database, while the Node service owns the work-order
> domain. So I strangled it."

```bash
curl -s localhost:55173/wo/strangler/status | python3 -m json.tool
```

Four stages: `legacy` → `shadow` → `canary` → `new`.

**Spend the time on shadow, because it is the stage people skip:**

> "In shadow mode every request runs through BOTH implementations. The legacy
> response is served to the user; the new one is compared and thrown away.
> Twenty requests, twenty compared, divergence rate zero — I have proof the new
> path is equivalent, measured on real traffic, with zero user exposure."

Then roll it forward live:

```bash
TOK=$(...admin token...)
curl -X POST localhost:55173/wo/strangler/config -H "Authorization: Bearer $TOK" \
     -H 'content-type: application/json' -d '{"mode":"canary","canary_percent":10}'
# then 50, then {"mode":"new"}, then {"mode":"legacy"} to roll back
```

Show the `x-served-by` header flipping between `legacy-api` and `work-orders`.

**Three details worth naming:**

> "Shadow comparison is not awaited — it runs off the request path, so it can
> never add latency to a user request or fail one."

> "Comparison is on load-bearing fields, not whole payloads. Timestamps and key
> order differ harmlessly; comparing everything trains you to ignore the alarm."

> "Routing is deterministic on the entity id, so one work order never flips
> between implementations on refresh. A user seeing two different answers is
> worse than a user seeing the old one."

### Saga — both kinds, side by side

> "The dispatch flow was already a choreographed saga: services react to events,
> no coordinator. Its weakness is that no single place shows where a transaction
> has got to — you reconstruct it from correlation ids in the logs."

> "So I added an orchestrated one alongside it. Same events, but now the
> transaction has explicit state, explicit steps, and explicit compensations."

```bash
curl -s localhost:55173/wo/sagas?limit=1 | python3 -m json.tool
```

Dispatch, then reject, and show the saga:

```
reserve_funds   UNDO   hold 328
await_response  OK     technician declined   (irreversible)
reason: already booked        →  escrow back to $0.00
```

**The point to land:**

> "Compensations run in REVERSE order, because later steps can depend on earlier
> ones. And steps are marked compensatable or not — which forces the ordering
> question every saga has to answer: put the irreversible steps last, so
> everything before them can still be rolled back. Sending an email is the
> classic one; once it is out, no compensation exists."

> "I would not replace the choreography with this. Orchestration buys
> observability and explicit rollback at the cost of coupling — the coordinator
> has to know the whole flow. For four services reacting to events, choreography
> is right. The moment a flow needs compensating steps in a defined order, it
> is not."

---

## Act 6 — The four bugs (10 min) — *the most valuable part*

Do not skip this to show another feature. This is what separates you.

### 1. Concurrent delivery double-charged a hirer

> "Two holds on one work order. $1,183 escrowed for a $591 job."

> "Cause: one queue per event type means RabbitMQ delivers them concurrently —
> there is no ordering guarantee across queues. The rejection and the second
> dispatch raced, and both handlers read 'no existing hold' before either
> committed."

> "The fix was not a lock. It was modelling: holds are scoped to the assignment,
> not the work order, with a unique constraint so the database makes duplicates
> impossible regardless of arrival order. The handlers now commute — order stops
> mattering. A mutex would have hidden it."

### 2. A seeder silently dropped a production column

> "`assignment_id` kept vanishing. The seeder ran `synchronize: true` from an
> image one build behind, whose entity had no such column — so TypeORM helpfully
> deleted it."

> "That is the best argument for migrations over synchronize I have ever had, and
> I did not have to invent it. Seeders no longer own schema."

### 3. The gateway silently routed to the wrong services

> "After scaling containers up and down, `/id/health` started returning the
> work-orders service and `/wo/health` returned identity."

> "nginx resolves upstream hostnames ONCE at config load and caches them
> forever. Containers were recreated, Docker reassigned the IPs, and the gateway
> kept sending traffic to whatever now held the old address. It had been correct
> for hours and only broke after a recreate — which is exactly how that class of
> bug behaves."

> "The fix needs two things: an explicit resolver so nginx re-resolves, and a
> variable in proxy_pass to force per-request lookup. The catch is that once
> proxy_pass contains a variable, nginx stops stripping the location prefix, so
> every route needs an explicit rewrite. I got that wrong first and 404'd
> everything."

### 4. Taxonomy resolution rejected correct matches

> "Resolution scored 0.39 on phrases it identified correctly — below threshold,
> so good matches were being thrown away. I had embedded each attribute as one
> blob of its label plus aliases, which lands the vector on an average matching
> none of the actual phrasings."

> "One vector per surface form instead. 0.39 → 0.60, and vector-resolved
> attributes doubled from 67 to 141."

**The line to land:**

> "Four of my architectural decisions were corrections after measurement, not
> calls I got right up front. That is in the decisions record with the numbers.
> A story where every choice was right first time would be a less honest story."

---

## Questions you should expect

**"How much of this is real data?"**
Three live public job APIs plus a generator. Every row carries `source_type`,
and `/stats` breaks it down. Open job APIs are remote-work boards and carry
almost no on-site technician work, so the generator fills the domain gap.

**"Why polyglot?"**
Stack per workload: Python where the ML ecosystem lives, Node for the I/O-bound
transactional core and real-time surfaces. Be straight that identity and payments
were specified as Laravel and dropped after measuring `composer create-project`
at 502 seconds — with a fixed deadline, that time belonged in the event platform.
Service boundaries are unchanged, so either could be reimplemented in Laravel
behind the same contracts without touching anything else.

**"What is missing?"**
Say it before they ask: no tests; distance is stored but not used in ranking, so
a Columbus technician can match a Nashville job; no notification service, the
frontends poll; `synchronize: true` instead of migrations.

**"How long did this take?"**
Two days. Say it plainly.

**"Would you build it this way at Field Nation?"**
No — and mean it. Choreography over orchestration is right for four services and
wrong once a flow needs compensating transactions in a defined order. Shared
retry queues are right at 20 event types and wrong when one starts starving
another. Both are decisions to revisit with production traffic, not on a laptop.

---

## If something breaks

| Symptom | Fix |
|---|---|
| A service is unhealthy | `make ps`, then `docker compose up -d --force-recreate <svc>` |
| Frontend shows nothing | Check `make health`; the API may still be starting |
| Demo state is messy | `make demo` — 10 seconds, keeps work orders and accounts |
| Total rebuild | `make reset` — several minutes, do not do this live |

**If a live demo fails, do not debug it on camera.** Say what should have
happened, move to the architecture and the bugs, and offer to send the repo.
The three-bugs section needs no running system and is the stronger material.
