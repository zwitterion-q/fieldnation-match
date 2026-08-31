#!/usr/bin/env bash
# =============================================================================
# Circuit breaker drill.
#
# Trips the breaker by taking the dependency down for real — no simulation, no
# forceOpen(). The legacy read path lives in the `api` container; stop it, hit
# the strangler endpoint, and the breaker sees three genuine failures and opens.
# Start it again and watch open → half_open → closed.
#
# Watch it happen:  Grafana → "Circuit breaker state"  (5s refresh)
#
#   ./scripts/breaker-drill.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

B=http://localhost:55173
WO=${WO:-$(docker compose exec -T db-workorders psql -U fn -d workorders -tAc \
      "SELECT work_order_id FROM work_orders WHERE status='open' LIMIT 1;" | tr -d ' ')}

state() { python3 scripts/breaker-state.py; }
hit()   { for _ in $(seq 1 "$1"); do curl -s -o /dev/null "$B/wo/strangler/work-orders/$WO"; done; }
say()   { printf "  %s\n" "$*"; }
head()  { printf "\n\033[1m%s\033[0m\n" "$*"; }

head "0 · baseline — dependency healthy"
hit 3; say "$(state)"

head "1 · take the dependency down (docker compose stop api)"
docker compose stop api >/dev/null 2>&1
say "api stopped — every legacy call will now fail"

head "2 · three requests · threshold is 3"
for i in 1 2 3; do hit 1; printf "  request %d → %s\n" "$i" "$(state)"; done

head "3 · breaker is OPEN — further calls fail instantly, no load on the dependency"
hit 10
say "$(state)"
say "note short_circuited climbing while failures does not — that is the point:"
say "it stopped calling, so it stopped burning a timeout per request"

head "4 · bring the dependency back"
docker compose start api >/dev/null 2>&1
say "api starting…"
until curl -sf --max-time 2 http://localhost:58000/health >/dev/null 2>&1; do sleep 1; done
say "api healthy again — but the breaker is still open until the 10s cooldown"

head "5 · cooldown, then ONE probe"
for t in 4 8 11 13 15; do
  sleep 2
  hit 1
  printf "  t+%-3ss  %s\n" "$t" "$(state)"
done

head "6 · closed again"
hit 3; say "$(state)"
printf "\n  Grafana: http://localhost:43000/d/fn-platform — 'Circuit breaker state'\n"
printf "  0 = closed   1 = half_open   2 = open\n\n"
