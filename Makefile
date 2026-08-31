# Field Nation matching + dispatch platform
# Every target is idempotent. `make help` lists them.

SHELL       := /bin/bash
COMPOSE     := docker compose
INFRA       := db-workorders db-technicians db-identity db-payments qdrant rabbitmq
APPS        := api identity work-orders payments web-buyer web-tech
OBS         := prometheus grafana pg-exporter-workorders pg-exporter-payments
PROJECT_DIR := $(shell pwd)

.DEFAULT_GOAL := help
.PHONY: help bootstrap check-deps up down restart build rebuild infra apps seed ingest reset logs ps status \
        demo-data health creds open rabbit topology psql-wo psql-tech psql-identity psql-pay qdrant-collections clean nuke check-docker

# ---------------------------------------------------------------- meta ------
help: ## Show this help
	@echo ""
	@echo "  Field Nation platform — make targets"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo ""

bootstrap: ## First run on a new machine — installs everything, then starts it
	@./install.sh

check-deps: ## Check this machine has every dependency, change nothing
	@./install.sh --check

check-docker: ## Fail fast with a useful message if the daemon is down
	@docker info >/dev/null 2>&1 || { \
	  echo "Docker daemon is not running. Start Docker Desktop and retry."; exit 1; }

# ---------------------------------------------------------------- build ----
build: check-docker ## Build all service images
	$(COMPOSE) build

rebuild: check-docker ## Rebuild all images without cache
	$(COMPOSE) build --no-cache

# ---------------------------------------------------------------- run ------
infra: check-docker ## Start datastores + broker, wait until healthy
	$(COMPOSE) up -d $(INFRA)
	@echo "waiting for infrastructure to report healthy..."
	@for i in $$(seq 1 60); do \
	  n=$$($(COMPOSE) ps --format '{{.Health}}' | grep -c healthy || true); \
	  if [ "$$n" -ge 6 ]; then echo "  infrastructure healthy"; exit 0; fi; \
	  sleep 3; \
	done; echo "  timed out waiting for health"; $(COMPOSE) ps; exit 1

apps: check-docker ## Start application services
	$(COMPOSE) up -d $(APPS)

obs: check-docker ## Start Prometheus, Grafana and the Postgres exporters
	$(COMPOSE) up -d $(OBS)

grafana: ## Open Grafana
	@open http://localhost:43000 || true
	@echo "  Grafana     http://localhost:43000  (fn/fn, anonymous viewing enabled)"
	@echo "  Prometheus  http://localhost:49090"

up: infra apps obs ## Start everything
	@$(MAKE) --no-print-directory status

down: ## Stop everything, keep data
	$(COMPOSE) down

restart: down up ## Stop and start

# ---------------------------------------------------------------- data -----
ingest: check-docker ## Run the ingestion pipeline (sources -> normalise -> vectors)
	$(COMPOSE) run --rm ingest python -m pipeline --all

seed-identity: check-docker ## Seed roles, permissions and ~30 logins -> CREDENTIALS.md
	$(COMPOSE) run --rm identity-seed

fund: check-docker ## Fund hirer accounts with opening deposits
	$(COMPOSE) run --rm payments-fund

seed: ingest seed-identity fund ## Build all data, accounts and balances

reset: check-docker ## Destroy all data and rebuild from scratch
	$(COMPOSE) down -v
	@$(MAKE) --no-print-directory infra
	@$(MAKE) --no-print-directory ingest
	@$(MAKE) --no-print-directory apps
	@$(MAKE) --no-print-directory seed-identity
	@$(MAKE) --no-print-directory status

# ---------------------------------------------------------------- inspect --
ports: ## Print the LIVE host port for every service (ranges move between runs)
	@python3 scripts/ports.py

ps: ## Container status
	@$(COMPOSE) ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

status: ps health ## Containers plus API health

health: ## API health probe
	@curl -s --max-time 5 http://localhost:58000/health | python3 -m json.tool 2>/dev/null \
	  || echo "  api not responding yet"

logs: ## Tail logs for all services (SVC=name to narrow)
	$(COMPOSE) logs -f --tail=100 $(SVC)

topology: ## Show the declared RabbitMQ topology
	@echo "exchanges:"; docker exec fieldnation-match-rabbitmq-1 rabbitmqctl list_exchanges name type 2>/dev/null | grep fieldnation || true
	@echo ""; echo "queues (name / messages / consumers):"
	@docker exec fieldnation-match-rabbitmq-1 rabbitmqctl list_queues name messages consumers 2>/dev/null | grep '^q\.' || true

