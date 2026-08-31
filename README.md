# Field Nation — Work Order ↔ Technician Matching & Dispatch

A working field-service marketplace: work orders are ingested from live job
feeds, normalised into a canonical taxonomy, embedded as vectors, and matched
against technicians. A hirer dispatches a job, a technician accepts it, money
moves through a double-entry ledger held in escrow, and every step of that
happens across six services over RabbitMQ.

It is built to be read as much as run. Every non-obvious decision has a comment
explaining the trade it makes, and the documents below are the argument.

---

## Run it

**One command.** macOS or Linux, nothing pre-installed required.

```bash
git clone https://github.com/zwitterion-q/fieldnation-match.git
cd fieldnation-match
./install.sh
```

That checks for every dependency, installs whatever is missing, builds the
images, starts sixteen containers, seeds the data, and opens the consoles in
your browser. It is safe to re-run — every step checks before it acts.

```bash
./install.sh --check      # verify the machine is ready, change nothing
./install.sh --no-open    # set up without opening a browser
```

First run takes **10–15 minutes**, most of it pulling images and running the
ingestion pipeline. After that, `make up` is about ninety seconds.

<details>
<summary><b>What it installs, and how to do it yourself</b></summary>

| Dependency | Why | If missing |
|---|---|---|
| Docker + Compose v2 | Everything runs in containers | macOS: Homebrew cask · Linux: apt/dnf/pacman |
| Homebrew | macOS package manager | Installed from brew.sh (asks for your password) |
| `curl`, `git`, `make` | Build and health checks | Package manager |
| `python3` | Helper scripts | Package manager |
| pytest, requests, pika | Test suite only | Into `.venv/`, never system-wide |
| Node modules | Jest unit tests only | `npm ci` in the two NestJS services |

Nothing is installed system-wide except the OS packages above. Python
dependencies go into a repo-local `.venv`. If you would rather do it by hand:
install Docker Desktop, then `make up && make seed`.

**Windows:** not supported directly. Use WSL2 and run `./install.sh` inside it.
</details>

---

## What you get

| | | |
|---|---|---|
| **Hirer console** | http://localhost:55173 | Browse work orders, see ranked technicians and why each matched, dispatch, approve, and read the ledger |
| **Technician app** | http://localhost:55174 | The offer with its countdown, why it matched you, accept / reject, submit for approval |
| **Matching API** | http://localhost:58000/docs | Match endpoints and live taxonomy resolution |
| **Grafana** | http://localhost:43000 | 14 panels — queue depth, the retry ladder, RED metrics (`fn` / `fn`) |
| **Prometheus** | http://localhost:49090 | 9 scrape targets |
| **RabbitMQ** | http://localhost:45672 | 7 exchanges, 45 queues (`fn` / `fn`) |
| **Qdrant** | http://localhost:56333/dashboard | 8 vector collections |

Log in as `hirer@vertex.hospitality.test` or `yusuf.quinn.1@tech.test`,
password `Passw0rd!`. All **71 seeded accounts** across five roles are in
[CREDENTIALS.md](CREDENTIALS.md).

> `work-orders` and `payments` publish port *ranges* so they can scale past one
> replica, so their host port moves between runs. **`make ports`** prints the
> live map. Both consoles proxy every service through their own origin, which is
> stable: `localhost:55173/{api,id,wo,pay}/*`.

---

## The five-minute tour

```bash
make demo        # clean slate: no assignments, hirers funded at $25k
```

1. **Hirer console** → open a work order. The attributes on the left were
   extracted from free text and resolved to canonical taxonomy ids; the
   description is deliberately the only field left unstructured.
2. **Ranked technicians**, each with a per-feature breakdown of *why*.
3. **Dispatch one.** One database transaction writes the assignment, the event
   log and an outbox row together.
4. **Check the ledger** — an escrow hold appears within a second. Nobody called
   the payments service; it consumed an event.
5. **Technician app** → accept. The hold moves to `confirmed`.
6. **Submit**, then try to approve *as the technician* → `403`. The party doing
   the work cannot release payment for it.
7. **Approve as the hirer** → escrow splits 85 / 15 into the technician's
   payable and platform revenue, in one balanced posting.
8. **Trial balance** → debits equal credits across the whole system.

`GET /wo/sagas` then shows where that transaction actually is, step by step.

