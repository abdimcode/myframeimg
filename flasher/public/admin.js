// MyFrame Admin — login gate + build-package + audit query panel.
// Talks to the mock backend at whatever ?server= URL is given (default:
// http://<host>:8080).

import { assertSupported } from './browser-check.js';
if (!assertSupported()) throw new Error('unsupported browser');

import { t, applyDom, toggleLang } from './i18n.js';

// Vercel deploy: same-origin serverless functions live under /api.
// Local `vercel dev` also routes /api → api/*.mjs, so the same default works.
// The legacy `?server=` override is retained for hybrid setups.
const SERVER = (() => {
  const q = new URL(window.location.href).searchParams.get('server');
  if (q) return q.replace(/\/$/, '');
  const prefix = window.location.pathname.startsWith("/firmware") ? "/firmware/api" : "/api";
  return `${window.location.origin}${prefix}`;
})();
const TOKEN_KEY = 'myframe-admin-token';

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const box = $('adminLog');
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
  box.textContent += line;
  box.scrollTop = box.scrollHeight;
};

async function api(path, opts = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(SERVER + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${body.error || 'unknown'}`);
  return body;
}

// ── Login flow ──────────────────────────────────────────────
async function tryEnter() {
  const token = localStorage.getItem(TOKEN_KEY);
  return !!token;
}

function showPanel() {
  $('loginGate').classList.add('hidden');
  $('adminPanel').classList.remove('hidden');
  loadWorkorderOptions();
  loadFirmwareOptions();
  loadAuditWorkorderOptions();
  log(`Logged in · server ${SERVER}`);
}

function showLogin() {
  $('adminPanel').classList.add('hidden');
  $('loginGate').classList.remove('hidden');
  setTimeout(() => $('pwd').focus(), 50);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = $('pwd').value;
  const errBox = $('loginError');
  errBox.classList.add('hidden');
  try {
    const raw = await fetch(SERVER + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    const body = await raw.json().catch(() => ({}));
    if (raw.status === 429 || body.code === 'LOGIN_LOCKED') {
      throw new Error(t('admin.login.locked'));
    }
    if (!raw.ok) {
      // Show remaining attempts (rate-limit backend counts down from 5).
      const left = body.attemptsLeft ?? null;
      const msg = left != null
        ? t('admin.login.attempts_left', { n: left })
        : (body.error || t('admin.login.failed'));
      throw new Error(msg);
    }
    localStorage.setItem(TOKEN_KEY, body.token);
    showPanel();
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
  }
});

$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
});

// ── Data population ─────────────────────────────────────────
let _workorders = [];
async function loadWorkorderOptions() {
  // Fetch the list from the server (backed by the ordering system in prod;
  // seeded in-memory STATE in the mock). Falls back to a single default if
  // the server hasn't been reached yet.
  try {
    const body = await api('/admin/workorders');
    _workorders = body.workorders || [];
  } catch (e) {
    _workorders = [{ id: 'WO-DEV-0001', shortCode: 'DEV001' }];
    log(`Workorder list fetch failed (${e.message}) — using single default`);
  }
  const sel = $('woId');
  sel.innerHTML = '';
  // One-shot workorder policy: a workorder that already has a .myfw built
  // is displayed but not selectable — admin must click "新建工单 · Create
  // workorder" to make a fresh one. Prevents accidental quota resets.
  const anyBuildable = _workorders.some((w) => !w.hasPackage);
  for (const w of _workorders) {
    const opt = document.createElement('option');
    opt.value = w.id;
    const lic = w.license || {};
    if (w.hasPackage) {
      opt.textContent = `${w.id} · built ${lic.used || 0}/${lic.quota || 0} · read-only`;
      opt.disabled = true;
    } else {
      opt.textContent = `${w.id} · not built · ready to build`;
    }
    sel.appendChild(opt);
  }
  if (!anyBuildable) {
    const opt = document.createElement('option');
    opt.textContent = t('admin.build.no_free_wo');
    opt.disabled = true;
    opt.selected = true;
    sel.insertBefore(opt, sel.firstChild);
    // Guide the first-time operator toward the "New workorder" input —
    // otherwise they see all workorders greyed out and don't realise the
    // fix is to create a new one in the field just below.
    const newWoStatus = $('newWoStatus');
    if (newWoStatus && !newWoStatus.textContent) {
      newWoStatus.textContent = t('guide.empty_wo_hint');
      newWoStatus.style.color = 'var(--warn)';
    }
    setTimeout(() => { $('newWoId')?.focus(); }, 0);
  }
  // Auto-select the first buildable workorder so the form is immediately usable.
  const firstFree = _workorders.find((w) => !w.hasPackage);
  if (firstFree) sel.value = firstFree.id;
  // Mirror the same list into the audit dropdown so both stay in sync.
  const auditSel = $('auditWoId');
  if (auditSel) {
    const prev = auditSel.value;
    auditSel.innerHTML = '';
    for (const w of _workorders) {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.id;
      auditSel.appendChild(opt);
    }
    if (prev) auditSel.value = prev;
  }
  if (_workorders[0]) await loadWorkorderRules(_workorders[0].id);
  _syncBuildDownloadVisibility();
  _syncAuditDownloadVisibility();
}


// Stream a built workorder's .myfw package to the admin's local Downloads
// folder. Uses the same /package/<woId> endpoint the build-success CTA
// uses, so blob- and disk-backed packages both work via the authed path.
async function downloadWorkorderPackage(woId) {
  if (!woId || typeof woId !== 'string') return;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { showLogin(); return; }
  const btn = document.querySelector('#downloadMyfwBtn, #auditDownloadBtn');
  const prevLabel = btn ? btn.textContent : '';
  const prevDisabled = btn ? btn.disabled : false;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t('admin.build.downloading_myfw');
  }
  log(`Downloading ${woId}.myfw …`);
  try {
    const res = await fetch(`${SERVER}/package/${encodeURIComponent(woId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`.trim();
      try {
        const body = await res.json();
        if (body && body.error) msg = body.error;
      } catch (_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = woId + '.myfw';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    log(`✓ Downloaded ${woId}.myfw (${blob.size.toLocaleString()} B)`);
  } catch (e) {
    log(`✕ Download failed for ${woId}: ${e.message}`);
    alert(t('admin.build.download_failed', { msg: e.message }));
  } finally {
    if (btn) {
      btn.disabled = prevDisabled;
      btn.textContent = prevLabel || t('admin.build.download_myfw');
    }
  }
}

// Show the build-form Download button only when the selected workorder
// has a built .myfw package stored.
function _syncBuildDownloadVisibility() {
  const buildSel = $('woId');
  const btn = $('downloadMyfwBtn');
  if (!buildSel || !btn) return;
  const wid = buildSel.value;
  if (!wid) {
    btn.style.display = 'none';
    return;
  }
  const wo = (_workorders || []).find((w) => w.id === wid);
  btn.style.display = wo && wo.hasPackage ? '' : 'none';
}

// Show the audit-section Download button only when the audited workorder
// has a built package (license object present in the response).
function _syncAuditDownloadVisibility() {
  const btn = $('auditDownloadBtn');
  if (!btn) return;
  const wid = $('auditWoId')?.value;
  const wo = (_workorders || []).find((w) => w.id === wid);
  btn.style.display = wo && wo.hasPackage ? '' : 'none';
}

async function loadWorkorderRules(woId) {
  try {
    const wo = await api(`/workorder/${encodeURIComponent(woId)}`);
    const sel = $('snRule');
    sel.innerHTML = '';
    for (const r of wo.snRules || []) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.label || r.id} · ${r.template}`;
      sel.appendChild(opt);
    }
    // Auto-generate license id + set 7-day expiry.
    const nextLicId = `LIC-${new Date().toISOString().slice(0,10).replace(/-/g, '')}-${Math.floor(Math.random() * 900 + 100)}`;
    $('licenseId').value = nextLicId;
    if (!$('expiresAt').value) {
      const exp = new Date();
      exp.setDate(exp.getDate() + 7);
      $('expiresAt').value = exp.toISOString().slice(0, 10);
    }
  } catch (e) {
    log(`Load workorder failed: ${e.message}`);
  }
}
$('woId').addEventListener('change', () => { loadWorkorderRules($('woId').value); _syncBuildDownloadVisibility(); });

// Create a fresh workorder id — the one-shot policy in build-package.mjs
// rejects any rebuild attempt, so admin must POST a new id each batch.
async function createWorkorder() {
  const id = $('newWoId').value.trim();
  const status = $('newWoStatus');
  status.className = 'admin-form__status';
  if (!id) {
    status.className = 'admin-form__status error';
    status.textContent = t('admin.build.new_wo_missing');
    return;
  }
  status.textContent = t('admin.build.creating');
  try {
    const body = await api('/admin/workorders', {
      method: 'POST',
      body: JSON.stringify({ id, shortCode: id }),
    });
    status.className = 'admin-form__status success';
    status.textContent = `✓ ${body.id}`;
    log(`✓ Created workorder ${body.id}`);
    $('newWoId').value = '';
    await loadWorkorderOptions();
    $('woId').value = body.id;
    await loadWorkorderRules(body.id);
  } catch (e) {
    status.className = 'admin-form__status error';
    status.textContent = `✕ ${e.message}`;
    log(`✕ Create workorder failed: ${e.message}`);
    if (/401/.test(e.message)) showLogin();
  }
}
$('newWoBtn').addEventListener('click', createWorkorder);
$('newWoId').addEventListener('keydown', (e) => { if (e.key === 'Enter') createWorkorder(); });

// Build-form direct .myfw download (visible when the selected workorder has a built package).
$('downloadMyfwBtn')?.addEventListener('click', () => {
  const wid = $('woId')?.value;
  if (wid) downloadWorkorderPackage(wid);
});

// Suggest a fresh id: WO-YYYYMMDD-<seq>
function suggestNewWoId() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(Math.floor(Math.random() * 900) + 100);
  $('newWoId').placeholder = `WO-${today}-${seq}`;
}
suggestNewWoId();

