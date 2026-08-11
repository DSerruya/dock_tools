# Configuration Guide

Every configurable feature in Dock Tools, in one place: per-script settings, platform-level
features (auth, webhooks, backups), and deployment/infra configuration. For a quick start, see
[README.md](README.md). This doc goes deeper on *how to configure* each piece.

## Contents

- [Per-script configuration](#per-script-configuration)
  - [Basics: language, source, entry point](#basics-language-source-entry-point)
  - [Build command & Preserve Environment](#build-command--preserve-environment)
  - [Run mode: Persistent vs Scheduled](#run-mode-persistent-vs-scheduled)
  - [Port](#port)
  - [Environment variables](#environment-variables)
  - [VPN (OpenVPN sidecar)](#vpn-openvpn-sidecar)
  - [Heartbeat monitoring](#heartbeat-monitoring)
  - [Private repos (GitHub token)](#private-repos-github-token)
- [Upload-based scripts (no git)](#upload-based-scripts-no-git)
- [Webhooks (auto-sync on push)](#webhooks-auto-sync-on-push)
- [Roles & authentication](#roles--authentication)
- [Backup, Export, Import](#backup-export-import)
- [Audit log](#audit-log)
- [Self-update](#self-update)
- [Admin ops tools](#admin-ops-tools)
- [Deployment & infrastructure](#deployment--infrastructure)

---

## Per-script configuration

Everything below is set in the **Add Script** / **Edit Script** modal (the ✏ button on a script's
card).

### Basics: language, source, entry point

| Field | Description |
|---|---|
| **Name** | Lowercase letters, numbers, hyphens only. Immutable after creation. |
| **Language** | `python` (3.12), `ruby` (3.3), `node` (20), or `typescript` (runs via `ts-node` on the Node 20 image). |
| **Source Type** | `git` (default) or `upload` — immutable after creation. See [Upload-based scripts](#upload-based-scripts-no-git) for the upload flow. |
| **Repo / Branch** | Git-only. HTTPS clone URL and branch to track. |
| **Entry Point** | The start command, e.g. `ruby main.rb`, `python -u main.py`, `node index.js`. Run through `sh -c`, so flags/prefixes work (`stdbuf -o0 ruby main.rb`). |

Use the **?** button (top-right of the Add Script modal) for per-language copy-paste snippets and
stdout-buffering gotchas (Ruby and Python buffer stdout by default inside Docker — fix with
`$stdout.sync = true` / `python -u`, or `PYTHONUNBUFFERED=1`).

### Build command & Preserve Environment

**Build Command** (optional) — a pre-start step run before Entry Point, e.g.
`npm install && npm run build`, `bundle install`, `pip install -r requirements.txt`. When set,
Entry Point becomes the *start* command (e.g. `npm start`) and the repo directory is mounted
read-write so build output can be written.

By default, Build Command re-runs on **every** start/restart — for a `bundle install` or
`npm install` that takes real time, that's most of your run time spent reinstalling dependencies
that didn't change.

**Preserve Environment** toggle (appears once a Build Command is set) — skips re-running Build
Command once it has succeeded, verified by a marker file (`.deps-installed`) written into the
repo directory only after Build Command actually exits 0. It's a plain on/off flag:

- **Off (default)** — Build Command always runs. Simple, always fresh, slower.
- **On** — Build Command runs once, then gets skipped on subsequent runs — *until* one of:
  - **Update Deps** button (on the script's card, appears when Preserve Environment + Build
    Command are both set) — forces exactly one rebuild, then goes back to skipping.
  - You edit the **Build Command** text itself.
  - **Any git pull** — restart, start, or Update (Apply Update) for a git-based script always
    forces one rebuild, regardless of whether Build Command's text changed. This matters because
    a pull can bring in a new dependency (e.g. a `Gemfile` gaining a new gem) without touching
    Build Command at all — skipping the reinstall in that case would silently run stale
    dependencies. `run-now` (no pull involved) is unaffected and still skips normally.

  For **upload**-based scripts, replacing the code via a new archive upload always wipes the
  cache too (the whole repo directory is replaced).

Practical guidance: turn this on for any script with a slow `bundle install`/`npm install` that
restarts often (e.g. via webhook or a frequent schedule). Leave it off for scripts where a build
is cheap or rarely restarts — no benefit, no risk.

### Run mode: Persistent vs Scheduled

- **Persistent** — an always-on container (`unless-stopped` restart policy). Use for services,
  daemons, long-running loops.
- **Scheduled** — a cron expression + timezone; the manager runs the script as a one-shot
  container on each tick and captures its exit code. Use the quick-pick buttons or type a raw
  cron expression; the preview shows a human-readable description and next run time.

Switching modes on an existing script (via Edit) tears down whatever's currently running and
applies the new mode.

### Port

Persistent scripts only. If set, the container's port is published on the host at the same
number (`-p <port>:<port>`) and an "Open App ↗" link appears on the script's card. Leave blank for
scripts with no HTTP server.

### Environment variables

Per-script key/value pairs, stored in `scripts.json` (not in the repo). Add rows individually, or
bulk-paste a `.env`-formatted block. Download the current set as a `.env` file from the script's
card. Values are masked to key-names-only in the audit log and export bundle.

### VPN (OpenVPN sidecar)

Toggle **VPN Enabled** to route all of a script's traffic through OpenVPN. Upload a `.ovpn` config
file (≤512 KB) — the manager stores it and spins up a dedicated sidecar container
(`script-vpn-<name>`) sharing its network namespace with the script container, so the script gets
routed traffic with no code changes.

**MSS Fix** (optional, digits only, e.g. `1360`) — passed to OpenVPN as `--mssfix <n>`. Use this if
larger queries/responses over the tunnel hang or truncate while small ones work fine — a classic
symptom of a Path-MTU-Discovery blackhole (ICMP dropped somewhere on the path, so the kernel's
PMTU cache never populates and `iptables --clamp-mss-to-pmtu` can't help either). See
[MTU-VPN-DEBUGGING-PLAYBOOK.md](MTU-VPN-DEBUGGING-PLAYBOOK.md) for how to diagnose the right value,
or use the Admin → SQL-over-VPN test tool ([below](#admin-ops-tools)) to test one against a real
query before committing it to a production script.

### Heartbeat monitoring

Toggle **Heartbeat Monitoring** and set a **Heartbeat URL** to have the manager send a `GET`
request to that URL after every run that exits successfully (exit code `0`) — the "dead man's
switch" pattern used by monitors such as Zenduty and Xurrent's heartbeat check-ins.

- **On success** — the URL is pinged.
- **On failure** — nothing is sent. The whole point of this pattern is that the monitor's own
  missed-heartbeat timeout is what raises the alert; the manager reporting the failure itself
  would be redundant and could race a monitor that's already down.

Applies to both run modes: a Persistent script is pinged if/when its container exits `0`; a
Scheduled script is pinged after each successful cron tick or **Run Now**. Heartbeat URL is
required while the toggle is on, and must be `http://` or `https://`. Ping failures (timeout,
non-2xx, DNS) are logged to the script's run log and the manager's console but never fail the run.

### Private repos (GitHub token)

Git-based scripts only. Paste a GitHub Personal Access Token with **Contents: read** scope. Stored
encrypted at rest (AES-256-GCM, keyed from `WEBHOOK_SECRET`) and masked to `***` everywhere it's
displayed or logged. Leaving the field blank on an edit keeps the existing token; there's no way to
view it again once saved — replace it if you need to rotate it.

---

## Upload-based scripts (no git)

For code that doesn't live in a git repo (or where you'd rather not connect one). No webhook
support, no auto-sync — you push code manually.

1. **Create** the script with **Source Type: Upload**. It's created inert — no container, no
   code yet.
2. **Upload code**: on the script's card (or right after creation), upload a `.tar.gz`/`.tgz`
   archive (≤250 MB) containing a single top-level directory (its contents get extracted with
   `--strip-components=1` — matching what the ⬇ Download button produces, so a round-trip via
   Download → re-upload elsewhere always works). This wipes and replaces everything on disk for
   that script, then starts it (persistent) or registers its cron job (scheduled).
3. **Replace code** later by uploading a new archive the same way — full overwrite, no diffing.
4. **Download** the current code anytime via the ⬇ button, e.g. to seed another script or as a
   backup before replacing it.

Archive entries with an absolute path or a `..` segment are rejected (path-traversal guard).
`check-update`/`update`/webhook actions all correctly refuse upload-based scripts and point you
back to uploading a new archive instead.

---

## Webhooks (auto-sync on push)

Git-based scripts get a webhook URL shown on their card:
`http://<your-host>/webhook/<script-name>`. Add it in GitHub → your repo → **Settings → Webhooks
→ Add webhook**:

| Field | Value |
|---|---|
| Payload URL | the URL shown on the script's card |
| Content type | `application/json` |
| Secret | your `WEBHOOK_SECRET` value |
| Events | just **push** |

On receipt: the signature (`X-Hub-Signature-256`, HMAC-SHA256 over the raw body) is verified
against `WEBHOOK_SECRET` — wrong/missing secret is rejected, and the endpoint 503s if
`WEBHOOK_SECRET` isn't configured at all. If the pushed branch doesn't match the script's
configured branch, the push is silently ignored. Otherwise: pull latest code, and for **persistent**
scripts, restart immediately; for **scheduled** scripts, the new code just waits for the next tick
(no restart).

This route bypasses the UI's Basic Auth entirely (it's public, GitHub needs to reach it) — HMAC
verification is the only gate, which is why `WEBHOOK_SECRET` must be a real secret, not the
`.env.example` placeholder.

---

## Roles & authentication

Three roles: **Admin**, **Agent**, **Viewer**.

| Action | Viewer | Agent | Admin |
|---|---|---|---|
| View scripts, logs, status | ✅ | ✅ | ✅ |
| Export config | ✅ | ✅ | ✅ |
| Create / edit / start / stop / restart scripts, upload VPN/archive/code | | ✅ | ✅ |
| View audit log | | ✅ | ✅ |
| Import scripts | | ✅ | ✅ |
| Delete scripts | | | ✅ |
| Manage users, backups, self-update, admin ops tools (Ollama, SQL/VPN tests, addons) | | | ✅ |

Users live in `scripts-data/users.json` (created via the Admin → Users tab, admin-only) — password
hashed with scrypt + a random salt, never stored or logged in plaintext.

**Open mode**: if no users exist yet (i.e. `UI_PASSWORD` was never set in `.env`), the entire UI is
served with **no authentication** — every request is treated as an anonymous admin. A warning is
printed on every boot and an `X-Open-Mode-Warning` response header is set while this is active.
Set `UI_PASSWORD` (and redeploy, or add a user via the API) to leave open mode.

Failed logins are rate-limited to 20 attempts per IP per 15 minutes (`429` past that).

---

## Backup, Export, Import

Three different things, easy to mix up:

| | What it includes | Format | Who can | Use for |
|---|---|---|---|---|
| **Export** | Script configs only (no `repoToken`, env values in plaintext) | Plain JSON | any role | Quick config snapshot, sharing a script's setup |
| **Import** | Adds git-based scripts from an exported/hand-written JSON array | Plain JSON | Admin, Agent | Bulk-adding scripts; skips names that already exist; upload-based scripts can't round-trip (no `repo` field) |
| **Backup** | *Everything*: script configs incl. `repoToken`, all users (password hashes), full audit log, both admin VPN `.ovpn` files | Encrypted `.dtbackup` (AES-256-GCM, keyed from `WEBHOOK_SECRET`) | Admin only | Full disaster recovery / migrating to a new host |

**Backup** requires `WEBHOOK_SECRET` to be set (fails otherwise) and can only be decrypted with
that *same* secret later — changing `WEBHOOK_SECRET` permanently breaks any existing backup and
any encrypted `repoToken`. **Restore** is a full overwrite: it requires typing `RESTORE` to
confirm, tears down any container not present in the backup, and replaces `scripts.json`,
`users.json`, and `audit.json` wholesale.

---

## Audit log

Admin → **Audit** tab (Admin/Agent only — viewers can't see it). Every config change, start/stop/
restart, deploy, and admin action is recorded with before/after values. Secrets are masked
(`repoToken` → `***`, `env` → key names only, never values). Retention is a hard cap of the most
recent **2000 entries** — no time-based expiry, oldest entries silently drop off past that.

---

## Self-update

Admin → **System** card:

1. **Check for updates** — compares the running build's commit SHA against `main` on the repo
   configured via `PROJECT_REPO` (defaults to the upstream Dock Tools repo).
2. **Update** — clones latest, builds a new image, and does a zero-downtime swap: renames the
   running container out of the way, starts the new one, health-checks it (container state, then
   an HTTP `/healthz` check), reloads nginx to pick up the new container before stopping the old
   one, and only then stops the old container. If the new container fails its health check, it
   rolls back automatically and the old container keeps running — no manual intervention needed.

Requires Docker socket access (already mounted) and works from any docker-compose deployment; the
new container inherits the running one's volume binds and restart policy automatically.

---

## Admin ops tools

All under the **Admin** tab, admin-only:

- **SQL-over-VPN test** — upload a dedicated `.ovpn`, then run a one-off query (Postgres/MySQL/
  MSSQL) through a throwaway VPN-connected container. Runs path-MTU diagnostics and can apply
  `--mssfix`/MSS-clamping before the query, so you can find the right VPN settings *before*
  wiring them into a real script. For MSSQL specifically it also surfaces the FreeTDS wire trace
  on failure. See [MTU-VPN-DEBUGGING-PLAYBOOK.md](MTU-VPN-DEBUGGING-PLAYBOOK.md).
- **General VPN test** — a simpler connectivity test: connects a `.ovpn` and proves data actually
  moved (kernel byte counters on the tunnel interface, before/after a real request) rather than
  trusting the "connected" log line alone — catches split-tunnel configs that connect but don't
  actually route your traffic.
- **Ollama tools** — CPU-compatibility check (detects AMX/AVX support, useful since some CPUs
  segfault on Ollama's AMX path), one-click fix buttons (`OLLAMA_NO_AMX`, `GGML_NO_AMX`, force
  AVX2, etc. — each recreates the `ollama` container with different env vars), a version pinner,
  a version/model compatibility tester, and memory-limit controls. `docker-compose.yml` ships with
  the AMX-avoidance flags pre-applied by default.
- **Addons** — one-click installs for common Ollama models plus a "Docker Health Check" addon
  that installs a cron job restarting any down compose service every 30 minutes (via the
  `health-checker` container, otherwise idle).
- **System resources** — host disk/memory plus per-container memory and disk usage.

---

## Deployment & infrastructure

**Choosing a deployment method**:

| Method | Use when |
|---|---|
| `bash install.sh` | Standard case — any VM/server/local Docker host. Interactive: installs prereqs if missing, configures `.env`, optional HTTPS (self-signed or your own cert), starts everything. |
| `bash deploy-rancher.sh` | You're already running Rancher Desktop's local k3s and want the Kubernetes manifests instead of Compose. No TLS option; fixed NodePort 30080; single-replica only (the Docker-socket mount means you can never scale beyond 1 instance). |
| Manual `docker compose up -d --build` | Full control — CI, scripted deploys, or custom port mapping via `docker-compose.override.yml`. Copy `.env.example` → `.env` and fill in `WEBHOOK_SECRET`, `HOST_SCRIPTS_DATA_PATH`, `UI_PASSWORD` by hand; TLS requires manually copying `nginx/nginx-tls.conf` over `nginx/nginx.conf` and placing `cert.pem`/`key.pem` in `nginx/certs/`. |

**Compose services** (`docker-compose.yml`): `manager` (the app itself), `nginx` (reverse proxy —
only whichever file is currently named `nginx.conf` is active: plain HTTP by default, or the TLS
variant), `ollama` (local LLM runtime for the addons feature, AMX-avoidance flags pre-set), and
`health-checker` (idle cron container, used only by the Docker Health Check addon).

**Required `.env` values** — see [README.md](README.md#manual-setup) for the table; the same
three (`WEBHOOK_SECRET`, `HOST_SCRIPTS_DATA_PATH`, `UI_PASSWORD`) apply everywhere, Compose or k8s.

**Kubernetes specifics** not already in the README: `HOST_SCRIPTS_DATA_PATH` in
`k8s/configmap-manager.yaml` must exactly match the `hostPath.path` used for the `scripts-data`
volume in `deployment-manager.yaml` — if you relocate it, change both together. The Deployment
uses `strategy: Recreate` (never scale replicas — only one instance can safely hold the Docker
socket). No TLS variant exists for the k8s nginx config. Image tag is hardcoded to
`dock-tools-manager:latest` with no per-environment parameterization out of the box.
