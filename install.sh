#!/usr/bin/env bash
# =============================================================================
# fieldnation-match — one-command setup.
#
#   ./install.sh
#
# Checks for every dependency, installs whatever is missing, starts the stack,
# seeds the data and opens the consoles. Safe to re-run: every step is a check
# first and an action only if the check fails.
#
#   ./install.sh --check    verify this machine is ready, change nothing
#   ./install.sh --no-open  set everything up but do not open a browser
#
# Supported: macOS (Intel + Apple Silicon) and Linux (apt / dnf / pacman).
# Windows is not supported; use WSL2 and run this inside it.
# =============================================================================
set -uo pipefail

CHECK_ONLY=0; NO_OPEN=0
for a in "$@"; do
  case "$a" in
    --check)    CHECK_ONLY=1 ;;
    --no-open)  NO_OPEN=1 ;;
    -h|--help)
      cat <<'USAGE'

  fieldnation-match — one-command setup

    ./install.sh              check every dependency, install what is missing,
                              build, start, seed, and open the consoles
    ./install.sh --check      verify this machine is ready; change nothing
    ./install.sh --no-open    set everything up without opening a browser
    ./install.sh --help       this message

  Safe to re-run: every step checks before it acts.
  macOS and Linux (apt / dnf / pacman). Windows: use WSL2.

USAGE
      exit 0 ;;
    *)          echo "unknown option: $a  (try --help)"; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO" || exit 1

# ── output ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else B=""; D=""; R=""; G=""; Y=""; C=""; N=""; fi

step()  { printf "\n${B}%s${N}\n" "$*"; }
ok()    { printf "  ${G}✓${N} %s\n" "$*"; }
info()  { printf "  ${D}·${N} %s\n" "$*"; }
warn()  { printf "  ${Y}!${N} %s\n" "$*"; }
die()   { printf "  ${R}✗${N} %s\n\n" "$*"; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

banner() {
cat <<'ART'
  ┌──────────────────────────────────────────────────────────────┐
  │  fieldnation-match                                           │
  │  work-order ↔ technician matching + dispatch platform        │
  └──────────────────────────────────────────────────────────────┘
ART
}

# ── platform ─────────────────────────────────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux)  OS=linux ;;
    *)      die "unsupported OS: $(uname -s). macOS or Linux only (Windows: use WSL2)." ;;
  esac
  if [ "$OS" = linux ]; then
    if   have apt-get; then PKG=apt
    elif have dnf;     then PKG=dnf
    elif have pacman;  then PKG=pacman
    else die "no supported package manager found (need apt, dnf or pacman)."; fi
  else
    PKG=brew
  fi
  ok "$OS ($(uname -m))${PKG:+, package manager: $PKG}"
}

SUDO=""
need_sudo() {
  [ "$(id -u)" -eq 0 ] && return 0
  have sudo || die "this step needs root and sudo is not installed."
  SUDO=sudo
}

pkg_install() {  # pkg_install <name-for-humans> <apt> <dnf> <pacman>
  local human=$1 a=$2 d=$3 p=$4
  info "installing $human…"
  case "$PKG" in
    apt)    need_sudo; $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$a" ;;
    dnf)    need_sudo; $SUDO dnf install -y -q "$d" ;;
    pacman) need_sudo; $SUDO pacman -Sy --noconfirm --quiet "$p" ;;
    brew)   brew install "$a" ;;
  esac
}

# ── 1. homebrew (macOS only) ─────────────────────────────────────────────────
ensure_brew() {
  [ "$OS" = macos ] || return 0
  if have brew; then ok "homebrew $(brew --version | head -1 | awk '{print $2}')"; return; fi
  warn "homebrew not found — installing (this will ask for your password)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || die "homebrew install failed. Install it manually: https://brew.sh"
  # Apple Silicon puts brew in /opt/homebrew, which is not on PATH until a new shell.
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ]    && eval "$(/usr/local/bin/brew shellenv)"
  have brew && ok "homebrew installed" || die "homebrew installed but not on PATH — open a new terminal and re-run."
}

# ── 2. base tools ────────────────────────────────────────────────────────────
ensure_base() {
  for t in curl git make; do
    if have "$t"; then ok "$t"
    else pkg_install "$t" "$t" "$t" "$t"; have "$t" && ok "$t installed" || die "could not install $t"; fi
  done

  if have python3; then
    ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"
  else
    pkg_install python3 python3 python3 python
    have python3 && ok "python3 installed" || die "could not install python3"
  fi
}

