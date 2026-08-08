# ⚙️ Dock Tools — Script Manager

A self-hosted web dashboard for running and managing Python, Ruby, Node.js, and TypeScript scripts as Docker containers — with GitHub auto-sync, cron scheduling, live logs, and a one-click self-update.

![v1.1.0](https://img.shields.io/badge/version-1.1.0-6366f1)
![License](https://img.shields.io/badge/license-MIT-22c55e)

📖 **[CONFIGURATION.md](CONFIGURATION.md)** — detailed guide to every feature: per-script settings, roles, webhooks, backups, admin tools, and deployment options.

---

## Features

- **Web UI** — dark-themed dashboard to add, start, stop, restart, and monitor scripts
- **GitHub sync** — clones your repo on add; webhook auto-pulls and restarts on push
- **Run modes** — *Persistent* (always-on service) or *Scheduled* (cron, per-timezone)
- **Live logs** — real-time streaming log viewer per run
- **Multi-language** — Python 3.12, Ruby 3.3, Node.js 20, TypeScript (transpiled)
- **Build step** — optional `buildCommand` (e.g. `npm install && npm run build`) before start
- **Environment variables** — per-script env vars, bulk-import from `.env` paste
- **Role-based access** — Admin / Agent / Viewer roles with HTTP Basic Auth
- **Audit log** — every config change recorded with before/after values
- **Export / Import** — JSON config snapshots for backup or migration
- **Self-update** — Admin tab button clones latest code, rebuilds the Docker image, and restarts automatically
- **Kubernetes ready** — Kustomize manifests included for Rancher / k3s deployments

---

## Quick Start (Docker Compose)

**Requirements:** Docker, Docker Compose, Git

```bash
git clone https://github.com/DSerruya/dock_tools.git
cd dock_tools
bash install.sh
```

The installer will:
1. Check and optionally install prerequisites
2. Ask for a webhook secret, UI port, timezone, and password
3. Optionally set up HTTPS with a self-signed or custom certificate
4. Build and start the containers
5. Print the URL and credentials

The UI will be available at `http://<your-ip>:<port>` (default port 80).

---

## Manual Setup

Copy the example env file and fill in your values:

```bash
cp .env.example .env
# edit .env — set WEBHOOK_SECRET, HOST_SCRIPTS_DATA_PATH, UI_PASSWORD
docker compose up -d --build
```

**Required `.env` values:**

| Variable | Description |
|----------|-------------|
| `WEBHOOK_SECRET` | HMAC-SHA256 secret shared with GitHub webhooks |
| `HOST_SCRIPTS_DATA_PATH` | Absolute path on the host where cloned repos are stored |
| `UI_PASSWORD` | Web UI password (leave empty to disable auth — not recommended) |

---

## Adding a Script

1. Open the Web UI → click the **+ Add Script** ghost card (bottom of the grid)
2. Paste your GitHub repo URL, choose language and entry point
3. Optionally add a build command, environment variables, or a GitHub token for private repos
4. Choose **Persistent** (runs continuously) or **Scheduled** (cron expression)
5. Add the displayed webhook URL to your GitHub repo's webhook settings

On every `git push` to the watched branch, the manager pulls the latest code and restarts the container automatically.

---

## GitHub Webhook Setup

In your script's GitHub repo → **Settings → Webhooks → Add webhook**:

| Field | Value |
|-------|-------|
| Payload URL | `http://<your-host>/webhook/<script-name>` |
| Content type | `application/json` |
| Secret | Your `WEBHOOK_SECRET` value |
| Events | Just the push event |

---

## Roles

| Role | Can do |
|------|--------|
| **Admin** | Everything — manage users, scripts, view logs and audit |
| **Agent** | Create, start, stop, restart scripts — view logs and audit |
| **Viewer** | Read-only — view scripts and logs |

---

## Kubernetes / Rancher

Kustomize manifests are in `k8s/`. Apply with:

```bash
# Create the namespace and secrets first
kubectl create namespace dock-tools
kubectl create secret generic dock-tools-secret \
  --from-literal=WEBHOOK_SECRET=<your-secret> \
  --from-literal=UI_PASSWORD=<your-password> \
  -n dock-tools

# Deploy
kubectl apply -k k8s/
```

The manager deployment uses `imagePullPolicy: Never` and expects a locally built image tagged `dock-tools-manager:latest`:

```bash
docker build \
  --build-arg GIT_COMMIT=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t dock-tools-manager:latest ./manager
kubectl rollout restart deployment/manager -n dock-tools
```

---

## Self-Update

In the Admin tab → **System** card:

1. Click **Check for updates** — compares the running commit SHA against `main` on GitHub
2. If behind, click **↑ Update** — the manager clones the latest code, rebuilds its own Docker image via the socket, and restarts; the UI streams the build log live and reloads when the new pod is ready

---

## Security Notes

- All webhook payloads are verified with HMAC-SHA256 — requests with an empty or wrong secret are rejected
- GitHub PATs (repo tokens) are encrypted at rest with AES-256-GCM using `WEBHOOK_SECRET` as key material
- Auth endpoints are rate-limited to 20 failed attempts per IP per 15 minutes
- Script containers run with `Privileged: false`, `CapDrop: ALL`
- Security headers (CSP, X-Frame-Options, etc.) set by both Express and nginx
- `WEBHOOK_SECRET` must be set — the webhook endpoint returns 503 without it

---

## Project Structure

```
dock_tools/
├── manager/          # Node.js / Express API + web UI
│   ├── src/
│   │   ├── routes/   # API endpoints
│   │   ├── services/ # Docker, git, cron, config, audit
│   │   ├── middleware/
│   │   └── public/   # index.html + app.js (vanilla JS)
│   └── Dockerfile
├── nginx/            # Reverse proxy config (HTTP + TLS variants)
├── k8s/              # Kubernetes / Kustomize manifests
├── examples/         # Sample Python and Ruby scripts
├── install.sh        # Interactive installer
└── docker-compose.yml
```

---

## License

MIT
