#!/usr/bin/env bash
# =============================================================================
# Dock Tools — Guided Installer
# Supports: Ubuntu, Debian, Rancher/K8s
# Run as a user with sudo privileges.
# =============================================================================

set -uo pipefail

# ── Colours & helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[•]${RESET} $*"; }
success() { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[!]${RESET} $*"; }
error()   { echo -e "${RED}[✗]${RESET} $*"; exit 1; }
section() { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}\n"; }

ask() {
  echo -e "${BOLD}${YELLOW}▶ $*${RESET}"
}

confirm() {
  local prompt="$1" default="${2:-y}" yn
  [[ "$default" == "y" ]] && prompt="$prompt [Y/n]: " || prompt="$prompt [y/N]: "
  read -rp "$(echo -e "${BOLD}${YELLOW}▶ ${prompt}${RESET}")" yn
  yn="${yn:-$default}"
  [[ "$yn" =~ ^[Yy]$ ]]
}

require_cmd() {
  command -v "$1" &>/dev/null || error "$1 is required but not installed."
}

wait_for() {
  local url="$1" retries="${2:-30}" delay="${3:-3}"
  info "Waiting for $url ..."
  for i in $(seq 1 "$retries"); do
    if curl -sf --max-time 5 "$url" &>/dev/null; then
      echo ""; return 0
    fi
    sleep "$delay"; echo -n "."
  done
  echo ""; return 1
}

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo -e "${BOLD}${CYAN}"
echo "  ██████╗  ██████╗  ██████╗██╗  ██╗    ████████╗ ██████╗  ██████╗ ██╗     ███████╗"
echo "  ██╔══██╗██╔═══██╗██╔════╝██║ ██╔╝    ╚══██╔══╝██╔═══██╗██╔═══██╗██║     ██╔════╝"
echo "  ██║  ██║██║   ██║██║     █████╔╝        ██║   ██║   ██║██║   ██║██║     ███████╗"
echo "  ██║  ██║██║   ██║██║     ██╔═██╗        ██║   ██║   ██║██║   ██║██║          ██║"
echo "  ██████╔╝╚██████╔╝╚██████╗██║  ██╗       ██║   ╚██████╔╝╚██████╔╝███████╗███████║"
echo "  ╚═════╝  ╚═════╝  ╚═════╝╚═╝  ╚═╝       ╚═╝    ╚═════╝  ╚═════╝╚══════╝╚══════╝"
echo -e "${RESET}"
echo -e "  ${BOLD}Guided Installer${RESET} — Ubuntu / Debian / Rancher / K8s\n"

# ── Detect OS ─────────────────────────────────────────────────────────────────
OS_ID="unknown"
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  OS_ID="${ID,,}"
fi

# ── Deployment target ─────────────────────────────────────────────────────────
section "Step 1 — Deployment Target"
echo    "  1) Docker Compose  — Ubuntu / Debian (single VM)"
echo    "  2) Rancher / K8s   — Kubernetes cluster"
echo ""
ask "Select deployment target [1/2]:"
read -r HOST_TYPE
[[ "$HOST_TYPE" =~ ^[12]$ ]] || error "Invalid selection. Enter 1 or 2."
[[ "$HOST_TYPE" == "1" ]] && HOST_LABEL="Docker Compose (${OS_ID^})" || HOST_LABEL="Rancher / Kubernetes"
success "Target: $HOST_LABEL"

# Shared variables
INSTALL_DIR=""
SCRIPTS_DATA_DIR=""
UI_USERNAME="admin"
UI_PASSWORD=""
WEBHOOK_SECRET=""
DEFAULT_TIMEZONE="UTC"
MANAGER_PORT=80
MANAGER_TLS_PORT=443
USE_TLS=false
BASE_URL=""
PROTOCOL="http"
LB_IP=""
NODE_IP="localhost"

# =============================================================================
# DOCKER COMPOSE PATH (Ubuntu / Debian)
# =============================================================================
if [[ "$HOST_TYPE" == "1" ]]; then

  # ── Dependencies ─────────────────────────────────────────────────────────────
  section "Step 2 — Dependencies"

  install_pkg() {
    if ! command -v "$1" &>/dev/null; then
      info "Installing $2 ..."
      case "$OS_ID" in
        ubuntu|debian)
          sudo apt-get update -qq
          sudo apt-get install -y "$2"
          ;;
        *) warn "Unknown OS '${OS_ID}'. Install $1 manually and re-run." ;;
      esac
    else
      success "$1 is already installed"
    fi
  }

  if ! command -v docker &>/dev/null; then
    info "Installing Docker..."
    sudo apt-get update -qq
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    warn "Docker installed. You may need to run 'newgrp docker' or log out/in for group changes."
  else
    success "Docker $(docker --version | awk '{print $3}' | tr -d ',')"
  fi

  install_pkg git  git
  install_pkg curl curl

  # ── Install directory ─────────────────────────────────────────────────────────
  section "Step 3 — Install Directory"
  DEFAULT_DIR="$HOME/dock-tools"
  ask "Where should Dock Tools be installed? [${DEFAULT_DIR}]:"
  read -r INSTALL_DIR
  INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"
  INSTALL_DIR="${INSTALL_DIR%/}"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    warn "Directory already exists and is a git repo. Pulling latest changes..."
    git -C "$INSTALL_DIR" pull || warn "git pull failed — continuing with existing files."
  elif [[ -d "$INSTALL_DIR" && -f "$INSTALL_DIR/docker-compose.yml" ]]; then
    warn "Directory already contains Dock Tools. Using existing files."
  else
    info "Cloning Dock Tools into $INSTALL_DIR ..."
    git clone https://github.com/DSerruya/dock_tools.git "$INSTALL_DIR" \
      || error "Git clone failed. Check internet connectivity and try again."
  fi

  [[ -f "$INSTALL_DIR/docker-compose.yml" ]] \
    || error "docker-compose.yml not found in $INSTALL_DIR. Clone may have failed."
  success "Source ready at $INSTALL_DIR"

  # Always create scripts-data before anything else
  SCRIPTS_DATA_DIR="${INSTALL_DIR}/scripts-data"
  mkdir -p "$SCRIPTS_DATA_DIR"
  success "scripts-data directory ready: $SCRIPTS_DATA_DIR"

  # ── .env configuration ────────────────────────────────────────────────────────
  section "Step 4 — Configuration"

  # Webhook secret
  DEFAULT_SECRET=$(openssl rand -hex 32 2>/dev/null \
    || head -c 32 /dev/urandom | base64 | tr -dc 'a-f0-9' | head -c 32)
  ask "Webhook secret (press Enter to auto-generate):"
  read -r WEBHOOK_SECRET
  WEBHOOK_SECRET="${WEBHOOK_SECRET:-$DEFAULT_SECRET}"
  success "Webhook secret set"

  # Timezone
  DETECTED_TZ=$(timedatectl show --property=Timezone --value 2>/dev/null || echo "UTC")
  ask "Timezone [${DETECTED_TZ}]:"
  read -r DEFAULT_TIMEZONE
  DEFAULT_TIMEZONE="${DEFAULT_TIMEZONE:-$DETECTED_TZ}"
  success "Timezone: $DEFAULT_TIMEZONE"

  # Port
  ask "HTTP port [80]:"
  read -r MANAGER_PORT
  MANAGER_PORT="${MANAGER_PORT:-80}"
  [[ "$MANAGER_PORT" =~ ^[0-9]+$ ]] || error "Invalid port number: $MANAGER_PORT"
  success "HTTP port: $MANAGER_PORT"

  # UI username
  ask "Web UI username [admin]:"
  read -r UI_USERNAME
  UI_USERNAME="${UI_USERNAME:-admin}"

  # UI password
  while [[ -z "$UI_PASSWORD" ]]; do
    ask "Web UI password (required):"
    read -rsp "" UI_PASSWORD; echo ""
    [[ -z "$UI_PASSWORD" ]] && warn "Password cannot be empty."
  done
  ask "Confirm password:"
  read -rsp "" UI_PASSWORD_CONFIRM; echo ""
  [[ "$UI_PASSWORD" == "$UI_PASSWORD_CONFIRM" ]] || error "Passwords do not match."
  success "Credentials set (${UI_USERNAME} / ***)"

  # TLS
  if confirm "Enable HTTPS / TLS?" "n"; then
    USE_TLS=true
    ask "HTTPS port [443]:"
    read -r MANAGER_TLS_PORT
    MANAGER_TLS_PORT="${MANAGER_TLS_PORT:-443}"

    CERT_DIR="${INSTALL_DIR}/nginx/certs"
    mkdir -p "$CERT_DIR"

    if [[ -f "$CERT_DIR/cert.pem" && -f "$CERT_DIR/key.pem" ]]; then
      success "Existing TLS certificates found"
    else
      info "Generating self-signed certificate..."
      openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
        -subj "/CN=dock-tools.local" &>/dev/null
      success "Self-signed certificate generated"
    fi
    sed -i.bak 's|nginx\.conf|nginx-tls.conf|' "${INSTALL_DIR}/docker-compose.yml"
    PROTOCOL="https"
  fi

  # Write .env
  cat > "${INSTALL_DIR}/.env" <<EOF