# ── 3. docker ────────────────────────────────────────────────────────────────
ensure_docker() {
  if have docker; then
    ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
  elif [ "$OS" = macos ]; then
    warn "Docker Desktop not found — installing via homebrew (needs your password)"
    brew install --cask docker || die "Docker Desktop install failed. Get it from https://docker.com/products/docker-desktop"
    ok "Docker Desktop installed"
  else
    warn "docker not found — installing"
    need_sudo
    case "$PKG" in
      apt)    $SUDO apt-get update -qq
              $SUDO apt-get install -y -qq docker.io docker-compose-plugin ;;
      dnf)    $SUDO dnf install -y -q docker docker-compose-plugin ;;
      pacman) $SUDO pacman -Sy --noconfirm --quiet docker docker-compose ;;
    esac
    have docker || die "could not install docker."
    $SUDO systemctl enable --now docker 2>/dev/null || true
    if ! groups | grep -qw docker; then
      $SUDO usermod -aG docker "$USER" 2>/dev/null && \
        warn "added you to the 'docker' group — log out and back in, then re-run this script"
    fi
    ok "docker installed"
  fi

  # compose v2 ships as a docker plugin; v1 was a separate binary.
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose $(docker compose version --short 2>/dev/null)"
  elif have docker-compose; then
    die "found docker-compose v1. This project needs Compose v2 ('docker compose'). Upgrade Docker."
  else
    [ "$OS" = linux ] && pkg_install "docker compose plugin" docker-compose-plugin docker-compose-plugin docker-compose
    docker compose version >/dev/null 2>&1 || die "docker compose v2 not available."
  fi
}

# ── 4. docker daemon running ─────────────────────────────────────────────────
ensure_daemon() {
  if docker info >/dev/null 2>&1; then ok "docker daemon running"; return; fi

  if [ "$OS" = macos ]; then
    info "starting Docker Desktop…"
    open -a Docker 2>/dev/null || die "could not launch Docker Desktop — open it manually and re-run."
  else
    info "starting the docker service…"
    need_sudo; $SUDO systemctl start docker 2>/dev/null || true
  fi

  printf "  ${D}·${N} waiting for the daemon"
  for _ in $(seq 1 90); do
    if docker info >/dev/null 2>&1; then printf "\r"; ok "docker daemon running                    "; return; fi
    printf "."; sleep 2
  done
  printf "\n"
  die "docker daemon did not come up in 3 minutes. Start Docker manually and re-run."
}

# ── 5. python tooling for tests + load tests (in a venv, never system-wide) ──
ensure_python_env() {
  # PEP 668 marks system Pythons as externally managed, so pip install would
  # refuse anyway. A venv inside the repo keeps the host untouched and is
  # gitignored.
  if [ ! -d .venv ]; then
    info "creating .venv…"
    python3 -m venv .venv 2>/dev/null || {
      [ "$PKG" = apt ] && pkg_install "python3-venv" python3-venv python3-venv python
      python3 -m venv .venv || { warn "could not create a venv — tests will be unavailable, the demo is unaffected"; return; }
    }
  fi
  # shellcheck disable=SC1091
  . .venv/bin/activate
  python -m pip install -q --upgrade pip >/dev/null 2>&1
  python -m pip install -q pytest requests pika >/dev/null 2>&1 \
    && ok "python test deps (pytest, requests, pika) in .venv" \
    || warn "python deps failed — the demo still works, 'make test-int' will not"
}

# ── 6. node deps for the two Jest suites (optional) ──────────────────────────
ensure_node_deps() {
  if ! have npm; then
    info "npm not present — skipping unit-test deps (the demo does not need them)"
    return
  fi
  for s in work-orders payments; do
    if [ -d "services/$s/node_modules" ]; then
      ok "services/$s deps present"
    else
      info "installing services/$s deps for the Jest suite…"
      (cd "services/$s" && npm ci --silent >/dev/null 2>&1 || npm install --silent >/dev/null 2>&1) \
        && ok "services/$s deps installed" \
        || warn "services/$s deps failed — 'make test-unit' will not run; everything else is fine"
    fi
  done
}

