/* ── State ─────────────────────────────────────────────────────────────────── */
let currentTab         = 'scripts';
let refreshInterval    = null;
let currentEventSource = null;
let autoScroll         = true;
let currentUser        = { username: 'anonymous', role: 'admin' };
let editingUsername    = null;   // for user management modal
let scriptModalMode    = 'add';  // 'add' | 'edit'
let editingScriptName  = null;   // name of script being edited
let _pendingVpnFile    = null;   // File object staged for upload on add-mode submit
let _vpnConfigured     = false;  // whether current edit target has an .ovpn on server
let currentLogViewer   = { runId: null, scriptName: null }; // run shown in the log viewer modal

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
const TAB_INDEX = { scripts: 0, logs: 1, audit: 2, admin: 3, tests: 4 };

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b  => b.classList.remove('active'));
  const panel = document.getElementById(`tab-${tab}`);
  if (panel) panel.classList.add('active');
  const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
  const idx = TAB_INDEX[tab] ?? 0;
  if (tabBtns[idx]) tabBtns[idx].classList.add('active');


  if (tab === 'scripts')    loadScripts();
  else if (tab === 'logs')  loadLogs();
  else if (tab === 'audit') loadAudit();
  else if (tab === 'admin') { loadUsers(); loadSystemVersion(); loadAddons(); loadResources(); ovLoad(); }
  else if (tab === 'tests') { vtInit(); avpnInit(); sqltInit(); }
}

/* ── Role helpers ──────────────────────────────────────────────────────────── */
function isAdmin()   { return currentUser.role === 'admin'; }
function canWrite()  { return currentUser.role === 'admin' || currentUser.role === 'agent'; }
function canDelete() { return currentUser.role === 'admin'; }

async function loadCurrentUser() {
  try {
    currentUser = await api('GET', '/api/me');
    // Show admin tab and system tests tab only for admins
    document.getElementById('tab-admin-btn').style.display = isAdmin() ? '' : 'none';
    document.getElementById('tab-tests-btn').style.display = isAdmin() ? '' : 'none';
    // Show user pill
    const badge = document.getElementById('user-badge');
    badge.textContent = `${currentUser.username} · ${currentUser.role}`;
    badge.className   = `role-badge role-${currentUser.role}`;
    badge.style.display = '';
  } catch (e) {
    console.warn('Could not load user info:', e.message);
  }
}

function refreshCurrent() {
  if (currentTab === 'scripts')    loadScripts();
  else if (currentTab === 'logs')  loadLogs();
  else if (currentTab === 'audit') loadAudit();
}

/* ── Scripts tab ──────────────────────────────────────────────────────────── */

const pendingScripts = new Set(); // names of scripts with an in-flight action
let   cachedScripts  = [];        // last successful fetch, used for instant re-renders

async function loadScripts() {
  setLoading(true);
  try {
    const scripts = await api('GET', '/api/scripts');
    cachedScripts = scripts;
    renderScripts(scripts);
    document.getElementById('refresh-label').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) { toast('Failed to load scripts: ' + e.message, 'error'); }
  finally { setLoading(false); }
}

function renderScripts(scripts) {
  const el      = document.getElementById('scripts-container');
  const addCard = canWrite()
    ? `<div class="card card-add" onclick="openAddModal()" title="Add script">
         <span class="card-add-icon">+</span>
         <span class="card-add-label">Add Script</span>
       </div>`
    : '';

  if (!scripts.length) {
    el.innerHTML = `<div class="scripts-grid">${addCard}</div>`;
    return;
  }
  el.innerHTML = `<div class="scripts-grid">${scripts.map(renderCard).join('')}${addCard}</div>`;
}

function renderCard({ config, status, nextRun, vpnStatus }) {
  const isScheduled  = config.runMode === 'scheduled';
  const dotClass     = isScheduled && status !== 'error' ? 'status-scheduled' : `status-${status}`;
  const statusText   = isScheduled ? (status === 'running' ? 'running' : 'scheduled') : status.replace('_',' ');
  const webhookUrl   = `${location.origin}/webhook/${config.name}`;

  const portMeta = config.port
    ? `<span>🌐 Port ${config.port} <a class="open-app-link" href="http://${location.hostname}:${config.port}" target="_blank" rel="noopener">Open App ↗</a></span>`
    : '';

  const meta = [
    `<span>📁 ${escHtml(config.repo.replace('https://github.com/',''))}</span>`,
    config.buildCommand
      ? `<span>🔨 Build: <code>${escHtml(config.buildCommand)}</code></span>`
      : '',
    `<span>🌿 ${escHtml(config.branch)} · 🚀 ${escHtml(config.entryPoint)}</span>`,
    config.lastSync ? `<span>🔄 Synced ${relativeTime(config.lastSync)}</span>` : '',
    config.lastRun  ? `<span>⏱ Last run ${relativeTime(config.lastRun)}</span>`  : '',
    portMeta,
  ].filter(Boolean).join('');

  const scheduleDetail = [
    describeCron(config.schedule),
    nextRun ? `Next: ${fmtDateTime(nextRun)}` : '',
  ].filter(Boolean).join(' · ');

  const scheduleBlock = isScheduled ? `
    <div class="schedule-info">
      <div class="schedule-row">
        <span class="schedule-cron">${escHtml(config.schedule||'')}</span>
        <span title="${nextRun ? fmtDateTime(nextRun) : ''}">${nextRun ? timeUntil(nextRun) : '—'}</span>
      </div>
      ${scheduleDetail ? `<div style="color:var(--muted);font-size:11px;margin-top:3px">${scheduleDetail}</div>` : ''}
    </div>` : '';

  const isPending    = pendingScripts.has(config.name);
  const canStart     = !isPending && status !== 'running'  && status !== 'not_cloned';
  const canStop      = !isPending && status === 'running';
  const canRestart   = !isPending && status === 'running';
  const canRunNow    = !isPending && status !== 'not_cloned';

  const writeActions = canWrite() ? (
    isScheduled
      ? `<button class="btn btn-ghost btn-sm" onclick="runNow('${config.name}')" ${canRunNow ? '' : 'disabled'}>▶ Run Now</button>`
      : `<button class="btn btn-ghost btn-sm" onclick="startScript('${config.name}')"   ${canStart   ? '' : 'disabled'}>▶ Start</button>
         <button class="btn btn-ghost btn-sm" onclick="stopScript('${config.name}')"    ${canStop    ? '' : 'disabled'}>⏹ Stop</button>
         <button class="btn btn-ghost btn-sm" onclick="restartScript('${config.name}')" ${canRestart ? '' : 'disabled'}>↺ Restart</button>`
  ) : '';

  const editBtn = canWrite()
    ? `<button class="btn btn-ghost btn-sm" onclick="editScript('${escHtml(config.name)}')">✏ Edit</button>`
    : '';

  const deleteBtn = canDelete()
    ? `<button class="btn btn-danger btn-sm" onclick="deleteScript('${config.name}')">🗑</button>`
    : '';

  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <span class="status-dot ${dotClass}" title="${statusText}"></span>
          <span class="card-name">${escHtml(config.name)}</span>
          <span class="badge badge-${config.language}">${config.language}</span>
          ${isScheduled ? '<span class="badge" style="background:#1a1a3e;color:var(--accent)">cron</span>' : ''}
          ${config.vpnEnabled ? `<span class="badge badge-vpn-${vpnStatus}" title="VPN ${vpnStatus}">⬤ VPN</span>` : ''}
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
        ${writeActions}
        ${editBtn}
        <button class="btn btn-ghost btn-sm" onclick="showTab('logs');filterLogs('${config.name}')">📋 Logs</button>
        <button class="btn btn-ghost btn-sm" onclick="showLiveLogs('${escHtml(config.name)}')" title="Stream live docker logs for this container">📡 Live Logs</button>
        <button class="btn btn-ghost btn-sm" onclick="downloadScript('${escHtml(config.name)}')" title="Download cloned repo as .tar.gz">⬇</button>
        ${deleteBtn}
      </div>
    </div>`;
}

function _scriptPendingStart(name) {
  pendingScripts.add(name);
  if (cachedScripts.length) renderScripts(cachedScripts);
}
function _scriptPendingEnd(name) {
  pendingScripts.delete(name);
  loadScripts();
}

async function startScript(name) {
  _scriptPendingStart(name);
  try { await api('POST', `/api/scripts/${name}/start`); toast(`${name} started`, 'success'); }
  catch (e) { toast(e.message, 'error'); }
  finally { _scriptPendingEnd(name); }
}
async function stopScript(name) {
  _scriptPendingStart(name);
  try { await api('POST', `/api/scripts/${name}/stop`); toast(`${name} stopped`, 'info'); }
  catch (e) { toast(e.message, 'error'); }
  finally { _scriptPendingEnd(name); }
}
async function restartScript(name) {
  _scriptPendingStart(name);
  toast(`Restarting ${name}…`, 'info');
  try { await api('POST', `/api/scripts/${name}/restart`); toast(`${name} restarted`, 'success'); }
  catch (e) { toast(e.message, 'error'); }
  finally { _scriptPendingEnd(name); }
}
async function runNow(name) {
  _scriptPendingStart(name);
  try { await api('POST', `/api/scripts/${name}/run-now`); toast(`${name} triggered`, 'success'); }
  catch (e) { toast(e.message, 'error'); }
  finally {
    pendingScripts.delete(name);
    if (cachedScripts.length) renderScripts(cachedScripts);
    if (currentTab === 'logs') loadLogs();
  }
}
async function editScript(name) {
  try {
    const { config } = await api('GET', `/api/scripts/${encodeURIComponent(name)}/status`);
    openEditModal(config);
  } catch (e) { toast('Failed to load config: ' + e.message, 'error'); }
}

/* ── Download helpers ─────────────────────────────────────────────────────── */
async function triggerDownload(url, filename) {
  try {
    const r = await fetch(url);
    if (!r.ok) { toast('Download failed: ' + (await r.text()), 'error'); return; }
    const blob = await r.blob();
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast('Download failed: ' + e.message, 'error'); }
}

async function exportScripts() {
  const date = new Date().toISOString().slice(0, 10);
  await triggerDownload('/api/export', `scripts-export-${date}.json`);
}

async function downloadFullBackup() {
  const date = new Date().toISOString().slice(0, 10);
  await triggerDownload('/api/admin/backup', `dock-tools-backup-${date}.dtbackup`);
}

async function downloadWebhookSecret() {
  await triggerDownload('/api/admin/webhook-secret', 'webhook-secret.txt');
}

async function downloadScript(name) {
  await triggerDownload(`/api/scripts/${encodeURIComponent(name)}/download`, `${name}.tar.gz`);
}

async function downloadRunLog(runId, scriptName) {
  try {
    const { content } = await api('GET', `/api/logs/${encodeURIComponent(runId)}/content`);
    const blob = new Blob([content || ''], { type: 'text/plain' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `${scriptName}-${runId}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast('Download failed: ' + e.message, 'error'); }
}

async function deleteScript(name) {
  if (!confirm(`Delete "${name}"? This will stop the container.`)) return;
  try { await api('DELETE', `/api/scripts/${name}`); toast(`${name} deleted`, 'info'); loadScripts(); }
  catch (e) { toast(e.message, 'error'); }
}

/* ── Import Scripts ──────────────────────────────────────────────────────── */
let importParsed  = [];   // scripts parsed from the uploaded JSON
let existingNames = new Set();

function openImportModal() {
  resetImportModal();
  document.getElementById('import-modal').classList.remove('hidden');
}
function closeImportModal() {
  document.getElementById('import-modal').classList.add('hidden');
  importParsed = [];
}
function resetImportModal() {
  importParsed = [];
  document.getElementById('import-step-1').style.display  = '';
  document.getElementById('import-step-2').style.display  = 'none';
  document.getElementById('import-submit-btn').style.display = 'none';
  document.getElementById('import-back-btn').style.display   = 'none';
  document.getElementById('import-table-container').innerHTML = '';
  document.getElementById('import-file-input').value = '';
}

