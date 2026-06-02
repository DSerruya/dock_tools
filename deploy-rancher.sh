#!/usr/bin/env bash
set -euo pipefail

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="dock-tools-manager"
IMAGE_TAG="latest"
NAMESPACE="dock-tools"

echo -e "${BOLD}${CYAN}"
cat << 'EOF'
  ____             _     _____           _
 |  _ \  ___   ___| | __| ____|__  ___ | |___
 | | | |/ _ \ / __| |/ /|  _| / _ \ / _ \| / __|
 | |_| | (_) | (__|   < | |__| (_) | (_) | \__ \
 |____/ \___/ \___|_|\_\|_____\___/ \___/|_|___/
   Rancher Desktop (k3s) Deployer
EOF
echo -e "${RESET}"

# ─── 1. Checks ────────────────────────────────
step "Checking prerequisites"

command -v kubectl &>/dev/null || error "kubectl not found"
command -v docker  &>/dev/null || error "docker not found"

CLUSTER=$(kubectl config current-context 2>/dev/null || echo "unknown")
SERVER=$(kubectl cluster-info 2>/dev/null | grep "control plane" | awk '{print $NF}' || echo "")
success "kubectl context: $CLUSTER"
success "Cluster: $SERVER"

# Warn if not pointing at local k3s
if [[ "$SERVER" != *"127.0.0.1"* && "$SERVER" != *"localhost"* ]]; then
  warn "Cluster server ($SERVER) does not look like a local Rancher Desktop instance."
  read -rp "  Continue anyway? [y/N]: " CONT
  [[ "$CONT" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }
fi

# ─── 2. Configuration ─────────────────────────
step "Configuration"

if command -v openssl &>/dev/null; then
  DEFAULT_SECRET=$(openssl rand -hex 32)
else
  DEFAULT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-f0-9' | head -c 32)
fi

echo ""
echo -e "  ${BOLD}GitHub Webhook Secret${RESET}"
read -rp "  Webhook secret [press Enter to use generated]: " WEBHOOK_SECRET
WEBHOOK_SECRET="${WEBHOOK_SECRET:-$DEFAULT_SECRET}"

echo ""
echo -e "  ${BOLD}Default Timezone${RESET} (for cron schedules)"
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

# ─── 3. Build image ───────────────────────────
step "Building Docker image"

info "Building $IMAGE_NAME:$IMAGE_TAG from $SCRIPT_DIR/manager ..."
docker build -t "$IMAGE_NAME:$IMAGE_TAG" "$SCRIPT_DIR/manager" \
  || error "Docker build failed"

success "Image built: $IMAGE_NAME:$IMAGE_TAG"

# ─── 4. Namespace ─────────────────────────────
step "Creating namespace"

kubectl apply -f "$SCRIPT_DIR/k8s/namespace.yaml"
success "Namespace '$NAMESPACE' ready"

# ─── 5. Secret ────────────────────────────────
step "Applying secret"

kubectl create secret generic dock-tools-secret \
  --namespace="$NAMESPACE" \
  --from-literal=WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  --from-literal=UI_PASSWORD="$UI_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

success "Secret applied"

# ─── 6. Patch timezone in configmap if changed ─
if [ "$DEFAULT_TZ" != "UTC" ]; then
  info "Patching DEFAULT_TIMEZONE → $DEFAULT_TZ"
  # We'll patch after apply via kubectl patch
fi

# ─── 7. Apply manifests ───────────────────────
step "Applying Kubernetes manifests"

kubectl apply -k "$SCRIPT_DIR/k8s/"

if [ "$DEFAULT_TZ" != "UTC" ]; then
  kubectl patch configmap manager-config \
    --namespace="$NAMESPACE" \
    --type merge \
    -p "{\"data\":{\"DEFAULT_TIMEZONE\":\"${DEFAULT_TZ}\"}}"
fi

success "Manifests applied"

# ─── 8. Wait for rollout ──────────────────────
step "Waiting for deployments to be ready"

info "Waiting for manager..."
kubectl rollout status deployment/manager -n "$NAMESPACE" --timeout=120s \
  || warn "Manager rollout timed out — check: kubectl logs -n $NAMESPACE deployment/manager"

info "Waiting for nginx..."
kubectl rollout status deployment/nginx -n "$NAMESPACE" --timeout=60s \
  || warn "Nginx rollout timed out"

# ─── 9. Get access URL ────────────────────────
step "Deployment complete"

NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}' 2>/dev/null || echo "")
if [ -z "$NODE_IP" ]; then
  NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || echo "192.168.64.2")
fi

LB_IP=$(kubectl get svc nginx -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  Deployed to Rancher Desktop!${RESET}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${BOLD}Web UI:${RESET}"
echo -e "    http://localhost:30080       (NodePort)"
[ -n "$LB_IP" ] && echo -e "    http://$LB_IP              (LoadBalancer)"
echo -e "    http://$NODE_IP:30080"
echo ""
echo -e "  ${BOLD}Webhook base URL:${RESET}"
echo -e "    http://$NODE_IP:30080/webhook/<script-name>"
echo ""
echo -e "  ${BOLD}Login:${RESET}           admin / ${UI_PASSWORD:-'(no password set)'}"
echo -e "  ${BOLD}Webhook secret:${RESET}  $WEBHOOK_SECRET"
echo ""
echo -e "${BOLD}  Useful commands:${RESET}"
echo -e "    Pods:     kubectl get pods -n $NAMESPACE"
echo -e "    Logs:     kubectl logs -n $NAMESPACE deployment/manager -f"
echo -e "    Services: kubectl get svc -n $NAMESPACE"
echo -e "    Redeploy: bash $SCRIPT_DIR/deploy-rancher.sh"
echo -e "    Teardown: kubectl delete namespace $NAMESPACE"
echo ""