# ── 7. env file ──────────────────────────────────────────────────────────────
ensure_env() {
  if [ -f .env ]; then
    ok ".env present"
  elif [ -f .env.example ]; then
    cp .env.example .env && ok ".env created from .env.example" \
      || die "could not write .env — check permissions in $REPO"
  else
    # Nothing to copy is survivable: every variable the compose file reads has
    # a default, so the stack starts without a .env at all.
    warn "no .env.example found — continuing without a .env (all keys are optional)"
  fi
  info "every key in it is optional — the pipeline falls back to deterministic rules without an LLM"
}

# ── 8. build and start ───────────────────────────────────────────────────────
bring_up() {
  info "building images (first run pulls ~2GB and takes 5–10 minutes)…"
  docker compose build --quiet 2>&1 | grep -viE "^$|warn" | tail -3
  make up
}

seed() {
  if docker compose exec -T db-workorders psql -U fn -d workorders -tAc \
       "SELECT count(*) FROM work_orders" 2>/dev/null | tr -d ' ' | grep -qvE '^0?$'; then
    ok "data already present — skipping seed (use 'make reset' to rebuild it)"
  else
    info "seeding: ingestion pipeline, 71 logins, funded hirer accounts (3–5 min)…"
    make seed
  fi
}

wait_healthy() {
  printf "  ${D}·${N} waiting for the API"
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 3 http://localhost:58000/health >/dev/null 2>&1; then
      printf "\r"; ok "api healthy                    "; return 0
    fi
    printf "."; sleep 3
  done
  printf "\n"; warn "api did not answer in 3 minutes — check 'docker compose logs api'"
  return 1
}

open_portals() {
  local urls=(
    "http://localhost:55173"
    "http://localhost:55174"
    "http://localhost:58000/docs"
    "http://localhost:43000/d/fn-platform/field-nation-e28094-platform?orgId=1&refresh=5s"
    "http://localhost:49090/targets"
    "http://localhost:45672/#/queues"
    "http://localhost:56333/dashboard"
  )
  local opener=""
  if   [ "$OS" = macos ] && have open;      then opener="open"
  elif have xdg-open;                       then opener="xdg-open"
  fi
  if [ -z "$opener" ]; then
    warn "no browser opener found — the URLs are listed below"
    return
  fi
  info "opening the consoles…"
  for u in "${urls[@]}"; do "$opener" "$u" >/dev/null 2>&1; sleep 0.4; done
}

summary() {
cat <<EOF

${B}Everything is up.${N}

  ${C}Hirer console${N}       http://localhost:55173   post work, pick a technician, dispatch
  ${C}Technician app${N}      http://localhost:55174   accept or reject, submit for approval
  ${C}Matching API${N}        http://localhost:58000/docs
  ${C}Grafana${N}             http://localhost:43000   fn / fn
  ${C}Prometheus${N}          http://localhost:49090
  ${C}RabbitMQ${N}            http://localhost:45672   fn / fn
  ${C}Qdrant${N}              http://localhost:56333/dashboard

  ${B}Log in with${N}   hirer@vertex.hospitality.test   ${D}/${N}  Passw0rd!
                 yusuf.quinn.1@tech.test          ${D}/${N}  Passw0rd!
  All 71 accounts are in CREDENTIALS.md.

  ${B}Next${N}
    make ports     live host port for every service
    make demo      reset transactional state for a clean run
    make test      the full test suite
    make down      stop everything (keeps the data)
    make nuke      stop and delete the data too

  ${B}Start here${N}  README.md  →  DEMO.md  →  ARCHITECTURE.md

EOF
}

# ── run ──────────────────────────────────────────────────────────────────────
banner
step "1/8  platform";        detect_platform
step "2/8  package manager"; ensure_brew
step "3/8  base tools";      ensure_base
step "4/8  docker";          ensure_docker; ensure_daemon

if [ "$CHECK_ONLY" = 1 ]; then
  # Everything above is read-only or installs a missing OS package. Stop here
  # so `--check` can answer "is this machine ready" without touching the repo.
  printf "\n  ${G}This machine is ready.${N} Run ${B}./install.sh${N} to build and start.\n\n"
  exit 0
fi

step "5/8  test tooling";    ensure_python_env; ensure_node_deps
step "6/8  configuration";   ensure_env
step "7/8  build and start"; bring_up
step "8/8  data";            seed
wait_healthy && { [ "$NO_OPEN" = 1 ] || open_portals; }
summary
