#!/bin/bash
# Tests a range of Ollama versions to find the oldest that supports a model
# without segfaulting on this kernel.
#
# Usage:
#   ./test-ollama-versions.sh              # tests gemma3:4b (default)
#   ./test-ollama-versions.sh gemma3:12b   # tests a different model

MODEL="${1:-gemma3:4b}"
CONTAINER="ollama-version-test"
HOST_PORT=11435
VOLUME="ollama-version-test-cache"

VERSIONS=(
  0.6.0  0.7.0  0.8.0  0.9.0  0.10.0
  0.11.0 0.12.0 0.13.0 0.14.0 0.15.0
  0.16.0 0.17.0 0.18.0 0.19.0 0.20.0
  0.21.0 0.22.0 0.23.0 0.24.0 0.25.0
  0.26.0 0.27.0 0.28.0 0.29.0 0.30.0 0.30.10
)

cleanup() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

pad()   { printf "%-12s" "$1"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
yellow(){ printf '\033[33m%s\033[0m' "$*"; }

echo "========================================"
echo "Ollama version compatibility test"
echo "Model : $MODEL"
echo "Kernel: $(uname -r)"
echo "Date  : $(date)"
echo "========================================"
echo ""

declare -A RESULTS

for VER in "${VERSIONS[@]}"; do
  pad "$VER"
  cleanup

  # Pull docker image — skip if not published
  if ! docker pull -q "ollama/ollama:$VER" 2>/dev/null; then
    yellow "SKIP"; echo " (image not found on Docker Hub)"
    RESULTS[$VER]="skip"
    continue
  fi

  # Start container
  docker run -d \
    --name "$CONTAINER" \
    --security-opt seccomp=unconfined \
    -v "$VOLUME:/root/.ollama" \
    -p "${HOST_PORT}:11434" \
    "ollama/ollama:$VER" >/dev/null

  # Wait up to 30s for the API to be ready
  ready=0
  for _ in $(seq 1 30); do
    if curl -sf "http://localhost:${HOST_PORT}/api/tags" >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep 1
  done

  if [ $ready -eq 0 ]; then
    red "FAIL"; echo " (container didn't start in 30s)"
    RESULTS[$VER]="fail_start"
    continue
  fi

  # Try pulling the model (reuses cached weights from volume on repeat runs)
  pull_log=$(timeout 600 docker exec "$CONTAINER" ollama pull "$MODEL" 2>&1 || true)

  if echo "$pull_log" | grep -qE "412|newer version of Ollama"; then
    yellow "TOO OLD"; echo " (412 — model requires a newer Ollama)"
    RESULTS[$VER]="too_old"
    cleanup
    continue
  fi

  if echo "$pull_log" | grep -qiE "^Error|failed|connection refused"; then
    red "PULL FAIL"; echo " ($(echo "$pull_log" | head -1))"
    RESULTS[$VER]="pull_fail"
    cleanup
    continue
  fi

  # Try running the model
  run_log=$(timeout 120 docker exec "$CONTAINER" ollama run "$MODEL" "say hello" 2>&1 || true)

  if echo "$run_log" | grep -qiE "segmentation fault|signal: segmentation|core dumped|500 Internal Server Error"; then
    red "SEGFAULT"; echo " (crashes on this kernel)"
    RESULTS[$VER]="segfault"
  elif [ -n "$run_log" ] && ! echo "$run_log" | grep -qiE "^Error|500"; then
    green "OK"; echo " — response: $(echo "$run_log" | head -1)"
    RESULTS[$VER]="ok"
  else
    red "ERROR"; echo " ($(echo "$run_log" | head -1))"
    RESULTS[$VER]="error"
  fi

  cleanup
done

# Clean up shared model cache volume
docker volume rm "$VOLUME" 2>/dev/null || true

echo ""
echo "========================================"
echo "SUMMARY — $MODEL on kernel $(uname -r)"
echo "========================================"
printf "%-12s %s\n" "VERSION" "RESULT"
echo "------------ ---------------------------------"
for VER in "${VERSIONS[@]}"; do
  result="${RESULTS[$VER]:-skip}"
  printf "%-12s " "$VER"
  case "$result" in
    ok)        green "OK — works!" ;;
    too_old)   yellow "TOO OLD (412)" ;;
    segfault)  red   "SEGFAULT" ;;
    skip)      echo -n "SKIP (not on Docker Hub)" ;;
    *)         red "$result" ;;
  esac
  echo ""
done
echo ""
echo "Tip: pin the oldest OK version in docker-compose.yml to avoid future regressions."
