# Docker Script Manager — Implementation Plan

## Overview

A Docker-based platform to manage Python, Ruby, and TypeScript scripts/tools with:
- Web UI dashboard
- GitHub webhook auto-sync (push → pull → restart)
- **Cron scheduling** — run scripts on a time-based schedule (every X minutes/hours/days)
- Multi-language support
- Reverse proxy via Nginx

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Host Machine                  │
│                                                 │
│  ┌──────────┐    ┌────────────────────────────┐ │
│  │  Nginx   │───▶│   Manager (TypeScript)     │ │
│  │  :80     │    │   :3000                    │ │
│  └──────────┘    │  - Web UI                  │ │
│       │          │  - REST API                │ │
│       │          │  - GitHub Webhook handler  │ │
│       │          │  - Docker socket access    │ │
│       │          │  - Git operations          │ │
│       │          └────────────────────────────┘ │
│       │                      │                  │
│       │             Docker socket               │
│       │                      │                  │
│       │          ┌───────────▼──────────────┐   │
│       │          │    Script Containers      │   │
│       │          │  ┌──────┐ ┌──────┐ ┌───┐ │   │
│       └─────────▶│  │ Py   │ │ Ruby │ │ TS│ │   │
│                  │  │ :xxxx│ │ :xxxx│ │:xx│ │   │
│                  │  └──────┘ └──────┘ └───┘ │   │
│                  └───────────────────────────┘   │
│                                                  │
│  scripts-data/   ← shared volume (cloned repos)  │
└──────────────────────────────────────────────────┘
```

---

## Directory Structure

```
docker_support_env/
├── docker-compose.yml          # Orchestrates manager + nginx
├── .env                        # Secrets (webhook secret, host path)
├── .env.example                # Template for .env
├── PLAN.md                     # This file
├── nginx/
│   └── nginx.conf              # Reverse proxy config
├── manager/                    # TypeScript web app
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # Express app entry point
│       ├── types.ts            # Shared TypeScript types
│       ├── services/
│       │   ├── configService.ts   # Read/write scripts.json
│       │   ├── dockerService.ts   # Manage containers via dockerode
│       │   ├── gitService.ts      # Clone/pull repos via simple-git
│       │   └── cronService.ts     # Cron schedule management (node-cron)
│       ├── routes/
│       │   ├── scripts.ts         # CRUD + start/stop/logs API
│       │   ├── schedules.ts       # Cron schedule CRUD API
│       │   └── webhooks.ts        # GitHub webhook handler
│       └── public/
│           ├── index.html         # Single-page web UI
│           └── app.js             # UI JavaScript
├── scripts-data/               # Created at runtime; holds cloned repos
│   └── .gitkeep
└── examples/
    ├── python-example/
    │   ├── main.py
    │   └── requirements.txt
    └── ruby-example/
        ├── main.rb
        └── Gemfile
```

---

## Step-by-Step Implementation

### Step 1 — Project Scaffolding

Create all directories:
```
manager/src/services/
manager/src/routes/
manager/src/public/
nginx/
examples/python-example/
examples/ruby-example/
scripts-data/
```

Create `.env` from `.env.example`:
```
WEBHOOK_SECRET=your_github_webhook_secret
HOST_SCRIPTS_DATA_PATH=/absolute/path/to/docker_support_env/scripts-data
```

---

### Step 2 — Manager Service (TypeScript)

#### `manager/package.json`
Key dependencies:
- `express` — HTTP server
- `dockerode` — Docker API client
- `simple-git` — Git clone/pull
- `node-cron` — Cron scheduling (standard cron syntax)
- `crypto` (built-in) — Webhook HMAC validation
- `typescript`, `ts-node`, `@types/*` — Dev tooling

#### `manager/tsconfig.json`
- Target: ES2020
- Module: CommonJS
- Output: `dist/`

#### `manager/src/types.ts`
```typescript
type RunMode = 'persistent' | 'scheduled';
// persistent: container stays running continuously (default)
// scheduled:  container starts, runs to completion, stops — on cron tick

interface ScriptConfig {
  name: string;           // unique slug → container name prefix
  language: 'python' | 'ruby' | 'node' | 'typescript';
  repo: string;           // GitHub HTTPS clone URL
  branch: string;         // e.g. "main"
  entryPoint: string;     // e.g. "main.py", "main.rb", "index.js"
  port?: number;          // optional exposed port (persistent mode only)
  env?: Record<string, string>;
  runMode: RunMode;       // default: 'persistent'
  schedule?: string;      // cron expression, required when runMode='scheduled'
                          // e.g. "*/5 * * * *" (every 5 min), "0 9 * * *" (daily 9am)
  timezone?: string;      // e.g. "America/New_York", default UTC
}