async function loadFirmwareOptions(throwOnError = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(SERVER + '/firmwares', { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + await res.text());
    const body = await res.json();
    if (!Array.isArray(body.firmwares)) throw new Error('Invalid firmware list response');
    const firmwares = body.firmwares;
    // Build-package "固件" dropdown — every firmware, tagged by source.
    const sel = $('fwName');
    sel.innerHTML = '';
    for (const f of firmwares) {
      const opt = document.createElement('option');
      opt.value = f.id;
      const tag = f.source === 'blob' ? ' [uploaded]' : ' [built-in]';
      opt.textContent = f.label + tag;
      sel.appendChild(opt);
    }
    // Firmware manager list — same data with delete buttons for Blob-hosted.
    renderFirmwareManager(firmwares);
    log(`Firmware sources · ${firmwares.length} total (${firmwares.filter((f) => f.source === 'blob').length} uploaded, ${firmwares.filter((f) => f.source === 'disk').length} built-in)`);
  } catch (e) {
    log(`Firmware scan failed: ${e.message}`);
    if (throwOnError) throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Render the firmware-manager list card with per-row delete buttons.
function renderFirmwareManager(firmwares) {
  const box = $('fwManagerList');
  if (!box) return;
  box.innerHTML = '';
  if (firmwares.length === 0) {
    box.innerHTML = `<div style="color:var(--ink-500);font-size:13px;">${t('admin.fw.empty')}</div>`;
    return;
  }
  for (const f of firmwares) {
    const row = document.createElement('div');
    row.className = 'fw-manager__row';
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--paper-400)';
    const badge = f.source === 'blob'
      ? `<span style="background:var(--cinnabar-700);color:white;padding:2px 6px;border-radius:3px;font-size:11px;">uploaded</span>`
      : `<span style="background:var(--ink-500);color:white;padding:2px 6px;border-radius:3px;font-size:11px;">built-in</span>`;
    const sizeMb = (f.size / 1024 / 1024).toFixed(2);
    row.innerHTML = `
      ${badge}
      <span style="flex:1;font-family:monospace;font-size:13px;">${f.id}</span>
      <span style="color:var(--ink-500);font-size:12px;">${sizeMb} MB</span>
    `;
    if (f.deletable) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn--small';
      delBtn.style.cssText = 'background:transparent;border:1px solid var(--error);color:var(--error);';
      delBtn.textContent = t('admin.fw.delete');
      delBtn.addEventListener('click', () => deleteFirmware(f.id));
      row.appendChild(delBtn);
    }
    box.appendChild(row);
  }
}


