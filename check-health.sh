#!/usr/bin/env bash
# ─────────────────────────────────────────────
#  Dock Tools — Post-Restart Health Check
#  Usage:  bash check-health.sh
#  Run this after rebooting the VM/host to confirm the whole stack
#  (manager, nginx, ollama, health-checker, and any script containers)
#  came back up cleanly.
# ─────────────────────────────────────────────
set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
FAIL=0

info() { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()   { echo -e "${GREEN}[ OK ]${RESET}  $*"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}[FAIL]${RESET}  $*"; FAIL=$((FAIL + 1)); }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }
step() { echo -e "\n${BOLD}▶ $*${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
MANAGER_PORT="${MANAGER_PORT:-8484}"

CORE_SERVICES=(script-manager script-nginx ollama health-checker)

# ─── Docker daemon ────────────────────────────
step "Docker daemon"
if docker info >/dev/null 2>&1; then
  ok "Docker daemon is responding"
else
  fail "Docker daemon is not responding — is it running? (systemctl status docker)"
  echo -e "\n${BOLD}Summary: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET}"
  exit 1
fi

# ─── Core compose services ───────────────────
step "Core services"
for name in "${CORE_SERVICES[@]}"; do
  status=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "missing")
  if [ "$status" = "missing" ]; then
    fail "$name container not found — was 'docker compose up -d' run in this directory?"
    continue
  fi
  if [ "$status" != "running" ]; then
    fail "$name is '$status' (expected running) — check: docker compose logs $name"
    continue
  fi
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null)
  case "$health" in
    unhealthy) fail "$name is running but reports unhealthy — check: docker compose logs $name" ;;
    starting)  warn "$name health check still starting — recheck in ~30s"; ok "$name is running" ;;
    none)      ok "$name is running" ;;
    *)         ok "$name is running (health: $health)" ;;
  esac
done

# ─── Manager reachability (through nginx) ────
step "Manager reachability"
if curl -sf --max-time 5 "http://localhost:${MANAGER_PORT}/healthz" >/dev/null; then
  ok "http://localhost:${MANAGER_PORT}/healthz responded"
else
  fail "http://localhost:${MANAGER_PORT}/healthz did not respond — check: docker compose logs manager nginx"
fi

# ─── Script containers ───────────────────────
step "Script containers"
CORE_PATTERN="^($(IFS='|'; echo "${CORE_SERVICES[*]}"))\$"
FOUND_SCRIPT=0
while IFS= read -r c; do
  [ -z "$c" ] && continue
  FOUND_SCRIPT=1
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)
  if [ "$st" = "running" ]; then
    ok "script '$c' is running"
  else
    warn "script '$c' is '$st' — expected for a scheduled script between runs, otherwise check its Scripts tab card"
  fi
done < <(docker ps -a --filter "network=script-network" --format '{{.Names}}' | grep -Ev "$CORE_PATTERN")
if [ "$FOUND_SCRIPT" -eq 0 ]; then
  info "No script containers found (none added yet, or all cron-only awaiting their next run)"
fi

# ─── Ollama models ────────────────────────────
step "Ollama"
if docker inspect ollama >/dev/null 2>&1; then
  if curl -sf --max-time 5 http://localhost:11434/api/tags >/dev/null; then
    MODEL_COUNT=$(curl -s http://localhost:11434/api/tags | grep -o '"name"' | wc -l | tr -d ' ')
    ok "Ollama API responded ($MODEL_COUNT model(s) loaded)"
  else
    fail "ollama container is up but the API on :11434 did not respond"
  fi
else
  info "ollama container not found — skipping"
fi

# ─── Docker Health Check addon ────────────────
step "Docker Health Check addon"
if docker inspect health-checker >/dev/null 2>&1; then
  if docker exec health-checker crontab -l 2>/dev/null | grep -q "docker compose up -d"; then
    ok "Auto-restart cron job is installed in health-checker"
  else
    warn "No auto-restart cron job found in health-checker (install it from Admin → Addons if you want it)"
  fi
fi

# ─── Summary ──────────────────────────────────
step "Summary"
echo -e "${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET}"
if [ "$FAIL" -gt 0 ]; then
  echo -e "${YELLOW}Something needs attention — try: docker compose up -d, then re-run this script.${RESET}"
  exit 1
fi
echo -e "${GREEN}Everything looks healthy.${RESET}"
exit 0