interface ScriptStatus {
  config: ScriptConfig;
  containerId?: string;
  status: 'running' | 'stopped' | 'error' | 'not_cloned';
  lastSync?: string;      // ISO timestamp of last git pull
  lastRun?: string;       // ISO timestamp of last cron execution
  nextRun?: string;       // ISO timestamp of next scheduled run (scheduled mode only)
}

interface CronJob {
  scriptName: string;
  expression: string;
  timezone: string;
  active: boolean;
}
```

#### `manager/src/services/configService.ts`
- Persists configs to `/app/scripts-data/scripts.json`
- Methods: `loadAll()`, `save(config)`, `remove(name)`, `get(name)`

#### `manager/src/services/gitService.ts`
Uses `simple-git`:
- `clone(config)` → clones repo to `/app/scripts-data/<name>/repo/`
- `pull(config)` → pulls latest on configured branch
- `isCloned(name)` → checks if `.git` directory exists
- `getLocalPath(name)` → returns local path inside manager container

#### `manager/src/services/cronService.ts`
Uses `node-cron` library:

- Maintains an in-memory map of active cron jobs: `Map<scriptName, ScheduledTask>`
- **`register(config: ScriptConfig): void`**
  - Validates the cron expression with `cron.validate(expression)`
  - Schedules a task using `cron.schedule(expression, callback, { timezone })`
  - Callback: clone if needed → start container → wait for exit → record `lastRun`
  - Stores the task in the map; replaces any existing job for that script
- **`unregister(name: string): void`**
  - Stops and destroys the scheduled task for that script
- **`reschedule(config: ScriptConfig): void`**
  - Calls `unregister` then `register` (used when schedule expression changes)
- **`getNextRun(name: string): string | null`**
  - Returns ISO timestamp of the next scheduled execution, or null if not scheduled
- **`initAll(configs: ScriptConfig[]): void`**
  - Called at manager startup — registers cron jobs for all configs with `runMode='scheduled'` and a valid `schedule`
- **`isValidExpression(expression: string): boolean`**
  - Wraps `cron.validate()` for use in API validation

**How scheduled execution works:**
1. Cron tick fires at the scheduled time
2. cronService calls `dockerService.runOnce(config, repoPath)`:
   - Creates a fresh container (no restart policy)
   - Starts it
   - Waits for container to exit (`container.wait()`)
   - Captures exit code and logs
   - Removes the container
3. Records `lastRun` timestamp in config
4. If the container is already running from a previous run that hasn't finished, the new tick is skipped (logged as "skipped — previous run still active")

**Cron expression standard (node-cron format):**
```
┌────────────── second (optional, 0-59)
│ ┌──────────── minute (0-59)
│ │ ┌────────── hour (0-23)
│ │ │ ┌──────── day of month (1-31)
│ │ │ │ ┌────── month (1-12)
│ │ │ │ │ ┌──── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │ │
* * * * * *
```
Common examples:
| Expression | Meaning |
|---|---|
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * 1` | Every Monday at 9:00 AM |
| `0 0 1 * *` | First day of every month |
| `*/30 * * * *` | Every 30 minutes |

#### `manager/src/services/dockerService.ts`
Uses `dockerode` (connects via `/var/run/docker.sock`):
- **Language → Docker image mapping:**
  - `python` → `python:3.12-slim`
  - `ruby` → `ruby:3.3-slim`
  - `node` → `node:20-slim`
  - `typescript` → `node:20-slim` (runs compiled JS or ts-node)
- **Container name:** `script-<name>`
- **Volume mount:** host path `$HOST_SCRIPTS_DATA_PATH/<name>/repo` → `/app` inside container
- **CMD:** `["python", "main.py"]` / `["ruby", "main.rb"]` / `["node", "index.js"]`
- Methods:
  - `start(config)` — create + start container (persistent mode)
  - `stop(name)` — stop container
  - `restart(config)` — stop → remove → recreate → start
  - `runOnce(config, repoPath)` — create → start → wait for exit → remove (scheduled mode)
  - `getStatus(name)` — query Docker for container state
  - `getLogs(name, lines)` — fetch last N log lines
  - `remove(name)` — remove container
- Container restart policy: `always` for persistent, `no` for scheduled