// Direct-to-VPS-disk upload — POSTs raw .bin bytes straight to the local
// Node/Express runner, which streams them into public/firmware/<name> with
// no Blob CDN in the path.
//
// Flow:
//   1) admin.js  → POST /firmwares?name=xxx.bin?force=0|1
//                    headers: Authorization: Bearer <admin>, Content-Type: application/octet-stream
//                    body: file (File / Blob — Content-Length auto-set)
//   2) server    → pipes req → writeStream → public/firmware/<name>
//                  chmod 644, returns { ok, name, path, size }
//   3) admin.js  → refresh firmware list from server, auto-select new entry
//
// We use XMLHttpRequest rather than fetch because XHR exposes real
// upload-progress events (xhr.upload.onprogress); fetch's body stream
// doesn't progress-report reliably across browsers when the body is a
// File. There is no third-party CDN dependency in this path.
async function uploadFirmware(file) {
  const status = $('fwUploadStatus');
  status.className = 'admin-form__status';
  status.innerHTML = '<span class="progress-line">' +
    '<span class="progress-line__label">' + t('admin.fw.uploading', { name: file.name }) + '</span>' +
    '<progress class="progress-line__bar" max="100" value="0" style="width:180px;vertical-align:middle;margin:0 8px;"></progress>' +
    '<span class="progress-line__pct">0%</span></span>';
  const bar = status.querySelector('progress');
  const pct = status.querySelector('.progress-line__pct');

  const token = localStorage.getItem(TOKEN_KEY);
  const doUpload = (force) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = SERVER + '/firmwares?name=' + encodeURIComponent(file.name) + (force ? '&force=1' : '');
    xhr.open('POST', url);
    xhr.timeout = 360000;
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.round((e.loaded / e.total) * 100);
      bar.value = p;
      pct.textContent = p + '% \u00b7 ' + (e.loaded / 1024 / 1024).toFixed(2) + '/' + (e.total / 1024 / 1024).toFixed(2) + ' MB';
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!body.ok || body.name !== file.name || body.size !== file.size) {
          reject(new Error('Invalid upload completion response'));
          return;
        }
        resolve(body);
      } else {
        const err = new Error(body.error || ('HTTP ' + xhr.status + ': ' + xhr.responseText.slice(0, 500)));
        err.status = xhr.status;
        err.code = body.code;
        err.body = body;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onabort = () => reject(new Error('upload aborted'));
    xhr.ontimeout = () => reject(new Error('Upload timed out. Refresh firmware sources before retrying.'));
    xhr.send(file);
  });

  try {
    let result;
    try {
      result = await doUpload(false);
    } catch (e) {
      if (e.status === 409 && e.code === 'FIRMWARE_EXISTS') {
        const ex = e.body.existing || {};
        const msg = '\u56fa\u4ef6 ' + file.name + ' \u5df2\u5b58\u5728 (' + (ex.source || 'disk') + ', ' +
                    (ex.size / 1024 / 1024).toFixed(2) + ' MB, ' + (ex.mtimeIso || '?') + ')\u3002\n' +
                    'Firmware exists \u00b7 overwrite?';
        if (!confirm(msg)) throw new Error('user cancelled overwrite');
        bar.value = 0;
        result = await doUpload(true);
      } else {
        throw e;
      }
    }

    status.className = 'admin-form__status success';
    status.textContent = '\u2713 ' + file.name + ' \u00b7 ' + (result.size || file.size).toLocaleString() + ' B';
    log('\u2713 Uploaded firmware ' + file.name + ' (' + (result.size || file.size).toLocaleString() + ' B) \u2192 ' +
        (result.path || ('/firmware/' + file.name)));
    await loadFirmwareOptions(true);
    const fwSel = $('fwName');
    if (fwSel) {
      const opt = Array.from(fwSel.options).find((o) => o.value === file.name);
      if (opt) fwSel.value = file.name;
    }
  } catch (e) {
    status.className = 'admin-form__status error';
    status.textContent = '\u2715 ' + e.message;
    log('\u2715 Upload failed: ' + e.message);
    if (/401/.test(e.message)) showLogin();
  }
}

