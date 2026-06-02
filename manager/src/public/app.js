/* global state */
let refreshInterval = null;
let logsInterval = null;
let currentLogsScript = null;

const CRON_DESCRIPTIONS = [
  [/^\*\/(\d+) \* \* \* \*$/, m => `Every ${m[1]} minute${m[1]==='1'?'':'s'}`],
  [/^0 \*\/(\d+) \* \* \*$/, m => `Every ${m[1]} hour${m[1]==='1'?'':'s'}`],
  [/^0 \* \* \* \*$/,        () => 'Every hour'],
  [/^0 (\d+) \* \* \*$/,    m => `Daily at ${m[1].padStart(2,'0')}:00`],
  [/^0 (\d+) \* \* (\d)$/,  m => {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return `Every ${days[+m[2]] || 'day'} at ${m[1].padStart(2,'0')}:00`;
  }],
  [/^0 0 1 \* \*$/,          () => 'First day of every month'],
  [/^0 0 \* \* \*$/,         () => 'Daily at midnight'],
];

function describeCron(expr) {
  for (const [re, fn] of CRON_DESCRIPTIONS) {
    const m = expr.trim().match(re);
    if (m) return fn(m);
  }
  return null;
}

function relativeTime(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

function timeUntil(iso) {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const s = Math.floor(diff / 1000);
  if (s < 60)   return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `in ${h}h`;
  return `in ${Math.floor(h/24)}d`;
}

/* ── API helpers ── */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/* ── Load & render scripts ── */
async function loadScripts() {
  setLoading(true);
  try {
    const scripts = await api('GET', '/api/scripts');
    renderScripts(scripts);
    document.getElementById('refresh-label').textContent =
      `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    toast('Failed to load scripts: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

function renderScripts(scripts) {
  const container = document.getElementById('scripts-container');
  if (!scripts.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">📦</div>
        <h2>No scripts yet</h2>
        <p style="color:var(--muted);margin-top:8px">Click "Add Script" to get started</p>
      </div>`;
    return;
  }
  container.innerHTML = `<div class="scripts-grid">${scripts.map(renderCard).join('')}</div>`;
}

function renderCard({ config, status, nextRun }) {
  const lang = config.language;
  const isScheduled = config.runMode === 'scheduled';
  const webhookUrl = `${location.origin}/webhook/${config.name}`;

  const statusDotClass = isScheduled && status !== 'error'
    ? 'status-scheduled'
    : `status-${status}`;

  const statusText = isScheduled
    ? (status === 'running' ? 'running' : 'scheduled')
    : status.replace('_', ' ');

  const metaLines = [
    `<span>📁 ${escHtml(config.repo.replace('https://github.com/', ''))}</span>`,
    `<span>🌿 ${escHtml(config.branch)}  ·  🚀 ${escHtml(config.entryPoint)}</span>`,
    config.lastSync ? `<span>🔄 Synced ${relativeTime(config.lastSync)}</span>` : '',
    config.lastRun  ? `<span>⏱ Last run ${relativeTime(config.lastRun)}</span>` : '',
    config.port     ? `<span>🌐 Port ${config.port}</span>` : '',
  ].filter(Boolean).join('');

  const scheduleBlock = isScheduled ? `
    <div class="schedule-info">
      <div class="schedule-row">
        <span class="schedule-cron">${escHtml(config.schedule || '')}</span>
        <span>${nextRun ? timeUntil(nextRun) : '—'}</span>
      </div>
      ${describeCron(config.schedule || '') ? `<div style="color:var(--muted);font-size:11px;margin-top:3px">${describeCron(config.schedule)}</div>` : ''}
    </div>` : '';

  const actions = isScheduled
    ? `<button class="btn btn-ghost btn-sm" onclick="runNow('${config.name}')">▶ Run Now</button>`
    : `<button class="btn btn-ghost btn-sm" onclick="startScript('${config.name}')">▶ Start</button>
       <button class="btn btn-ghost btn-sm" onclick="stopScript('${config.name}')">⏹ Stop</button>
       <button class="btn btn-ghost btn-sm" onclick="restartScript('${config.name}')">↺ Restart</button>`;

  return `
    <div class="card" id="card-${config.name}">
      <div class="card-header">
        <div class="card-title">
          <span class="status-dot ${statusDotClass}" title="${statusText}"></span>
          <span class="card-name">${escHtml(config.name)}</span>
          <span class="badge badge-${lang}">${lang}</span>
          ${isScheduled ? '<span class="badge" style="background:#1a1a3e;color:var(--accent)">cron</span>' : ''}
        </div>
        <span class="status-label">${statusText}</span>
      </div>

      <div class="card-meta">${metaLines}</div>

      ${scheduleBlock}

      <div class="webhook-row">
        <span class="webhook-url" title="${escHtml(webhookUrl)}">${escHtml(webhookUrl)}</span>
        <button class="copy-btn" onclick="copyText('${escHtml(webhookUrl)}')" title="Copy webhook URL">📋</button>
      </div>

      <div class="card-actions">
        ${actions}
        <button class="btn btn-ghost btn-sm" onclick="showLogs('${config.name}')">📋 Logs</button>
        <button class="btn btn-danger btn-sm" onclick="deleteScript('${config.name}')">🗑</button>
      </div>
    </div>`;
}

/* ── Actions ── */
async function startScript(name) {
  try {
    await api('POST', `/api/scripts/${name}/start`);
    toast(`${name} started`, 'success');
    setTimeout(loadScripts, 1500);
  } catch (e) { toast(e.message, 'error'); }
}

async function stopScript(name) {
  try {
    await api('POST', `/api/scripts/${name}/stop`);
    toast(`${name} stopped`, 'info');
    setTimeout(loadScripts, 1000);
  } catch (e) { toast(e.message, 'error'); }
}

async function restartScript(name) {
  try {
    toast(`Restarting ${name}…`, 'info');
    await api('POST', `/api/scripts/${name}/restart`);
    toast(`${name} restarted`, 'success');
    setTimeout(loadScripts, 1500);
  } catch (e) { toast(e.message, 'error'); }
}

async function runNow(name) {
  try {
    await api('POST', `/api/scripts/${name}/run-now`);
    toast(`${name} triggered`, 'success');
    setTimeout(loadScripts, 2000);
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteScript(name) {
  if (!confirm(`Delete "${name}"? This will stop and remove the container.`)) return;
  try {
    await api('DELETE', `/api/scripts/${name}`);
    toast(`${name} deleted`, 'info');
    loadScripts();
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Logs ── */
function showLogs(name) {
  currentLogsScript = name;
  document.getElementById('logs-title').textContent = `Logs — ${name}`;
  document.getElementById('logs-modal').classList.remove('hidden');
  refreshLogs();
  logsInterval = setInterval(refreshLogs, 5000);
}

async function refreshLogs() {
  if (!currentLogsScript) return;
  try {
    const { logs } = await api('GET', `/api/scripts/${currentLogsScript}/logs`);
    const el = document.getElementById('logs-output');
    el.classList.remove('logs-empty');
    el.textContent = logs || '(no output)';
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    document.getElementById('logs-output').textContent = 'Error fetching logs: ' + e.message;
  }
}

function closeLogs() {
  clearInterval(logsInterval);
  logsInterval = null;
  currentLogsScript = null;
  document.getElementById('logs-modal').classList.add('hidden');
}

/* ── Add Modal ── */
function openAddModal() {
  resetForm();
  document.getElementById('add-modal').classList.remove('hidden');
}

function closeAddModal() {
  document.getElementById('add-modal').classList.add('hidden');
}

function resetForm() {
  ['f-name','f-repo','f-entry','f-schedule'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('f-branch').value = 'main';
  document.getElementById('f-lang').value = 'python';
  document.getElementById('f-port').value = '';
  document.getElementById('f-timezone').value = 'UTC';
  document.getElementById('rm-persistent').checked = true;
  document.getElementById('env-rows').innerHTML = '';
  document.getElementById('cron-preview').textContent = '';
  toggleRunMode();
}

function toggleRunMode() {
  const scheduled = document.getElementById('rm-scheduled').checked;
  document.getElementById('persistent-fields').style.display = scheduled ? 'none' : '';
  document.getElementById('scheduled-fields').style.display  = scheduled ? '' : 'none';
}

document.querySelectorAll('input[name="run-mode"]').forEach(r => {
  r.addEventListener('change', toggleRunMode);
});

function addEnvRow(key, val) {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `
    <input type="text" placeholder="KEY" value="${escHtml(key||'')}" class="env-key" />
    <input type="text" placeholder="value" value="${escHtml(val||'')}" class="env-val" />
    <button class="env-remove" onclick="this.parentElement.remove()">×</button>`;
  document.getElementById('env-rows').appendChild(row);
}

function setCron(expr) {
  document.getElementById('f-schedule').value = expr;
  updateCronPreview();
}

function updateCronPreview() {
  const expr = document.getElementById('f-schedule').value.trim();
  const el = document.getElementById('cron-preview');
  if (!expr) { el.textContent = ''; return; }
  const desc = describeCron(expr);
  el.className = 'cron-preview';
  el.textContent = desc || expr;
}

async function submitAdd() {
  const name     = document.getElementById('f-name').value.trim();
  const language = document.getElementById('f-lang').value;
  const repo     = document.getElementById('f-repo').value.trim();
  const branch   = document.getElementById('f-branch').value.trim() || 'main';
  const entry    = document.getElementById('f-entry').value.trim();
  const runMode  = document.querySelector('input[name="run-mode"]:checked').value;
  const port     = document.getElementById('f-port').value;
  const schedule = document.getElementById('f-schedule').value.trim();
  const timezone = document.getElementById('f-timezone').value;

  if (!name || !repo || !entry) {
    toast('Name, repo URL, and entry point are required', 'error'); return;
  }
  if (runMode === 'scheduled' && !schedule) {
    toast('Cron expression is required for scheduled mode', 'error'); return;
  }

  const env = {};
  document.querySelectorAll('.env-row').forEach(row => {
    const k = row.querySelector('.env-key').value.trim();
    const v = row.querySelector('.env-val').value.trim();
    if (k) env[k] = v;
  });

  const body = { name, language, repo, branch, entryPoint: entry, runMode, env };
  if (port) body.port = parseInt(port);
  if (runMode === 'scheduled') { body.schedule = schedule; body.timezone = timezone; }

  try {
    await api('POST', '/api/scripts', body);
    toast(`"${name}" added — cloning repository…`, 'success');
    closeAddModal();
    setTimeout(loadScripts, 2000);
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Utilities ── */
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied!', 'info'));
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function setLoading(on) {
  document.getElementById('loading-bar').style.width = on ? '70%' : '100%';
  if (!on) setTimeout(() => { document.getElementById('loading-bar').style.width = '0'; }, 300);
}

/* ── Close modals on overlay click ── */
document.getElementById('add-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeAddModal();
});
document.getElementById('logs-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLogs();
});

/* ── Boot ── */
loadScripts();
refreshInterval = setInterval(loadScripts, 10000);
