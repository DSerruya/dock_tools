#!/usr/bin/env bash
# ─────────────────────────────────────────────
#  Dock Tools — SQL-over-VPN MTU / PMTUD Diagnostic
#  Usage:  bash check-sql-vpn-mtu.sh -h <db-host> -P <db-port> -d <database> -u <username> [-w <password>] [-q <query>]
#
#  Piggybacks on the "admin-sqltest" container the Admin -> SQL Test feature
#  already manages — start a test from the Web UI first (upload the .ovpn,
#  fill in the connection fields, click Run) just to get the VPN connected;
#  this script does its own queries once that container is up.
#
#  Checks (matches the "SQL-over-VPN test hangs after login" runbook):
#    1. Interface MTUs on this host and inside the VPN/SQL container
#    2. Path-MTU-Discovery: ping -M do at decreasing payload sizes
#    3. SELECT 1 (tiny response) vs. a larger query (bigger response),
#       to correlate failure with response size rather than auth/port
#
#  MSSQL/bsqldb only, matching the app's own SQL-over-VPN test client.
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

CONTAINER="admin-sqltest"
DB_HOST=""
DB_PORT=""
DB_NAME=""
DB_USER=""
DB_PASS="${SQLT_PASSWORD:-}"
CUSTOM_QUERY=""
DEFAULT_QUERY="SELECT top 50 name, object_id FROM sys.objects"
MTU_PROBE_SIZES=(1472 1400 1372 1300 1200)

usage() {
  echo "Usage: $0 -h <db-host> -P <db-port> -d <database> -u <username> [-w <password>] [-q <query>]"
  echo "  Password can also be supplied via the SQLT_PASSWORD env var (preferred — keeps it out of shell history)."
  exit 1
}

while getopts "h:P:d:u:w:q:" opt; do
  case "$opt" in
    h) DB_HOST="$OPTARG" ;;
    P) DB_PORT="$OPTARG" ;;
    d) DB_NAME="$OPTARG" ;;
    u) DB_USER="$OPTARG" ;;
    w) DB_PASS="$OPTARG" ;;
    q) CUSTOM_QUERY="$OPTARG" ;;
    *) usage ;;
  esac
done

if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then
  usage
fi
if [ -z "$DB_PASS" ]; then
  read -r -s -p "Password for ${DB_USER}: " DB_PASS
  echo
fi

QUERY="${CUSTOM_QUERY:-$DEFAULT_QUERY}"

# ─── Precondition: the VPN/SQL container must already be up ──────────────
step "Precondition"
if ! docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null | grep -q running; then
  fail "$CONTAINER is not running — start a test from Admin -> SQL Test first (upload the .ovpn, fill in connection details, click Run) so the VPN tunnel is up, then re-run this script."
  echo -e "\n${BOLD}Summary: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET}"
  exit 1
fi
ok "$CONTAINER is running"

# ─── 1. Interface MTUs ────────────────────────────────────────────────────
step "1. Interface MTUs"
info "This host:"
if command -v ip >/dev/null 2>&1; then
  ip link show 2>&1 | sed 's/^/    /'
else
  echo "    (no 'ip' binary on this host — skipping; not expected on the target Linux VM)"
fi
info "Inside $CONTAINER (look at tun0 — almost always lower than eth0):"
docker exec "$CONTAINER" ip link show 2>&1 | sed 's/^/    /'
ok "Collected interface MTUs (compare tun0's value against a run on a machine where this works)"

# ─── 2. Path-MTU-Discovery probe ──────────────────────────────────────────
step "2. Path MTU (ping -M do, stepping down until one gets through)"
mtu_ok=""
for size in "${MTU_PROBE_SIZES[@]}"; do
  mtu=$((size + 28))
  out=$(docker exec "$CONTAINER" ping -M do -c 3 -w 5 -s "$size" "$DB_HOST" 2>&1)
  if echo "$out" | grep -qE '\b0(\.0)?% packet loss\b' && echo "$out" | grep -qi 'bytes from'; then
    ok "${size}-byte payload (MTU ${mtu}) got through cleanly"
    mtu_ok="$mtu"
    break
  fi
  if echo "$out" | grep -qi 'bytes from'; then
    warn "${size}-byte payload (MTU ${mtu}) got a reply but with loss/errors"
  else
    fail "${size}-byte payload (MTU ${mtu}) — no ICMP response at all (silent drop; PMTUD likely blocked on this path)"
  fi
done
if [ -z "$mtu_ok" ]; then
  last_idx=$((${#MTU_PROBE_SIZES[@]} - 1))
  fail "No payload size down to $((MTU_PROBE_SIZES[last_idx] + 28)) got through — real path MTU may be even smaller, or ICMP is fully blocked either way"
fi

# ─── 3. SELECT 1 vs. the real/larger query ────────────────────────────────
step "3. SELECT 1 (tiny response) vs. larger query (bigger response)"

run_query() {
  local label="$1" q="$2"
  docker exec \
    -e SQLT_HOST="$DB_HOST" -e SQLT_PORT="$DB_PORT" -e SQLT_DB="$DB_NAME" \
    -e SQLT_USER="$DB_USER" -e SQLT_PASS="$DB_PASS" -e SQLT_Q="$q" \
    "$CONTAINER" sh -c '
      grep -q "\[mtuprobe\]" /etc/freetds.conf 2>/dev/null || cat >> /etc/freetds.conf <<CONF
[mtuprobe]
    host = $SQLT_HOST
    port = $SQLT_PORT
    tds version = auto
CONF
      printf "%s\ngo\n" "$SQLT_Q" | bsqldb -S mtuprobe -D "$SQLT_DB" -U "$SQLT_USER" -P "$SQLT_PASS" -t "\t" -v
    ' >/tmp/mtuprobe_out.$$ 2>&1
  local code=$?
  if [ "$code" -eq 0 ]; then
    ok "$label succeeded"
  else
    fail "$label failed (exit $code) — see /tmp/mtuprobe_out.$$ on this host for the FreeTDS trace"
    return 1
  fi
  rm -f "/tmp/mtuprobe_out.$$"
  return 0
}

small_ok=0
run_query "SELECT 1" "SELECT 1" && small_ok=1
large_ok=0
run_query "the larger query" "$QUERY" && large_ok=1

# ─── Verdict ───────────────────────────────────────────────────────────────
step "Verdict"
if [ "$small_ok" -eq 1 ] && [ "$large_ok" -eq 0 ]; then
  echo -e "${RED}${BOLD}SELECT 1 works but the larger query dies — this is response-size-triggered.${RESET}"
  echo -e "That's the signature of a Path-MTU-Discovery blackhole, not a blocked port or bad credentials."
  echo -e "Next step: re-run the SQL test with the ${BOLD}mssFix${RESET} or ${BOLD}Clamp MSS to PMTU${RESET} option enabled in Admin -> SQL Test."
elif [ "$small_ok" -eq 0 ]; then
  echo -e "${RED}${BOLD}Even SELECT 1 failed${RESET} — this points at something before response-size ever matters: credentials, DB permissions, or the port/DB itself. Check the FreeTDS trace saved above."
else
  echo -e "${GREEN}${BOLD}Both queries succeeded${RESET} — no MTU issue detected right now against this host/port."
fi

echo -e "\n${BOLD}Summary: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET}"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