#### `manager/src/routes/scripts.ts`
REST API:

| Method | Path | Action |
|--------|------|--------|
| GET | `/api/scripts` | List all with live Docker status + nextRun for scheduled |
| POST | `/api/scripts` | Add script → clone repo → start/register based on runMode |
| DELETE | `/api/scripts/:name` | Stop + remove container + unregister cron + delete config |
| POST | `/api/scripts/:name/start` | Clone if needed → start (persistent) or run once now (scheduled) |
| POST | `/api/scripts/:name/stop` | Stop container |
| POST | `/api/scripts/:name/restart` | Git pull → restart container |
| POST | `/api/scripts/:name/run-now` | Trigger one immediate execution regardless of schedule |
| GET | `/api/scripts/:name/logs` | Last 200 lines of container logs |
| GET | `/api/scripts/:name/status` | Live container status + next/last run times |

#### `manager/src/routes/schedules.ts`
Schedule management REST API:

| Method | Path | Action |
|--------|------|--------|
| GET | `/api/schedules` | List all active cron jobs with nextRun times |
| PUT | `/api/scripts/:name/schedule` | Set or update cron expression (body: `{ schedule, timezone }`) |
| DELETE | `/api/scripts/:name/schedule` | Remove schedule → switch to persistent mode |
| POST | `/api/schedules/validate` | Validate a cron expression (body: `{ expression }`) |

#### `manager/src/routes/webhooks.ts`
- `POST /webhook/:name`
- Validates `X-Hub-Signature-256` header using HMAC-SHA256 + timing-safe compare
- Checks push is to configured branch
- Calls `gitService.pull(config)` then `dockerService.restart(config)`
- Returns 200 on success, 400/500 on failure

#### `manager/src/index.ts`
- Express app setup
- Mount `/api` → scripts router
- Mount `/api` → schedules router
- Mount `/webhook` → webhooks router
- Serve `public/` as static files
- On startup: call `cronService.initAll(configs)` to restore all scheduled jobs
- Listen on port 3000

---

### Step 3 — Web UI

#### `manager/src/public/index.html` + `app.js`

**UI Features:**
- Dark-themed dashboard
- **Header:** "Script Manager" + "Add Script" button
- **Script cards grid:** one card per script showing:
  - Name + language badge (color-coded: blue=python, red=ruby, green=node/ts)
  - Status badge (green=running, red=stopped, grey=not cloned, yellow=error)
  - Last synced timestamp
  - Webhook URL (click to copy): `http://<host>/webhook/<name>`
  - Action buttons: Start / Stop / Restart / Logs / Delete
- **Add Script modal** with form fields:
  - Name (slug, lowercase, hyphens only)
  - Language (select: python / ruby / node / typescript)
  - GitHub Repo URL
  - Branch (default: main)
  - Entry Point (e.g. main.py)
  - **Run Mode** (toggle: Persistent / Scheduled)
    - If Persistent: show Port (optional)
    - If Scheduled: show Schedule field + Timezone field
  - **Schedule** — cron expression input with:
    - Inline human-readable preview (e.g. "Every 5 minutes")
    - Quick-pick buttons: Every 5 min / Every hour / Daily at 9am / Weekly
    - Validate button → calls `/api/schedules/validate`
  - **Timezone** — select dropdown (common zones + UTC default)
  - Env vars (key=value, add/remove rows)
- **Script cards** show additional info for scheduled scripts:
  - Clock icon instead of status dot
  - "Next run: in 3 minutes" (live countdown)
  - "Last run: 10 minutes ago" timestamp
  - Run Now button (triggers immediate execution)
- **Logs modal:** shows last 200 lines, auto-refreshes every 5s while open
- **Auto-refresh** script statuses every 10 seconds

---

### Step 4 — Nginx Config

`nginx/nginx.conf`:
- Listens on port 80
- Proxies all traffic to `manager:3000`
- WebSocket upgrade headers
- Properly forwards `X-Real-IP` and `X-Forwarded-For`

---

### Step 5 — Docker Compose

`docker-compose.yml` services:
1. **manager** — builds from `./manager`, mounts Docker socket + scripts-data volume
2. **nginx** — `nginx:alpine`, mounts config file, depends on manager

Shared network: `script-network` (bridge) — script containers also join this network so Nginx can optionally proxy their web ports too.

Volume: `./scripts-data` bind-mounted into manager at `/app/scripts-data`. The same host path is passed as `HOST_SCRIPTS_DATA_PATH` so the manager can create correct bind mounts for script containers.