// Drag-and-drop handlers
function importDragOver(e) {
  e.preventDefault();
  document.getElementById('import-drop-zone').classList.add('drag-over');
}
function importDragLeave(e) {
  document.getElementById('import-drop-zone').classList.remove('drag-over');
}
function importDrop(e) {
  e.preventDefault();
  document.getElementById('import-drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadImportFile(file);
}

async function loadImportFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.json')) { toast('Please select a .json file', 'error'); return; }

  try {
    const text   = await file.text();
    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed) || !parsed.length) {
      toast('Invalid file — expected a non-empty JSON array of scripts', 'error');
      return;
    }

    importParsed = parsed;

    // Fetch current script names to detect conflicts
    const current = await api('GET', '/api/scripts').catch(() => []);
    existingNames  = new Set(current.map(s => s.config.name));

    renderImportTable();

    document.getElementById('import-step-1').style.display  = 'none';
    document.getElementById('import-step-2').style.display  = '';
    document.getElementById('import-submit-btn').style.display = '';
    document.getElementById('import-back-btn').style.display   = '';
  } catch (e) {
    toast('Failed to parse file: ' + e.message, 'error');
  }
}

function renderImportTable() {
  const canImport = importParsed.filter(s => !existingNames.has(s.name)).length;

  const rows = importParsed.map((s, i) => {
    const exists = existingNames.has(s.name);
    return `<tr style="${exists ? 'opacity:.6' : ''}">
      <td style="width:36px;text-align:center">
        <input type="checkbox" id="icb-${i}" ${exists ? 'disabled' : 'checked'} />
      </td>
      <td><strong>${escHtml(s.name)}</strong></td>
      <td><span class="badge badge-${s.language||'node'}">${escHtml(s.language||'node')}</span></td>
      <td style="font-size:11px;color:var(--muted);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${escHtml((s.repo||'').replace('https://github.com/',''))}
      </td>
      <td><span class="run-type">${escHtml(s.runMode||'persistent')}</span></td>
      <td>
        ${exists
          ? '<span class="import-exists">⚠ Name already exists — cannot import</span>'
          : '<span class="import-ready">✓ Ready</span>'
        }
      </td>
    </tr>`;
  }).join('');

  document.getElementById('import-table-container').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <span style="font-size:13px;color:var(--muted)">
        <strong>${importParsed.length}</strong> scripts in file ·
        <strong style="color:var(--green)">${canImport}</strong> available to import ·
        <strong style="color:var(--red)">${importParsed.length - canImport}</strong> already exist
      </span>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="selectAllImport(true)">Select All</button>
        <button class="btn btn-ghost btn-sm" onclick="selectAllImport(false)">Deselect All</button>
      </div>
    </div>
    <div style="max-height:360px;overflow-y:auto">
      <table class="runs-table">
        <thead>
          <tr>
            <th></th><th>Name</th><th>Language</th><th>Repo</th><th>Mode</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function selectAllImport(checked) {
  importParsed.forEach((_, i) => {
    const cb = document.getElementById(`icb-${i}`);
    if (cb && !cb.disabled) cb.checked = checked;
  });
}

async function submitImport() {
  const selected = importParsed.filter((_, i) => {
    const cb = document.getElementById(`icb-${i}`);
    return cb && !cb.disabled && cb.checked;
  });

  if (!selected.length) { toast('No scripts selected', 'error'); return; }

  // Double-check for conflicts before submitting
  const conflicts = selected.filter(s => existingNames.has(s.name));
  if (conflicts.length) {
    toast(`Cannot import: "${conflicts.map(s => s.name).join('", "')}" already exist`, 'error');
    return;
  }

  try {
    const result = await api('POST', '/api/import', { scripts: selected });

    const parts = [];
    if (result.imported?.length)
      parts.push(`✅ Imported ${result.imported.length}: ${result.imported.join(', ')}`);
    if (result.skipped?.length)
      parts.push(`⚠ Skipped (already exist): ${result.skipped.join(', ')}`);
    if (result.errors?.length)
      parts.push(`❌ Errors: ${result.errors.map(e => `${e.name} — ${e.error}`).join('; ')}`);

    const hasError = result.errors?.length > 0;
    toast(parts.join(' · ') || 'Done', hasError ? 'error' : 'success');
    closeImportModal();
    setTimeout(loadScripts, 2000);
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Full Environment Backup / Restore ───────────────────────────────────── */
let _backupRestoreFile = null;

function openBackupRestoreModal() {
  resetBackupRestoreModal();
  document.getElementById('backup-restore-modal').classList.remove('hidden');
}
function closeBackupRestoreModal() {
  document.getElementById('backup-restore-modal').classList.add('hidden');
  _backupRestoreFile = null;
}
function resetBackupRestoreModal() {
  _backupRestoreFile = null;
  document.getElementById('backup-restore-step-1').style.display = '';
  document.getElementById('backup-restore-step-2').style.display = 'none';
  document.getElementById('backup-restore-submit-btn').style.display = 'none';
  document.getElementById('backup-restore-back-btn').style.display   = 'none';
  document.getElementById('backup-restore-confirm-input').value = '';
  document.getElementById('backup-restore-summary').innerHTML = '';
  document.getElementById('backup-restore-file-input').value = '';
}

function backupRestoreDragOver(e) {
  e.preventDefault();
  document.getElementById('backup-restore-drop-zone').classList.add('drag-over');
}
function backupRestoreDragLeave(e) {
  document.getElementById('backup-restore-drop-zone').classList.remove('drag-over');
}
function backupRestoreDrop(e) {
  e.preventDefault();
  document.getElementById('backup-restore-drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadBackupFile(file);
}

async function loadBackupFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.dtbackup')) { toast('Please select a .dtbackup file', 'error'); return; }

  try {
    const fd = new FormData();
    fd.append('backup', file);
    const r    = await fetch('/api/admin/backup/inspect', { method: 'POST', body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    _backupRestoreFile = file;

    document.getElementById('backup-restore-summary').innerHTML = `
      <div>Created: <strong>${fmtDateTime(data.createdAt)}</strong></div>
      <div><strong>${data.scriptNames.length}</strong> script(s): ${escHtml(data.scriptNames.join(', ') || '—')}</div>
      <div><strong>${data.usernames.length}</strong> user(s): ${escHtml(data.usernames.join(', ') || '—')}</div>
      <div>${data.auditEntries} audit entries · Admin VPN config: ${data.hasAdminVpn ? 'yes' : 'no'} · SQL-test VPN config: ${data.hasSqlTestVpn ? 'yes' : 'no'}</div>`;

    document.getElementById('backup-restore-step-1').style.display = 'none';
    document.getElementById('backup-restore-step-2').style.display = '';
    document.getElementById('backup-restore-submit-btn').style.display = '';
    document.getElementById('backup-restore-back-btn').style.display   = '';
    backupRestoreConfirmInputChanged();
  } catch (e) {
    toast('Failed to read backup: ' + e.message, 'error');
  }
}

function backupRestoreConfirmInputChanged() {
  const typed = document.getElementById('backup-restore-confirm-input').value;
  document.getElementById('backup-restore-submit-btn').disabled = typed !== 'RESTORE';
}

async function submitBackupRestore() {
  if (!_backupRestoreFile) return;
  const btn = document.getElementById('backup-restore-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Restoring…';

  try {
    const fd = new FormData();
    fd.append('backup', _backupRestoreFile);
    fd.append('confirm', 'RESTORE');
    const r    = await fetch('/api/admin/backup/restore', { method: 'POST', body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    toast(`Environment restored — ${data.scripts} script(s), ${data.users} user(s)`, 'success');
    closeBackupRestoreModal();
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    toast('Restore failed: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Restore Environment';
  }
}

/* ── Admin tab — User Management ─────────────────────────────────────────── */

async function loadUsers() {
  setLoading(true);
  try {
    const users = await api('GET', '/api/admin/users');
    renderUsersTable(users);
    document.getElementById('refresh-label').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) { toast('Failed to load users: ' + e.message, 'error'); }
  finally { setLoading(false); }
}

function renderUsersTable(users) {
  const el = document.getElementById('users-container');
  if (!users.length) {
    el.innerHTML = '<div class="empty-state"><div class="icon">👤</div><h2>No users yet</h2></div>';
    return;
  }

  const rows = users.map(u => {
    const isYou = u.username === currentUser.username;
    return `<tr>
      <td>
        <strong>${escHtml(u.username)}</strong>
        ${isYou ? '<span class="you-tag">you</span>' : ''}
      </td>
      <td><span class="role-badge role-${u.role}">${u.role}</span></td>
      <td>${fmtDateTime(u.createdAt)}</td>
      <td>
        <div style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="openEditUserModal('${escHtml(u.username)}','${u.role}')">✏ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteUser('${escHtml(u.username)}')"
            ${isYou ? 'disabled title="Cannot delete yourself"' : ''}>🗑</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>Username</th>
          <th>Role</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function openAddUserModal() {
  document.getElementById('nu-username').value = '';
  document.getElementById('nu-password').value = '';
  document.getElementById('nu-confirm').value  = '';
  document.getElementById('nu-role').value     = 'viewer';
  document.getElementById('add-user-modal').classList.remove('hidden');
}
function closeAddUserModal() { document.getElementById('add-user-modal').classList.add('hidden'); }

async function submitAddUser() {
  const username = document.getElementById('nu-username').value.trim();
  const role     = document.getElementById('nu-role').value;
  const password = document.getElementById('nu-password').value;
  const confirm  = document.getElementById('nu-confirm').value;

  if (!username || !password) { toast('Username and password are required', 'error'); return; }
  if (password !== confirm)   { toast('Passwords do not match', 'error'); return; }
  if (password.length < 6)   { toast('Password must be at least 6 characters', 'error'); return; }

  try {
    await api('POST', '/api/admin/users', { username, password, role });
    toast(`User "${username}" created`, 'success');
    closeAddUserModal();
    loadUsers();
  } catch (e) { toast(e.message, 'error'); }
}

function openEditUserModal(username, role) {
  editingUsername = username;
  document.getElementById('eu-title').textContent = `Edit User — ${username}`;
  document.getElementById('eu-role').value    = role;
  document.getElementById('eu-password').value = '';
  document.getElementById('eu-confirm').value  = '';
  document.getElementById('edit-user-modal').classList.remove('hidden');
}
function closeEditUserModal() {
  document.getElementById('edit-user-modal').classList.add('hidden');
  editingUsername = null;
}

async function submitEditUser() {
  const role     = document.getElementById('eu-role').value;
  const password = document.getElementById('eu-password').value;
  const confirm  = document.getElementById('eu-confirm').value;

  if (password && password !== confirm) { toast('Passwords do not match', 'error'); return; }
  if (password && password.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }

  const body = { role };
  if (password) body.password = password;

  try {
    await api('PUT', `/api/admin/users/${encodeURIComponent(editingUsername)}`, body);
    toast(`User "${editingUsername}" updated`, 'success');
    closeEditUserModal();
    loadUsers();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteUser(username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/admin/users/${encodeURIComponent(username)}`);
    toast(`User "${username}" deleted`, 'info');
    loadUsers();
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Audit / Changes tab ──────────────────────────────────────────────────── */

/* ── Admin tab — System / self-update ────────────────────────────────────── */

let _sysRepoSlug   = '';
let _sysCommit     = '';
let _updatePollTmr = null;
let _healthPollTmr = null;

async function loadSystemVersion() {
  try {
    const v = await api('GET', '/api/admin/version');
    _sysCommit   = v.commit || 'dev';
    _sysRepoSlug = v.repoSlug || '';
    const sha = _sysCommit === 'dev' ? 'dev build' : _sysCommit.slice(0, 7);
    const built = v.buildTime ? ` · built ${relativeTime(v.buildTime)}` : '';
    document.getElementById('sys-version').textContent = `commit ${sha}${built}`;
  } catch {
    document.getElementById('sys-version').textContent = 'version unknown';
  }
  _loadLastUpdateLog();
}

async function _loadLastUpdateLog() {
  try {
    const s = await api('GET', '/api/admin/update/status');
    if (!s.log) return;
    document.getElementById('sys-last-log').textContent = s.log;
    document.getElementById('sys-last-log-wrap').style.display = '';
  } catch { /* ignore */ }
}

function toggleLastUpdateLog() {
  const box    = document.getElementById('sys-last-log');
  const toggle = document.getElementById('sys-last-log-toggle');
  const shown  = box.style.display !== 'none';
  box.style.display    = shown ? 'none' : '';
  toggle.textContent   = shown ? '▾ show' : '▴ hide';
  if (!shown) box.scrollTop = box.scrollHeight;
}

async function checkForUpdates() {
  const badge  = document.getElementById('sys-update-badge');
  const btn    = document.getElementById('sys-check-btn');
  badge.textContent  = 'Checking…';
  badge.style.color  = 'var(--muted)';
  btn.disabled       = true;

  try {
    const { sha: latest } = await api('GET', '/api/admin/update/latest-commit');

    if (_sysCommit === 'dev' || latest.startsWith(_sysCommit) || _sysCommit.startsWith(latest.slice(0, 7))) {
      badge.textContent = '✓ Up to date';
      badge.style.color = 'var(--green)';
      document.getElementById('sys-update-btn').style.display = 'none';
    } else {
      badge.textContent = `↑ Update available (${latest.slice(0, 7)})`;
      badge.style.color = 'var(--yellow)';
      document.getElementById('sys-update-btn').style.display = '';
    }
  } catch {
    badge.textContent = 'Could not reach GitHub';
    badge.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

async function triggerUpdate() {
  if (!confirm('This will rebuild and restart the manager. The UI will be unavailable for ~1–2 minutes. Continue?')) return;

  document.getElementById('sys-update-btn').style.display = 'none';
  document.getElementById('sys-check-btn').disabled = true;

  const log = document.getElementById('sys-update-log');
  log.style.display = 'block';
  log.textContent   = '';

  const badge = document.getElementById('sys-update-badge');
  badge.textContent = 'Starting…';
  badge.style.color = 'var(--accent)';

  try {
    await api('POST', '/api/admin/update');
    _pollUpdateStatus();
  } catch (e) {
    badge.textContent = 'Failed to start update';
    badge.style.color = 'var(--red)';
    toast('Update failed: ' + e.message, 'error');
    document.getElementById('sys-check-btn').disabled = false;
  }
}

function _pollUpdateStatus() {
  if (_updatePollTmr) clearInterval(_updatePollTmr);
  _updatePollTmr = setInterval(async () => {
    try {
      const s     = await api('GET', '/api/admin/update/status');
      const log   = document.getElementById('sys-update-log');
      const badge = document.getElementById('sys-update-badge');
      log.textContent = s.log || '';
      log.scrollTop   = log.scrollHeight;
      // Keep last-log block in sync
      const lastLog = document.getElementById('sys-last-log');
      if (s.log) {
        lastLog.textContent = s.log;
        document.getElementById('sys-last-log-wrap').style.display = '';
      }
      // Keep Logs tab card in sync while update is running
      _refreshSysLogCard();

      if (s.status === 'cloning') {
        badge.textContent = 'Cloning…';  badge.style.color = 'var(--accent)';
      } else if (s.status === 'building') {
        badge.textContent = 'Building…'; badge.style.color = 'var(--yellow)';
      } else if (s.status === 'done') {
        badge.textContent = 'Restarting…'; badge.style.color = 'var(--green)';
        clearInterval(_updatePollTmr);
        _pollHealth();
      } else if (s.status === 'error') {
        badge.textContent = `Error: ${s.error}`;
        badge.style.color = 'var(--red)';
        clearInterval(_updatePollTmr);
        document.getElementById('sys-check-btn').disabled = false;
        toast('Update failed: ' + s.error, 'error');
      }
    } catch { /* server is probably restarting — will catch in _pollHealth */ }
  }, 1000);
}

function _pollHealth() {
  if (_healthPollTmr) clearInterval(_healthPollTmr);
  _healthPollTmr = setInterval(async () => {
    try {
      const r = await fetch('/healthz');
      if (r.ok) {
        clearInterval(_healthPollTmr);
        toast('Update complete! Reloading…', 'success');
        setTimeout(() => location.reload(), 1200);
      }
    } catch { /* still restarting */ }
  }, 2000);
}

const ACTION_META = {
  'script.created':          { icon: '➕', label: 'Script created',    color: 'var(--green)'  },
  'script.imported':         { icon: '📥', label: 'Script imported',   color: 'var(--green)'  },
  'script.deleted':          { icon: '🗑',  label: 'Script deleted',    color: 'var(--red)'    },
  'script.started':          { icon: '▶',  label: 'Script started',    color: 'var(--accent)' },
  'script.stopped':          { icon: '⏹',  label: 'Script stopped',    color: 'var(--muted)'  },
  'script.restarted':        { icon: '↺',  label: 'Script restarted',  color: 'var(--yellow)' },
  'config.schedule.set':     { icon: '🕐', label: 'Schedule set',      color: 'var(--accent)' },
  'config.schedule.removed': { icon: '🚫', label: 'Schedule removed',  color: 'var(--yellow)' },
  'run.triggered':           { icon: '⚡', label: 'Run triggered',     color: 'var(--blue)'   },
  'code.synced':             { icon: '🔄', label: 'Code synced',       color: 'var(--green)'  },
};

function fmtValRaw(v) {
  if (v === undefined || v === null) return '(none)';
  return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
}

// Render compact pills of changed field names only
function renderChanges(changes) {
  if (!changes?.length) return '<span class="no-changes">—</span>';
  return changes.map(c => `<code style="font-size:11px">${escHtml(c.field)}</code>`).join(' ');
}

function openChangeDiff(entryId) {
  const entry = _allAuditEntries.find(e => e.id === entryId);
  if (!entry) return;
  const changes = entry.changes || [];

  const fmtBox = (side) => changes.map(c => {
    const val = fmtValRaw(side === 'old' ? c.oldValue : c.newValue);
    return `<div style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:600;color:var(--accent);font-family:monospace;margin-bottom:3px">${escHtml(c.field)}</div>
      <div style="font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-all">${escHtml(val)}</div>
    </div>`;
  }).join('');

  const meta   = ACTION_META[entry.action] || { icon: '•', label: entry.action };
  const modal  = document.getElementById('change-diff-modal');
  document.getElementById('cdiff-title').textContent  = `${meta.icon} ${meta.label} — ${entry.scriptName}`;
  document.getElementById('cdiff-time').textContent   = fmtDateTime(entry.timestamp) + ' by ' + entry.user;
  document.getElementById('cdiff-old').innerHTML      = changes.length ? fmtBox('old') : '<span style="color:var(--muted);font-style:italic">No previous values</span>';
  document.getElementById('cdiff-new').innerHTML      = changes.length ? fmtBox('new') : '<span style="color:var(--muted);font-style:italic">No new values</span>';
  modal.classList.remove('hidden');
}

function closeChangeDiff() {
  document.getElementById('change-diff-modal').classList.add('hidden');
}

let _allAuditEntries = [];

async function loadAudit() {
  setLoading(true);
  try {
    const scripts = await api('GET', '/api/scripts').catch(() => []);

    // Populate script filter
    const scriptSel = document.getElementById('audit-filter');
    const curScript = scriptSel.value;
    scriptSel.innerHTML = '<option value="">All scripts</option>' +
      scripts.map(s => `<option value="${escHtml(s.config.name)}"${s.config.name===curScript?' selected':''}>${escHtml(s.config.name)}</option>`).join('');
    if (curScript) scriptSel.value = curScript;

    const filter  = scriptSel.value;
    const url     = filter ? `/api/audit?script=${encodeURIComponent(filter)}` : '/api/audit';
    _allAuditEntries = await api('GET', url);

    // Populate action filter from actual data
    const actionSel = document.getElementById('audit-action-filter');
    const curAction = actionSel.value;
    const actions   = [...new Set(_allAuditEntries.map(e => e.action))].sort();
    actionSel.innerHTML = '<option value="">All actions</option>' +
      actions.map(a => {
        const meta = ACTION_META[a] || { icon: '•', label: a };
        return `<option value="${escHtml(a)}"${a===curAction?' selected':''}>${meta.icon} ${escHtml(meta.label)}</option>`;
      }).join('');
    if (curAction && actions.includes(curAction)) actionSel.value = curAction;

    document.getElementById('refresh-label').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    applyAuditFilters();
  } catch (e) { toast('Failed to load audit log: ' + e.message, 'error'); }
  finally { setLoading(false); }
}

function applyAuditFilters() {
  const action  = document.getElementById('audit-action-filter').value;
  const entries = action ? _allAuditEntries.filter(e => e.action === action) : _allAuditEntries;
  document.getElementById('audit-count').textContent = `${entries.length} entr${entries.length===1?'y':'ies'}`;
  renderAuditTable(entries);
}

function renderAuditTable(entries) {
  const el = document.getElementById('audit-container');
  if (!entries.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">🕵</div><h2>No changes recorded yet</h2><p style="color:var(--muted);margin-top:8px">Every config change appears here with before/after values</p></div>`;
    return;
  }

  const rows = entries.map(e => {
    const meta = ACTION_META[e.action] || { icon: '•', label: e.action, color: 'var(--muted)' };
    const diffBtn = e.changes?.length
      ? `<button class="eye-btn" onclick="openChangeDiff('${escHtml(e.id)}')" title="View changes">👁</button>`
      : '';
    return `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
          <span style="font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap">${fmtDateTime(e.timestamp)}</span>
          <span style="font-size:11px;color:var(--muted)">👤 ${escHtml(e.user)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:13px;font-weight:600">${escHtml(e.scriptName)}</span>
          <span style="font-size:12px;color:${meta.color}">${meta.icon} ${meta.label}</span>
          ${e.changes?.length ? `<span style="font-size:11px;color:var(--muted)">${renderChanges(e.changes)}</span>` : ''}
        </div>
      </div>
      <div style="flex-shrink:0;margin-top:4px">${diffBtn}</div>
    </div>`;
  }).join('');

  el.innerHTML = `<div style="padding:0 2px">${rows}</div>`;
}

/* ── Logs tab ─────────────────────────────────────────────────────────────── */
let logsScriptFilter = '';

function filterLogs(scriptName) {
  logsScriptFilter = scriptName;
  const sel = document.getElementById('logs-filter');
  if (sel) sel.value = scriptName;
  loadLogs();
}

// ── Logs date-period filter ───────────────────────────────────────────────────
let _logsPeriod = '1h';   // default

function setLogsPeriod(btn) {
  document.querySelectorAll('.logs-period').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _logsPeriod = btn.dataset.period;
  const custom = document.getElementById('logs-custom-range');
  if (_logsPeriod === 'custom') {
    custom.classList.add('visible');
    // Pre-fill custom inputs with current computed range
    const { since, until } = _logsDateRange();
    if (since) document.getElementById('logs-from').value  = _toLocalInput(new Date(since));
    if (until) document.getElementById('logs-until').value = _toLocalInput(new Date(until));
  } else {
    custom.classList.remove('visible');
    loadLogs();
  }
}

function _toLocalInput(d) {
  // Format Date as 'YYYY-MM-DDTHH:MM' for datetime-local input
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _logsDateRange() {
  if (_logsPeriod === 'all') return {};
  if (_logsPeriod === 'custom') {
    const from  = document.getElementById('logs-from').value;
    const until = document.getElementById('logs-until').value;
    return {
      since: from  ? new Date(from).toISOString()  : undefined,
      until: until ? new Date(until).toISOString() : undefined,
    };
  }
  const now  = new Date();
  const msMap = { '1h': 3600000, '6h': 21600000, '12h': 43200000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
  const ms    = msMap[_logsPeriod] || 86400000;
  return { since: new Date(now - ms).toISOString(), until: now.toISOString() };
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

    const filter          = sel.value;
    const { since, until } = _logsDateRange();
    const params = new URLSearchParams();
    if (filter) params.set('script', filter);
    if (since)  params.set('since',  since);
    if (until)  params.set('until',  until);
    const url  = `/api/logs${params.toString() ? '?' + params.toString() : ''}`;
    const runs = await api('GET', url);

    const periodLabel = { '1h':'last 1h', '6h':'last 6h', '12h':'last 12h', '24h':'last 24h', '7d':'last 7d', '30d':'last 30d', 'all':'all time', 'custom':'custom range' }[_logsPeriod] || '';
    document.getElementById('logs-count').textContent = `${runs.length} run${runs.length===1?'':'s'} · ${periodLabel}`;
    renderRunsTable(runs);
    document.getElementById('refresh-label').textContent = `Updated ${new Date().toLocaleTimeString()}`;

    // Show system update log if there is any update activity
    _refreshSysLogCard();
  } catch (e) { toast('Failed to load logs: ' + e.message, 'error'); }
  finally { setLoading(false); }
}

async function _refreshSysLogCard() {
  try {
    const s = await api('GET', '/api/admin/update/status');
    if (!s || !s.log) return;
    const card   = document.getElementById('sys-log-card');
    const output = document.getElementById('sys-log-output');
    const badge  = document.getElementById('sys-log-badge');
    card.style.display  = 'block';
    output.textContent  = s.log;
    output.scrollTop    = output.scrollHeight;
    const statusColor = { cloning:'var(--accent)', building:'var(--yellow)', done:'var(--green)', error:'var(--red)' }[s.status] || 'var(--muted)';
    const statusLabel = { cloning:'Cloning…', building:'Building…', done:'Complete', error:`Error: ${s.error||''}`, idle:'' }[s.status] || s.status;
    badge.textContent  = statusLabel;
    badge.style.color  = statusColor;
  } catch (_) { /* admin endpoint may not be accessible for non-admin roles */ }
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
      <td>${r.endTime ? fmtDateTime(r.endTime) : '<span style="color:var(--muted)">—</span>'}${duration ? ` <span style="color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums">(${duration})</span>` : ''}</td>
      <td><span class="badge badge-${r.language}">${r.language}</span></td>
      <td><span class="run-type">${r.runMode}</span></td>
      <td><span class="run-status ${statusClass}">${statusIcon} ${r.status}</span></td>
      <td>
        <button class="eye-btn" onclick="openLogViewer('${escHtml(r.runId)}','${escHtml(r.scriptName)}','${r.status}','${escHtml(r.startTime)}')" title="View logs">👁</button>
        <button class="eye-btn" onclick="downloadRunLog('${escHtml(r.runId)}','${escHtml(r.scriptName)}')" title="Download log as .txt">⬇</button>
      </td>
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
  currentLogViewer = { runId, scriptName };

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

function showLiveLogs(scriptName) {
  if (currentEventSource) { currentEventSource.close(); currentEventSource = null; }

  document.getElementById('log-viewer-modal').classList.remove('hidden');
  document.getElementById('lv-title').textContent = `Live Logs — ${scriptName}`;
  document.getElementById('lv-meta').innerHTML =
    `<span>Container: <code style="color:var(--accent)">script-${escHtml(scriptName)}</code></span>` +
    `<span style="color:var(--border)"> │ </span>` +
    `<span>Last 50 lines + following</span>`;

  const output = document.getElementById('lv-output');
  output.textContent = '';
  autoScroll = true;

  document.getElementById('lv-live-badge').style.display = '';

  const es = new EventSource(`/api/logs/container/${encodeURIComponent(scriptName)}/stream?tail=50`);
  currentEventSource = es;

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'data' || msg.type === 'content') {
      output.textContent += msg.text;
      if (autoScroll) output.scrollTop = output.scrollHeight;
    }

    if (msg.type === 'end') {
      document.getElementById('lv-live-badge').style.display = 'none';
      output.textContent += '\n[container stopped]\n';
      es.close();
      currentEventSource = null;
      if (autoScroll) output.scrollTop = output.scrollHeight;
    }

    if (msg.type === 'error') {
      document.getElementById('lv-live-badge').style.display = 'none';
      output.textContent += `\n[error] ${msg.text}\n`;
      es.close();
      currentEventSource = null;
    }
  };

  es.onerror = () => {
    document.getElementById('lv-live-badge').style.display = 'none';
    es.close();
    currentEventSource = null;
  };

  output.addEventListener('scroll', () => {
    autoScroll = output.scrollTop + output.clientHeight >= output.scrollHeight - 10;
  });
}

async function copyLogs() {
  const text = document.getElementById('lv-output').textContent || '';
  const btn = document.getElementById('lv-copy-btn');
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  } catch {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }
}

function scrollLogsToBottom() {
  const output = document.getElementById('lv-output');
  output.scrollTop = output.scrollHeight;
  autoScroll = true;
}

function downloadCurrentLog() {
  const text = document.getElementById('lv-output').textContent || '';
  const { runId, scriptName } = currentLogViewer;
  const blob = new Blob([text], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `${scriptName || 'log'}-${runId || 'current'}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── Add / Edit Script Modal ─────────────────────────────────────────────── */
function openAddModal() {
  scriptModalMode   = 'add';
  editingScriptName = null;
  resetForm();
  document.getElementById('script-modal-title').textContent  = 'Add Script';
  document.getElementById('script-modal-submit').textContent = 'Add Script';
  document.getElementById('f-name').disabled   = false;
  document.getElementById('f-name-hint').style.display = 'none';
  document.getElementById('env-download-btn').style.display = 'none';
  document.getElementById('add-modal').classList.remove('hidden');
}

function openEditModal(config) {
  scriptModalMode   = 'edit';
  editingScriptName = config.name;
  resetForm();
  populateScriptForm(config);
  document.getElementById('script-modal-title').textContent  = `Edit Script — ${config.name}`;
  document.getElementById('script-modal-submit').textContent = 'Save Changes';
  document.getElementById('f-name').disabled   = true;
  document.getElementById('f-name-hint').style.display = '';
  document.getElementById('update-check-area').style.display = 'flex';
  document.getElementById('env-download-btn').style.display = '';
  document.getElementById('add-modal').classList.remove('hidden');
}

function closeAddModal() {
  document.getElementById('add-modal').classList.add('hidden');
  resetUpdateCheck();
  scriptModalMode   = 'add';
  editingScriptName = null;
}

function resetForm() {
  ['f-name','f-repo','f-entry','f-schedule','f-buildcmd','f-token'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('f-branch').value    = 'main';
  document.getElementById('f-lang').value      = 'python';
  document.getElementById('f-port').value      = '';
  document.getElementById('f-timezone').value  = 'UTC';
  document.getElementById('rm-persistent').checked = true;
  document.getElementById('env-rows').innerHTML    = '';
  cancelEnvPaste();
  document.getElementById('cron-preview').textContent = '';
  document.getElementById('f-token').placeholder = 'ghp_xxxxxxxxxxxxxxxxxxxx';
  onBuildCmdChange();
  toggleRunMode();
  resetUpdateCheck();
  _pendingVpnFile = null;
  _setVpnUi(false, false, null);
}

function resetUpdateCheck() {
  document.getElementById('update-check-area').style.display = 'none';
  document.getElementById('update-status-text').textContent  = '';
  document.getElementById('update-status-text').style.color  = 'var(--muted)';
  const installBtn = document.getElementById('install-update-btn');
  installBtn.style.display = 'none';
  installBtn.textContent   = 'Install Update';
  installBtn.disabled      = false;
  const checkBtn = document.getElementById('check-update-btn');
  checkBtn.disabled    = false;
  checkBtn.textContent = 'Check for Updates';
}

/* ── OpenVPN helpers ─────────────────────────────────────────────────────── */
function _setVpnUi(enabled, configured, filename) {
  document.getElementById('f-vpn-enabled').checked = enabled;
  document.getElementById('vpn-toggle-label').textContent = enabled ? 'Enabled' : 'Disabled';
  document.getElementById('vpn-config-area').style.display = enabled ? '' : 'none';
  _vpnConfigured = configured;
  const statusEl    = document.getElementById('vpn-file-status');
  const removeBtn   = document.getElementById('vpn-remove-btn');
  if (configured || filename) {
    statusEl.textContent = filename ? filename : '.ovpn configured';
    statusEl.style.color = 'var(--green)';
    removeBtn.style.display = '';
  } else {
    statusEl.textContent = 'No .ovpn file uploaded';
    statusEl.style.color = 'var(--muted)';
    removeBtn.style.display = 'none';
  }
}

function onVpnToggle() {
  const enabled = document.getElementById('f-vpn-enabled').checked;
  document.getElementById('vpn-toggle-label').textContent = enabled ? 'Enabled' : 'Disabled';
  document.getElementById('vpn-config-area').style.display = enabled ? '' : 'none';
}

function onVpnFileSelected() {
  const input = document.getElementById('vpn-file-input');
  const file = input.files[0];
  if (!file) return;
  if (!file.name.endsWith('.ovpn')) {
    toast('Only .ovpn files are accepted', 'error');
    input.value = '';
    return;
  }

  if (scriptModalMode === 'edit' && editingScriptName) {
    // In edit mode: upload immediately
    const fd = new FormData();
    fd.append('ovpn', file);
    fetch(`/api/scripts/${encodeURIComponent(editingScriptName)}/vpn`, {
      method: 'POST', body: fd,
    }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || 'Upload failed'))))
      .then(() => {
        _setVpnUi(true, true, file.name);
        toast('.ovpn uploaded', 'success');
      })
      .catch(e => toast(e.message, 'error'));
  } else {
    // In add mode: stage locally, upload after script created
    _pendingVpnFile = file;
    _setVpnUi(true, false, file.name);
  }
  input.value = '';
}

function removeVpnConfig() {
  if (scriptModalMode === 'edit' && editingScriptName && _vpnConfigured) {
    api('DELETE', `/api/scripts/${encodeURIComponent(editingScriptName)}/vpn`)
      .then(() => {
        _setVpnUi(true, false, null);
        toast('.ovpn removed', 'info');
      })
      .catch(e => toast(e.message, 'error'));
  } else {
    // Just clear the staged file
    _pendingVpnFile = null;
    _setVpnUi(true, false, null);
  }
}

function checkScriptUpdate() {
  const checkBtn  = document.getElementById('check-update-btn');
  const statusEl  = document.getElementById('update-status-text');
  const installBtn = document.getElementById('install-update-btn');

  checkBtn.disabled    = true;
  checkBtn.textContent = 'Checking…';
  statusEl.textContent = '';
  installBtn.style.display = 'none';

  api('GET', `/api/scripts/${encodeURIComponent(editingScriptName)}/check-update`)
    .then(data => {
      if (data.hasUpdate) {
        const count = data.behind === 1 ? '1 new commit' : `${data.behind} new commits`;
        statusEl.textContent   = data.latestMessage ? `${count}: ${data.latestMessage}` : count;
        statusEl.style.color   = 'var(--yellow)';
        installBtn.textContent = 'Install Update';
        installBtn.disabled    = false;
        installBtn.style.display = '';
      } else {
        statusEl.textContent = 'Already up to date';
        statusEl.style.color = 'var(--green)';
      }
      checkBtn.disabled    = false;
      checkBtn.textContent = 'Check Again';
    })
    .catch(err => {
      statusEl.textContent = err.message || 'Check failed';
      statusEl.style.color = '#f87171';
      checkBtn.disabled    = false;
      checkBtn.textContent = 'Check for Updates';
    });
}

async function applyScriptUpdate() {
  const checkBtn   = document.getElementById('check-update-btn');
  const statusEl   = document.getElementById('update-status-text');
  const installBtn = document.getElementById('install-update-btn');

  installBtn.disabled    = true;
  installBtn.textContent = 'Installing…';
  checkBtn.disabled      = true;
  statusEl.textContent   = 'Pulling latest code…';
  statusEl.style.color   = 'var(--muted)';

  try {
    const result = await api('POST', `/api/scripts/${encodeURIComponent(editingScriptName)}/update`);
    statusEl.textContent     = result.message || 'Update applied';
    statusEl.style.color     = 'var(--green)';
    installBtn.style.display = 'none';
    checkBtn.disabled        = false;
    checkBtn.textContent     = 'Check Again';
    toast(result.message || 'Update applied', 'success');
    setTimeout(loadScripts, 1500);
  } catch (err) {
    statusEl.textContent   = err.message || 'Update failed';
    statusEl.style.color   = '#f87171';
    installBtn.disabled    = false;
    installBtn.textContent = 'Install Update';
    checkBtn.disabled      = false;
  }
}

function populateScriptForm(config) {
  document.getElementById('f-name').value     = config.name;
  document.getElementById('f-lang').value     = config.language;
  document.getElementById('f-repo').value     = config.repo;
  document.getElementById('f-branch').value   = config.branch;
  document.getElementById('f-entry').value    = config.entryPoint;
  document.getElementById('f-buildcmd').value = config.buildCommand || '';
  document.getElementById('f-port').value     = config.port || '';
  document.getElementById('f-token').value    = '';
  document.getElementById('f-token').placeholder = config.repoToken
    ? '(token already set — leave blank to keep)'
    : 'ghp_xxxxxxxxxxxxxxxxxxxx';

  if (config.runMode === 'scheduled') {
    document.getElementById('rm-scheduled').checked = true;
  } else {
    document.getElementById('rm-persistent').checked = true;
  }
  document.getElementById('f-schedule').value = config.schedule  || '';
  document.getElementById('f-timezone').value = config.timezone  || 'UTC';

  document.getElementById('env-rows').innerHTML = '';
  cancelEnvPaste();
  Object.entries(config.env || {}).forEach(([k, v]) => addEnvRow(k, v));

  onBuildCmdChange();
  updateCronPreview();
  toggleRunMode();

  // Load VPN state async
  if (config.vpnEnabled) {
    api('GET', `/api/scripts/${encodeURIComponent(config.name)}/vpn`)
      .then(d => _setVpnUi(true, d.configured, d.configured ? '.ovpn configured' : null))
      .catch(() => _setVpnUi(true, false, null));
  } else {
    _setVpnUi(false, false, null);
  }
}

async function submitScriptModal() {
  if (scriptModalMode === 'add') await submitAdd();
  else                           await submitEdit();
}

function onBuildCmdChange() {
  const hasBuild = document.getElementById('f-buildcmd').value.trim() !== '';
  document.getElementById('entry-point-label').textContent = hasBuild ? 'Start Command *' : 'Entry Point *';
  document.getElementById('f-entry').placeholder           = hasBuild ? 'npm start'       : 'main.py';
  document.getElementById('buildcmd-hint').style.display  = hasBuild ? '' : 'none';
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

function toggleEnvPaste() {
  const area = document.getElementById('env-paste-area');
  const isHidden = area.style.display === 'none' || area.style.display === '';
  area.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    document.getElementById('env-paste-input').value = '';
    document.getElementById('env-paste-input').focus();
  }
}

function applyEnvPaste() {
  const text = document.getElementById('env-paste-input').value;
  const parsed = parseEnvText(text);
  if (Object.keys(parsed).length === 0) return;
  Object.entries(parsed).forEach(([k, v]) => addEnvRow(k, v));
  cancelEnvPaste();
}

function cancelEnvPaste() {
  document.getElementById('env-paste-area').style.display = 'none';
  document.getElementById('env-paste-input').value = '';
}

function clearEnvRows() {
  if (!confirm('Remove all environment variables?')) return;
  document.getElementById('env-rows').innerHTML = '';
}

function downloadEnvFile() {
  if (!editingScriptName) return;
  const a = document.createElement('a');
  a.href = `/api/scripts/${encodeURIComponent(editingScriptName)}/env-file`;
  a.download = `${editingScriptName}.env`;
  a.click();
}

function parseEnvText(text) {
  const result = {};
  text.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  });
  return result;
}

function setCron(expr) { document.getElementById('f-schedule').value = expr; updateCronPreview(); }
function updateCronPreview() {
  const expr = document.getElementById('f-schedule').value.trim();
  const el   = document.getElementById('cron-preview');
  el.textContent = expr ? (describeCron(expr) || expr) : '';
}

function collectScriptFormBody() {
  const lang     = document.getElementById('f-lang').value;
  const repo     = document.getElementById('f-repo').value.trim();
  const branch   = document.getElementById('f-branch').value.trim() || 'main';
  const entry    = document.getElementById('f-entry').value.trim();
  const runMode  = document.querySelector('input[name="run-mode"]:checked').value;
  const port     = document.getElementById('f-port').value;
  const sched    = document.getElementById('f-schedule').value.trim();
  const tz       = document.getElementById('f-timezone').value;
  const buildcmd = document.getElementById('f-buildcmd').value.trim();
  const token    = document.getElementById('f-token').value.trim();

  const env = {};
  document.querySelectorAll('.env-row').forEach(row => {
    const k = row.querySelector('.env-key').value.trim();
    const v = row.querySelector('.env-val').value.trim();
    if (k) env[k] = v;
  });

  const vpnEnabled = document.getElementById('f-vpn-enabled').checked;
  const body = { language: lang, repo, branch, entryPoint: entry, runMode, env, vpnEnabled };
  if (port)                   body.port         = parseInt(port);
  body.buildCommand = buildcmd;           // empty string clears it on edit
  if (token)                  body.repoToken    = token;
  body.schedule  = runMode === 'scheduled' ? sched : '';
  body.timezone  = tz;
  return { body, entry, repo, runMode, sched };
}

async function submitAdd() {
  const name = document.getElementById('f-name').value.trim();
  const { body, entry, repo, runMode, sched } = collectScriptFormBody();

  if (!name || !repo || !entry) { toast('Name, repo URL, and entry point are required', 'error'); return; }
  if (runMode === 'scheduled' && !sched) { toast('Cron expression required for scheduled mode', 'error'); return; }

  try {
    await api('POST', '/api/scripts', { name, ...body });
    if (_pendingVpnFile) {
      const fd = new FormData();
      fd.append('ovpn', _pendingVpnFile);
      await fetch(`/api/scripts/${encodeURIComponent(name)}/vpn`, { method: 'POST', body: fd });
      _pendingVpnFile = null;
    }
    toast(`"${name}" added — cloning in background…`, 'success');
    closeAddModal();
    setTimeout(loadScripts, 2000);
  } catch (e) { toast(e.message, 'error'); }
}

async function submitEdit() {
  const { body, entry, repo, runMode, sched } = collectScriptFormBody();

  if (!repo || !entry) { toast('Repo URL and entry point are required', 'error'); return; }
  if (runMode === 'scheduled' && !sched) { toast('Cron expression required for scheduled mode', 'error'); return; }

  try {
    const result = await api('PUT', `/api/scripts/${encodeURIComponent(editingScriptName)}`, body);
    toast(result.message || 'Config updated', 'success');
    closeAddModal();
    setTimeout(loadScripts, 1500);
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Utilities ────────────────────────────────────────────────────────────── */
// ── Addons ────────────────────────────────────────────────────────────────────

let addonPollTimer = null;

async function loadAddons() {
  try {
    const addons = await api('GET', '/api/admin/addons');
    renderAddons(addons);
    const busy = addons.some(a => a.opStatus === 'installing' || a.opStatus === 'removing');
    clearTimeout(addonPollTimer);
    if (busy) addonPollTimer = setTimeout(loadAddons, 2000);
  } catch (e) {
    const el = document.getElementById('addons-container');
    if (el) el.innerHTML = `<div style="font-size:12px;color:var(--red)">Error: ${e.message}</div>`;
  }
}

function addonStatusBadge(a) {
  if      (a.opStatus === 'installing')  return '<span style="font-size:11px;color:var(--accent)">⟳ Installing…</span>';
  else if (a.opStatus === 'removing')    return '<span style="font-size:11px;color:var(--yellow,#facc15)">⟳ Removing…</span>';
  else if (a.opStatus === 'error')       return `<span style="font-size:11px;color:var(--red)" title="${escHtml(a.error||'')}">✗ Error</span>`;
  else if (!a.containerFound)            return '<span style="font-size:11px;color:var(--muted)">Container not found</span>';
  else if (a.installed)                  return '<span style="font-size:11px;color:var(--green)">✓ Installed</span>';
  else                                   return '<span style="font-size:11px;color:var(--muted)">Not installed</span>';
}

function addonLogBlock(a) {
  const isBusy = a.opStatus === 'installing' || a.opStatus === 'removing';
  if (!(isBusy || a.opStatus === 'done' || a.opStatus === 'error') || !a.log) return '';
  return `<pre style="margin-top:8px;font-family:'Courier New',monospace;font-size:11px;background:#0a0c12;border:1px solid var(--border);border-radius:6px;padding:8px;max-height:140px;overflow-y:auto;color:#a3e635;white-space:pre-wrap;word-break:break-all">${escHtml(a.log)}</pre>`;
}

function renderAddons(addons) {
  const container = document.getElementById('addons-container');
  if (!container) return;
  if (!addons.length) {
    container.innerHTML = '<div style="font-size:12px;color:var(--muted)">No addons configured.</div>';
    return;
  }

  const ollamaAddons = addons.filter(a => a.id.startsWith('ollama-'));
  const otherAddons  = addons.filter(a => !a.id.startsWith('ollama-'));

  let html = '';

  // ── Ollama Models ──────────────────────────────────────────────────────────
  if (ollamaAddons.length) {
    const containerFound  = ollamaAddons.some(a => a.containerFound);
    const anyBusy         = ollamaAddons.some(a => a.opStatus === 'installing' || a.opStatus === 'removing');
    const availableModels = ollamaAddons.filter(a => !a.installed && a.opStatus !== 'installing');
    const installedModels = ollamaAddons.filter(a => a.installed || a.opStatus === 'installing' || a.opStatus === 'removing' || a.opStatus === 'error');

    // Group available models by tier; fall back to flat list if no group info
    const groups = [];
    const seen   = new Set();
    availableModels.forEach(a => { if (a.group && !seen.has(a.group)) { seen.add(a.group); groups.push(a.group); } });
    const modelOptions = groups.length
      ? groups.map(g => {
          const opts = availableModels
            .filter(a => a.group === g)
            .map(a => `<option value="${escHtml(a.id)}">${escHtml(a.name.replace(/^Ollama\s*[–-]\s*/i, ''))}</option>`)
            .join('');
          return `<optgroup label="${escHtml(g)}">${opts}</optgroup>`;
        }).join('')
      : availableModels.map(a => {
          const label = a.name.replace(/^Ollama\s*[–-]\s*/i, '');
          return `<option value="${escHtml(a.id)}">${escHtml(label)}</option>`;
        }).join('');

    const selectDisabled = !containerFound || anyBusy || !availableModels.length ? 'disabled' : '';
    const installDisabled = !containerFound || anyBusy || !availableModels.length ? 'disabled' : '';

    html += `
      <div style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Ollama Models</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
        <select id="ollama-model-select" ${selectDisabled}
          style="flex:1;background:var(--surface2,#1a1d27);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:13px;color:var(--fg);min-width:0">
          <option value="">${availableModels.length ? 'Select a model…' : 'All models installed'}</option>
          ${modelOptions}
        </select>
        <button class="btn btn-primary btn-sm" onclick="installSelectedModel()" ${installDisabled}>↓ Install</button>
      </div>`;

    if (installedModels.length) {
      html += `<div style="display:flex;flex-direction:column;gap:8px">`;
      for (const a of installedModels) {
        const isBusy = a.opStatus === 'installing' || a.opStatus === 'removing';
        const label  = a.name.replace(/^Ollama\s*[–-]\s*/i, '');
        html += `
          <div style="background:var(--surface2,#1a1d27);border:1px solid var(--border);border-radius:6px;padding:10px 12px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:13px;font-weight:600">${escHtml(label)}</span>
                ${addonStatusBadge(a)}
              </div>
              <button class="btn btn-ghost btn-sm" onclick="removeAddon('${escHtml(a.id)}')"
                ${(isBusy || !a.containerFound) ? 'disabled' : ''}>✕ Remove</button>
            </div>
            ${addonLogBlock(a)}
          </div>`;
      }
      html += `</div>`;
    } else {
      html += `<div style="font-size:12px;color:var(--muted);padding:6px 0">No models installed yet.</div>`;
    }
  }

  // ── Other addons ───────────────────────────────────────────────────────────
  if (otherAddons.length) {
    if (ollamaAddons.length) html += `<div style="margin-top:20px;margin-bottom:10px;border-top:1px solid var(--border)"></div>`;
    html += otherAddons.map((a, i) => {
      const isBusy = a.opStatus === 'installing' || a.opStatus === 'removing';
      const sep = i < otherAddons.length - 1 ? 'padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--border);' : '';
      return `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px;${sep}">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:13px;font-weight:600">${escHtml(a.name)}</span>
              ${addonStatusBadge(a)}
            </div>
            <div style="font-size:12px;color:var(--muted);line-height:1.5">${escHtml(a.description)}</div>
            ${addonLogBlock(a)}
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0;margin-top:2px">
            <button class="btn btn-primary btn-sm" onclick="installAddon('${escHtml(a.id)}')"
              ${(isBusy || a.installed || !a.containerFound) ? 'disabled' : ''}>↓ Install</button>
            <button class="btn btn-ghost btn-sm" onclick="removeAddon('${escHtml(a.id)}')"
              ${(isBusy || !a.installed || !a.containerFound) ? 'disabled' : ''}>✕ Remove</button>
          </div>
        </div>`;
    }).join('');
  }

  container.innerHTML = html;
}

async function installSelectedModel() {
  const sel = document.getElementById('ollama-model-select');
  if (!sel || !sel.value) return;
  await installAddon(sel.value);
}

async function installAddon(id) {
  try {
    await api('POST', `/api/admin/addons/${id}/install`);
    await loadAddons();
  } catch (e) { alert('Install failed: ' + e.message); }
}

async function removeAddon(id) {
  if (!confirm('Remove this model?')) return;
  try {
    await api('POST', `/api/admin/addons/${id}/remove`);
    await loadAddons();
  } catch (e) { alert('Remove failed: ' + e.message); }
}

/* ── System Resources ────────────────────────────────────────────────────── */

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

function resGauge(used, total, label) {
  const pct   = total ? Math.round(used / total * 100) : 0;
  const color = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--yellow)' : 'var(--accent)';
  return `<div>
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
      <span style="font-weight:600">${label}</span>
      <span style="color:var(--muted)">${fmtBytes(used)} / ${fmtBytes(total)} (${pct}%)</span>
    </div>
    <div style="background:var(--border);border-radius:4px;height:5px">
      <div style="background:${color};height:5px;border-radius:4px;width:${pct}%;transition:width .4s"></div>
    </div>
  </div>`;
}

async function loadResources() {
  const el = document.getElementById('res-content');
  try {
    const d = await api('GET', '/api/admin/system/resources');

    let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      ${resGauge(d.disk.used, d.disk.total, '💿 Disk')}
      ${resGauge(d.memory.used, d.memory.total, '🧠 Memory')}
    </div>`;

    if (d.containers.length) {
      html += `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:8px">Containers</div>
        <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11px">
        <tr style="background:var(--surface2)">
          <th style="text-align:left;padding:6px 10px;color:var(--muted);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.04em">Name</th>
          <th style="text-align:right;padding:6px 10px;color:var(--muted);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.04em">Memory</th>
          <th style="text-align:right;padding:6px 10px;color:var(--muted);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.04em">Disk (Δ)</th>
        </tr>`;
      for (const c of d.containers.sort((a, b) => b.memUsage - a.memUsage)) {
        const memPct   = c.memLimit ? Math.round(c.memUsage / c.memLimit * 100) : 0;
        const memColor = memPct > 90 ? 'var(--red)' : memPct > 70 ? 'var(--yellow)' : 'var(--muted)';
        html += `<tr style="border-top:1px solid var(--border)">
          <td style="padding:6px 10px;font-family:monospace;font-size:11px">${escHtml(c.name)}</td>
          <td style="padding:6px 10px;text-align:right;color:${memColor};font-variant-numeric:tabular-nums">${fmtBytes(c.memUsage)} <span style="color:var(--muted);font-size:10px">(${memPct}%)</span></td>
          <td style="padding:6px 10px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">${c.diskRw ? fmtBytes(c.diskRw) : '—'}</td>
        </tr>`;
      }
      html += '</table></div>';
    }

    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<span style="font-size:12px;color:var(--red)">${escHtml(e.message)}</span>`;
  }
}

/* ── Ollama Version Pin ──────────────────────────────────────────────────── */

async function ovLoad() {
  try {
    const d = await api('GET', '/api/admin/ollama/compose-version');
    document.getElementById('ov-compose').textContent = d.composeImage || '—';
    document.getElementById('ov-running').textContent = d.runningImage || '—';
    if (d.composeImage) {
      const ver = d.composeImage.replace('ollama/ollama:', '');
      document.getElementById('ov-version').placeholder = ver;
    }
    if (!d.composeAccessible) {
      document.getElementById('ov-msg').textContent = '⚠ docker-compose.yml not mounted — save disabled.';
      document.getElementById('ov-msg').style.color = '#f59e0b';
    }
  } catch {}
}

async function ovSave(apply) {
  const version = document.getElementById('ov-version').value.trim();
  if (!version) { toast('Enter a version (e.g. 0.25.0 or latest)', 'error'); return; }
  const msg = document.getElementById('ov-msg');
  msg.textContent = apply ? 'Pulling and applying…' : 'Saving…';
  msg.style.color = 'var(--muted)';
  try {
    const r = await api('POST', '/api/admin/ollama/compose-version', { version, apply });
    msg.textContent = '✓ ' + r.message;
    msg.style.color = 'var(--green)';
    document.getElementById('ov-version').value = '';
    await ovLoad();
  } catch (e) {
    msg.textContent = e.message;
    msg.style.color = '#ef4444';
  }
}

/* ── Ollama Version Tester ───────────────────────────────────────────────── */

let vtPollTimer   = null;
let vtInitialized = false;

async function vtInit() {
  if (vtInitialized) { vtRefresh(); return; }
  vtInitialized = true;
  try {
    const cfg = await api('GET', '/api/admin/ollama/version-test/config');
    const sel  = document.getElementById('vt-model');
    sel.innerHTML = '<option value="">Select a model…</option>' +
      cfg.models.map(m => `<option value="${m}">${m}</option>`).join('');
    const el   = document.getElementById('vt-versions');
    cfg.versions.forEach((v, i) => {
      const lbl = document.createElement('label');
      lbl.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;padding:2px 8px;border:1px solid var(--border);border-radius:4px;white-space:nowrap';
      lbl.innerHTML = `<input type="checkbox" value="${v}"> ${v}`;
      el.appendChild(lbl);
    });
    vtRefresh();
  } catch (e) { console.warn('vtInit:', e.message); }
}

function vtSelectedVersions() {
  return [...document.querySelectorAll('#vt-versions input:checked')].map(i => i.value);
}
function vtSelectAll()  { document.querySelectorAll('#vt-versions input').forEach(i => i.checked = true); }
function vtSelectNone() { document.querySelectorAll('#vt-versions input').forEach(i => i.checked = false); }

async function vtRun() {
  const versions = vtSelectedVersions();
  if (!versions.length) { toast('Select at least one version', 'error'); return; }
  const model = document.getElementById('vt-model').value;
  if (!model) { toast('Select a model first', 'error'); return; }
  try {
    await api('POST', '/api/admin/ollama/version-test/run', { versions, model });
    vtStartPolling();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function vtStop() {
  await api('POST', '/api/admin/ollama/version-test/stop').catch(() => {});
  toast('Stop requested', 'info');
}

async function vtClean() {
  if (!confirm('Remove test container, volume and all downloaded test images?')) return;
  const btn = document.getElementById('vt-clean-btn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/admin/ollama/version-test/clean');
    toast(r.message, 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
  finally { btn.disabled = false; }
}

async function vtDeleteAllModels() {
  if (!confirm('Delete ALL models from the Ollama container? This cannot be undone.')) return;
  try {
    const r = await api('DELETE', '/api/admin/ollama/models');
    toast(r.message, 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

function vtStartPolling() {
  if (vtPollTimer) clearInterval(vtPollTimer);
  vtPollTimer = setInterval(vtRefresh, 2000);
  vtRefresh();
}
function vtStopPolling() {
  if (vtPollTimer) { clearInterval(vtPollTimer); vtPollTimer = null; }
}

const VT_STATUS = {
  pending:       { label: '⏳ Pending',       color: 'var(--muted)' },
  pulling_image: { label: '⬇ Pulling image',  color: 'var(--accent)' },
  starting:      { label: '⟳ Starting',       color: 'var(--accent)' },
  pulling_model: { label: '⬇ Pulling model',  color: 'var(--accent)' },
  running:       { label: '⟳ Running',        color: 'var(--accent)' },
  ok:            { label: '✓ OK',             color: 'var(--green)' },
  too_old:       { label: '⚠ Too old (412)',  color: '#f59e0b' },
  segfault:      { label: '✗ Segfault',       color: '#ef4444' },
  skip:          { label: '— Skip',           color: 'var(--muted)' },
  error:         { label: '✗ Error',          color: '#ef4444' },
};

async function vtRefresh() {
  const state = await api('GET', '/api/admin/ollama/version-test/status').catch(() => null);
  if (!state) return;
  document.getElementById('vt-run-btn').disabled       = state.running;
  document.getElementById('vt-stop-btn').style.display = state.running ? '' : 'none';
  if (!state.running) vtStopPolling();
  if (!state.results.length) return;
  document.getElementById('vt-results').style.display = '';
  const table = document.getElementById('vt-results-table');
  let html = `<div style="font-size:11px;color:var(--muted);margin-bottom:6px">Model: <strong>${escHtml(state.model)}</strong>${state.running ? ' <span style="color:var(--accent)">⟳ running…</span>' : ''}</div>`;
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px">'
        + '<tr style="border-bottom:1px solid var(--border)">'
        + '<th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:500">Version</th>'
        + '<th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:500">Status</th>'
        + '<th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:500">Detail</th>'
        + '</tr>';
  for (const r of state.results) {
    const s = VT_STATUS[r.status] || { label: r.status, color: 'var(--muted)' };
    html += `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:4px 8px;font-family:monospace;white-space:nowrap">${escHtml(r.version)}</td>
      <td style="padding:4px 8px;color:${s.color};white-space:nowrap">${s.label}</td>
      <td style="padding:4px 8px;color:var(--muted);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.message || '')}</td>
    </tr>`;
  }
  html += '</table>';
  table.innerHTML = html;
}

/* ── OpenVPN Connection (admin, global) ─────────────────────────────────── */

let avpnPollTimer = null;

async function avpnInit() {
  await avpnLoadConfigStatus();
  const state = await api('GET', '/api/admin/vpn/test/status').catch(() => null);
  if (state && state.running) avpnStartPolling();
  else avpnRefresh();
}

async function avpnLoadConfigStatus() {
  try {
    const { configured } = await api('GET', '/api/admin/vpn/config');
    document.getElementById('avpn-file-status').textContent = configured ? '.ovpn configured' : 'No .ovpn file uploaded';
    document.getElementById('avpn-remove-btn').style.display = configured ? '' : 'none';
  } catch (e) { console.warn('avpnLoadConfigStatus:', e.message); }
}

function avpnFileSelected() {
  const input = document.getElementById('avpn-file-input');
  const file  = input.files[0];
  if (!file) return;
  if (!file.name.endsWith('.ovpn')) {
    toast('Only .ovpn files are accepted', 'error');
    input.value = '';
    return;
  }
  const fd = new FormData();
  fd.append('ovpn', file);
  fetch('/api/admin/vpn/config', { method: 'POST', body: fd })
    .then(r => r.json().then(data => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Upload failed');
      toast('.ovpn uploaded', 'success');
      avpnLoadConfigStatus();
    })
    .catch(e => toast('Upload failed: ' + e.message, 'error'));
  input.value = '';
}

async function avpnRemoveConfig() {
  if (!confirm('Remove the uploaded OpenVPN config?')) return;
  try {
    await api('DELETE', '/api/admin/vpn/config');
    toast('.ovpn removed', 'info');
    avpnLoadConfigStatus();
    document.getElementById('avpn-result').innerHTML = '';
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function avpnRun() {
  try {
    await api('POST', '/api/admin/vpn/test/run');
    document.getElementById('avpn-result').innerHTML = '';
    avpnStartPolling();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function avpnStop() {
  await api('POST', '/api/admin/vpn/test/stop').catch(() => {});
  toast('Stop requested', 'info');
}

async function avpnClean() {
  if (!confirm('Remove the OpenVPN test container?')) return;
  try {
    const r = await api('POST', '/api/admin/vpn/test/clean');
    toast(r.message, 'success');
    avpnRefresh();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

function avpnStartPolling() {
  if (avpnPollTimer) clearInterval(avpnPollTimer);
  avpnPollTimer = setInterval(avpnRefresh, 1500);
  avpnRefresh();
}
function avpnStopPolling() {
  if (avpnPollTimer) { clearInterval(avpnPollTimer); avpnPollTimer = null; }
}

function avpnToggleLog() {
  const box    = document.getElementById('avpn-log');
  const toggle = document.getElementById('avpn-log-toggle');
  const shown  = box.style.display !== 'none';
  box.style.display  = shown ? 'none' : '';
  toggle.textContent = shown ? '▾ show' : '▴ hide';
  if (!shown) box.scrollTop = box.scrollHeight;
}

const AVPN_STATUS = {
  idle:          { label: '— Idle',              color: 'var(--muted)' },
  pulling_image: { label: '⬇ Pulling image',     color: 'var(--accent)' },
  starting:      { label: '⟳ Starting',          color: 'var(--accent)' },
  connecting:    { label: '⟳ Connecting…',       color: 'var(--accent)' },
  testing_data:  { label: '⟳ Testing data flow', color: 'var(--accent)' },
  success:       { label: '✓ Connected — data transferred', color: 'var(--green)' },
  partial:       { label: '⚠ Connected — routing unconfirmed', color: '#f59e0b' },
  failed:        { label: '✗ Failed',            color: '#ef4444' },
};

async function avpnRefresh() {
  const state = await api('GET', '/api/admin/vpn/test/status').catch(() => null);
  if (!state) return;

  document.getElementById('avpn-run-btn').disabled       = state.running;
  document.getElementById('avpn-stop-btn').style.display = state.running ? '' : 'none';
  if (!state.running) avpnStopPolling();

  const s = AVPN_STATUS[state.status] || { label: state.status, color: 'var(--muted)' };
  const badge = document.getElementById('avpn-status-badge');
  badge.textContent = s.label;
  badge.style.color = s.color;

  const resultEl = document.getElementById('avpn-result');
  if (state.status === 'success' && state.result) {
    resultEl.innerHTML = `<span style="color:var(--green)">✓ Connected and transferred data through the tunnel.</span><br>
      Exit IP: <code>${escHtml(state.result.publicIp || '—')}</code> ·
      rx: ${state.result.rxBytesDelta} bytes · tx: ${state.result.txBytesDelta} bytes`;
  } else if (state.status === 'partial' && state.result) {
    resultEl.innerHTML = `<span style="color:#f59e0b">⚠ VPN connected, but full-tunnel routing could not be confirmed (split-tunnel config?).</span><br>
      ${state.result.publicIp ? `Observed IP: <code>${escHtml(state.result.publicIp)}</code> · ` : ''}
      rx: ${state.result.rxBytesDelta} bytes · tx: ${state.result.txBytesDelta} bytes`;
  } else if (state.status === 'failed' && state.error) {
    resultEl.innerHTML = `<span style="color:#ef4444">✗ ${escHtml(state.error)}</span>`;
  } else {
    resultEl.innerHTML = '';
  }

  if (state.log) {
    document.getElementById('avpn-log-wrap').style.display = '';
    const log = document.getElementById('avpn-log');
    log.textContent = state.log;
    if (state.running) log.scrollTop = log.scrollHeight;
  }
}

/* ── SQL over VPN test ───────────────────────────────────────────────────── */
let sqltPollTimer = null;

const SQLT_DEFAULT_PORT = { postgres: '5432', mysql: '3306', mssql: '1433' };

function sqltEngineChanged() {
  const engine   = document.getElementById('sqlt-engine').value;
  const portInput = document.getElementById('sqlt-port');
  // Only auto-fill the port if it still matches one of the known defaults —
  // don't clobber a value the admin typed in themselves.
  if (Object.values(SQLT_DEFAULT_PORT).includes(portInput.value)) {
    portInput.value = SQLT_DEFAULT_PORT[engine];
  }
}

async function sqltInit() {
  await sqltLoadConfigStatus();
  const state = await api('GET', '/api/admin/sql-test/status').catch(() => null);
  if (state && state.running) sqltStartPolling();
  else sqltRefresh();
}

async function sqltLoadConfigStatus() {
  try {
    const { configured } = await api('GET', '/api/admin/sql-test/vpn/config');
    document.getElementById('sqlt-file-status').textContent = configured ? '.ovpn configured' : 'No .ovpn file uploaded';
    document.getElementById('sqlt-remove-btn').style.display = configured ? '' : 'none';
  } catch (e) { console.warn('sqltLoadConfigStatus:', e.message); }
}

function sqltFileSelected() {
  const input = document.getElementById('sqlt-file-input');
  const file  = input.files[0];
  if (!file) return;
  if (!file.name.endsWith('.ovpn')) {
    toast('Only .ovpn files are accepted', 'error');
    input.value = '';
    return;
  }
  const fd = new FormData();
  fd.append('ovpn', file);
  fetch('/api/admin/sql-test/vpn/config', { method: 'POST', body: fd })
    .then(r => r.json().then(data => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Upload failed');
      toast('.ovpn uploaded', 'success');
      sqltLoadConfigStatus();
    })
    .catch(e => toast('Upload failed: ' + e.message, 'error'));
  input.value = '';
}

async function sqltRemoveConfig() {
  if (!confirm('Remove the uploaded OpenVPN config?')) return;
  try {
    await api('DELETE', '/api/admin/sql-test/vpn/config');
    toast('.ovpn removed', 'info');
    sqltLoadConfigStatus();
    document.getElementById('sqlt-result').innerHTML = '';
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function sqltRun() {
  const engine   = document.getElementById('sqlt-engine').value;
  const host     = document.getElementById('sqlt-host').value.trim();
  const port     = document.getElementById('sqlt-port').value.trim();
  const database = document.getElementById('sqlt-database').value.trim();
  const username = document.getElementById('sqlt-username').value.trim();
  const password = document.getElementById('sqlt-password').value;
  const query    = document.getElementById('sqlt-query').value.trim();

  if (!host || !port || !database || !username || !query) {
    toast('Host, port, database, username and query are required', 'error');
    return;
  }

  try {
    await api('POST', '/api/admin/sql-test/run', { engine, host, port, database, username, password, query });
    document.getElementById('sqlt-result').innerHTML = '';
    document.getElementById('sqlt-table-wrap').style.display = 'none';
    document.getElementById('sqlt-table-wrap').innerHTML = '';
    document.getElementById('sqlt-download-btn').style.display = 'none';
    sqltStartPolling();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function sqltStop() {
  await api('POST', '/api/admin/sql-test/stop').catch(() => {});
  toast('Stop requested', 'info');
}

async function sqltClean() {
  if (!confirm('Remove the SQL test container?')) return;
  try {
    const r = await api('POST', '/api/admin/sql-test/clean');
    toast(r.message, 'success');
    sqltRefresh();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

function sqltStartPolling() {
  if (sqltPollTimer) clearInterval(sqltPollTimer);
  sqltPollTimer = setInterval(sqltRefresh, 1500);
  sqltRefresh();
}
function sqltStopPolling() {
  if (sqltPollTimer) { clearInterval(sqltPollTimer); sqltPollTimer = null; }
}

function sqltToggleLog() {
  const box    = document.getElementById('sqlt-log');
  const toggle = document.getElementById('sqlt-log-toggle');
  const shown  = box.style.display !== 'none';
  box.style.display  = shown ? 'none' : '';
  toggle.textContent = shown ? '▾ show' : '▴ hide';
  if (!shown) box.scrollTop = box.scrollHeight;
}

function sqltDownloadLog() {
  const text   = document.getElementById('sqlt-log').textContent || '';
  const engine = document.getElementById('sqlt-engine').value || 'sql';
  const blob   = new Blob([text], { type: 'text/plain' });
  const a      = document.createElement('a');
  a.href       = URL.createObjectURL(blob);
  a.download   = `sql-over-vpn-test-${engine}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function sqltSaveParams() {
  const params = {
    engine:   document.getElementById('sqlt-engine').value,
    database: document.getElementById('sqlt-database').value.trim(),
    host:     document.getElementById('sqlt-host').value.trim(),
    port:     document.getElementById('sqlt-port').value.trim(),
    username: document.getElementById('sqlt-username').value.trim(),
    query:    document.getElementById('sqlt-query').value,
  };
  const blob = new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `sql-over-vpn-test-params-${params.engine || 'sql'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Parameters saved (password not included)', 'info');
}

function sqltParamsFileSelected() {
  const input = document.getElementById('sqlt-params-file-input');
  const file  = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let params;
    try {
      params = JSON.parse(reader.result);
    } catch (e) {
      toast('Invalid parameters file: not valid JSON', 'error');
      return;
    }
    if (params.engine != null && ['postgres', 'mysql', 'mssql'].includes(params.engine)) {
      document.getElementById('sqlt-engine').value = params.engine;
    }
    if (params.database != null) document.getElementById('sqlt-database').value = params.database;
    if (params.host     != null) document.getElementById('sqlt-host').value     = params.host;
    if (params.port     != null) document.getElementById('sqlt-port').value     = params.port;
    if (params.username != null) document.getElementById('sqlt-username').value = params.username;
    if (params.query    != null) document.getElementById('sqlt-query').value    = params.query;
    toast('Parameters loaded — enter the password separately', 'success');
  };
  reader.onerror = () => toast('Failed to read parameters file', 'error');
  reader.readAsText(file);
  input.value = '';
}

const SQLT_STATUS = {
  idle:                  { label: '— Idle',                  color: 'var(--muted)' },
  pulling_image:         { label: '⬇ Pulling image',         color: 'var(--accent)' },
  starting:              { label: '⟳ Starting',              color: 'var(--accent)' },
  connecting_vpn:        { label: '⟳ Connecting VPN…',        color: 'var(--accent)' },
  checking_reachability: { label: '⟳ Checking reachability…', color: 'var(--accent)' },
  connecting_db:         { label: '⟳ Connecting to DB…',      color: 'var(--accent)' },
  running_query:         { label: '⟳ Running query…',         color: 'var(--accent)' },
  success:               { label: '✓ Success',                color: 'var(--green)' },
  failed:                { label: '✗ Failed',                 color: '#ef4444' },
};

async function sqltRefresh() {
  const state = await api('GET', '/api/admin/sql-test/status').catch(() => null);
  if (!state) return;

  document.getElementById('sqlt-run-btn').disabled       = state.running;
  document.getElementById('sqlt-stop-btn').style.display = state.running ? '' : 'none';
  if (!state.running) sqltStopPolling();

  const s = SQLT_STATUS[state.status] || { label: state.status, color: 'var(--muted)' };
  const badge = document.getElementById('sqlt-status-badge');
  badge.textContent = s.label;
  badge.style.color = s.color;

  const resultEl = document.getElementById('sqlt-result');
  if (state.status === 'success') {
    resultEl.innerHTML = state.result
      ? '<span style="color:var(--green)">✓ Query ran successfully.</span>'
      : '<span style="color:var(--green)">✓ Query ran successfully — see the log below for output.</span>';
  } else if (state.status === 'failed' && state.error) {
    resultEl.innerHTML = `<span style="color:#ef4444">✗ ${escHtml(state.error)}</span>`;
  } else {
    resultEl.innerHTML = '';
  }

  const tableWrap = document.getElementById('sqlt-table-wrap');
  if (state.result && state.result.columns && state.result.columns.length) {
    const r = state.result;
    let html = `<div style="font-size:11px;color:var(--muted);margin-bottom:6px">
      Sample result — ${r.rows.length} row${r.rows.length === 1 ? '' : 's'} shown${r.truncated ? ` (of ${r.totalRows} total)` : ''}
    </div>`;
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px">'
          + '<tr style="border-bottom:1px solid var(--border)">'
          + r.columns.map(c => `<th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:500;white-space:nowrap">${escHtml(c)}</th>`).join('')
          + '</tr>';
    for (const row of r.rows) {
      html += '<tr style="border-bottom:1px solid var(--border)">'
            + row.map(v => `<td style="padding:4px 8px;font-family:monospace;white-space:nowrap">${escHtml(v)}</td>`).join('')
            + '</tr>';
    }
    html += '</table>';
    tableWrap.innerHTML = html;
    tableWrap.style.display = '';
  } else {
    tableWrap.style.display = 'none';
    tableWrap.innerHTML = '';
  }

  if (state.log) {
    document.getElementById('sqlt-log-wrap').style.display = '';
    document.getElementById('sqlt-download-btn').style.display = '';
    const log = document.getElementById('sqlt-log');
    log.textContent = state.log;
    if (state.running) log.scrollTop = log.scrollHeight;
  }
}

/* ── Ollama CPU diagnostics ──────────────────────────────────────────────── */
async function ollamaCpuCheck() {
  const btn          = document.getElementById('ollama-cpu-btn');
  const result       = document.getElementById('ollama-cpu-result');
  const updateBtn    = document.getElementById('ollama-update-btn');
  const fixBtn       = document.getElementById('ollama-fix-btn');
  const ggmlFixBtn   = document.getElementById('ollama-ggml-fix-btn');
  const bothFixBtn   = document.getElementById('ollama-both-fix-btn');
  const avx2FixBtn      = document.getElementById('ollama-avx2-fix-btn');
  const avx2RunnerBtn   = document.getElementById('ollama-avx2-runner-btn');

  btn.disabled = true;
  btn.textContent = '⟳ Checking…';
  result.innerHTML = '';
  document.getElementById('ollama-mem-row').style.display = 'none';
  const resetBtn = document.getElementById('ollama-reset-btn');
  [updateBtn, fixBtn, ggmlFixBtn, bothFixBtn, avx2FixBtn, avx2RunnerBtn, resetBtn].forEach(b => { b.style.display = 'none'; });

  try {
    const data = await api('GET', '/api/admin/ollama/cpu-check');

    if (!data.containerFound) {
      result.innerHTML = '<span style="font-size:12px;color:var(--muted)">Ollama container not found — is it running?</span>';
      return;
    }

    const flagsHtml = data.flags.length
      ? data.flags.map(f => {
          const isAmx = f.startsWith('amx');
          return `<code style="display:inline-block;margin:2px 4px 2px 0;padding:1px 6px;border-radius:4px;font-size:11px;background:${isAmx ? '#3b1215' : '#0f1623'};color:${isAmx ? '#f87171' : '#94a3b8'}">${escHtml(f)}</code>`;
        }).join('')
      : '<span style="font-size:12px;color:var(--muted)">No AMX/AVX flags found</span>';

    let envStatus = '';
    if (data.noAmxSet)      envStatus += '<code style="font-size:11px;color:var(--green)">OLLAMA_NO_AMX=1</code> ';
    if (data.noGgmlAmxSet)  envStatus += '<code style="font-size:11px;color:var(--green)">GGML_NO_AMX=1</code> ';
    if (data.avx2OnlySet)   envStatus += '<code style="font-size:11px;color:var(--green)">OLLAMA_CPU_FEATURES=avx2</code> ';
    if (data.avx2RunnerSet) envStatus += '<code style="font-size:11px;color:var(--green)">OLLAMA_LLM_LIBRARY=cpu_avx2</code>';
    const envLine = envStatus
      ? `<div style="margin-top:6px;font-size:12px;color:var(--muted)">Active fixes: ${envStatus}</div>`
      : '';

    let guidance = '';
    if (data.hasAmx) {
      guidance = `<div style="margin-top:8px;padding:8px 10px;background:#1a1a0d;border:1px solid #713f12;border-radius:6px;font-size:12px;color:#fde68a;line-height:1.6">
        ⚠ AMX instructions detected — likely cause of segfaults in llama3 / gemma3:12b.<br>
        <strong>Step 1:</strong> Try updating Ollama to the latest version (⬆ Update Ollama).<br>
        <strong>Step 2:</strong> If still segfaulting and CPU supports AMX → apply <code>GGML_NO_AMX=1</code>.<br>
        <strong>Step 3:</strong> If CPU doesn't fully support AMX → apply <code>OLLAMA_NO_AMX=1</code>.
      </div>`;
      updateBtn.style.display = '';
      if (!data.noAmxSet)     fixBtn.style.display = '';
      if (!data.noGgmlAmxSet) ggmlFixBtn.style.display = '';
      if (!data.noAmxSet || !data.noGgmlAmxSet) bothFixBtn.style.display = '';
      if (!data.avx2OnlySet)   avx2FixBtn.style.display = '';
      if (!data.avx2RunnerSet) avx2RunnerBtn.style.display = '';
    } else {
      guidance = `<div style="margin-top:8px;font-size:12px;color:var(--green)">✓ No AMX features detected — CPU compatibility looks fine.</div>`;
    }

    // Memory limit row — always shown once container is found
    const gb = 1024 ** 3;
    const memLabel = data.memoryBytes === 0 ? 'unlimited' : `${Math.round(data.memoryBytes / gb)} GB`;
    document.getElementById('ollama-mem-current').textContent = memLabel;
    const sel = document.getElementById('ollama-mem-select');
    const knownVals = ['0', '8g', '12g', '16g', '24g', '32g'];
    const memKey = data.memoryBytes === 0 ? '0' : `${Math.round(data.memoryBytes / gb)}g`;
    sel.value = knownVals.includes(memKey) ? memKey : 'custom';
    if (sel.value === 'custom') {
      document.getElementById('ollama-mem-custom').style.display = '';
      document.getElementById('ollama-mem-custom').value = memKey;
    }
    document.getElementById('ollama-mem-row').style.display = 'flex';

    const anyFlagSet = data.noAmxSet || data.noGgmlAmxSet || data.avx2OnlySet || data.avx2RunnerSet;
    if (anyFlagSet) resetBtn.style.display = '';
    result.innerHTML = `<div style="margin-bottom:6px;font-size:12px;color:var(--muted)">CPU flags:</div>${flagsHtml}${envLine}${guidance}`;
  } catch (e) {
    result.innerHTML = `<span style="font-size:12px;color:var(--red)">Error: ${escHtml(e.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Check CPU Flags';
  }
}

async function _ollamaRestartAction(endpoint, envVar, btnId, label) {
  const btn    = document.getElementById(btnId);
  const result = document.getElementById('ollama-cpu-result');
  if (!confirm(`This will stop, remove, and recreate the Ollama container with ${envVar}. It will be unavailable for a few seconds. Continue?`)) return;
  btn.disabled = true;
  btn.textContent = '⟳ Restarting…';
  try {
    await api('POST', endpoint);
    toast(`Ollama restarted with ${envVar}`, 'success');
    result.innerHTML += `<div style="margin-top:8px;font-size:12px;color:var(--green)">✓ Done. Run Check again to confirm, then retry your model query. To make it permanent add <code>${envVar}</code> to your <code>.env</code>.</div>`;
    btn.style.display = 'none';
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function ollamaApplyAmxFix() {
  await _ollamaRestartAction('/api/admin/ollama/restart-no-amx', 'OLLAMA_NO_AMX=1', 'ollama-fix-btn', '⚡ Fix: OLLAMA_NO_AMX=1');
}

async function ollamaApplyGgmlAmxFix() {
  await _ollamaRestartAction('/api/admin/ollama/restart-no-ggml-amx', 'GGML_NO_AMX=1', 'ollama-ggml-fix-btn', '⚡ Fix: GGML_NO_AMX=1');
}

async function ollamaApplyBothAmxFix() {
  await _ollamaRestartAction('/api/admin/ollama/restart-no-both-amx', 'OLLAMA_NO_AMX=1 + GGML_NO_AMX=1', 'ollama-both-fix-btn', '⚡ Fix: Both AMX flags');
}

async function ollamaApplyAvx2Fix() {
  await _ollamaRestartAction('/api/admin/ollama/restart-avx2-only', 'OLLAMA_CPU_FEATURES=avx2', 'ollama-avx2-fix-btn', '⚡ Fix: AVX2 only');
}

async function ollamaApplyAvx2Runner() {
  await _ollamaRestartAction('/api/admin/ollama/restart-avx2-runner', 'OLLAMA_LLM_LIBRARY=cpu_avx2', 'ollama-avx2-runner-btn', '⚡ Fix: AVX2 runner');
}

async function ollamaResetFlags() {
  const btn    = document.getElementById('ollama-reset-btn');
  const result = document.getElementById('ollama-cpu-result');
  if (!confirm('Remove all CPU env var fixes and restart Ollama with defaults. Continue?')) return;
  btn.disabled = true;
  btn.textContent = '⟳ Resetting…';
  try {
    await api('POST', '/api/admin/ollama/reset-flags');
    toast('All CPU flags removed and Ollama restarted', 'success');
    result.innerHTML += '<div style="margin-top:8px;font-size:12px;color:var(--green)">✓ Flags cleared. Run Check CPU Flags again to verify.</div>';
    btn.style.display = 'none';
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↺ Reset All Flags';
  }
}

function ollamaMemSelectChanged() {
  const sel    = document.getElementById('ollama-mem-select');
  const custom = document.getElementById('ollama-mem-custom');
  custom.style.display = sel.value === 'custom' ? '' : 'none';
}

async function ollamaSetMemory() {
  const sel    = document.getElementById('ollama-mem-select');
  const custom = document.getElementById('ollama-mem-custom');
  const memory = sel.value === 'custom' ? custom.value.trim() : sel.value;
  if (!memory) { toast('Enter a memory value', 'error'); return; }
  if (!confirm(`Recreate Ollama container with memory limit: ${memory === '0' ? 'unlimited' : memory}?`)) return;
  try {
    const res = await api('POST', '/api/admin/ollama/set-memory', { memory });
    toast(res.message, 'success');
    document.getElementById('ollama-mem-current').textContent = memory === '0' ? 'unlimited' : memory;
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function ollamaUpdate() {
  const btn    = document.getElementById('ollama-update-btn');
  const result = document.getElementById('ollama-cpu-result');
  if (!confirm('This will pull ollama/ollama:latest and recreate the container. It may take a minute to download. Continue?')) return;
  btn.disabled = true;
  btn.textContent = '⟳ Updating…';
  try {
    await api('POST', '/api/admin/ollama/update');
    toast('Ollama updated to latest and restarted', 'success');
    result.innerHTML += '<div style="margin-top:8px;font-size:12px;color:var(--green)">✓ Ollama updated. Retry your model query — if it still segfaults, apply one of the env var fixes below.</div>';
    btn.disabled = false;
    btn.textContent = '⬆ Update Ollama';
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '⬆ Update Ollama';
  }
}

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
document.getElementById('add-modal').addEventListener('click',       e => { if (e.target===e.currentTarget) closeAddModal(); });
document.getElementById('import-modal').addEventListener('click',    e => { if (e.target===e.currentTarget) closeImportModal(); });
document.getElementById('backup-restore-modal').addEventListener('click', e => { if (e.target===e.currentTarget) closeBackupRestoreModal(); });
document.getElementById('log-viewer-modal').addEventListener('click', e => { if (e.target===e.currentTarget) closeLogViewer(); });
document.getElementById('add-user-modal').addEventListener('click',   e => { if (e.target===e.currentTarget) closeAddUserModal(); });
document.getElementById('edit-user-modal').addEventListener('click',  e => { if (e.target===e.currentTarget) closeEditUserModal(); });

/* ── Boot ─────────────────────────────────────────────────────────────────── */
loadCurrentUser().then(() => loadScripts());
refreshInterval = setInterval(() => {
  if (currentTab === 'scripts')    loadScripts();
  else if (currentTab === 'logs')  loadLogs();
  else if (currentTab === 'audit') loadAudit();
  else if (currentTab === 'admin') loadUsers();
}, 10000);

// ── Theme toggle ─────────────────────────────────────────────────────────────
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.getElementById('theme-toggle-btn').textContent = next === 'light' ? '🌙' : '☀';
  localStorage.setItem('theme', next);
}
(function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) btn.textContent = saved === 'light' ? '🌙' : '☀';
  });
})();

// ── HowTo modal ──────────────────────────────────────────────────────────────
function openHowTo()  { document.getElementById('howto-modal').classList.remove('hidden'); }
function closeHowTo() { document.getElementById('howto-modal').classList.add('hidden'); }

function showHowToTab(lang) {
  document.querySelectorAll('.howto-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.howto-panel').forEach(p => p.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('howto-' + lang).classList.add('active');
}

function howToCopy(text) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target;
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.style.color = 'var(--green)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1200);
  });
}

// ── Heartbeat quick-add ───────────────────────────────────────────────────────
function openHeartbeatModal() {
  // Open the standard Add Script modal pre-filled for the heartbeat test script
  openAddModal();
  document.getElementById('f-name').value      = 'heartbeat-test';
  document.getElementById('f-lang').value      = 'ruby';
  document.getElementById('f-repo').value      = 'https://github.com/DSerruya/dock_tools_test.git';
  document.getElementById('f-branch').value    = 'main';
  document.getElementById('f-entry').value     = 'ruby main.rb';
  document.getElementById('f-buildcmd').value  = '';
  // Trigger placeholder/hint update
  onBuildCmdChange();
  document.getElementById('f-entry').placeholder = 'ruby main.rb';
}