# Generated by Dock Tools guided installer — $(date)
WEBHOOK_SECRET=${WEBHOOK_SECRET}
HOST_SCRIPTS_DATA_PATH=${SCRIPTS_DATA_DIR}
DEFAULT_TIMEZONE=${DEFAULT_TIMEZONE}
MANAGER_PORT=${MANAGER_PORT}
MANAGER_TLS_PORT=${MANAGER_TLS_PORT}
UI_USERNAME=${UI_USERNAME}
UI_PASSWORD=${UI_PASSWORD}
EOF
  success ".env written to ${INSTALL_DIR}/.env"

  # Validate
  [[ -d "$SCRIPTS_DATA_DIR" ]] \
    || error "scripts-data directory missing: $SCRIPTS_DATA_DIR"
  grep -q "HOST_SCRIPTS_DATA_PATH=${SCRIPTS_DATA_DIR}" "${INSTALL_DIR}/.env" \
    || error "HOST_SCRIPTS_DATA_PATH not set correctly in .env"
  success "Configuration validated"

  # ── Build & start ─────────────────────────────────────────────────────────────
  section "Step 5 — Build & Deploy"
  info "Building and starting containers (this may take a few minutes)..."
  cd "$INSTALL_DIR"
  docker compose down --remove-orphans 2>/dev/null || true
  docker compose up -d --build || error "docker compose up failed. Run 'docker compose logs' for details."
  success "Containers started"

  # ── Validate services ─────────────────────────────────────────────────────────
  section "Step 6 — Validate Services"

  sleep 4
  docker compose ps
  echo ""

  BASE_URL="${PROTOCOL}://localhost:${MANAGER_PORT}"

  if wait_for "$BASE_URL" 20 3; then
    success "Web UI is responding at ${BASE_URL}"
  else
    warn "Web UI not responding yet. Services may still be starting."
    warn "Run: docker compose logs  (inside ${INSTALL_DIR})"
  fi

  # Verify volume mount inside manager container
  info "Verifying volume mount inside manager container..."
  MGR_CONTAINER=$(docker compose ps -q manager 2>/dev/null | head -1 || echo "")
  if [[ -n "$MGR_CONTAINER" ]]; then
    MOUNT_CHECK=$(docker exec "$MGR_CONTAINER" ls /app/scripts-data 2>/dev/null && echo "ok" || echo "fail")
    if [[ "$MOUNT_CHECK" == "ok" ]]; then
      success "Volume mount /app/scripts-data is working"
    else
      warn "Volume mount check failed. HOST_SCRIPTS_DATA_PATH may be incorrect."
      warn "Current value: ${SCRIPTS_DATA_DIR}"
    fi
  fi

  # ── Demo script ───────────────────────────────────────────────────────────────
  section "Step 7 — Demo Script"
  echo "  Creates a local Python heartbeat script, adds it to Dock Tools,"
  echo "  starts it, and verifies the full pipeline is working end-to-end."
  echo ""

  if confirm "Run the demo script test?"; then
    DEMO_NAME="demo-heartbeat"
    DEMO_REPO_DIR="${SCRIPTS_DATA_DIR}/_demo-repo"

    info "Creating demo git repository at $DEMO_REPO_DIR ..."
    rm -rf "$DEMO_REPO_DIR"
    mkdir -p "$DEMO_REPO_DIR"
    cd "$DEMO_REPO_DIR"
    git init -q
    git config user.email "dock-tools@localhost"
    git config user.name  "Dock Tools Demo"

    cat > main.py <<'PYEOF'
