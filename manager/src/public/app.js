/* ── State ─────────────────────────────────────────────────────────────────── */
let currentTab         = 'scripts';
let refreshInterval    = null;
let currentEventSource = null;
let autoScroll         = true;
let currentUser        = { username: 'anonymous', role: 'admin' };
let editingUsername    = null;   // for user management modal
let scriptModalMode    = 'add';  // 'add' | 'edit'
let editingScriptName  = null;   // name of script being edited

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
const TAB_INDEX = { scripts: 0, logs: 1, audit: 2, admin: 3 };

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
  else if (tab === 'admin') { loadUsers(); loadSystemVersion(); }
}

/* ── Role helpers ──────────────────────────────────────────────────────────── */
function isAdmin()   { return currentUser.role === 'admin'; }
function canWrite()  { return currentUser.role === 'admin' || currentUser.role === 'agent'; }
function canDelete() { return currentUser.role === 'admin'; }

async function loadCurrentUser() {
  try {
    currentUser = await api('GET', '/api/me');
    // Show admin tab only for admins
    document.getElementById('tab-admin-btn').style.display = isAdmin() ? '' : 'none';
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

function renderCard({ config, status, nextRun }) {
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

  const scheduleBlock = isScheduled ? `
    <div class="schedule-info">
      <div class="schedule-row">
        <span class="schedule-cron">${escHtml(config.schedule||'')}</span>
        <span>${nextRun ? timeUntil(nextRun) : '—'}</span>
      </div>
      ${describeCron(config.schedule) ? `<div style="color:var(--muted);font-size:11px;margin-top:3px">${describeCron(config.schedule)}</div>` : ''}
    </div>` : '';

  const writeActions = canWrite() ? (
    isScheduled
      ? `<button class="btn btn-ghost btn-sm" onclick="runNow('${config.name}')">▶ Run Now</button>`
      : `<button class="btn btn-ghost btn-sm" onclick="startScript('${config.name}')">▶ Start</button>
         <button class="btn btn-ghost btn-sm" onclick="stopScript('${config.name}')">⏹ Stop</button>
         <button class="btn btn-ghost btn-sm" onclick="restartScript('${config.name}')">↺ Restart</button>`
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
        <button class="btn btn-ghost btn-sm" onclick="downloadScript('${escHtml(config.name)}')" title="Download cloned repo as .tar.gz">⬇</button>
        ${deleteBtn}
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

async function downloadScript(name) {
  await triggerDownload(`/api/scripts/${encodeURIComponent(name)}/download`, `${name}.tar.gz`);
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
}

async function checkForUpdates() {
  const badge  = document.getElementById('sys-update-badge');
  const btn    = document.getElementById('sys-check-btn');
  badge.textContent  = 'Checking…';
  badge.style.color  = 'var(--muted)';
  btn.disabled       = true;

  try {
    const { sha: latest } = await api('GET', '/api/admin/update/latest-commit');

    if (_sysCommit === 'dev' || _sysCommit === latest) {
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

/* ── Add / Edit Script Modal ─────────────────────────────────────────────── */
function openAddModal() {
  scriptModalMode   = 'add';
  editingScriptName = null;
  resetForm();
  document.getElementById('script-modal-title').textContent  = 'Add Script';
  document.getElementById('script-modal-submit').textContent = 'Add Script';
  document.getElementById('f-name').disabled   = false;
  document.getElementById('f-name-hint').style.display = 'none';
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
  document.getElementById('add-modal').classList.remove('hidden');
}

function closeAddModal() {
  document.getElementById('add-modal').classList.add('hidden');
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

  const body = { language: lang, repo, branch, entryPoint: entry, runMode, env };
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
