/* ── State ─────────────────────────────────────────────────────────────────── */
let currentTab       = 'scripts';
let refreshInterval  = null;
let currentEventSource = null;
let autoScroll       = true;

/* ── Cron helpers ────────────────────────────────────────────────────────── */
const CRON_DESCS = [
  [/^\*\/(\d+) \* \* \* \*$/, m => `Every ${m[1]} minute${m[1]==='1'?'':'s'}`],
  [/^0 \*\/(\d+) \* \* \*$/, m => `Every ${m[1]} hour${m[1]==='1'?'':'s'}`],
  [/^0 \* \* \* \*$/,         () => 'Every hour'],
  [/^0 (\d+) \* \* \*$/,     m => `Daily at ${m[1].padStart(2,'0')}:00`],
  [/^0 0 \* \* \*$/,          () => 'Daily at midnight'],
  [/^0 (\d+) \* \* (\d)$/,   m => {
    const d = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return `Every ${d[+m[2]]||'day'} at ${m[1].padStart(2,'0')}:00`;
  }],
  [/^0 0 1 \* \*$/,           () => 'First day of every month'],
];
function describeCron(expr) {
  for (const [re, fn] of CRON_DESCS) { const m = (expr||'').trim().match(re); if (m) return fn(m); }
  return null;
}

/* ── Time helpers ─────────────────────────────────────────────────────────── */
function relativeTime(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s/60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}
function timeUntil(iso) {
  if (!iso) return '—';
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0)   return 'now';
  if (s < 60)   return `in ${s}s`;
  const m = Math.floor(s/60); if (m < 60) return `in ${m}m`;
  const h = Math.floor(m/60); if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h/24)}d`;
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle:'short', timeStyle:'short' });
}
function fmtDuration(start, end) {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const s  = Math.floor(ms/1000);
  if (s < 60) return `${s}s`;
  const m  = Math.floor(s/60); return `${m}m ${s%60}s`;
}

/* ── API helpers ─────────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r    = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/* ── Tab switching ──────────────────────────────────────────────────────── */
const TAB_INDEX = { scripts: 0, logs: 1, audit: 2 };

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b  => b.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.querySelectorAll('.tab-btn')[TAB_INDEX[tab] ?? 0].classList.add('active');

  document.getElementById('add-btn').style.display = tab === 'scripts' ? '' : 'none';

  if (tab === 'scripts') loadScripts();
  else if (tab === 'logs') loadLogs();
  else if (tab === 'audit') loadAudit();
}

function refreshCurrent() {
  if (currentTab === 'scripts')    loadScripts();
  else if (currentTab === 'logs')  loadLogs();
  else if (currentTab === 'audit') loadAudit();
}

/* ── Scripts tab ──────────────────────────────────────────────────────────── */
async function loadScripts() {
  setLoading(true);
  try {
    const scripts = await api('GET', '/api/scripts');
    renderScripts(scripts);
    document.getElementById('refresh-label').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) { toast('Failed to load scripts: ' + e.message, 'error'); }
  finally { setLoading(false); }
}

function renderScripts(scripts) {
  const el = document.getElementById('scripts-container');
  if (!scripts.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">📦</div><h2>No scripts yet</h2><p style="color:var(--muted);margin-top:8px">Click "Add Script" to get started</p></div>`;
    return;
  }
  el.innerHTML = `<div class="scripts-grid">${scripts.map(renderCard).join('')}</div>`;
}