---

### Step 6 — Example Scripts

**`examples/python-example/main.py`**
```python
# Simple loop script — demonstrates auto-restart on push
import time, datetime
while True:
    print(f"[{datetime.datetime.now()}] Python script running - v1")
    time.sleep(10)
```

**`examples/ruby-example/main.rb`**
```ruby
# Simple loop script
loop do
  puts "[#{Time.now}] Ruby script running - v1"
  sleep 10
end
```

---

### Step 7 — Manager Dockerfile

```dockerfile
FROM node:20-slim

# Install git (required for clone/pull operations)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/index.js"]
```

---

## Cron Schedule Behavior

### Run Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **Persistent** | Container stays running indefinitely; restarts on crash | Long-running servers, daemons, web apps |
| **Scheduled** | Container starts, runs script to completion, then stops | ETL jobs, reports, cleanup tasks, scrapers |

### Scheduled Mode Lifecycle

```
Cron tick fires
      │
      ▼
Is a previous run still active?
      │
   Yes │ No
      │  └──▶ git pull (if webhook-synced) ──▶ docker run ──▶ script executes
      │                                                              │
      ▼                                                              ▼
  Skip + log                                               container exits
  "already running"                                               │
                                                                  ▼
                                                    record lastRun timestamp
                                                    remove container
                                                    wait for next tick
```

### Webhook + Schedule Interaction

When a script has BOTH a GitHub webhook AND a cron schedule:
- Webhook push → `git pull` only (does NOT trigger an immediate run; waits for next cron tick)
- Exception: if `runMode` is `persistent`, webhook push → `git pull` + restart as before

This avoids double-executions. The UI shows "Code updated — will use new code on next scheduled run."

---

## GitHub Webhook Setup (Per Script)

After adding a script in the UI:

1. Go to your GitHub repo → **Settings → Webhooks → Add webhook**
2. **Payload URL:** `http://<your-server-ip>/webhook/<script-name>`
3. **Content type:** `application/json`
4. **Secret:** same value as `WEBHOOK_SECRET` in `.env`
5. **Events:** select "Just the push event"
6. Click **Add webhook**

From that point on, every `git push` to the configured branch will:
- Trigger the webhook
- Manager validates signature
- Manager runs `git pull` on the cloned repo
- Manager stops → removes → recreates → starts the container
- Script runs with the new code within seconds

---

## Startup Instructions

```bash
# 1. Clone this repo / enter the directory
cd docker_support_env

# 2. Set up environment
cp .env.example .env
# Edit .env: set WEBHOOK_SECRET and HOST_SCRIPTS_DATA_PATH

# 3. Build and start
docker compose up -d --build

# 4. Open the UI
open http://localhost

# 5. Add your first script via the UI
# Fill in the form, click Add → it clones the repo and starts the container
```

---

## Bonus — TypeScript / Web Tools

The platform already supports `node` and `typescript` as language options. For web-interface tools (e.g. a Next.js app, a React dashboard, an API server):

- Set **language:** `node` or `typescript`
- Set **port:** e.g. `8080`
- Set **entry point:** `server.js` or `dist/index.js`
- The container's port is exposed on the host and proxied via Nginx

To add Nginx routing for a script's web UI, add an upstream block in `nginx.conf` pointing to `script-<name>:<port>`.

---

## Example: Adding a Scheduled Python Script

1. Push your Python script to GitHub (e.g. `my-daily-report`)
2. Open the UI → Add Script
3. Fill in:
   - Name: `daily-report`
   - Language: `python`
   - Repo: `https://github.com/you/my-daily-report`
   - Branch: `main`
   - Entry Point: `main.py`
   - Run Mode: **Scheduled**
   - Schedule: `0 9 * * *` → preview shows "Every day at 9:00 AM"
   - Timezone: `America/New_York`
4. Click Add — the repo is cloned, the cron job is registered
5. Every morning at 9 AM (NY time) the script runs automatically
6. To run it immediately: click **Run Now** on the script card
7. Set up the GitHub webhook to keep code in sync between pushes

---

## Security Notes

- Docker socket is mounted — the manager has full Docker access. Run on a trusted network or behind a VPN.
- Webhook HMAC-SHA256 validation prevents unauthorized triggers.
- Use strong, random `WEBHOOK_SECRET` (e.g. `openssl rand -hex 32`).
- Consider adding HTTP Basic Auth to the manager UI in production.