async function deleteFirmware(name) {
  if (!confirm(t('admin.fw.confirm_delete', { name }))) return;
  const status = $('fwUploadStatus');
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch(`${SERVER}/firmwares?name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    status.className = 'admin-form__status success';
    status.textContent = `✓ deleted ${name}`;
    log(`✓ Deleted firmware ${name}`);
    await loadFirmwareOptions();
  } catch (e) {
    status.className = 'admin-form__status error';
    status.textContent = `✕ ${e.message}`;
    log(`✕ Delete failed: ${e.message}`);
  }
}

// Wire the upload input (deferred until DOM ready).
setTimeout(() => {
  $('fwUploadInput')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!/\.bin$/i.test(f.name)) {
      log('✕ Only .bin files are accepted');
      return;
    }
    await uploadFirmware(f);
    e.target.value = '';   // reset so re-picking the same file re-fires
  });
}, 0);

// ── Audit query ────────────────────────────────────────────
async function loadAuditWorkorderOptions() {
  // Actual options are populated by loadWorkorderOptions (which also touches
  // the audit dropdown so both stay in sync). This hook just kicks off the
  // initial query once the dropdown has a value.
  await runAuditQuery();
}

// Audit table state — kept module-scoped so the header-click handler can
// re-render with a different sort without a fresh server round trip, and
// so the CSV export uses exactly what the operator sees on screen.
let _lastAuditRows = [];
let _lastAuditWo = null;
const _auditSort = { col: 'ts', dir: 'asc' };

function auditSortComparator(a, b) {
  const { col, dir } = _auditSort;
  const av = a[col] ?? '';
  const bv = b[col] ?? '';
  const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
  return dir === 'asc' ? cmp : -cmp;
}

function sortIndicator(col) {
  if (_auditSort.col !== col) return '';
  return _auditSort.dir === 'asc' ? '↑' : '↓';
}

// Export the currently-loaded audit rows as CSV. RFC-4180 quoting: any
// field containing " , or newline gets double-quoted and internal quotes
// doubled. Header row matches the on-screen columns.
function exportAuditCsv() {
  if (!_lastAuditRows.length) {
    log('Audit CSV: nothing to export');
    return;
  }
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['idx', 'ts', 'sn', 'mac', 'fwName', 'result', 'stage', 'error'];
  const rows = [..._lastAuditRows].sort(auditSortComparator).map((e, i) => [
    i + 1, e.ts ?? '', e.sn ?? '', e.mac ?? '', e.fwName ?? '',
    e._kind === 'ok' ? 'ok' : 'fail',
    e.stage ?? '', e.error ?? '',
  ]);
  const csv = [header, ...rows].map((r) => r.map(q).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${_lastAuditWo || 'audit'}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  log(`Audit CSV: exported ${_lastAuditRows.length} row(s) for ${_lastAuditWo}`);
}

async function runAuditQuery() {
  const wid = $('auditWoId').value || 'WO-DEV-0001';
  const summary = $('auditSummary');
  const table = $('auditTable');
  summary.textContent = t('admin.audit.querying');
  try {
    const body = await api(`/admin/audit/${encodeURIComponent(wid)}`);
    const lic = body.license || {};
    const quota = lic.quota || 0;
    const used = lic.used || 0;
    const remaining = Math.max(0, quota - used);
    summary.innerHTML = t('admin.status.remaining', {
      wo: body.workorderId,
      lic: lic.id || '-',
      fw: lic.fwName || '-',
      used, quota, remain: remaining,
    });

    // Merge success + failure rows so the table shows the full production
    // trace, not just the happy path. Failed burns were previously silent
    // in the UI even when they existed in `failures[]` — operators had no
    // way to see them without reading the raw JSON. Now every attempt
    // shows up with a ✓ / ✕ column and, for failures, the reason.
    const successes = (body.entries  || []).map((e) => ({ ...e, _kind: 'ok'   }));
    const failures  = (body.failures || []).map((e) => ({ ...e, _kind: 'fail' }));
    // Persist audit rows for CSV export + sort. Latest server payload
    // replaces whatever we had — audit is append-only so this is safe.
    _lastAuditRows = [...successes, ...failures];
    _lastAuditWo = body.workorderId;
    const all = [..._lastAuditRows].sort(auditSortComparator);

    if (all.length === 0) {
      table.innerHTML = `<tbody><tr><td colspan="7" class="admin-audit__empty">${t('admin.audit.empty')}</td></tr></tbody>`;
      log(`Audit ${wid}: 0 records (0 successes, 0 failures)`);
      return;
    }

    let html = `
      <thead><tr>
        <th data-sort="idx" style="cursor:pointer;user-select:none;">#</th>
        <th data-sort="ts"  style="cursor:pointer;user-select:none;">${t('admin.audit.col_time')} ${sortIndicator('ts')}</th>
        <th data-sort="sn"  style="cursor:pointer;user-select:none;">SN ${sortIndicator('sn')}</th>
        <th data-sort="mac" style="cursor:pointer;user-select:none;">MAC ${sortIndicator('mac')}</th>
        <th>${t('admin.audit.col_fw')}</th>
        <th data-sort="_kind" style="cursor:pointer;user-select:none;">${t('admin.audit.col_smoke')} ${sortIndicator('_kind')}</th>
        <th>${t('admin.audit.col_error') || 'Error'}</th>
      </tr></thead><tbody>
    `;
    all.forEach((e, i) => {
      const time = e.ts ? e.ts.replace('T', ' ').slice(0, 19) : '-';
      const okCls = e._kind === 'ok' ? 'ok' : 'fail';
      const okTxt = e._kind === 'ok' ? '✓' : '✕';
      const err  = e._kind === 'fail' ? `${e.stage ? `[${e.stage}] ` : ''}${e.error || '-'}` : '';
      const sn = e.sn ?? '-';
      const mac = e.mac ?? '-';
      html += `<tr>
        <td>${i + 1}</td>
        <td>${time}</td>
        <td class="sn" data-copy="${sn}" title="click to copy" style="cursor:copy;">${sn}</td>
        <td data-copy="${mac}" title="click to copy" style="cursor:copy;">${mac}</td>
        <td>${e.fwName ?? '-'}</td>
        <td class="${okCls}">${okTxt}</td>
        <td style="color:var(--ink-500);font-size:12px;">${err}</td>
      </tr>`;
    });
    html += '</tbody>';
    table.innerHTML = html;
    // Sort-header clicks — toggles asc/desc on the clicked column.
    table.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-sort');
        if (_auditSort.col === col) _auditSort.dir = _auditSort.dir === 'asc' ? 'desc' : 'asc';
        else { _auditSort.col = col; _auditSort.dir = col === 'ts' ? 'asc' : 'asc'; }
        runAuditQuery();
      });
    });
    // Click-to-copy on SN / MAC cells.
    table.querySelectorAll('td[data-copy]').forEach((td) => {
      td.addEventListener('click', async () => {
        const val = td.getAttribute('data-copy');
        try {
          await navigator.clipboard.writeText(val);
          const prev = td.textContent;
          td.textContent = '✓ copied';
          setTimeout(() => { td.textContent = prev; }, 900);
        } catch { /* clipboard unavailable */ }
      });
    });
    log(`Audit ${wid}: ${successes.length} ok · ${failures.length} fail`);
  } catch (e) {
    summary.textContent = '';
    table.innerHTML = `<tbody><tr><td colspan="7" class="admin-audit__empty" style="color:var(--error)">${t('admin.audit.failed')}: ${e.message}</td></tr></tbody>`;
    log(`Audit failed: ${e.message}`);
    if (/401/.test(e.message)) showLogin();
  }
}

// Wire the query button — using a fallback since DOMContentLoaded may have fired.
setTimeout(() => {
  $('auditRefreshBtn')?.addEventListener('click', runAuditQuery);
  $('auditWoId')?.addEventListener('change', () => { runAuditQuery(); _syncAuditDownloadVisibility(); });
  $('auditExportBtn')?.addEventListener('click', exportAuditCsv);
  $('auditDownloadBtn')?.addEventListener('click', () => {
    const wid = $('auditWoId')?.value;
    if (wid) downloadWorkorderPackage(wid);
  });
}, 0);

// Blob URL from the previous build — revoked before the next one runs, so
// admins repeatedly generating packages never accumulate 15 MB blob refs.
let _lastBuildBlobUrl = null;

// ── Build the .myfw ─────────────────────────────────────────
$('buildBtn').addEventListener('click', async () => {
  const btn = $('buildBtn');
  const status = $('buildStatus');
  status.className = 'admin-form__status';
  status.textContent = t('admin.build.working');
  btn.disabled = true;
  // Release the previous build's Blob URL immediately so its ~15 MB backing
  // buffer is eligible for GC before we start pulling the new package.
  if (_lastBuildBlobUrl) {
    URL.revokeObjectURL(_lastBuildBlobUrl);
    _lastBuildBlobUrl = null;
  }

  const payload = {
    workorderId: $('woId').value,
    licenseId:   $('licenseId').value || undefined,
    quota:       Number($('quota').value || 10),
    expiresAt:   ($('expiresAt').value ? new Date($('expiresAt').value).toISOString() : undefined),
    snRuleId:    $('snRule').value,
    fwName:      $('fwName').value,
    factoryId:   $('factoryId').value || 'F-DEMO',
  };
  log(`Building: ${JSON.stringify(payload)}`);

  try {
    const body = await api('/admin/build-package', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    log(`✓ Built · License ${body.licenseId} · ${body.packageBytes.toLocaleString()} B`);
    status.className = 'admin-form__status success';
    status.textContent = `✓ ${body.packageBytes.toLocaleString()} B · ${t('admin.build.downloading')}`;

    // Auto-trigger download with a streaming progress bar. The 302
    // redirect strips Content-Length across origins so we ask the
    // server for the Blob URL as JSON first, then fetch the Blob CDN
    // directly — that response DOES expose Content-Length and CORS
    // headers, which is what the ReadableStream reader needs to
    // compute a real percentage.
    try {
      status.innerHTML = `
        <span class="progress-line">
          <span class="progress-line__label">${t('admin.build.downloading')}</span>
          <progress class="progress-line__bar" max="100" value="0" style="width:180px;vertical-align:middle;margin:0 8px;"></progress>
          <span class="progress-line__pct">0%</span>
        </span>`;
      const dlBar = status.querySelector('progress');
      const dlPct = status.querySelector('.progress-line__pct');

      // Step 1 — get the direct Blob URL + expected size from the server.
      const meta = await api(`${body.downloadPath}?url=1`);
      if (!meta.url) throw new Error('server did not return blob URL');
      const expected = Number(meta.size || 0);

      // Step 2 — fetch the package. Public Blob URLs are CORS-enabled and
      // need no auth header; same-origin local-disk packages DO need the
      // admin bearer, which we attach only when the URL is relative (so a
      // cross-origin Blob URL never leaks the token).
      const token = localStorage.getItem(TOKEN_KEY);
      const r = await fetch(meta.url, meta.url.startsWith('/') ? { headers: { Authorization: 'Bearer ' + token } } : undefined);
      if (!r.ok) throw new Error(`${r.status}: ${await r.text().catch(() => '')}`);
      const clen = Number(r.headers.get('Content-Length') || 0);
      const total = clen || expected;   // fall back to server-reported size
      let received = 0;
      const chunks = [];
      if (r.body && r.body.getReader) {
        const reader = r.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          if (total > 0) {
            const p = Math.round((received / total) * 100);
            dlBar.value = p;
            dlPct.textContent = `${p}% · ${(received / 1024 / 1024).toFixed(2)}/${(total / 1024 / 1024).toFixed(2)} MB`;
          } else {
            dlBar.removeAttribute('value');   // indeterminate
            dlPct.textContent = `… ${(received / 1024 / 1024).toFixed(2)} MB`;
          }
        }
      }
      const blob = chunks.length
        ? new Blob(chunks, { type: 'application/octet-stream' })
        : await r.blob();
      const url = URL.createObjectURL(blob);
      _lastBuildBlobUrl = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${payload.workorderId}.myfw`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // 500 ms is enough for the browser to hand the download to the OS.
      // After that the object URL can go — its 15 MB backing buffer will
      // be reclaimed on the next GC pass and won't leak across rebuilds.
      setTimeout(() => {
        if (_lastBuildBlobUrl === url) {
          URL.revokeObjectURL(url);
          _lastBuildBlobUrl = null;
        }
      }, 500);
      log(`✓ Downloaded ${payload.workorderId}.myfw (${blob.size.toLocaleString()} B) · buffer released`);
      // CTA chain — first-time users don't know the next step after
      // download. Render a persistent link "next → open flasher" so the
      // path to burning is obvious. Query param carries the workorder
      // id; the .myfw already contains the bearer, so no token in URL.
      const flasherUrl = `${window.location.origin}/?workorder=${encodeURIComponent(payload.workorderId)}`;
      status.innerHTML = `<span class="progress-line" style="gap:6px;">
        <span class="progress-line__label" style="color:var(--success);font-weight:600;">${t('guide.next_open_flasher')}</span>
        <a href="${flasherUrl}" target="_blank" rel="noopener" class="btn btn--primary btn--small" style="margin-left:8px;">${t('admin.panel.open_flasher')}</a>
      </span>`;
      status.textContent = `✓ ${blob.size.toLocaleString()} B · ${t('admin.build.saved')}`;
      // Refresh workorder list + re-sync visibility (the just-built WO is now built=read-only).
      await loadWorkorderOptions();
      _syncBuildDownloadVisibility();
      _syncAuditDownloadVisibility();
    } catch (e) {
      log(`✕ Download failed: ${e.message}`);
      status.className = 'admin-form__status error';
      status.textContent = `✕ Download failed: ${e.message}`;
    }

    // Refresh audit table (quota resets to 0/N on rebuild).
    runAuditQuery();
    // Advance license id for the next build.
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    $('licenseId').value = `LIC-${now}-${Math.floor(Math.random() * 900 + 100)}`;
  } catch (e) {
    log(`✕ Build failed: ${e.message}`);
    status.className = 'admin-form__status error';
    // Surface the one-shot-workorder policy hint clearly — direct admin to
    // the "新建工单" input rather than leaving a generic 409 message.
    if (/WORKORDER_ALREADY_BUILT|already has a package/i.test(e.message)) {
      status.textContent = `✕ ${t('admin.build.new_wo')} — ${e.message}`;
      $('newWoId').focus();
    } else {
      status.textContent = `✕ ${e.message}`;
    }
    if (/401/.test(e.message)) {
      log('Session expired — please log in again');
      showLogin();
    }
  } finally {
    btn.disabled = false;
  }
});