rabbit: ## Open the RabbitMQ management UI
	@open http://localhost:45672 || echo "  http://localhost:45672  (fn / fn)"

qdrant-collections: ## List Qdrant collections and vector counts
	@curl -s http://localhost:56333/collections | python3 -c "import json,sys;\
	  [print(f\"  {c['name']}\") for c in json.load(sys.stdin)['result']['collections']]"

psql-wo: ## psql shell into the work-orders database
	$(COMPOSE) exec db-workorders psql -U fn -d workorders

psql-tech: ## psql shell into the technicians database
	$(COMPOSE) exec db-technicians psql -U fn -d technicians

psql-identity: ## psql shell into the identity database
	@$(COMPOSE) exec db-identity psql -U fn -d identity

psql-pay: ## psql shell into the payments database (the ledger)
	@$(COMPOSE) exec db-payments psql -U fn -d payments

creds: ## Print seeded login credentials
	@cat CREDENTIALS.md 2>/dev/null || echo "  CREDENTIALS.md not generated yet — run 'make seed'"

# ------------------------------------------------------------------ tests ---
test-unit: ## Fast unit tests — no infrastructure needed
	@cd services/work-orders && npx jest --silent
	@cd services/payments && npx jest --silent

test-int: ## Integration + authorization tests against the live stack
	@cd tests && python3 -m pytest test_dispatch_saga.py test_authorization.py

test-regress: ## Regression tests for bugs that actually happened
	@cd tests && python3 -m pytest test_regressions.py

test-strangler: ## Prove the two implementations agree and rollback works
	@cd tests && python3 -m pytest test_strangler.py

test-chaos: ## Failure injection — kills and restarts containers
	@cd tests && python3 -m pytest test_chaos.py -m chaos

test: test-unit test-int test-regress test-strangler ## Everything except chaos

test-all: test test-chaos ## Everything, including container kills

# ------------------------------------------------------------- load tests ---
LOAD := python3 loadtest/harness.py

load-burst: ## 50k messages, no consumer, then drain with 4 competing consumers
	@$(LOAD) burst --count 50000 --drain --work-ms 0.5

load-heavy: ## 200k messages — sustained queue depth for the Grafana panels
	@$(LOAD) burst --count 200000 --drain --work-ms 0.2 --timeout 300

load-backpressure: ## Same load at prefetch 1 vs 100 — shows the throughput trade
	@$(LOAD) backpressure --count 8000 --workers 4 --work-ms 1.0 --prefetch 100

load-retry: ## Messages that always fail — watch r1 -> r2 -> r3 escalate
	@$(LOAD) retry-storm --count 300

load-sustained: ## Steady 400/s for 90s with live consumers
	@$(LOAD) sustained --rate 400 --duration 90 --workers 4 --work-ms 1

load-purge: ## Clear every load-test queue
	@$(LOAD) purge

load-all: load-burst load-backpressure load-retry load-purge ## Run the full suite

# ---------------------------------------------------------- rabbitmq labs ---
scale-up: check-docker ## Scale notifications-style consumers to 3 (competing consumers)
	$(COMPOSE) up -d --scale work-orders=3 --no-recreate work-orders
	@echo "  3 work-orders replicas competing on the same queues"
	@sleep 4
	@docker exec fieldnation-match-rabbitmq-1 rabbitmqctl -q list_queues name consumers 2>/dev/null \
	  | grep '^q.workorders' | sed 's/^/    /'

scale-down: check-docker ## Back to a single replica
	$(COMPOSE) up -d --scale work-orders=1 --no-recreate work-orders

kill-one: check-docker ## Kill one consumer replica and watch redistribution
	@id=$$(docker ps --filter name=fieldnation-match-work-orders --format '{{.ID}}' | head -1); \
	 echo "  killing $$id"; docker kill $$id >/dev/null
	@sleep 5
	@docker exec fieldnation-match-rabbitmq-1 rabbitmqctl -q list_queues name consumers 2>/dev/null \
	  | grep '^q.workorders' | sed 's/^/    /'

exchanges: check-docker ## Show all four exchange types and what each routes
	@docker exec fieldnation-match-rabbitmq-1 rabbitmqctl -q list_exchanges name type 2>/dev/null \
	  | grep fieldnation | sed 's/^/    /'

strangler: check-docker ## Show the current migration stage and divergence rate
	@curl -s localhost:55173/wo/strangler/status | python3 -m json.tool

sagas: check-docker ## Show every saga instance and its steps
	@curl -s "localhost:55173/wo/sagas?limit=10" | python3 -m json.tool

sac: check-docker ## Show which queues enforce ordering via Single Active Consumer
	@docker exec fieldnation-match-rabbitmq-1 rabbitmqctl -q list_queues name arguments consumers 2>/dev/null \
	  | grep single-active | sed 's/^/    /'

demo-data: check-docker ## Build rich demo state — every status, a 3-offer work order, a full ledger (~2 min)
	@python3 scripts/demo-data.py

demo: check-docker ## Reset transactional state for a clean demo (keeps work orders + accounts)
	@$(COMPOSE) exec -T db-payments psql -U fn -d payments -qc \
	  "DELETE FROM ledger_entries; DELETE FROM ledger_transactions; DELETE FROM holds; \
	   DELETE FROM accounts; DELETE FROM outbox; DELETE FROM processed_messages;" >/dev/null
	@$(COMPOSE) exec -T db-workorders psql -U fn -d workorders -qc \
	  "DELETE FROM outbox; DELETE FROM assignments; DELETE FROM processed_messages; \
	   DELETE FROM saga_steps; DELETE FROM saga_instances; \
	   DELETE FROM event_store; TRUNCATE assignment_projection; \
	   UPDATE projection_checkpoint SET last_sequence=0, events_applied=0; \
	   UPDATE work_orders SET status='open' WHERE status='assigned';" >/dev/null
	@for q in $$(docker exec fieldnation-match-rabbitmq-1 rabbitmqctl -q list_queues name 2>/dev/null | grep '^q\.'); do \
	   curl -s -u fn:fn -X DELETE "http://localhost:45672/api/queues/%2F/$$q/contents" >/dev/null; done
	@$(COMPOSE) run --rm payments-fund >/dev/null 2>&1
	@echo "  demo state reset — hirers funded, no assignments, queues drained"

open: ## Open both frontends and the API docs
	@open http://localhost:55173 http://localhost:55174 http://localhost:58000/docs 2>/dev/null || true
	@echo "  buyer      http://localhost:55173"
	@echo "  technician http://localhost:55174"
	@echo "  api docs   http://localhost:58000/docs"
	@echo "  rabbitmq   http://localhost:45672  (fn/fn)"
	@echo "  grafana    http://localhost:43000  (fn/fn)"
	@echo "  prometheus http://localhost:49090"
	@echo "  qdrant     http://localhost:56333/dashboard"

# ---------------------------------------------------------------- clean ----
clean: ## Remove containers and networks, keep volumes
	$(COMPOSE) down --remove-orphans

nuke: ## Remove containers, networks AND all data volumes
	$(COMPOSE) down -v --remove-orphans

# ============================================================================
# The second deployment target.
#
# Everything above this line runs the platform on this machine with
# docker-compose. Everything below hands off to deploy/Makefile, which runs the
# same application on AWS -- EKS, RDS, Amazon MQ, ALB.
#
# The two are deliberately separate files rather than one file with an
# environment flag. A flag would imply they are the same deployment configured
# differently; they are not. Local trades durability for speed (containers,
# ephemeral volumes, plaintext AMQP, a hardcoded dev JWT secret). AWS trades
# speed for the properties you need when other people depend on it (managed
# datastores, TLS-only AMQP, generated secrets delivered by IRSA, multi-AZ
# scheduling). Keeping them apart keeps both honest. See DEPLOYMENT.md.
# ============================================================================
.PHONY: aws aws-up aws-down aws-status aws-cost aws-validate

aws: ## Show the AWS deployment targets
	@$(MAKE) -C deploy help

aws-up: ## Deploy to AWS  (~25 min, ~USD 0.27/hour while running)
	@$(MAKE) -C deploy up

aws-down: ## Destroy the AWS deployment and prove nothing is left billing
	@$(MAKE) -C deploy down

aws-status: ## Pods, nodes and ingress on AWS
	@$(MAKE) -C deploy status

aws-cost: ## What the AWS deployment costs while it runs
	@$(MAKE) -C deploy cost

aws-validate: ## Validate all Terraform and Kubernetes manifests — no AWS account needed
	@$(MAKE) -C deploy validate