import time, datetime, sys

print("=" * 50)
print("  Dock Tools Demo Script")
print("  If you see this, all of the following work:")
print("  [+] Docker container creation")
print("  [+] HOST_SCRIPTS_DATA_PATH volume mount")
print("  [+] Git repo cloning")
print("  [+] Script execution inside container")
print("=" * 50)
sys.stdout.flush()

count = 0
while True:
    count += 1
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] heartbeat #{count} — Dock Tools is running!")
    sys.stdout.flush()
    time.sleep(5)
PYEOF

    git add main.py
    git commit -q -m "Dock Tools demo heartbeat script"
    cd "$INSTALL_DIR"

    DEMO_REPO_URL="file:///app/scripts-data/_demo-repo"
    success "Demo repo created"

    # Add via API
    info "Adding demo script via Dock Tools API..."
    ADD_RESP=$(curl -sf -X POST "${BASE_URL}/api/scripts" \
      -u "${UI_USERNAME}:${UI_PASSWORD}" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"${DEMO_NAME}\",\"repoUrl\":\"${DEMO_REPO_URL}\",\"branch\":\"master\",\"language\":\"python\",\"entryPoint\":\"python main.py\",\"persistent\":true}" \
      2>&1 || echo "API_FAIL")

    if echo "$ADD_RESP" | grep -qi "API_FAIL\|error"; then
      warn "API call failed: $ADD_RESP"
      warn "Add the demo manually in the UI with:"
      warn "  Name: $DEMO_NAME | Repo: $DEMO_REPO_URL | Language: Python | Entry: python main.py"
    else
      success "Demo script added to Dock Tools"

      # Start
      info "Starting demo script..."
      curl -sf -X POST "${BASE_URL}/api/scripts/${DEMO_NAME}/start" \
        -u "${UI_USERNAME}:${UI_PASSWORD}" &>/dev/null && success "Demo script started" \
        || warn "Could not auto-start. Start it from the UI."

      # Check logs
      sleep 6
      info "Checking demo script logs..."
      LOGS=$(curl -sf "${BASE_URL}/api/scripts/${DEMO_NAME}/logs" \
        -u "${UI_USERNAME}:${UI_PASSWORD}" 2>/dev/null || echo "")
      if echo "$LOGS" | grep -q "heartbeat\|Dock Tools"; then
        success "Demo script is running and producing output!"
        success "Full pipeline validated: volume mount, git clone, container execution all working."
      else
        warn "Log output not visible yet — the script may still be starting."
        warn "Check the Logs tab in the UI for script: $DEMO_NAME"
      fi
    fi

    # Verify scripts-data populated
    info "Checking scripts-data directory..."
    if [[ -d "${SCRIPTS_DATA_DIR}/${DEMO_NAME}/repo" ]]; then
      success "Repo cloned correctly to: ${SCRIPTS_DATA_DIR}/${DEMO_NAME}/repo"
    else
      warn "Repo directory not found yet at: ${SCRIPTS_DATA_DIR}/${DEMO_NAME}/repo"
    fi
  fi

  # ── GitHub connectivity test ──────────────────────────────────────────────────
  section "Step 8 — GitHub Connectivity Test (optional)"
  echo "  Tests that the manager can clone from a real public GitHub repository."
  echo ""
  if confirm "Run GitHub connectivity test?" "n"; then
    ask "Public GitHub repo URL [https://github.com/DSerruya/dock_tools.git]:"
    read -r TEST_REPO
    TEST_REPO="${TEST_REPO:-https://github.com/DSerruya/dock_tools.git}"
    TEST_NAME="github-connectivity-test"

    info "Adding GitHub test script..."
    GH_RESP=$(curl -sf -X POST "${BASE_URL}/api/scripts" \
      -u "${UI_USERNAME}:${UI_PASSWORD}" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"${TEST_NAME}\",\"repoUrl\":\"${TEST_REPO}\",\"branch\":\"main\",\"language\":\"node\",\"entryPoint\":\"echo done\"}" \
      2>&1 || echo "API_FAIL")

    if echo "$GH_RESP" | grep -qi "API_FAIL\|error"; then
      warn "GitHub test failed: $GH_RESP"
    else
      sleep 5
      if [[ -d "${SCRIPTS_DATA_DIR}/${TEST_NAME}/repo" ]]; then
        success "GitHub clone succeeded — repo is at: ${SCRIPTS_DATA_DIR}/${TEST_NAME}/repo"
      else
        warn "Clone may still be in progress — check UI in a few seconds."
      fi
      # Clean up
      curl -sf -X DELETE "${BASE_URL}/api/scripts/${TEST_NAME}" \
        -u "${UI_USERNAME}:${UI_PASSWORD}" &>/dev/null || true
      info "GitHub test script removed"
    fi
  fi

  # ── Auto-start on reboot ──────────────────────────────────────────────────────
  section "Step 9 — Auto-start on Reboot"
  if confirm "Configure Dock Tools to start automatically on boot?"; then
    sudo tee /etc/systemd/system/dock-tools.service > /dev/null <<EOF