// ── Language toggle (both login-gate and admin-panel buttons) ──
function wireLang() {
  applyDom();
  const buttons = [$('langBtn'), $('langBtnLogin')].filter(Boolean);
  const refreshLabels = () => buttons.forEach((b) => { b.textContent = t('lang.switch'); });
  refreshLabels();
  buttons.forEach((b) => b.addEventListener('click', () => toggleLang()));
  window.addEventListener('mff:lang-change', () => {
    applyDom();
    refreshLabels();
    if (!$('adminPanel').classList.contains('hidden')) runAuditQuery();
  });
}

// ── Boot ────────────────────────────────────────────────────
wireLang();
// Periodically refresh audit while panel is open — server-side burns show up
// within 5 s without a manual click.
setInterval(() => {
  // Only poll when the admin tab is visible AND the panel is on screen.
  // Vercel Functions are billed per invocation; auditing every 5 s while
  // the operator switched away wastes budget and pings Redis for nothing.
  if (document.visibilityState !== 'visible') return;
  if (!$('adminPanel').classList.contains('hidden')) runAuditQuery();
}, 5000);
// Refresh immediately when the tab comes back into focus so operators
// don't stare at 5-second-stale numbers after returning.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('adminPanel').classList.contains('hidden')) {
    runAuditQuery();
  }
});

if (await tryEnter()) {
  showPanel();
} else {
  showLogin();
}