Full narrated version with the talking points: **[DEMO.md](DEMO.md)**.

---

## What is actually in here

Five deployed services, four Postgres databases, a vector store and a broker.
No service calls another synchronously for business events.

```
  web-buyer ─┐                                    ┌─ identity     NestJS  auth + RBAC
             ├─ nginx ─┬─ api        FastAPI ─────┤
  web-tech  ─┘         │  matching, embeddings    ├─ work-orders  NestJS  lifecycle, saga
                       │                          └─ payments     NestJS  ledger, escrow
                       └─ ingest     Python
                          extraction, taxonomy              ▼
                                              RabbitMQ  7 exchanges · 45 queues
```

**The data pipeline** — live job feeds → HTML strip → content-hash dedup → LLM
or rule-based extraction (same contract either way) → resolve to taxonomy ids by
alias then vector kNN → per-feature embeddings → weighted centroid → vector
dedup → Qdrant.

**The event platform** — transactional outbox, idempotent consumers, a
three-tier retry ladder with a parking lot, an orchestrated saga with
compensating transactions, event sourcing with a rebuildable projection, a
strangler-fig migration, a circuit breaker and a bulkhead.

**Two deployment targets** — `make up` for local Docker, `make aws-up` for
EKS + RDS + Amazon MQ via Terraform. The AWS one is built teardown-first:
`make aws-down` removes everything and then proves it by searching AWS *by tag*
rather than by Terraform state.

---

## Where to look

If you only read three files:

| File | Why |
|---|---|
| `services/work-orders/src/assignments/assignments.service.ts` | `dispatch()` — one transaction writing state, event log and outbox together |
| `services/payments/src/holds/holds.service.ts` | Escrow, and the comments on the two concurrency bugs that shaped it |
| `services/work-orders/src/saga/dispatch.saga.ts` | Compensating transactions, and the rule for running orchestration alongside choreography |

| Document | What it covers |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Every service, table, exchange and pattern — including a **Known gaps** section |
| **[RABBITMQ.md](RABBITMQ.md)** | The topology, the four exchange types and why each was chosen |
| **[MIGRATION.md](MIGRATION.md)** | The strangler fig, stage by stage |
| **[DEPLOYMENT.md](DEPLOYMENT.md)** | Local vs AWS, and the nine destroyability decisions |
| **[RUNBOOK.md](RUNBOOK.md)** | Operating it: ports, health, common failures |
| **[DEMO.md](DEMO.md)** | The guided walkthrough |

---

## Commands

```bash
make help          # everything, with descriptions
make up            # start the stack
make ports         # live host port per service
make demo          # reset transactional state for a clean run
make test          # 42 tests — unit, integration, authz, regression, strangler
make test-chaos    # kills containers mid-flow, asserts the ledger still balances
make load-all      # RabbitMQ load suite — watch the retry ladder in Grafana
make sagas         # every saga instance and its steps
make strangler     # migration stage and divergence rate
make down          # stop, keep data
make nuke          # stop and delete data
make aws-validate  # validate all Terraform + Kubernetes manifests offline
```

---

## Honest notes

Things a reviewer should know without having to find them:

- **`db-workorders` has two writers.** `ingest` inserts work orders and
  `work-orders` updates their status; `api` reads. One schema, three services,
  no contract — the bounded context there is nominal. The fix is the CQRS
  machinery already built for assignments, applied one level up.
- **No schema registry.** Events carry a `version` field and compatibility rests
  on discipline. `libs/pyevents` reimplements the TypeScript contract by hand
  with nothing detecting drift, and event sourcing makes any drift permanent.
- **No distributed tracing.** Correlation IDs give log correlation, which
  answers *what happened* but not *where the time went*.
- **The outbox relay polls at one second**, which is a latency floor nothing
  else needs. Change-data-capture is the upgrade.
- **The AWS stack has never been applied.** The Terraform validates, `tflint`
  and `checkov` pass in CI, and the teardown tooling is written — but it has not
  been run against a real account.

More detail on each in [ARCHITECTURE.md](ARCHITECTURE.md#11-known-gaps).

---

Passwords in this repository (`fn` / `fn`, `Passw0rd!`, the dev JWT secret) are
local development defaults and are intentionally committed. Nothing here
authenticates against anything real. On AWS every credential is generated by
Terraform into Secrets Manager and delivered to pods over IRSA.