function renderCard({ config, status, nextRun }) {
  const isScheduled  = config.runMode === 'scheduled';
  const dotClass     = isScheduled && status !== 'error' ? 'status-scheduled' : `status-${status}`;
  const statusText   = isScheduled ? (status === 'running' ? 'running' : 'scheduled') : status.replace('_',' ');
  const webhookUrl   = `${location.origin}/webhook/${config.name}`;

  const meta = [
    `<span>📁 ${escHtml(config.repo.replace('https://github.com/',''))}</span>`,
    `<span>🌿 ${escHtml(config.branch)} · 🚀 ${escHtml(config.entryPoint)}</span>`,
    config.lastSync ? `<span>🔄 Synced ${relativeTime(config.lastSync)}</span>` : '',
    config.lastRun  ? `<span>⏱ Last run ${relativeTime(config.lastRun)}</span>`  : '',
    config.port     ? `<span>🌐 Port ${config.port}</span>` : '',
  ].filter(Boolean).join('');

  const scheduleBlock = isScheduled ? `
    <div class="schedule-info">
      <div class="schedule-row">
        <span class="schedule-cron">${escHtml(config.schedule||'')}</span>
        <span>${nextRun ? timeUntil(nextRun) : '—'}</span>
      </div>
      ${describeCron(config.schedule) ? `<div style="color:var(--muted);font-size:11px;margin-top:3px">${describeCron(config.schedule)}</div>` : ''}
    </div>` : '';

  const actions = isScheduled
    ? `<button class="btn btn-ghost btn-sm" onclick="runNow('${config.name}')">▶ Run Now</button>`
    : `<button class="btn btn-ghost btn-sm" onclick="startScript('${config.name}')">▶ Start</button>
       <button class="btn btn-ghost btn-sm" onclick="stopScript('${config.name}')">⏹ Stop</button>
       <button class="btn btn-ghost btn-sm" onclick="restartScript('${config.name}')">↺ Restart</button>`;

  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <span class="status-dot ${dotClass}" title="${statusText}"></span>
          <span class="card-name">${escHtml(config.name)}</span>
          <span class="badge badge-${config.language}">${config.language}</span>
          ${isScheduled ? '<span class="badge" style="background:#1a1a3e;color:var(--accent)">cron</span>' : ''}
        </div>
        <span class="status-label">${statusText}</span>
      </div>
      <div class="card-meta">${meta}</div>
      ${scheduleBlock}
      <div class="webhook-row">
        <span class="webhook-url" title="${escHtml(webhookUrl)}">${escHtml(webhookUrl)}</span>
        <button class="copy-btn" onclick="copyText('${escHtml(webhookUrl)}')" title="Copy">📋</button>
      </div>
      <div class="card-actions">
        ${actions}
        <button class="btn btn-ghost btn-sm" onclick="showTab('logs');filterLogs('${config.name}')">📋 Logs</button>
        <button class="btn btn-danger btn-sm" onclick="deleteScript('${config.name}')">🗑</button>
      </div>
    </div>`;
}

async function startScript(name) {
  try { await api('POST', `/api/scripts/${name}/start`); toast(`${name} started`, 'success'); setTimeout(loadScripts, 1500); }
  catch (e) { toast(e.message, 'error'); }
}
async function stopScript(name) {
  try { await api('POST', `/api/scripts/${name}/stop`); toast(`${name} stopped`, 'info'); setTimeout(loadScripts, 1000); }
  catch (e) { toast(e.message, 'error'); }
}
async function restartScript(name) {
  try { toast(`Restarting ${name}…`, 'info'); await api('POST', `/api/scripts/${name}/restart`); toast(`${name} restarted`, 'success'); setTimeout(loadScripts, 1500); }
  catch (e) { toast(e.message, 'error'); }
}
async function runNow(name) {
  try { await api('POST', `/api/scripts/${name}/run-now`); toast(`${name} triggered`, 'success'); setTimeout(() => { if (currentTab==='logs') loadLogs(); }, 1000); }
  catch (e) { toast(e.message, 'error'); }
}
async function deleteScript(name) {
  if (!confirm(`Delete "${name}"? This will stop the container.`)) return;
  try { await api('DELETE', `/api/scripts/${name}`); toast(`${name} deleted`, 'info'); loadScripts(); }
  catch (e) { toast(e.message, 'error'); }
}

/* ── Audit / Changes tab ──────────────────────────────────────────────────── */

const ACTION_META = {
  'script.created':          { icon: '➕', label: 'Script created',    color: 'var(--green)'  },
  'script.deleted':          { icon: '🗑',  label: 'Script deleted',    color: 'var(--red)'    },
  'script.started':          { icon: '▶',  label: 'Script started',    color: 'var(--accent)' },
  'script.stopped':          { icon: '⏹',  label: 'Script stopped',    color: 'var(--muted)'  },
  'script.restarted':        { icon: '↺',  label: 'Script restarted',  color: 'var(--yellow)' },
  'config.schedule.set':     { icon: '🕐', label: 'Schedule set',      color: 'var(--accent)' },
  'config.schedule.removed': { icon: '🚫', label: 'Schedule removed',  color: 'var(--yellow)' },
  'run.triggered':           { icon: '⚡', label: 'Run triggered',     color: 'var(--blue)'   },
  'code.synced':             { icon: '🔄', label: 'Code synced',       color: 'var(--green)'  },
};

function fmtVal(v) {
  if (v === undefined || v === null) return '<span class="change-val change-val-none">(none)</span>';
  const s = typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v);
  return `<span class="change-val">${escHtml(s)}</span>`;
}

function renderChanges(changes) {
  if (!changes?.length) return '<span class="no-changes">—</span>';
  return `<div class="changes-list">${changes.map(c => `
    <div class="change-row">
      <span class="change-field">${escHtml(c.field)}</span>
      <span class="change-val change-val-old">${escHtml(c.oldValue !== undefined && c.oldValue !== null ? String(typeof c.oldValue==='object'?JSON.stringify(c.oldValue):c.oldValue) : '(none)')}</span>
      <span class="change-arrow">→</span>
      <span class="change-val change-val-new">${escHtml(c.newValue !== undefined && c.newValue !== null ? String(typeof c.newValue==='object'?JSON.stringify(c.newValue):c.newValue) : '(none)')}</span>
    </div>`).join('')}</div>`;
}

async function loadAudit() {
  setLoading(true);
  try {
    const scripts = await api('GET', '/api/scripts').catch(() => []);
    const sel = document.getElementById('audit-filter');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All scripts</option>' +
      scripts.map(s => `<option value="${escHtml(s.config.name)}"${s.config.name===cur?' selected':''}>${escHtml(s.config.name)}</option>`).join('');
    if (cur) sel.value = cur;

    const filter  = sel.value;
    const url     = filter ? `/api/audit?script=${encodeURIComponent(filter)}` : '/api/audit';
    const entries = await api('GET', url);

    document.getElementById('audit-count').textContent = `${entries.length} entr${entries.length===1?'y':'ies'}`;
    renderAuditTable(entries);
    document.getElementById('refresh-label').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) { toast('Failed to load audit log: ' + e.message, 'error'); }
  finally { setLoading(false); }
}

function renderAuditTable(entries) {
  const el = document.getElementById('audit-container');
  if (!entries.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">🕵</div><h2>No changes recorded yet</h2><p style="color:var(--muted);margin-top:8px">Every config change appears here with before/after values</p></div>`;
    return;
  }

  const rows = entries.map(e => {
    const meta = ACTION_META[e.action] || { icon: '•', label: e.action, color: 'var(--muted)' };
    return `<tr>
      <td style="white-space:nowrap">${fmtDateTime(e.timestamp)}</td>
      <td><span class="audit-user">👤 ${escHtml(e.user)}</span></td>
      <td><strong>${escHtml(e.scriptName)}</strong></td>
      <td><span class="audit-action" style="color:${meta.color}">${meta.icon} ${meta.label}</span></td>
      <td>${renderChanges(e.changes)}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="runs-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>User</th>
          <th>Script</th>
          <th>Action</th>
          <th>Changes (field: old → new)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ── Logs tab ─────────────────────────────────────────────────────────────── */
let logsScriptFilter = '';

function filterLogs(scriptName) {
  logsScriptFilter = scriptName;
  const sel = document.getElementById('logs-filter');
  if (sel) sel.value = scriptName;
  loadLogs();
}

async function loadLogs() {
  setLoading(true);
  try {
    // Populate filter dropdown from scripts
    const scripts = await api('GET', '/api/scripts').catch(() => []);
    const sel = document.getElementById('logs-filter');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All scripts</option>' +
      scripts.map(s => `<option value="${escHtml(s.config.name)}"${s.config.name===cur?' selected':''}>${escHtml(s.config.name)}</option>`).join('');
    if (logsScriptFilter) { sel.value = logsScriptFilter; logsScriptFilter = ''; }

    const filter = sel.value;
    const url    = filter ? `/api/logs?script=${encodeURIComponent(filter)}` : '/api/logs';
    const runs   = await api('GET', url);

    document.getElementById('logs-count').textContent = `${runs.length} run${runs.length===1?'':'s'}`;
    renderRunsTable(runs);
    document.getElementById('refresh-label').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) { toast('Failed to load logs: ' + e.message, 'error'); }
  finally { setLoading(false); }
}

function renderRunsTable(runs) {
  const el = document.getElementById('runs-container');
  if (!runs.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">📋</div><h2>No runs yet</h2><p style="color:var(--muted);margin-top:8px">Runs appear here once scripts are started</p></div>`;
    return;
  }

  const rows = runs.map(r => {
    const statusClass = { running:'run-status-running', success:'run-status-success', failed:'run-status-failed' }[r.status] || '';
    const statusIcon  = { running:'⏳', success:'✅', failed:'❌' }[r.status] || '';
    const duration    = r.endTime ? fmtDuration(r.startTime, r.endTime) : '';

    return `<tr>
      <td><strong>${escHtml(r.scriptName)}</strong></td>
      <td>${fmtDateTime(r.startTime)}</td>
      <td>${r.endTime ? fmtDateTime(r.endTime) : '<span style="color:var(--muted)">—</span>'}${duration ? ` <span style="color:var(--muted);font-size:11px">(${duration})</span>` : ''}</td>
      <td><span class="badge badge-${r.language}">${r.language}</span></td>
      <td><span class="run-type">${r.runMode}</span></td>
      <td><span class="run-status ${statusClass}">${statusIcon} ${r.status}</span></td>
      <td><button class="eye-btn" onclick="openLogViewer('${escHtml(r.runId)}','${escHtml(r.scriptName)}','${r.status}','${escHtml(r.startTime)}')" title="View logs">👁</button></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="runs-table">
      <thead>
        <tr>
          <th>Script</th>
          <th>Start</th>
          <th>End</th>
          <th>Language</th>
          <th>Type</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ── Log Viewer (SSE) ─────────────────────────────────────────────────────── */
function openLogViewer(runId, scriptName, status, startTime) {
  closeLogViewer();

  document.getElementById('log-viewer-modal').classList.remove('hidden');
  document.getElementById('lv-title').textContent  = `Logs — ${scriptName}`;
  document.getElementById('lv-meta').innerHTML = [
    `<span>Run ID: <code style="color:var(--accent)">${escHtml(runId)}</code></span>`,
    `<span>Started: ${fmtDateTime(startTime)}</span>`,
    `<span>Status: ${status}</span>`,
  ].join('<span style="color:var(--border)"> │ </span>');

  const output = document.getElementById('lv-output');
  output.textContent = '';
  autoScroll = true;

  const liveBadge = document.getElementById('lv-live-badge');
  liveBadge.style.display = status === 'running' ? '' : 'none';

  // Use SSE for both live and historical — server handles differentiation
  const es = new EventSource(`/api/logs/${encodeURIComponent(runId)}/stream`);
  currentEventSource = es;

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'data' || msg.type === 'content') {
      output.textContent += msg.text;
      if (autoScroll) output.scrollTop = output.scrollHeight;
    }

    if (msg.type === 'end') {
      liveBadge.style.display = 'none';
      es.close();
      currentEventSource = null;
      if (autoScroll) output.scrollTop = output.scrollHeight;
      // Refresh logs table to show final status
      if (currentTab === 'logs') setTimeout(loadLogs, 500);
    }

    if (msg.type === 'error') {
      output.textContent += `\n[stream error] ${msg.text}\n`;
      liveBadge.style.display = 'none';
      es.close();
      currentEventSource = null;
    }
  };

  es.onerror = () => {
    liveBadge.style.display = 'none';
    es.close();
    currentEventSource = null;
  };

  // Pause auto-scroll when user scrolls up
  output.addEventListener('scroll', () => {
    autoScroll = output.scrollTop + output.clientHeight >= output.scrollHeight - 10;
  });
}

function closeLogViewer() {
  if (currentEventSource) { currentEventSource.close(); currentEventSource = null; }
  document.getElementById('log-viewer-modal').classList.add('hidden');
  document.getElementById('lv-live-badge').style.display = 'none';
}

function scrollLogsToBottom() {
  const output = document.getElementById('lv-output');
  output.scrollTop = output.scrollHeight;
  autoScroll = true;
}

/* ── Add Modal ────────────────────────────────────────────────────────────── */
function openAddModal() { resetForm(); document.getElementById('add-modal').classList.remove('hidden'); }
function closeAddModal() { document.getElementById('add-modal').classList.add('hidden'); }

function resetForm() {
  ['f-name','f-repo','f-entry','f-schedule'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('f-branch').value = 'main';
  document.getElementById('f-lang').value   = 'python';
  document.getElementById('f-port').value   = '';
  document.getElementById('f-timezone').value = 'UTC';
  document.getElementById('rm-persistent').checked = true;
  document.getElementById('env-rows').innerHTML = '';
  document.getElementById('cron-preview').textContent = '';
  toggleRunMode();
}

function toggleRunMode() {
  const isScheduled = document.getElementById('rm-scheduled').checked;
  document.getElementById('persistent-fields').style.display = isScheduled ? 'none' : '';
  document.getElementById('scheduled-fields').style.display  = isScheduled ? '' : 'none';
}

document.querySelectorAll('input[name="run-mode"]').forEach(r => r.addEventListener('change', toggleRunMode));

function addEnvRow(k, v) {
  const row = document.createElement('div'); row.className = 'env-row';
  row.innerHTML = `<input type="text" placeholder="KEY" value="${escHtml(k||'')}" class="env-key" />
    <input type="text" placeholder="value" value="${escHtml(v||'')}" class="env-val" />
    <button class="env-remove" onclick="this.parentElement.remove()">×</button>`;
  document.getElementById('env-rows').appendChild(row);
}

function setCron(expr) { document.getElementById('f-schedule').value = expr; updateCronPreview(); }
function updateCronPreview() {
  const expr = document.getElementById('f-schedule').value.trim();
  const el   = document.getElementById('cron-preview');
  el.textContent = expr ? (describeCron(expr) || expr) : '';
}

async function submitAdd() {
  const name    = document.getElementById('f-name').value.trim();
  const lang    = document.getElementById('f-lang').value;
  const repo    = document.getElementById('f-repo').value.trim();
  const branch  = document.getElementById('f-branch').value.trim() || 'main';
  const entry   = document.getElementById('f-entry').value.trim();
  const runMode = document.querySelector('input[name="run-mode"]:checked').value;
  const port    = document.getElementById('f-port').value;
  const sched   = document.getElementById('f-schedule').value.trim();
  const tz      = document.getElementById('f-timezone').value;

  if (!name || !repo || !entry) { toast('Name, repo URL, and entry point are required', 'error'); return; }
  if (runMode === 'scheduled' && !sched) { toast('Cron expression required for scheduled mode', 'error'); return; }

  const env = {};
  document.querySelectorAll('.env-row').forEach(row => {
    const k = row.querySelector('.env-key').value.trim();
    const v = row.querySelector('.env-val').value.trim();
    if (k) env[k] = v;
  });

  const body = { name, language: lang, repo, branch, entryPoint: entry, runMode, env };
  if (port) body.port = parseInt(port);
  if (runMode === 'scheduled') { body.schedule = sched; body.timezone = tz; }

  try {
    await api('POST', '/api/scripts', body);
    toast(`"${name}" added — cloning in background…`, 'success');
    closeAddModal();
    setTimeout(loadScripts, 2000);
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Utilities ────────────────────────────────────────────────────────────── */
function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function copyText(text) { navigator.clipboard.writeText(text).then(() => toast('Copied!', 'info')); }
function toast(msg, type='info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`; el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
function setLoading(on) {
  document.getElementById('loading-bar').style.width = on ? '70%' : '100%';
  if (!on) setTimeout(() => { document.getElementById('loading-bar').style.width = '0'; }, 300);
}

/* ── Modal close on overlay click ─────────────────────────────────────────── */
document.getElementById('add-modal').addEventListener('click', e => { if (e.target===e.currentTarget) closeAddModal(); });
document.getElementById('log-viewer-modal').addEventListener('click', e => { if (e.target===e.currentTarget) closeLogViewer(); });

/* ── Boot ─────────────────────────────────────────────────────────────────── */
loadScripts();
refreshInterval = setInterval(() => {
  if (currentTab === 'scripts')    loadScripts();
  else if (currentTab === 'logs')  loadLogs();
  else if (currentTab === 'audit') loadAudit();
}, 10000);
