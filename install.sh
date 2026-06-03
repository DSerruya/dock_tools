#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
#  Script Manager — Installer
#  Usage:  bash install.sh
#          curl -fsSL https://raw.githubusercontent.com/YOU/REPO/main/install.sh | bash
# ─────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}▶ $*${RESET}"; }

# ─── Banner ───────────────────────────────────
echo -e "${BOLD}${CYAN}"
cat << 'EOF'
 ____            _       _     __  __
/ ___|  ___ _ __(_)_ __ | |_  |  \/  | __ _ _ __   __ _  __ _  ___ _ __
\___ \ / __| '__| | '_ \| __| | |\/| |/ _` | '_ \ / _` |/ _` |/ _ \ '__|
 ___) | (__| |  | | |_) | |_  | |  | | (_| | | | | (_| | (_| |  __/ |
|____/ \___|_|  |_| .__/ \__| |_|  |_|\__,_|_| |_|\__,_|\__, |\___|_|
                  |_|                                     |___/
EOF
echo -e "${RESET}"
echo -e "  Docker-based script manager — Python, Ruby, TypeScript"
echo -e "  Cron scheduling · GitHub auto-sync · Web UI\n"

# ─── 1. Prerequisites ─────────────────────────
step "Checking prerequisites"

# ── OS detection ──────────────────────────────
detect_os() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  elif [ -f /etc/debian_version ]; then
    echo "debian"
  elif [ -f /etc/redhat-release ] || [ -f /etc/fedora-release ]; then
    echo "rhel"
  elif [ -f /etc/alpine-release ]; then
    echo "alpine"
  else
    echo "unknown"
  fi
}

OS=$(detect_os)
MISSING=()   # collects names of missing tools
COMPOSE_CMD=""

# ── Silent checks — collect what's missing ────
command -v docker &>/dev/null   || MISSING+=("docker")
command -v git    &>/dev/null   || MISSING+=("git")

if docker compose version &>/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
else
  MISSING+=("docker-compose")
fi

# Report what was found
for tool in docker git; do
  command -v "$tool" &>/dev/null && success "$tool found ($(command -v "$tool"))"
done
[ -n "$COMPOSE_CMD" ] && success "$COMPOSE_CMD found"

# ── If anything is missing, offer to install ──
if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  warn "The following prerequisites are missing:"
  for item in "${MISSING[@]}"; do
    echo -e "    ${RED}✗${RESET}  $item"
  done
  echo ""

  if [ "$OS" = "unknown" ]; then
    echo -e "  ${YELLOW}Automatic installation is not supported on this OS.${RESET}"
    echo -e "  Please install the missing tools manually and re-run this script.\n"
    echo -e "  docker:          https://docs.docker.com/get-docker/"
    echo -e "  docker-compose:  https://docs.docker.com/compose/install/"
    echo -e "  git:             https://git-scm.com/downloads\n"
    error "Prerequisites missing. Cannot continue."
  fi

  read -rp "  Would you like to install the missing prerequisites now? [y/N]: " INSTALL_PREREQS
  if [[ ! "$INSTALL_PREREQS" =~ ^[Yy]$ ]]; then
    echo ""
    info "You can install them manually and re-run this script:"
    echo -e "    docker:          https://docs.docker.com/get-docker/"
    echo -e "    docker-compose:  https://docs.docker.com/compose/install/"
    echo -e "    git:             https://git-scm.com/downloads"
    echo ""
    error "Prerequisites missing. Exiting."
  fi

  echo ""
  step "Installing prerequisites"

  # ── macOS ──
  if [ "$OS" = "macos" ]; then
    if ! command -v brew &>/dev/null; then
      info "Homebrew not found — installing Homebrew first..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || error "Failed to install Homebrew. Install it manually from https://brew.sh"
      success "Homebrew installed"
    fi
    for item in "${MISSING[@]}"; do
      case "$item" in
        docker)
          info "Installing Docker Desktop for Mac..."
          brew install --cask docker \
            || error "Failed to install Docker. Download manually from https://docs.docker.com/desktop/mac/"
          success "Docker Desktop installed — please start it from Applications, then re-run this script."
          exit 0   # Docker Desktop needs to be launched before the daemon is available
          ;;
        docker-compose)
          info "Installing docker-compose..."
          brew install docker-compose || error "Failed to install docker-compose"
          success "docker-compose installed"
          ;;
        git)
          info "Installing git..."
          brew install git || error "Failed to install git"
          success "git installed"
          ;;
      esac
    done

  # ── Debian / Ubuntu ──
  elif [ "$OS" = "debian" ]; then
    info "Updating apt package index..."
    sudo apt-get update -qq

    for item in "${MISSING[@]}"; do
      case "$item" in
        docker)
          info "Installing Docker Engine..."
          curl -fsSL https://get.docker.com | sudo sh \
            || error "Failed to install Docker. See https://docs.docker.com/engine/install/"
          sudo systemctl enable --now docker
          # Allow current user to run docker without sudo
          sudo usermod -aG docker "$USER" && warn "Added $USER to the docker group. You may need to log out and back in."
          success "Docker installed"
          ;;
        docker-compose)
          info "Installing docker-compose-plugin..."
          sudo apt-get install -y docker-compose-plugin 2>/dev/null \
            || sudo apt-get install -y docker-compose 2>/dev/null \
            || error "Failed to install docker-compose."
          success "docker-compose installed"
          ;;
        git)
          info "Installing git..."
          sudo apt-get install -y git || error "Failed to install git"
          success "git installed"
          ;;
      esac
    done

  # ── RHEL / CentOS / Fedora ──
  elif [ "$OS" = "rhel" ]; then
    PKG_MGR="yum"
    command -v dnf &>/dev/null && PKG_MGR="dnf"

    for item in "${MISSING[@]}"; do
      case "$item" in
        docker)
          info "Installing Docker Engine..."
          curl -fsSL https://get.docker.com | sudo sh \
            || error "Failed to install Docker. See https://docs.docker.com/engine/install/"
          sudo systemctl enable --now docker
          sudo usermod -aG docker "$USER" && warn "Added $USER to the docker group. You may need to log out and back in."
          success "Docker installed"
          ;;
        docker-compose)
          info "Installing docker-compose-plugin..."
          sudo $PKG_MGR install -y docker-compose-plugin 2>/dev/null \
            || error "Failed to install docker-compose. See https://docs.docker.com/compose/install/"
          success "docker-compose installed"
          ;;
        git)
          info "Installing git..."
          sudo $PKG_MGR install -y git || error "Failed to install git"
          success "git installed"
          ;;
      esac
    done

  # ── Alpine ──
  elif [ "$OS" = "alpine" ]; then
    for item in "${MISSING[@]}"; do
      case "$item" in
        docker)
          info "Installing Docker..."
          sudo apk add --no-cache docker
          sudo rc-update add docker default
          sudo service docker start
          success "Docker installed"
          ;;
        docker-compose)
          info "Installing docker-compose..."
          sudo apk add --no-cache docker-compose || error "Failed to install docker-compose"
          success "docker-compose installed"
          ;;
        git)
          info "Installing git..."
          sudo apk add --no-cache git || error "Failed to install git"
          success "git installed"
          ;;
      esac
    done
  fi

  # ── Re-check after installation ───────────────
  echo ""
  info "Re-checking prerequisites after installation..."
  STILL_MISSING=()

  command -v docker &>/dev/null || STILL_MISSING+=("docker")
  command -v git    &>/dev/null || STILL_MISSING+=("git")

  if docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
  else
    STILL_MISSING+=("docker-compose")
  fi

  if [ ${#STILL_MISSING[@]} -gt 0 ]; then
    error "Installation failed for: ${STILL_MISSING[*]}. Please install manually and re-run."
  fi

  success "All prerequisites installed successfully"
fi

# ── Docker daemon running? ─────────────────────
if ! docker info &>/dev/null; then
  echo ""
  warn "Docker is installed but the daemon is not running."
  if [ "$OS" = "macos" ]; then
    info "Please start Docker Desktop from your Applications folder, then re-run this script."
  else
    info "Attempting to start Docker daemon..."
    sudo systemctl start docker 2>/dev/null || sudo service docker start 2>/dev/null \
      || error "Could not start Docker. Start it manually and re-run this script."
  fi
  # Final check
  docker info &>/dev/null || error "Docker daemon still not running. Start it manually and re-run."
fi
success "Docker daemon is running"

# ─── 2. Install directory ─────────────────────
step "Choose install directory"

DEFAULT_DIR="$HOME/script-manager"
echo -e "  Default: ${BOLD}${DEFAULT_DIR}${RESET}"
read -rp "  Install directory [press Enter for default]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"   # expand ~ manually

if [ -d "$INSTALL_DIR" ]; then
  warn "Directory $INSTALL_DIR already exists."
  read -rp "  Continue and overwrite config files? [y/N]: " OVERWRITE
  [[ "$OVERWRITE" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }
fi

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
success "Working in $INSTALL_DIR"

# ─── 3. Source code ───────────────────────────
step "Getting source code"

REPO_URL="https://github.com/DSerruya/dock_tools.git"

if [ -f "./docker-compose.yml" ]; then
  info "Source files already present — skipping clone."
elif [ -n "${SCRIPT_MANAGER_LOCAL:-}" ]; then
  # Developer mode: copy from a local path (used during development)
  info "Copying from local source: $SCRIPT_MANAGER_LOCAL"
  cp -r "$SCRIPT_MANAGER_LOCAL/." .
  success "Source files copied"
else
  info "Cloning repository..."
  git clone "$REPO_URL" . || error "Failed to clone $REPO_URL"
  success "Repository cloned"
fi

# Create required runtime directories
mkdir -p scripts-data
touch scripts-data/.gitkeep
success "Runtime directories created"

# ─── 4. Configuration ─────────────────────────
step "Configuration"

# Generate a secure default secret
if command -v openssl &>/dev/null; then
  DEFAULT_SECRET=$(openssl rand -hex 32)
else
  DEFAULT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-f0-9' | head -c 32)
fi

echo ""
echo -e "  ${BOLD}GitHub Webhook Secret${RESET}"
echo -e "  Used to verify that webhook calls come from GitHub."
echo -e "  A secure random value has been generated for you.\n"
read -rp "  Webhook secret [press Enter to use generated]: " WEBHOOK_SECRET
WEBHOOK_SECRET="${WEBHOOK_SECRET:-$DEFAULT_SECRET}"

echo ""
echo -e "  ${BOLD}Manager Port${RESET}"
echo -e "  The web UI and API will be available on this port.\n"
read -rp "  Port [default: 80]: " MANAGER_PORT
MANAGER_PORT="${MANAGER_PORT:-80}"

echo ""
echo -e "  ${BOLD}HTTPS / TLS${RESET}"
echo -e "  Encrypts traffic so that Basic Auth credentials are never sent in plaintext."
echo -e "  You can use a self-signed certificate (for internal use) or provide your own.\n"
read -rp "  Enable HTTPS? [y/N]: " ENABLE_TLS
ENABLE_TLS="${ENABLE_TLS:-n}"
MANAGER_TLS_PORT="443"

if [[ "$ENABLE_TLS" =~ ^[Yy]$ ]]; then
  read -rp "  HTTPS port [default: 443]: " MANAGER_TLS_PORT
  MANAGER_TLS_PORT="${MANAGER_TLS_PORT:-443}"

  mkdir -p nginx/certs

  echo ""
  echo -e "  Certificate options:"
  echo -e "    [1] Generate a self-signed certificate (for internal/dev use)"
  echo -e "    [2] Provide paths to existing cert and key files\n"
  read -rp "  Choice [1]: " TLS_CHOICE
  TLS_CHOICE="${TLS_CHOICE:-1}"

  if [ "$TLS_CHOICE" = "2" ]; then
    read -rp "  Path to certificate file (.pem): " TLS_CERT_SRC
    read -rp "  Path to private key file (.pem): " TLS_KEY_SRC
    if [ ! -f "$TLS_CERT_SRC" ] || [ ! -f "$TLS_KEY_SRC" ]; then
      error "Certificate or key file not found. Aborting."
    fi
    cp "$TLS_CERT_SRC" nginx/certs/cert.pem
    cp "$TLS_KEY_SRC"  nginx/certs/key.pem
    success "Certificates copied"
  else
    if ! command -v openssl &>/dev/null; then
      error "openssl is required to generate a self-signed certificate. Install it and re-run."
    fi
    read -rp "  Common Name / domain (e.g. localhost or your server IP) [localhost]: " TLS_CN
    TLS_CN="${TLS_CN:-localhost}"
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout nginx/certs/key.pem -out nginx/certs/cert.pem \
      -subj "/CN=${TLS_CN}" -addext "subjectAltName=DNS:${TLS_CN},IP:127.0.0.1" \
      2>/dev/null
    success "Self-signed certificate generated (valid 10 years)"
    warn "Browsers will show a security warning for self-signed certs — add an exception or use a real certificate for production."
  fi

  chmod 600 nginx/certs/key.pem nginx/certs/cert.pem

  # Activate TLS nginx config
  cp nginx/nginx-tls.conf nginx/nginx.conf
  success "TLS nginx config activated"
fi

echo ""
echo -e "  ${BOLD}Timezone${RESET}"
echo -e "  Default timezone for cron schedules (can be overridden per script)."
echo -e "  Examples: UTC, America/New_York, Europe/London, Asia/Tokyo\n"
read -rp "  Timezone [default: UTC]: " DEFAULT_TZ
DEFAULT_TZ="${DEFAULT_TZ:-UTC}"

echo ""
echo -e "  ${BOLD}Web UI Password${RESET}"
echo -e "  Protects the dashboard with HTTP Basic Auth (username: admin)."
echo -e "  Press Enter to skip and leave the UI open (not recommended).\n"
while true; do
  read -rsp "  Password: " UI_PASSWORD
  echo ""
  if [ -z "$UI_PASSWORD" ]; then
    warn "No password set — the UI will be publicly accessible."
    break
  fi
  read -rsp "  Confirm password: " UI_PASSWORD_CONFIRM
  echo ""
  if [ "$UI_PASSWORD" = "$UI_PASSWORD_CONFIRM" ]; then
    success "Password confirmed"
    break
  else
    echo -e "  ${RED}Passwords do not match — try again.${RESET}\n"
  fi
done

# Write .env
cat > .env << EOF
# Script Manager — Environment Configuration
# Generated by install.sh on $(date -u +"%Y-%m-%d %H:%M UTC")

# GitHub webhook HMAC-SHA256 secret
# Must match the "Secret" field in each GitHub repo's webhook settings
WEBHOOK_SECRET=${WEBHOOK_SECRET}

# Absolute path to the scripts-data directory on the HOST machine
# This is passed to Docker so script containers can mount repo directories
HOST_SCRIPTS_DATA_PATH=${INSTALL_DIR}/scripts-data

# Default timezone for cron schedules
DEFAULT_TIMEZONE=${DEFAULT_TZ}

# Port exposed on the host for the web UI (HTTP)
MANAGER_PORT=${MANAGER_PORT}

# Port exposed on the host for HTTPS (only used when TLS is enabled)
MANAGER_TLS_PORT=${MANAGER_TLS_PORT}

# Web UI Basic Auth (leave UI_PASSWORD empty to disable authentication)
UI_USERNAME=admin
UI_PASSWORD=${UI_PASSWORD}
EOF

chmod 600 .env
success ".env written"
info  "You can edit ${INSTALL_DIR}/.env at any time and restart to apply changes."

# ─── 5. Build & start ─────────────────────────
step "Building and starting containers"

info "This may take a few minutes on first run (downloading base images)..."
$COMPOSE_CMD up -d --build

success "Containers started"

# ─── 6. Health check ──────────────────────────
step "Waiting for manager to become healthy"

MAX_WAIT=60
WAITED=0
CURL_AUTH=""
[ -n "$UI_PASSWORD" ] && CURL_AUTH="-u admin:${UI_PASSWORD}"

# shellcheck disable=SC2086
until curl -sf $CURL_AUTH "http://localhost:${MANAGER_PORT}/api/scripts" &>/dev/null; do
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    warn "Manager did not respond within ${MAX_WAIT}s."
    warn "Check logs with:  ${COMPOSE_CMD} logs manager"
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  echo -ne "  waiting... ${WAITED}s\r"
done

# shellcheck disable=SC2086
if curl -sf $CURL_AUTH "http://localhost:${MANAGER_PORT}/api/scripts" &>/dev/null; then
  success "Manager is healthy"
fi

# ─── 7. Summary ───────────────────────────────
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  Installation complete!${RESET}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
if [[ "$ENABLE_TLS" =~ ^[Yy]$ ]]; then
  echo -e "  ${BOLD}Web UI:${RESET}          https://${HOST_IP}:${MANAGER_TLS_PORT}"
  echo -e "  ${BOLD}Local URL:${RESET}       https://localhost:${MANAGER_TLS_PORT}"
  echo -e "  ${BOLD}Webhook base URL:${RESET} https://${HOST_IP}:${MANAGER_TLS_PORT}/webhook/<script-name>"
else
  echo -e "  ${BOLD}Web UI:${RESET}          http://${HOST_IP}:${MANAGER_PORT}"
  echo -e "  ${BOLD}Local URL:${RESET}       http://localhost:${MANAGER_PORT}"
  echo -e "  ${BOLD}Webhook base URL:${RESET} http://${HOST_IP}:${MANAGER_PORT}/webhook/<script-name>"
fi
echo ""
echo -e "  ${BOLD}Login:${RESET}           admin / ${UI_PASSWORD:-'(no password set)'}"
echo -e "  ${BOLD}Webhook secret:${RESET}  ${WEBHOOK_SECRET}"
echo -e "  ${BOLD}Install dir:${RESET}     ${INSTALL_DIR}"
echo ""
echo -e "${BOLD}  Quick commands:${RESET}"
echo -e "    View logs:     cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f"
echo -e "    Stop:          cd ${INSTALL_DIR} && ${COMPOSE_CMD} down"
echo -e "    Restart:       cd ${INSTALL_DIR} && ${COMPOSE_CMD} restart"
echo -e "    Update:        cd ${INSTALL_DIR} && git pull && ${COMPOSE_CMD} up -d --build"
echo ""
echo -e "${BOLD}  Add your first script:${RESET}"
echo -e "    1. Open the web UI"
echo -e "    2. Click 'Add Script'"
echo -e "    3. Paste your GitHub repo URL"
echo -e "    4. Choose run mode: Persistent or Scheduled (cron)"
echo -e "    5. Add the webhook URL to your GitHub repo settings"
echo ""
echo -e "  ${YELLOW}Save your webhook secret — you'll need it when setting up GitHub webhooks.${RESET}"
echo ""