[Unit]
Description=Dock Tools
After=docker.service
Requires=docker.service

[Service]
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=always
User=${USER}

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable dock-tools
    success "Systemd service enabled — Dock Tools will start on boot"
  fi

# =============================================================================
# RANCHER / K8S PATH
# =============================================================================
else

  # ── Prerequisites ─────────────────────────────────────────────────────────────
  section "Step 2 — Prerequisites"
  require_cmd kubectl
  require_cmd docker
  require_cmd git
  require_cmd curl

  KUBE_CTX=$(kubectl config current-context 2>/dev/null || echo "none")
  info "Active kubectl context: ${KUBE_CTX}"
  confirm "Continue with this context?" || error "Switch kubectl context and re-run."

  # ── Install directory ─────────────────────────────────────────────────────────
  section "Step 3 — Install Directory"
  DEFAULT_DIR="$HOME/dock-tools"
  ask "Where should Dock Tools source be cloned? [${DEFAULT_DIR}]:"
  read -r INSTALL_DIR
  INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"
  INSTALL_DIR="${INSTALL_DIR%/}"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    warn "Existing repo found — pulling latest..."
    git -C "$INSTALL_DIR" pull || warn "git pull failed — continuing."
  elif [[ ! -d "$INSTALL_DIR" ]]; then
    info "Cloning Dock Tools..."
    git clone https://github.com/DSerruya/dock_tools.git "$INSTALL_DIR" \
      || error "Git clone failed. Check internet connectivity."
  fi
  success "Source ready at $INSTALL_DIR"

  # ── Configuration ─────────────────────────────────────────────────────────────
  section "Step 4 — Configuration"

  DEFAULT_SECRET=$(openssl rand -hex 32 2>/dev/null \
    || head -c 32 /dev/urandom | base64 | tr -dc 'a-f0-9' | head -c 32)
  ask "Webhook secret (press Enter to auto-generate):"
  read -r WEBHOOK_SECRET
  WEBHOOK_SECRET="${WEBHOOK_SECRET:-$DEFAULT_SECRET}"
  success "Webhook secret set"

  DETECTED_TZ=$(timedatectl show --property=Timezone --value 2>/dev/null || echo "UTC")
  ask "Timezone [${DETECTED_TZ}]:"
  read -r DEFAULT_TIMEZONE
  DEFAULT_TIMEZONE="${DEFAULT_TIMEZONE:-$DETECTED_TZ}"
  success "Timezone: $DEFAULT_TIMEZONE"

  while [[ -z "$UI_PASSWORD" ]]; do
    ask "Web UI password (required):"
    read -rsp "" UI_PASSWORD; echo ""
    [[ -z "$UI_PASSWORD" ]] && warn "Password cannot be empty."
  done
  ask "Confirm password:"
  read -rsp "" UI_PASSWORD_CONFIRM; echo ""
  [[ "$UI_PASSWORD" == "$UI_PASSWORD_CONFIRM" ]] || error "Passwords do not match."
  success "Credentials set (admin / ***)"

  DEFAULT_SCRIPTS_DATA="/opt/dock-tools/scripts-data"
  ask "Host scripts-data path [${DEFAULT_SCRIPTS_DATA}]:"
  read -r SCRIPTS_DATA_DIR_INPUT
  SCRIPTS_DATA_DIR="${SCRIPTS_DATA_DIR_INPUT:-$DEFAULT_SCRIPTS_DATA}"

  if [[ ! -d "$SCRIPTS_DATA_DIR" ]]; then
    info "Creating $SCRIPTS_DATA_DIR ..."
    sudo mkdir -p "$SCRIPTS_DATA_DIR" && sudo chown "$USER":"$USER" "$SCRIPTS_DATA_DIR" \
      || error "Cannot create $SCRIPTS_DATA_DIR. Run: sudo mkdir -p $SCRIPTS_DATA_DIR && sudo chown $USER:$USER $SCRIPTS_DATA_DIR"
  fi
  success "scripts-data path validated: $SCRIPTS_DATA_DIR"

  # Patch configmap with correct values
  sed -i.bak \
    -e "s|DEFAULT_TIMEZONE: UTC|DEFAULT_TIMEZONE: ${DEFAULT_TIMEZONE}|" \
    -e "s|HOST_SCRIPTS_DATA_PATH:.*|HOST_SCRIPTS_DATA_PATH: \"${SCRIPTS_DATA_DIR}\"|" \
    "${INSTALL_DIR}/k8s/configmap-manager.yaml"
  success "ConfigMap patched"

  # ── Build image ────────────────────────────────────────────────────────────────
  section "Step 5 — Build Docker Image"
  info "Building dock-tools-manager image (this may take a few minutes)..."
  docker build -t dock-tools-manager:latest "${INSTALL_DIR}/manager" \
    || error "Docker build failed. Check Dockerfile and internet access."
  success "Image built: dock-tools-manager:latest"

  # ── Deploy to Kubernetes ───────────────────────────────────────────────────────
  section "Step 6 — Deploy to Kubernetes"

  kubectl apply -f "${INSTALL_DIR}/k8s/namespace.yaml"
  success "Namespace dock-tools ready"

  kubectl delete secret dock-tools-secret -n dock-tools --ignore-not-found &>/dev/null
  kubectl create secret generic dock-tools-secret \
    --namespace dock-tools \
    --from-literal=WEBHOOK_SECRET="$WEBHOOK_SECRET" \
    --from-literal=UI_PASSWORD="$UI_PASSWORD"
  success "Secret dock-tools-secret created"

  kubectl apply -k "${INSTALL_DIR}/k8s/"
  success "Manifests applied"

  # ── Wait for rollout ───────────────────────────────────────────────────────────
  section "Step 7 — Validate Deployment"

  info "Waiting for manager rollout..."
  kubectl rollout status deployment/dock-tools-manager -n dock-tools --timeout=120s \
    || warn "Manager not ready yet — run: kubectl get pods -n dock-tools"

  info "Waiting for nginx rollout..."
  kubectl rollout status deployment/dock-tools-nginx -n dock-tools --timeout=120s \
    || warn "Nginx not ready yet"

  echo ""
  kubectl get pods -n dock-tools
  echo ""
  kubectl get svc  -n dock-tools
  echo ""

  NODE_IP=$(kubectl get nodes \
    -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' \
    2>/dev/null || echo "localhost")
  LB_IP=$(kubectl get svc dock-tools-nginx -n dock-tools \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
  MANAGER_PORT=30080
  BASE_URL="http://${NODE_IP}:${MANAGER_PORT}"

  if wait_for "$BASE_URL" 20 3; then
    success "Web UI is responding at $BASE_URL"
  else
    warn "Web UI not responding yet — try again in a minute."
  fi
fi

# =============================================================================
# FINAL SUMMARY
# =============================================================================
section "Installation Complete"

echo -e "  ${BOLD}Deployment:${RESET}      ${HOST_LABEL}"
echo -e "  ${BOLD}Web UI:${RESET}          ${GREEN}${BASE_URL}${RESET}"
echo -e "  ${BOLD}Username:${RESET}        ${UI_USERNAME}"
echo -e "  ${BOLD}Password:${RESET}        ${UI_PASSWORD}"
echo -e "  ${BOLD}Webhook secret:${RESET}  ${WEBHOOK_SECRET}"
echo ""
if [[ "$HOST_TYPE" == "2" ]]; then
  [[ -n "${LB_IP:-}" ]] && echo -e "  ${BOLD}LoadBalancer:${RESET}    ${GREEN}http://${LB_IP}${RESET}"
  echo -e "  ${BOLD}NodePort:${RESET}        ${GREEN}http://${NODE_IP}:30080${RESET}"
fi
if [[ "${USE_TLS:-false}" == "true" ]]; then
  echo -e "  ${BOLD}HTTPS:${RESET}           ${GREEN}https://localhost:${MANAGER_TLS_PORT}${RESET}"
  echo -e "  ${YELLOW}Browser will show a security warning (self-signed cert).${RESET}"
fi
echo ""
echo -e "  ${BOLD}Install path:${RESET}    ${INSTALL_DIR}"
echo -e "  ${BOLD}Scripts data:${RESET}    ${SCRIPTS_DATA_DIR}"
echo ""
echo -e "  ${YELLOW}Webhook URL format:  ${BASE_URL}/webhook/<script-name>${RESET}"
echo -e "  ${YELLOW}Save the webhook secret — you will need it when connecting GitHub.${RESET}"
echo ""
