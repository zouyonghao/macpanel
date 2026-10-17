'use strict';

/* =============== Core utilities =============== */
let ME = null;               // {user, csrf}
let LAST_STATUS = null;      // status snapshot cache (charts use it for memory %)
let AI_HIST = [];            // AI chat history (frontend memory)
let timers = [];
const $ = s => document.querySelector(s);
const mainEl = () => document.getElementById('main');
// ts(): translate server-provided strings (apiErr, monitor last_error, probe
// detail); non-strings and values without a dictionary entry pass through.
const ts = s => (typeof s === 'string' ? t(s) : s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtBytes(n) {
  n = +n || 0;
  if (!isFinite(n) || n < 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}
const fmtBps = n => fmtBytes(n) + '/s';
function fmtUptime(sec) {
  sec = +sec || 0;
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return (d ? d + t(' d ') : '') + h + t(' h ') + m + t(' min');
}
function fmtTime(iso) {
  if (!iso || String(iso).startsWith('0001-')) return '-';
  const d = new Date(iso);
  return isNaN(d) ? '-' : d.toLocaleString(I18N.lang === 'en' ? 'en-US' : 'zh-CN', { hour12: false });
}
function toast(msg, type) {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + (type || '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3500);
}
function openModal(title, html) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  document.getElementById('modal-content').innerHTML = '';
}
function confirmGo(msg) { return window.confirm(msg); }

async function api(path, method, body, headers) {
  const opts = { method: method || 'GET', headers: {} };
  if (ME) opts.headers['X-Panel-CSRF'] = ME.csrf;
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  Object.assign(opts.headers, headers || {});
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (res.status === 401) { showLogin(); throw new Error(t('Not signed in')); }
  if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

const loadedScripts = {};
function loadScript(src) {
  if (loadedScripts[src]) return loadedScripts[src];
  loadedScripts[src] = new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => no(new Error(t('Failed to load: ') + src));
    document.head.appendChild(s);
  });
  return loadedScripts[src];
}

function every(ms, fn) { timers.push(setInterval(fn, ms)); fn(); }
function stopTimers() { timers.forEach(clearInterval); timers = []; }

/* =============== Login / setup =============== */
function showLogin() {
  stopTimers();
  document.getElementById('login-layer').classList.remove('hidden');
  document.getElementById('nav').classList.add('hidden');
  mainEl().classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  document.getElementById('setup-form').classList.add('hidden');
}
function showSetup() {
  document.getElementById('login-layer').classList.remove('hidden');
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('setup-form').classList.remove('hidden');
  document.getElementById('login-sub').textContent = t('First run: create an admin account');
}
function enterPanel() {
  document.getElementById('login-layer').classList.add('hidden');
  document.getElementById('nav').classList.remove('hidden');
  mainEl().classList.remove('hidden');
  document.getElementById('foot-user').textContent = t('Signed in: ') + ME.user;
  navigate();
}

/* =============== Routing =============== */
const routes = {
  dashboard: pageDashboard, links: pageLinks, services: pageServices, monitors: pageMonitors,
  cron: pageCron, ports: pagePorts, sites: pageSites, containers: pageContainers,
  apps: pageApps, terminal: pageTerminal, ai: pageAI, settings: pageSettings,
};
function navigate() {
  const hash = (location.hash || '#dashboard').slice(1).split('?')[0];
  const fn = routes[hash] || pageDashboard;
  document.querySelectorAll('aside a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + hash));
  disconnectTerm();
  stopTimers();
  mainEl().innerHTML = '<div class="muted">' + t('Loading…') + '</div>';
  fn();
}

/* =============== Charts =============== */
function drawChart(canvas, series, opts) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 110;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  let max = (opts && opts.max) || 0;
  if (!max) {
    for (const s of series) for (const v of s.data) if (v > max) max = v;
    max = max ? max * 1.15 : 1;
  }
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.fillStyle = '#5c6b8c';
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const y = 4 + i * (h - 22) / 2;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    const val = max * (1 - i / 2);
    ctx.fillText(opts && opts.fmt ? opts.fmt(val) : Math.round(val).toString(), 4, y > 14 ? y - 3 : y + 11);
  }
  for (const s of series) {
    let pts = s.data;
    const N = 240;
    if (pts.length > N) {
      const step = pts.length / N;
      pts = Array.from({ length: N }, (_, i) => s.data[Math.floor(i * step)]);
    }
    if (pts.length < 2) continue;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = i / (pts.length - 1) * w;
      const y = h - 16 - Math.min(Math.max(pts[i], 0), max) / max * (h - 24);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.globalAlpha = 0.10; ctx.fillStyle = s.color; ctx.fill(); ctx.globalAlpha = 1;
  }
}

/* =============== Dashboard =============== */
function pageDashboard() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Dashboard')}</h2><div class="right muted" id="dash-host"></div></header>
    <div class="cards" id="dash-cards"></div>
    <div class="panel" id="dash-links-panel" style="display:none;margin-top:14px"><h4>${t('Quick Links')}</h4><div class="cards" id="dash-links"></div></div>
    <div class="grid2" style="margin-top:14px">
      <div class="chartbox"><h4 id="t-cpu">CPU</h4><canvas class="chart" id="ch-cpu"></canvas></div>
      <div class="chartbox"><h4 id="t-mem">${t('Memory')}</h4><canvas class="chart" id="ch-mem"></canvas></div>
      <div class="chartbox"><h4 id="t-net">${t('Network')}</h4><canvas class="chart" id="ch-net"></canvas></div>
      <div class="chartbox"><h4 id="t-io">${t('Disk I/O')}</h4><canvas class="chart" id="ch-io"></canvas></div>
    </div>
    <div class="grid2" style="margin-top:14px">
      <div class="panel"><h4>${t('Disk mounts')}</h4><div id="dash-disks" class="tbl-wrap"></div></div>
      <div class="panel"><h4>${t('Top processes')}</h4><div id="dash-procs" class="tbl-wrap"></div></div>
    </div>`;
  every(3000, refreshStatus);
  every(5000, refreshHistory);
  loadDashLinks();
}
async function loadDashLinks() {
  const panel = document.getElementById('dash-links-panel');
  const box = document.getElementById('dash-links');
  if (!panel || !box) return;
  try {
    const d = await api('/api/links');
    const links = d.links || [];
    if (!links.length) return;
    panel.style.display = '';
    box.innerHTML = links.map(l => `
      <a class="card dash-link" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}">
        <span class="link-icon">${esc(l.icon || '🔗')}</span>
        <span class="link-body"><b>${esc(l.name)}</b>${l.group ? `<span class="link-url">${esc(l.group)}</span>` : ''}</span>
      </a>`).join('');
  } catch (e) { /* ignore */ }
}
async function refreshStatus() {
  try {
    const st = await api('/api/system/status');
    LAST_STATUS = st;
    const mem = st.mem || {};
    const memPct = mem.Total ? mem.Used / mem.Total * 100 : 0;
    const ld = st.load || {};
    const rd = st.root_disk || {};
    document.getElementById('dash-host').textContent =
      st.host ? `${st.host.hostname} · ${st.host.os} · ${st.host.kernel}` : '';
    document.getElementById('dash-cards').innerHTML = `
      <div class="card"><h3>CPU (${st.cpu_count || '-'} ${t('cores')})</h3><div class="big">${(st.cpu || 0).toFixed(1)}%</div>
        <div class="sub">${t('Load')} ${(+ld.one || 0).toFixed(2)} / ${(+ld.five || 0).toFixed(2)} / ${(+ld.fifteen || 0).toFixed(2)}</div></div>
      <div class="card"><h3>${t('Memory')}</h3><div class="big">${memPct.toFixed(1)}%</div>
        <div class="sub">${fmtBytes(mem.Used)} / ${fmtBytes(mem.Total)}${mem.SwapUsed ? ' · Swap ' + fmtBytes(mem.SwapUsed) : ''}</div></div>
      <div class="card"><h3>${t('Root disk')}</h3><div class="big">${(rd.usedPercent || 0).toFixed(1)}%</div>
        <div class="sub">${fmtBytes(rd.used)} / ${fmtBytes(rd.total)}</div></div>
      <div class="card"><h3>${t('Uptime')}</h3><div class="big" style="font-size:18px">${fmtUptime(st.uptime)}</div>
        <div class="sub">${t('Sampled at')} ${fmtTime(st.time)}</div></div>`;
    const disks = st.disks || [];
    document.getElementById('dash-disks').innerHTML = `<table>
      <tr><th>${t('Mount point')}</th><th>${t('Type')}</th><th>${t('Size')}</th><th>${t('Used')}</th></tr>` +
      disks.map(d => `<tr><td>${esc(d.mount)}</td><td>${esc(d.fstype)}</td>
        <td>${fmtBytes(d.total)}</td>
        <td>${(d.used_pct || 0).toFixed(1)}% <span class="muted">(${fmtBytes(d.used)})</span></td></tr>`).join('') +
      `</table>`;
    const procs = st.top_procs || [];
    document.getElementById('dash-procs').innerHTML = `<table>
      <tr><th>PID</th><th>${t('Process')}</th><th>CPU</th><th>${t('Memory')}</th></tr>` +
      (procs.length ? procs.map(p => `<tr><td>${p.pid}</td><td>${esc(p.name)}</td>
        <td>${(p.cpu || 0).toFixed(1)}%</td><td>${(p.mem_mb || 0).toFixed(0)} MB</td></tr>`).join('')
        : '<tr><td colspan="4" class="muted">' + t('Collecting…') + '</td></tr>') + `</table>`;
  } catch (e) { /* 401 already handled */ }
}
async function refreshHistory() {
  try {
    const h = await api('/api/system/history');
    const total = (LAST_STATUS && LAST_STATUS.mem && LAST_STATUS.mem.Total) || 0;
    const memPct = total ? h.mem_used.map(v => v / total * 100) : [];
    const cur = arr => arr.length ? arr[arr.length - 1] : 0;
    document.getElementById('t-cpu').textContent = 'CPU  ' + cur(h.cpu).toFixed(1) + '%';
    document.getElementById('t-mem').textContent = t('Memory') + '  ' + (total ? (cur(h.mem_used) / total * 100).toFixed(1) + '%' : '');
    document.getElementById('t-net').textContent = t('Network') + '  ↓' + fmtBps(cur(h.net_rx)) + '  ↑' + fmtBps(cur(h.net_tx));
    document.getElementById('t-io').textContent = t('Disk I/O') + '  ' + t('read ') + fmtBps(cur(h.disk_r)) + '  ' + t('write ') + fmtBps(cur(h.disk_w));
    drawChart(document.getElementById('ch-cpu'), [{ data: h.cpu, color: '#4f8cff' }], { max: 100 });
    drawChart(document.getElementById('ch-mem'), [{ data: memPct, color: '#9a6bff' }], { max: 100 });
    drawChart(document.getElementById('ch-net'), [
      { data: h.net_rx, color: '#34c77b' }, { data: h.net_tx, color: '#f0a132' }], { fmt: fmtBps });
    drawChart(document.getElementById('ch-io'), [
      { data: h.disk_r, color: '#4f8cff' }, { data: h.disk_w, color: '#f05a5a' }], { fmt: fmtBps });
  } catch (e) { /* ignore */ }
}

/* =============== Quick Links (navigation) =============== */
function linkCardHTML(l, withActions) {
  return `
    <div class="card link-card">
      <a class="link-main" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}">
        <span class="link-icon">${esc(l.icon || '🔗')}</span>
        <span class="link-body"><b>${esc(l.name)}</b><span class="link-url">${esc(l.url)}</span></span>
      </a>
      ${withActions ? `<div class="actions">
        <button class="small ghost" data-act="link-up" data-arg="${l.id}" title="${t('Move up')}">↑</button>
        <button class="small ghost" data-act="link-down" data-arg="${l.id}" title="${t('Move down')}">↓</button>
        <button class="small ghost" data-act="link-edit" data-id="${l.id}" data-icon="${esc(l.icon || '')}"
          data-name="${esc(l.name)}" data-url="${esc(l.url)}" data-group="${esc(l.group || '')}">${t('Edit')}</button>
        <button class="small danger" data-act="link-del" data-arg="${l.id}" data-name="${esc(l.name)}">${t('Delete')}</button>
      </div>` : ''}
    </div>`;
}
function pageLinks() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Quick Links')}</h2><div class="right">
      <button class="ghost small" data-act="links-refresh">${t('Refresh')}</button></div></header>
    <div class="panel"><h4 id="link-form-title">${t('Add link')}</h4>
      <form data-form="link-add">
        <input type="hidden" name="id" value="">
        <div class="form-row">
          <div style="flex:0;min-width:90px"><label>${t('Icon')}</label><input name="icon" maxlength="8" placeholder="🔗"></div>
          <div><label>${t('Name')}</label><input name="name" required placeholder="${t('e.g. Nextcloud')}"></div>
          <div style="flex:2"><label>URL</label><input name="url" type="url" required placeholder="https://cloud.example.com"></div>
          <div><label>${t('Group (optional)')}</label><input name="group" list="link-groups" placeholder="${t('e.g. WebDAV')}"><datalist id="link-groups"></datalist></div>
          <div style="flex:0;align-self:end"><button type="submit" id="link-submit">${t('Add')}</button></div>
        </div>
      </form></div>
    <div id="links-list"><div class="muted">${t('Loading…')}</div></div>`;
  loadLinks();
}
async function loadLinks() {
  const box = document.getElementById('links-list');
  if (!box) return;
  try {
    const d = await api('/api/links');
    const list = d.links || [];
    const groups = {};
    list.forEach(l => { (groups[l.group || ''] = groups[l.group || ''] || []).push(l); });
    const names = Object.keys(groups).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    box.innerHTML = names.length ? names.map(g => `
      <div class="panel"><h4>${g ? esc(g) : t('General')}</h4><div class="cards">
        ${groups[g].map(l => linkCardHTML(l, true)).join('')}
      </div></div>`).join('')
      : '<div class="tbl-wrap"><div class="muted" style="padding:14px">' + t('No links yet; add your first entry above') + '</div></div>';
    const dl = document.getElementById('link-groups');
    if (dl) dl.innerHTML = names.filter(Boolean).map(g => `<option value="${esc(g)}">`).join('');
  } catch (e) { box.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`; }
}
function resetLinkForm() {
  const f = document.querySelector('form[data-form=link-add]');
  if (!f) return;
  f.reset();
  f.querySelector('input[name=id]').value = '';
  document.getElementById('link-form-title').textContent = t('Add link');
  document.getElementById('link-submit').textContent = t('Add');
}

/* =============== Services =============== */
function pageServices() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Services')}</h2><div class="right">
      <button class="ghost small" data-act="svc-refresh">${t('Refresh')}</button></div></header>
    <div class="panel"><h4>${t('Homebrew services')}</h4><div id="svc-brew" class="tbl-wrap"><div class="muted">${t('Loading…')}</div></div></div>
    <div class="panel"><h4>${t('launchd services (LaunchAgents / LaunchDaemons)')}</h4>
      <div class="muted" style="margin-bottom:8px">${t('System-level LaunchDaemons need root; the panel can only manage user-level services')}</div>
      <div id="svc-launchd" class="tbl-wrap"><div class="muted">${t('Loading…')}</div></div></div>`;
  every(10000, () => { loadBrewServices(); loadLaunchd(); });
}
async function loadBrewServices() {
  const box = document.getElementById('svc-brew');
  if (!box) return;
  try {
    const d = await api('/api/services/brew');
    const list = d.services || [];
    box.innerHTML = `<table><tr><th>${t('Name')}</th><th>${t('Status')}</th><th>${t('User')}</th><th>${t('File')}</th><th>${t('Actions')}</th></tr>` +
      (list.length ? list.map(sv => `<tr>
        <td><b>${esc(sv.name)}</b></td>
        <td><span class="badge ${sv.running ? 'ok' : (sv.status === 'error' ? 'err' : '')}">${esc(sv.status)}</span></td>
        <td>${esc(sv.user)}</td><td>${esc(sv.file)}</td>
        <td class="actions">
          ${sv.running
            ? `<button class="small ghost" data-act="brewsvc" data-arg="restart" data-name="${esc(sv.name)}">${t('Restart')}</button>
               <button class="small ghost" data-act="brewsvc" data-arg="stop" data-name="${esc(sv.name)}">${t('Stop')}</button>`
            : `<button class="small" data-act="brewsvc" data-arg="start" data-name="${esc(sv.name)}">${t('Start')}</button>`}
          <button class="small ghost" data-act="brewsvc" data-arg="run" data-name="${esc(sv.name)}" title="${t('Run in foreground; not registered for auto-start')}">${t('Run')}</button>
        </td></tr>`).join('') : '<tr><td colspan="5" class="muted">' + t('No brew services') + '</td></tr>') + `</table>`;
  } catch (e) { box.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`; }
}
async function loadLaunchd() {
  const box = document.getElementById('svc-launchd');
  if (!box) return;
  try {
    const d = await api('/api/services/launchd');
    const list = (d.services || []).sort((a, b) => a.label.localeCompare(b.label));
    box.innerHTML = `<table><tr><th>Label</th><th>${t('Domain')}</th><th>${t('Status')}</th><th>${t('Program')}</th><th>${t('Flags')}</th><th>${t('Actions')}</th></tr>` +
      list.map(sv => {
        const manageable = sv.domain === 'user' || sv.domain === 'agent';
        return `<tr>
        <td><b>${esc(sv.label)}</b></td>
        <td><span class="badge">${sv.domain === 'user' ? t('User') : sv.domain === 'agent' ? t('System Agent') : t('System Daemon')}</span></td>
        <td>${sv.running ? `<span class="badge ok">${t('Running')} ${sv.pid}</span>` : (sv.last_exit ? `<span class="badge err">${t('Exit code')} ${sv.last_exit}</span>` : '<span class="badge">' + t('Not running') + '</span>')}</td>
        <td><code>${esc(sv.program)}</code></td>
        <td class="muted">${sv.keep_alive ? 'KeepAlive ' : ''}${sv.run_at_load ? 'RunAtLoad ' : ''}${sv.disabled ? 'Disabled' : ''}</td>
        <td class="actions">
          ${manageable ? `
            <button class="small ghost" data-act="launchd" data-arg="restart" data-name="${esc(sv.label)}">${t('Restart')}</button>
            ${sv.running
              ? `<button class="small ghost" data-act="launchd" data-arg="stop" data-name="${esc(sv.label)}">${t('Stop')}</button>`
              : `<button class="small" data-act="launchd" data-arg="start" data-name="${esc(sv.label)}">${t('Start')}</button>`}`
            : '<span class="muted">' + t('Read-only') + '</span>'}
        </td></tr>`;
      }).join('') + `</table>`;
  } catch (e) { box.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`; }
}

/* =============== Monitors =============== */
function pageMonitors() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Monitors')}</h2><div class="right"><button class="ghost small" data-act="mon-refresh">${t('Refresh')}</button></div></header>
    <div class="panel"><h4>${t('Add monitor')}</h4>
      <form data-form="mon-add">
        <div class="form-row">
          <div><label>${t('Name')}</label><input name="name" required placeholder="${t('e.g. Nextcloud')}"></div>
          <div><label>${t('Type')}</label>
            <select name="type" id="mon-type">
              <option value="port">${t('Port (host:port)')}</option>
              <option value="http">HTTP(S) URL</option>
              <option value="launchd">${t('launchd service label')}</option>
              <option value="process">${t('Process name (pgrep -f)')}</option>
            </select></div>
          <div><label>${t('Target')}</label><input name="target" required placeholder="192.168.64.4:80"></div>
          <div style="flex:0;align-self:end"><label>&nbsp;</label><button type="submit">${t('Add')}</button></div>
        </div>
      </form></div>
    <div id="mon-list" class="tbl-wrap"><div class="muted">${t('Loading…')}</div></div>`;
  document.getElementById('mon-type').addEventListener('change', e => {
    const ph = { port: '192.168.64.4:80', http: 'http://127.0.0.1:8083', launchd: 'com.example.app', process: 'rclone' };
    e.target.closest('form').querySelector('input[name=target]').placeholder = ph[e.target.value] || '';
  });
  every(15000, loadMonitors);
  loadMonitors();
}
async function loadMonitors() {
  const box = document.getElementById('mon-list');
  if (!box) return;
  try {
    const d = await api('/api/monitors');
    const list = d.monitors || [];
    box.innerHTML = `<table><tr><th>${t('Name')}</th><th>${t('Type')}</th><th>${t('Target')}</th><th>${t('Status')}</th><th>${t('Latency')}</th><th>${t('Last check')}</th><th>${t('Actions')}</th></tr>` +
      (list.length ? list.map(m => `<tr>
        <td><b>${esc(m.name)}</b></td>
        <td><span class="badge">${esc(m.type)}</span></td>
        <td><code>${esc(m.target)}</code></td>
        <td>${m.last_check && !String(m.last_check).startsWith('0001')
          ? (m.last_ok ? '<span class="badge ok">' + t('Up') + '</span>' : `<span class="badge err" title="${esc(ts(m.last_error))}">${t('Down')}</span>`)
          : '<span class="badge">' + t('Not checked') + '</span>'}</td>
        <td>${m.latency_ms ? m.latency_ms.toFixed(0) + ' ms' : '-'}</td>
        <td class="muted">${m.last_check && !String(m.last_check).startsWith('0001') ? fmtTime(m.last_check) : '-'}</td>
        <td class="actions">
          <button class="small ghost" data-act="mon-check" data-arg="${m.id}">${t('Check')}</button>
          ${m.type === 'launchd' ? `
            <button class="small ghost" data-act="mon-act" data-arg="${m.id}" data-a="restart" data-name="${esc(m.target)}">${t('Restart')}</button>
            <button class="small ghost" data-act="mon-act" data-arg="${m.id}" data-a="start" data-name="${esc(m.target)}">${t('Start')}</button>
            <button class="small ghost" data-act="mon-act" data-arg="${m.id}" data-a="stop" data-name="${esc(m.target)}">${t('Stop')}</button>` : ''}
          <button class="small ghost" data-act="mon-toggle" data-arg="${m.id}" data-on="${m.enabled ? '1' : ''}">${m.enabled ? t('Disable') : t('Enable')}</button>
          <button class="small danger" data-act="mon-del" data-arg="${m.id}" data-name="${esc(m.name)}">${t('Delete')}</button>
        </td></tr>`).join('') : '<tr><td colspan="7" class="muted">' + t('No monitors yet; enabled items are checked automatically every 60 seconds') + '</td></tr>') + `</table>`;
  } catch (e) { box.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`; }
}

/* =============== Cron jobs =============== */
function pageCron() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Cron Jobs')}</h2><div class="right">
      <span class="muted">${t('Auto-backed up to data/cron-backup/ before writing')}</span>
      <button class="ghost small" data-act="cron-refresh">${t('Refresh')}</button></div></header>
    <div class="panel"><h4 id="cron-form-title">${t('New job')}</h4>
      <form data-form="cron-add">
        <input type="hidden" name="index" value="-1">
        <div class="form-row">
          <div><label>${t('Schedule')}</label><input name="schedule" required placeholder="*/5 * * * *">
            <select id="cron-preset" class="muted" style="margin-top:4px">
              <option value="">${t('Common presets…')}</option>
              <option value="* * * * *">${t('Every minute')}</option>
              <option value="*/5 * * * *">${t('Every 5 minutes')}</option>
              <option value="0 * * * *">${t('Hourly')}</option>
              <option value="0 3 * * *">${t('Daily at 03:00')}</option>
              <option value="0 3 * * 0">${t('Sundays at 03:00')}</option>
            </select></div>
          <div style="flex:2"><label>${t('Command')}</label><input name="command" required placeholder="/usr/local/bin/rclone sync ..."></div>
          <div><label>${t('Note (optional)')}</label><input name="name" placeholder="${t('e.g. tvbox-bisync')}"></div>
          <div style="flex:0;align-self:end"><button type="submit" id="cron-submit">${t('Add')}</button></div>
        </div>
      </form></div>
    <div id="cron-list" class="tbl-wrap"><div class="muted">${t('Loading…')}</div></div>`;
  document.getElementById('cron-preset').addEventListener('change', e => {
    if (e.target.value) {
      const f = e.target.closest('form');
      f.querySelector('input[name=schedule]').value = e.target.value;
      e.target.value = '';
    }
  });
  loadCron();
}
async function loadCron() {
  const box = document.getElementById('cron-list');
  if (!box) return;
  try {
    const d = await api('/api/cron');
    const list = d.jobs || [];
    box.innerHTML = `<table><tr><th>${t('Schedule')}</th><th>${t('Command')}</th><th>${t('Note')}</th><th>${t('Status')}</th><th>${t('Actions')}</th></tr>` +
      (list.length ? list.map(j => `<tr>
        <td><code>${esc(j.schedule)}</code></td>
        <td><code>${esc(j.command)}</code></td>
        <td>${esc(j.name)}</td>
        <td>${j.enabled ? '<span class="badge ok">' + t('Enabled') + '</span>' : '<span class="badge warn">' + t('Disabled') + '</span>'}</td>
        <td class="actions">
          <button class="small ghost" data-act="cron-toggle" data-arg="${j.index}">${j.enabled ? t('Disable') : t('Enable')}</button>
          <button class="small ghost" data-act="cron-edit" data-arg="${j.index}"
            data-sched="${esc(j.schedule)}" data-cmd="${esc(j.command)}" data-name="${esc(j.name)}">${t('Edit')}</button>
          <button class="small danger" data-act="cron-del" data-arg="${j.index}">${t('Delete')}</button>
        </td></tr>`).join('') : '<tr><td colspan="5" class="muted">' + t('crontab is empty') + '</td></tr>') + `</table>`;
  } catch (e) { box.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`; }
}

/* =============== Ports =============== */
function pagePorts() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Ports')}</h2><div class="right">
      <button class="ghost small" data-act="ports-refresh">${t('Refresh')}</button></div></header>
    <div class="muted" style="margin-bottom:10px">${t('Hold ⌘ while clicking "Open" for a new window; configure names and URLs in Settings → Known services')}</div>
    <div id="ports-list" class="tbl-wrap"><div class="muted">${t('Loading…')}</div></div>`;
  every(8000, loadPorts);
  loadPorts();
}
async function loadPorts() {
  const box = document.getElementById('ports-list');
  if (!box) return;
  try {
    const d = await api('/api/system/ports');
    const list = d.ports || [];
    const host = location.hostname || '127.0.0.1';
    box.innerHTML = `<table><tr><th></th><th>${t('Port')}</th><th>${t('Listening')}</th><th>${t('Process')}</th><th>${t('Label')}</th><th>${t('Actions')}</th></tr>` +
      list.map(p => {
        const url = 'http://' + host + ':' + p.port;
        return `<tr>
        <td><button class="small ghost" data-act="port-fav" data-arg="${p.port}" data-on="${p.fav ? '1' : ''}"
          title="${t('Favorite this port')}">${p.fav ? '★' : '☆'}</button></td>
        <td><b>${p.port}</b></td><td>${esc(p.addr)}</td>
        <td>${esc(p.process)} <span class="muted">(${p.pid})</span></td>
        <td>${p.known ? `<span class="badge ok">${esc(p.known)}</span>` : ''}</td>
        <td class="actions">
          <a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">${t('Open')}</a>
          <button class="small ghost" data-act="port-probe" data-arg="${p.port}">${t('Probe')}</button>
        </td></tr>`;
      }).join('') + `</table>`;
  } catch (e) { box.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`; }
}

/* =============== Sites (Caddy) =============== */
function pageSites() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Sites')}</h2><div class="right">
      <span id="caddy-badge"></span>
      <button class="small" data-act="caddy-act" data-arg="install">${t('Install Caddy')}</button>
      <button class="small ghost" data-act="caddy-act" data-arg="start">${t('Start')}</button>
      <button class="small ghost" data-act="caddy-act" data-arg="restart">${t('Restart')}</button>
      <button class="small ghost" data-act="caddy-act" data-arg="stop">${t('Stop')}</button>
      <button class="ghost small" data-act="sites-refresh">${t('Refresh')}</button></div></header>
    <div class="panel"><h4 id="site-form-title">${t('Add site')}</h4>
      <form data-form="site-add">
        <div class="form-row">
          <div><label>${t('Domain')}</label><input name="domain" required placeholder="${t('app.example.com or *:8443')}"></div>
          <div><label>${t('Type')}</label>
            <select name="type" id="site-type">
              <option value="proxy">${t('Reverse proxy')}</option>
              <option value="static">${t('Static site')}</option>
            </select></div>
          <div><label id="site-target-label">${t('Target (127.0.0.1:port)')}</label><input name="target" required placeholder="127.0.0.1:8083"></div>
        </div>
        <div class="form-row">
          <div><label>TLS</label>
            <select name="tls" id="site-tls">
              <option value="none">${t('None (HTTP only)')}</option>
              <option value="internal">${t('internal (Caddy self-signed CA, trusted on LAN only)')}</option>
              <option value="files">${t('Certificate files (issued by acme.sh)')}</option>
            </select></div>
          <div class="hidden site-tls-files"><label>${t('Certificate path')}</label><input name="cert" placeholder="~/.acme.sh/xx/fullchain.cer"></div>
          <div class="hidden site-tls-files"><label>${t('Private key path')}</label><input name="key" placeholder="~/.acme.sh/xx/xx.key"></div>
          <div style="flex:0;align-self:end"><label style="display:inline;vertical-align:middle">
            <input type="checkbox" name="enabled" checked style="width:auto"> ${t('Enabled')}</label></div>
          <div style="flex:0;align-self:end"><button type="submit" id="site-submit">${t('Save & sync Caddy')}</button></div>
        </div>
      </form></div>
    <div id="sites-list" class="tbl-wrap"><div class="muted">${t('Loading…')}</div></div>`;
  document.getElementById('site-type').addEventListener('change', e => {
    const proxy = e.target.value === 'proxy';
    document.getElementById('site-target-label').textContent = proxy ? t('Target (127.0.0.1:port)') : t('Static directory (absolute path)');
    e.target.closest('form').querySelector('input[name=target]').placeholder = proxy ? '127.0.0.1:8083' : '/Users/zyh/Sites/blog';
  });
  document.getElementById('site-tls').addEventListener('change', e => {
    document.querySelectorAll('.site-tls-files').forEach(el => el.classList.toggle('hidden', e.target.value !== 'files'));
  });
  loadSites();
}
async function loadSites() {
  const box = document.getElementById('sites-list');
  const badge = document.getElementById('caddy-badge');
  if (!box) return;
  try {
    const d = await api('/api/sites');
    if (badge) badge.innerHTML = d.caddy_installed
      ? (d.caddy_running ? '<span class="badge ok">' + t('Caddy running') + '</span>' : '<span class="badge warn">' + t('Caddy installed, not running') + '</span>')
      : '<span class="badge">' + t('Caddy not installed') + '</span>';
    const list = d.sites || [];
    box.innerHTML = `<table><tr><th>${t('Domain')}</th><th>${t('Type')}</th><th>${t('Target')}</th><th>TLS</th><th>${t('Status')}</th><th>${t('Actions')}</th></tr>` +
      (list.length ? list.map(s => `<tr>
        <td><b>${esc(s.domain)}</b></td>
        <td>${s.type === 'proxy' ? t('Proxy') : t('Static')}</td>
        <td><code>${esc(s.target)}</code></td>
        <td>${esc(s.tls || 'none')}</td>
        <td>${s.enabled ? '<span class="badge ok">' + t('Enabled') + '</span>' : '<span class="badge warn">' + t('Off') + '</span>'}</td>
        <td class="actions">
          <button class="small ghost" data-act="site-edit" data-domain="${esc(s.domain)}" data-type="${esc(s.type)}"
            data-target="${esc(s.target)}" data-tls="${esc(s.tls || 'none')}" data-cert="${esc(s.cert || '')}"
            data-key="${esc(s.key || '')}" data-enabled="${s.enabled ? '1' : ''}">${t('Edit')}</button>
          <button class="small danger" data-act="site-del" data-arg="${esc(s.domain)}">${t('Delete')}</button>
        </td></tr>`).join('') : '<tr><td colspan="6" class="muted">' + t('No sites yet; saving a site generates the Caddyfile and hot-reloads it') + '</td></tr>') + `</table>`;
  } catch (e) { box.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`; }
}

/* =============== Containers =============== */
function pageContainers() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Containers (Apple container)')}</h2><div class="right">
      <button class="ghost small" data-act="ct-refresh">${t('Refresh')}</button></div></header>
    <div class="panel"><h4>${t('Create container')}</h4>
      <form data-form="ct-run">
        <div class="form-row">
          <div><label>${t('Name')}</label><input name="name" required placeholder="my-redis"></div>
          <div style="flex:2"><label>${t('Image')}</label><input name="image" required placeholder="docker.m.daocloud.io/library/redis:7"></div>
        </div>
        <div class="form-row">
          <div><label>${t('Port mapping (comma-separated host:container)')}</label><input name="ports" placeholder="6379:6379"></div>
          <div><label>${t('Env vars K=V (comma-separated)')}</label><input name="env" placeholder="TZ=Asia/Shanghai"></div>
          <div><label>${t('Mounts /host:/cont (comma-separated)')}</label><input name="mounts" placeholder="/Users/zyh/data:/data"></div>
          <div style="flex:0;align-self:end"><button type="submit">${t('Create')}</button></div>
        </div>
      </form></div>
    <div id="ct-list" class="tbl-wrap"><div class="muted">${t('Loading…')}</div></div>
    <div class="panel" style="margin-top:14px"><h4>${t('Images')}</h4><div id="ct-images" class="muted">-</div></div>`;
  every(8000, () => { loadContainers(); });
  loadContainers(); loadImages();
}
async function loadContainers() {
  const box = document.getElementById('ct-list');
  if (!box) return;
  try {
    const d = await api('/api/container/list');
    const list = d.containers || [];
    box.innerHTML = `<table><tr><th>${t('Name')}</th><th>${t('Image')}</th><th>${t('Status')}</th><th>IP</th><th>${t('Ports')}</th><th>${t('Resources')}</th><th>${t('Actions')}</th></tr>` +
      (list.length ? list.map(c => {
        const running = c.state === 'running';
        return `<tr>
        <td><b>${esc(c.id)}</b></td><td><code>${esc(c.image)}</code></td>
        <td><span class="badge ${running ? 'ok' : ''}">${esc(c.state)}</span></td>
        <td>${esc(c.ip || '-')}</td>
        <td>${(c.ports || []).map(esc).join('<br>') || '-'}</td>
        <td class="muted">${c.cpus || '?'} CPU / ${c.mem_mb || '?'} MB</td>
        <td class="actions">
          ${running
            ? `<button class="small ghost" data-act="ct" data-arg="stop" data-name="${esc(c.id)}">${t('Stop')}</button>
               <button class="small ghost" data-act="ct" data-arg="restart" data-name="${esc(c.id)}">${t('Restart')}</button>`
            : `<button class="small" data-act="ct" data-arg="start" data-name="${esc(c.id)}">${t('Start')}</button>`}
          <button class="small ghost" data-act="ct-logs" data-arg="${esc(c.id)}">${t('Logs')}</button>
          <button class="small danger" data-act="ct-del" data-arg="${esc(c.id)}">${t('Delete')}</button>
        </td></tr>`;
      }).join('') : '<tr><td colspan="7" class="muted">' + t('No containers') + '</td></tr>') + `</table>`;
  } catch (e) { box.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`; }
}
async function loadImages() {
  const box = document.getElementById('ct-images');
  if (!box) return;
  try {
    const d = await api('/api/container/images');
    const imgs = d.images || [];
    box.innerHTML = imgs.length
      ? imgs.map(i => `<span class="badge">${esc(i.reference || JSON.stringify(i))}</span>`).join(' ')
      : t('No images');
  } catch (e) { box.textContent = t('Failed to fetch image list: ') + ts(e.message); }
}
function watchLogs(id) {
  window._ctLogId = id;
  openModal(t('Container logs: ') + id, '<pre class="log" id="ct-log-pre">' + t('Loading…') + '</pre>' +
    '<div style="margin-top:8px"><button class="small ghost" data-act="ct-logs-refresh">' + t('Refresh') + '</button></div>');
  refreshLogs();
}
async function refreshLogs() {
  const id = window._ctLogId;
  const pre = document.getElementById('ct-log-pre');
  if (!id || !pre) return;
  try {
    const d = await api('/api/container/logs?id=' + encodeURIComponent(id));
    pre.textContent = (d.logs || []).join('\n') || t('(no logs)');
    pre.scrollTop = pre.scrollHeight;
  } catch (e) { pre.textContent = ts(e.message); }
}

/* =============== App store =============== */
function pageApps() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Apps')}</h2><div class="right">
      <button class="ghost small" data-act="apps-refresh">${t('Refresh')}</button></div></header>
    <div class="panel"><h4>${t('Container apps')}</h4><div class="cards" id="apps-ctr"><div class="muted">${t('Loading…')}</div></div></div>
    <div class="panel"><h4>${t('Homebrew apps')}</h4><div class="cards" id="apps-brew"><div class="muted">${t('Loading…')}</div></div></div>
    <div class="panel"><h4>${t('Homebrew package management')}</h4>
      <form data-form="brew-search"><div class="form-row">
        <div><input name="q" placeholder="${t('Search brew packages, e.g. redis')}" required></div>
        <div style="flex:0;align-self:end"><button type="submit">${t('Search')}</button></div>
      </div></form>
      <div id="brew-results" style="margin-top:10px"></div>
      <hr class="hr">
      <div class="flex" style="margin-bottom:8px">
        <h4 style="margin:0">${t('Installed')} (<span id="brew-count">-</span>)</h4>
        <button class="small ghost" data-act="brew-installed-refresh">${t('Refresh list')}</button>
      </div>
      <div id="brew-installed" class="muted">${t('Loading…')}</div>
    </div>`;
  loadApps(); loadBrewInstalled();
}
async function loadApps() {
  const brewBox = document.getElementById('apps-brew');
  const ctrBox = document.getElementById('apps-ctr');
  if (!brewBox) return;
  try {
    const d = await api('/api/apps');
    ctrBox.innerHTML = (d.container || []).map(a => `
      <div class="card"><h3>${esc(a.name)}</h3>
        <div class="muted" style="min-height:34px">${esc(a.desc)}</div>
        <div class="muted" style="margin:6px 0">${t('Ports: ')}${(a.ports || []).join(', ') || '-'}</div>
        ${a.installed
          ? '<span class="badge ok">' + t('Installed') + '</span>'
          : `<button class="small" data-act="app-install-ctr" data-arg="${esc(a.id)}" data-name="${esc(a.name)}">${t('Install')}</button>`}
      </div>`).join('') || '<div class="muted">' + t('None') + '</div>';
    brewBox.innerHTML = (d.brew || []).map(a => `
      <div class="card"><h3>${esc(a.name)}</h3>
        <div class="muted" style="min-height:34px">${esc(a.desc)}</div>
        <div class="muted" style="margin:6px 0">${a.service ? t('brew service: ') + esc(a.service) : t('CLI tool, no service')}</div>
        ${a.installed
          ? '<span class="badge ok">' + t('Installed') + '</span>'
          : `<button class="small" data-act="app-install-brew" data-arg="${esc(a.id)}" data-name="${esc(a.name)}">${t('Install')}</button>`}
      </div>`).join('') || '<div class="muted">' + t('None') + '</div>';
  } catch (e) {
    brewBox.innerHTML = ctrBox.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`;
  }
}
async function loadBrewInstalled() {
  const box = document.getElementById('brew-installed');
  const cnt = document.getElementById('brew-count');
  if (!box) return;
  try {
    const d = await api('/api/brew/installed');
    const pkgs = d.packages || [];
    if (cnt) cnt.textContent = pkgs.length;
    box.innerHTML = `<table><tr><th>${t('Package')}</th><th>${t('Version')}</th><th>${t('Actions')}</th></tr>` +
      pkgs.map(p => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.version)}</td>
        <td class="actions">
          <button class="small ghost" data-act="brew-info" data-arg="${esc(p.name)}">${t('Details')}</button>
          <button class="small ghost" data-act="brew-upgrade" data-arg="${esc(p.name)}">${t('Upgrade')}</button>
          <button class="small danger" data-act="brew-uninstall" data-arg="${esc(p.name)}">${t('Uninstall')}</button>
        </td></tr>`).join('') + `</table>`;
  } catch (e) { box.innerHTML = esc(ts(e.message)); }
}
async function brewSearch(q) {
  const box = document.getElementById('brew-results');
  box.innerHTML = '<div class="muted">' + t('Searching…') + '</div>';
  try {
    const d = await api('/api/brew/search?q=' + encodeURIComponent(q));
    const rs = d.results || [];
    box.innerHTML = rs.length
      ? `<table><tr><th>${t('Package')}</th><th>${t('Actions')}</th></tr>` + rs.map(n => `<tr><td><b>${esc(n)}</b></td>
          <td class="actions">
            <button class="small ghost" data-act="brew-info" data-arg="${esc(n)}">${t('Details')}</button>
            <button class="small" data-act="brew-install" data-arg="${esc(n)}">${t('Install')}</button>
          </td></tr>`).join('') + `</table>`
      : '<div class="muted">' + t('No results') + '</div>';
  } catch (e) { box.innerHTML = `<div class="muted">${esc(ts(e.message))}</div>`; }
}
function brewInfo(name) {
  api('/api/brew/info?name=' + encodeURIComponent(name))
    .then(d => openModal('brew info: ' + name, '<pre class="log">' + esc(d.info) + '</pre>'))
    .catch(e => toast(ts(e.message), 'err'));
}

/* =============== Terminal =============== */
let term = null, termWS = null;
const termRO = new ResizeObserver(() => fitTerm());
function disconnectTerm() {
  if (termWS) { try { termWS.close(); } catch (e) {} termWS = null; }
  if (term) { try { term.dispose(); } catch (e) {} term = null; }
}
async function pageTerminal() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Terminal')}</h2><div class="right">
      <select id="term-preset">
        <option value="">${t('— Quick commands —')}</option>
        <option value="ssh root@192.168.31.1">${t('SSH to OpenWrt router')}</option>
        <option value="crontab -l">${t('View crontab')}</option>
        <option value="container ls --all">${t('List containers')}</option>
        <option value="brew services list">${t('brew services')}</option>
        <option value="launchctl list | head -30">${t('launchd list')}</option>
      </select>
      <button class="ghost small" data-act="term-reconnect">${t('Reconnect')}</button>
    </div></header>
    <div class="termbox" id="termbox"></div>`;
  document.getElementById('term-preset').addEventListener('change', e => {
    const cmd = e.target.value;
    if (!cmd) return;
    e.target.value = '';
    if (termWS && termWS.readyState === 1) { termWS.send(cmd); termWS.send('\r'); }
    else toast(t('Terminal not connected'), 'err');
  });
  try {
    await loadScript('/assets/xterm.min.js');
  } catch (e) {
    document.getElementById('termbox').innerHTML = '<div class="muted" style="padding:20px">' + t('Failed to load xterm.js: ') + esc(e.message) + '</div>';
    return;
  }
  connectTerm();
}
function connectTerm() {
  const box = document.getElementById('termbox');
  if (!box || typeof Terminal === 'undefined') return;
  disconnectTerm();
  term = new Terminal({
    cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, Monaco, monospace',
    theme: { background: '#0a0e18', foreground: '#c9d6f2', cursor: '#4f8cff' },
    scrollback: 5000,
  });
  term.open(box);
  termRO.observe(box);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  termWS = new WebSocket(proto + location.host + '/api/terminal');
  termWS.binaryType = 'arraybuffer';
  term.onData(d => { if (termWS && termWS.readyState === 1) termWS.send(d); });
  term.onResize(({ cols, rows }) => {
    if (termWS && termWS.readyState === 1) termWS.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
  termWS.onopen = () => { term.focus(); fitTerm(); };
  termWS.onmessage = ev => {
    if (term) term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  };
  termWS.onclose = () => { if (term) term.write('\r\n\x1b[33m' + t('[Disconnected — click "Reconnect"]') + '\x1b[0m\r\n'); };
}
function fitTerm() {
  const box = document.getElementById('termbox');
  if (!box || !term) return;
  const cols = Math.floor(box.clientWidth / 9);
  const rows = Math.floor(box.clientHeight / 17);
  if (cols > 4 && rows > 2 && (term.cols !== cols || term.rows !== rows)) {
    try { term.resize(cols, rows); } catch (e) {}
  }
}

/* =============== AI =============== */
function pageAI() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('AI Assistant')}</h2><div class="right">
      <button class="ghost small" data-act="ai-clear">${t('Clear chat')}</button></div></header>
    <details class="panel" id="ai-settings-panel">
      <summary style="cursor:pointer;font-size:13px">${t('AI settings (DeepSeek / OpenAI compatible)')}</summary>
      <form data-form="ai-settings" style="margin-top:10px">
        <div class="form-row">
          <div><label>Base URL</label><input name="base_url" id="ai-base" placeholder="https://api.deepseek.com"></div>
          <div><label>Model</label><input name="model" id="ai-model" placeholder="deepseek-chat"></div>
          <div><label>API Key <span class="muted" id="ai-key-hint"></span></label><input name="key" type="password" placeholder="${t('Leave blank to keep unchanged')}"></div>
          <div style="flex:0;align-self:end"><button type="submit">${t('Save settings')}</button></div>
        </div>
      </form>
    </details>
    <div class="chat">
      <div class="msgs" id="ai-msgs"><div class="msg ai">${t('Hi! I am the AI ops assistant built into this panel. Tick "Attach system snapshot" below to let me answer based on live server status.')}</div></div>
      <form class="input" data-form="ai-chat">
        <label style="display:inline;white-space:nowrap;align-self:center">
          <input type="checkbox" id="ai-diag" checked style="width:auto"> ${t('Attach system snapshot')}</label>
        <textarea id="ai-input" placeholder="${t('Ask something, e.g.: Is memory usage OK? Which services are running?')}"></textarea>
        <button type="submit" id="ai-send" style="align-self:flex-end">${t('Send')}</button>
      </form>
    </div>`;
  api('/api/ai/settings').then(d => {
    document.getElementById('ai-base').value = d.base_url || '';
    document.getElementById('ai-model').value = d.model || '';
    document.getElementById('ai-key-hint').textContent = d.key_set ? (t('Set (') + d.key_masked + ')') : t('Not set');
  }).catch(() => {});
}
function addMsg(role, text) {
  const box = document.getElementById('ai-msgs');
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}
async function aiSend(text) {
  const el = addMsg('ai', '…');
  const diagnose = document.getElementById('ai-diag').checked;
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel-CSRF': ME.csrf },
      body: JSON.stringify({ messages: AI_HIST.slice(-12), diagnose }),
    });
    if (!res.ok) {
      let d = null;
      try { d = await res.json(); } catch (e) {}
      throw new Error((d && d.error) || ('HTTP ' + res.status));
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', acc = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
          if (delta) { acc += delta; el.textContent = acc; }
        } catch (e) { /* ignore heartbeat chunks */ }
      }
    }
    if (!acc) el.textContent = t('(empty reply)');
    else AI_HIST.push({ role: 'assistant', content: acc });
  } catch (e) { el.textContent = t('Error: ') + ts(e.message); }
}

/* =============== Settings =============== */
function pageSettings() {
  mainEl().innerHTML = `
    <header class="top"><h2>${t('Settings')}</h2></header>
    <div class="panel"><h4>${t('Change password')}</h4>
      <form data-form="pass-change"><div class="form-row">
        <div><label>${t('Old password')}</label><input name="old" type="password" required></div>
        <div><label>${t('New password (at least 10 characters)')}</label><input name="new" type="password" required minlength="10"></div>
        <div style="flex:0;align-self:end"><button type="submit">${t('Change')}</button></div>
      </div></form></div>
    <div class="panel"><h4>${t('Security / Network')}</h4>
      <div class="muted" style="margin-bottom:8px" id="sec-entrance-hint"></div>
      <form data-form="security"><div class="form-row">
        <div><label>${t('Entrance path (secret prefix, anti-scanning)')}</label><input name="entrance" id="sec-entrance"></div>
        <div><label>${t('Listen address (restart to apply)')}</label><input name="listen" id="sec-listen" placeholder=":9000"></div>
        <div><label>${t('Session duration (hours)')}</label><input name="session_hours" id="sec-hours" type="number" min="1" max="720"></div>
      </div>
      <div class="form-row" style="margin-top:8px">
        <div><label>${t('TLS certificate path (fill in both cert and key to enable HTTPS)')}</label><input name="tls_cert" id="sec-cert" placeholder="/Users/zyh/.acme.sh/xx/fullchain.cer"></div>
        <div><label>${t('TLS private key path')}</label><input name="tls_key" id="sec-key"></div>
        <div><label>${t('HTTP redirect port (optional)')}</label><input name="http_port" id="sec-httpport" placeholder=":8000"></div>
      </div>
      <div style="margin-top:8px"><label>${t('IP allowlist (one per line, prefixes like 192.168.31. allowed; empty = no restriction)')}</label>
        <textarea name="ip_allowlist" id="sec-allow" rows="3" style="font-family:ui-monospace,monospace"></textarea></div>
      <div style="margin-top:10px"><button type="submit">${t('Save security settings')}</button></div>
      </form></div>
    <div class="panel"><h4>${t('Known services (labels for quick-open on the Ports page)')}</h4>
      <div class="muted" style="margin-bottom:6px">${t('One per line: ')}<code>${t('port name URL')}</code>${t(', e.g. ')}<code>8083 Nextcloud http://192.168.64.4:8083</code></div>
      <textarea id="known-editor" rows="5" style="font-family:ui-monospace,monospace" placeholder="8083 Nextcloud http://192.168.64.4:8083
8080 rclone http://127.0.0.1:8080"></textarea>
      <div style="margin-top:8px"><button data-act="known-save">${t('Save known services')}</button></div></div>
    <div class="panel"><h4>${t('Audit log')}</h4>
      <div class="muted" style="margin-bottom:8px">${t('Logs sign-ins, terminal sessions and all ops actions; file data/audit.log')}</div>
      <button class="ghost small" data-act="audit-view">${t('View last 500 entries')}</button></div>`;
  api('/api/settings').then(d => {
    document.getElementById('sec-entrance').value = d.entrance || '';
    document.getElementById('sec-listen').value = d.listen || ':9000';
    document.getElementById('sec-hours').value = d.session_hours || 24;
    document.getElementById('sec-cert').value = d.tls_cert || '';
    document.getElementById('sec-key').value = d.tls_key || '';
    document.getElementById('sec-httpport').value = d.http_port || '';
    document.getElementById('sec-allow').value = (d.ip_allowlist || []).join('\n');
    document.getElementById('sec-entrance-hint').innerHTML =
      t('Current entrance: ') + '<code>' + esc(location.origin + '/' + (d.entrance || '') + '/</code>') +
      t(' — after changing the entrance, use the new address; other paths 302-redirect to it');
    const ed = document.getElementById('known-editor');
    ed.value = (d.known_services || []).map(k => [k.port, k.name, k.url].join(' ')).join('\n');
  }).catch(e => toast(ts(e.message), 'err'));
}
function viewAudit() {
  api('/api/audit').then(d => {
    const rows = (d.entries || []).map(l => {
      try { const j = JSON.parse(l); return j.time + '  ' + j.event + '  ' + j.detail; }
      catch (e) { return l; }
    });
    openModal(t('Audit log (last ') + rows.length + t(' entries)'), '<pre class="log" style="max-height:60vh">' + esc(rows.join('\n')) + '</pre>');
  }).catch(e => toast(ts(e.message), 'err'));
}

/* =============== Event delegation =============== */
function wireEvents() {
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, arg = el.dataset.arg;
    const name = el.dataset.name || '';
    try {
      switch (act) {
        case 'close-modal': closeModal(); break;
        case 'toggle-lang': I18N.set(I18N.lang === 'zh' ? 'en' : 'zh'); break;
        case 'logout': await api('/api/logout', 'POST', {}); location.hash = ''; location.reload(); break;
        /* quick links */
        case 'links-refresh': loadLinks(); break;
        case 'link-up': await api('/api/links/move', 'POST', { id: arg, dir: 'up' }); loadLinks(); break;
        case 'link-down': await api('/api/links/move', 'POST', { id: arg, dir: 'down' }); loadLinks(); break;
        case 'link-edit': {
          const f = document.querySelector('form[data-form=link-add]');
          f.querySelector('input[name=id]').value = el.dataset.id;
          f.querySelector('input[name=icon]').value = el.dataset.icon;
          f.querySelector('input[name=name]').value = el.dataset.name;
          f.querySelector('input[name=url]').value = el.dataset.url;
          f.querySelector('input[name=group]').value = el.dataset.group;
          document.getElementById('link-form-title').textContent = t('Edit link ') + el.dataset.name;
          document.getElementById('link-submit').textContent = t('Save changes');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        }
        case 'link-del':
          if (!confirmGo(t('Delete link "') + name + '"?')) return;
          await api('/api/links/delete', 'POST', { id: arg }); loadLinks(); break;
        /* Services */
        case 'svc-refresh': loadBrewServices(); loadLaunchd(); break;
        case 'brewsvc': {
          const d = await api('/api/services/brew/action', 'POST', { name, action: arg });
          toast((d.output || t('Done')).split('\n')[0], 'ok'); loadBrewServices(); break;
        }
        case 'launchd': {
          const d = await api('/api/services/launchd/action', 'POST', { label: name, action: arg });
          toast((d.output || t('Done')).split('\n')[0], 'ok'); loadLaunchd(); break;
        }
        /* Monitors */
        case 'mon-refresh': loadMonitors(); break;
        case 'mon-check': {
          const d = await api('/api/monitors/check', 'POST', { id: arg });
          toast(d.monitor.last_ok ? nameOrId(d.monitor) + t(' OK (') + d.monitor.latency_ms.toFixed(0) + 'ms)'
            : nameOrId(d.monitor) + t(' FAIL: ') + ts(d.monitor.last_error), d.monitor.last_ok ? 'ok' : 'err');
          loadMonitors(); break;
        }
        case 'mon-toggle': await api('/api/monitors/toggle', 'POST', { id: arg, enabled: !el.dataset.on }); loadMonitors(); break;
        case 'mon-del':
          if (!confirmGo(t('Delete monitor "') + name + '"?')) return;
          await api('/api/monitors/delete', 'POST', { id: arg }); loadMonitors(); break;
        case 'mon-act': await api('/api/monitors/action', 'POST', { id: arg, action: el.dataset.a }); toast(t('Executed ') + el.dataset.a, 'ok'); loadMonitors(); break;
        /* cron */
        case 'cron-refresh': loadCron(); break;
        case 'cron-toggle': await api('/api/cron/toggle', 'POST', { index: +arg }); loadCron(); break;
        case 'cron-edit': {
          const f = document.querySelector('form[data-form=cron-add]');
          f.querySelector('input[name=index]').value = arg;
          f.querySelector('input[name=schedule]').value = el.dataset.sched;
          f.querySelector('input[name=command]').value = el.dataset.cmd;
          f.querySelector('input[name=name]').value = el.dataset.name;
          document.getElementById('cron-form-title').textContent = t('Edit job # ') + arg;
          document.getElementById('cron-submit').textContent = t('Save changes');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        }
        case 'cron-del':
          if (!confirmGo(t('Delete this cron job line?'))) return;
          await api('/api/cron/delete', 'POST', { index: +arg }); loadCron(); break;
        /* ports */
        case 'ports-refresh': loadPorts(); break;
        case 'port-fav': await api('/api/system/ports/favorite', 'POST', { port: +arg, fav: !el.dataset.on }); loadPorts(); break;
        case 'port-probe': {
          toast(t('Probing ') + arg + ' …');
          const d = await api('/api/system/probe?port=' + arg);
          toast(d.http_ok ? t('Port ') + arg + ' HTTP ' + d.status + ' (' + d.ms.toFixed(0) + 'ms)'
            : t('Port ') + arg + t(' probe failed: ') + ts(d.detail), d.http_ok ? 'ok' : 'err');
          break;
        }
        /* sites */
        case 'sites-refresh': loadSites(); break;
        case 'caddy-act': {
          const d = await api('/api/sites/caddy', 'POST', { action: arg });
          if (d.job_id) { watchJob(d.job_id, 'brew install caddy'); }
          else toast((d.output || t('Done')).split('\n')[0], 'ok');
          setTimeout(loadSites, 1500); break;
        }
        case 'site-edit': {
          const f = document.querySelector('form[data-form=site-add]');
          f.querySelector('input[name=domain]').value = el.dataset.domain;
          f.querySelector('select[name=type]').value = el.dataset.type;
          f.querySelector('input[name=target]').value = el.dataset.target;
          f.querySelector('select[name=tls]').value = el.dataset.tls;
          f.querySelector('select[name=tls]').dispatchEvent(new Event('change'));
          f.querySelector('input[name=cert]').value = el.dataset.cert;
          f.querySelector('input[name=key]').value = el.dataset.key;
          f.querySelector('input[name=enabled]').checked = !!el.dataset.enabled;
          document.getElementById('site-form-title').textContent = t('Edit site ') + el.dataset.domain;
          document.getElementById('site-submit').textContent = t('Save changes');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        }
        case 'site-del':
          if (!confirmGo(t('Delete site "') + arg + t('"? The Caddy config will be synced.'))) return;
          await api('/api/sites/delete', 'POST', { domain: arg }); loadSites(); break;
        /* containers */
        case 'ct-refresh': loadContainers(); loadImages(); break;
        case 'ct': {
          const d = await api('/api/container/action', 'POST', { id: name, action: arg });
          toast((d.output || t('Done')).split('\n')[0], 'ok'); setTimeout(loadContainers, 800); break;
        }
        case 'ct-logs': watchLogs(name); break;
        case 'ct-logs-refresh': refreshLogs(); break;
        case 'ct-del':
          if (!confirmGo(t('Force delete container "') + name + t('"? Data volumes must be cleaned up manually.'))) return;
          await api('/api/container/action', 'POST', { id: name, action: 'delete' }, { 'X-Panel-Confirm': 'yes' });
          toast(t('Deleted'), 'ok'); setTimeout(loadContainers, 800); break;
        /* app store */
        case 'apps-refresh': loadApps(); loadBrewInstalled(); break;
        case 'app-install-brew': {
          const d = await api('/api/apps/install-brew', 'POST', { id: arg });
          watchJob(d.job_id, t('Install ') + name); break;
        }
        case 'app-install-ctr': {
          const d = await api('/api/apps/install-container', 'POST', { id: arg });
          watchJob(d.job_id, t('Create container ') + name); break;
        }
        case 'brew-installed-refresh': loadBrewInstalled(); break;
        case 'brew-install': {
          const d = await api('/api/brew/action', 'POST', { name: arg, action: 'install' });
          watchJob(d.job_id, 'brew install ' + arg); break;
        }
        case 'brew-upgrade': {
          const d = await api('/api/brew/action', 'POST', { name: arg, action: 'upgrade' });
          watchJob(d.job_id, 'brew upgrade ' + arg); break;
        }
        case 'brew-uninstall': {
          if (!confirmGo(t('Uninstall ') + arg + '?')) return;
          const d = await api('/api/brew/action', 'POST', { name: arg, action: 'uninstall' }, { 'X-Panel-Confirm': 'yes' });
          watchJob(d.job_id, 'brew uninstall ' + arg); break;
        }
        case 'brew-info': brewInfo(arg); break;
        /* terminal */
        case 'term-reconnect': connectTerm(); break;
        /* AI */
        case 'ai-clear': AI_HIST = [];
          document.getElementById('ai-msgs').innerHTML = '<div class="msg ai">' + t('Chat cleared.') + '</div>';
          break;
        /* settings */
        case 'known-save': await saveKnown(); break;
        case 'audit-view': viewAudit(); break;
      }
    } catch (err) { toast(ts(err.message), 'err'); }
  });

  document.addEventListener('submit', async e => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const kind = f.dataset.form;
    const fd = new FormData(f);
    const val = n => (fd.get(n) || '').toString().trim();
    try {
      switch (kind) {
        case 'login': {
          const d = await api('/api/login', 'POST', { username: val('username'), password: fd.get('password') });
          ME = { user: d.user, csrf: d.csrf };
          enterPanel();
          break;
        }
        case 'setup': {
          const creds = { username: val('username'), password: String(fd.get('password')) };
          const d = await api('/api/setup', 'POST', creds);
          toast(t('Setup complete! Entrance path /%s/, please bookmark it').replace('%s', d.entrance), 'ok');
          const d2 = await api('/api/login', 'POST', creds);
          ME = { user: d2.user, csrf: d2.csrf };
          enterPanel();
          break;
        }
        case 'mon-add':
          await api('/api/monitors/add', 'POST', {
            name: val('name'), type: val('type'), target: val('target'), enabled: true,
          });
          toast(t('Added'), 'ok'); f.reset(); loadMonitors();
          break;
        case 'link-add':
          await api('/api/links/save', 'POST', {
            id: val('id'), icon: val('icon'), name: val('name'), url: val('url'), group: val('group'),
          });
          toast(t('Link saved'), 'ok');
          resetLinkForm();
          loadLinks();
          break;
        case 'cron-add': {
          const idx = parseInt(val('index'), 10);
          await api('/api/cron/save', 'POST', {
            index: isNaN(idx) ? -1 : idx, schedule: val('schedule'), command: val('command'), name: val('name'),
          });
          toast(t('crontab written back'), 'ok');
          f.reset();
          f.querySelector('input[name=index]').value = -1;
          document.getElementById('cron-form-title').textContent = t('New job');
          document.getElementById('cron-submit').textContent = t('Add');
          loadCron();
          break;
        }
        case 'site-add': {
          const body = {
            domain: val('domain'), type: val('type'), target: val('target'),
            tls: val('tls'), cert: val('cert'), key: val('key'), enabled: f.querySelector('input[name=enabled]').checked,
          };
          await api('/api/sites/save', 'POST', body);
          toast(t('Site saved and Caddy synced'), 'ok');
          f.reset();
          document.getElementById('site-form-title').textContent = t('Add site');
          document.getElementById('site-submit').textContent = t('Save & sync Caddy');
          document.querySelectorAll('.site-tls-files').forEach(el => el.classList.add('hidden'));
          loadSites();
          break;
        }
        case 'ct-run': {
          const split = s => s.split(',').map(x => x.trim()).filter(Boolean);
          const d = await api('/api/container/run', 'POST', {
            name: val('name'), image: val('image'),
            ports: split(val('ports')), env: split(val('env')), mounts: split(val('mounts')),
          });
          toast(t('Creating…'), 'ok');
          f.reset();
          watchJob(d.job_id, 'container run ' + val('name'));
          setTimeout(loadContainers, 3000);
          break;
        }
        case 'brew-search': brewSearch(val('q')); break;
        case 'ai-chat': {
          const ta = document.getElementById('ai-input');
          const text = ta.value.trim();
          if (!text) return;
          ta.value = '';
          addMsg('user', text);
          AI_HIST.push({ role: 'user', content: text });
          document.getElementById('ai-send').disabled = true;
          await aiSend(text);
          document.getElementById('ai-send').disabled = false;
          break;
        }
        case 'ai-settings':
          await api('/api/ai/settings/save', 'POST', {
            base_url: val('base_url'), model: val('model'), key: val('key'),
          });
          toast(t('AI settings saved'), 'ok');
          f.querySelector('input[name=key]').value = '';
          api('/api/ai/settings').then(d => {
            document.getElementById('ai-key-hint').textContent = d.key_set ? (t('Set (') + d.key_masked + ')') : t('Not set');
          }).catch(() => {});
          break;
        case 'pass-change':
          await api('/api/password', 'POST', { old: val('old'), new: val('new') });
          toast(t('Password changed'), 'ok');
          f.reset();
          break;
        case 'security': {
          const allow = val('ip_allowlist').split('\n').map(x => x.trim()).filter(Boolean);
          const hours = parseInt(val('session_hours'), 10) || 24;
          await api('/api/settings/save', 'POST', {
            entrance: val('entrance'), listen: val('listen'),
            tls_cert: val('tls_cert'), tls_key: val('tls_key'), http_port: val('http_port'),
            ip_allowlist: allow, session_hours: hours,
          });
          toast(t('Saved (listen/TLS/session changes need a panel restart)'), 'ok');
          break;
        }
      }
    } catch (err) {
      if (kind === 'login') document.getElementById('login-err').textContent = ts(err.message);
      else if (kind === 'setup') document.getElementById('setup-err').textContent = ts(err.message);
      else toast(ts(err.message), 'err');
    }
  });
}
function nameOrId(m) { return m.name || m.id; }

/* =============== Job progress modal =============== */
function watchJob(id, name) {
  openModal(t('Task: ') + esc(name), '<pre class="log" id="job-log">…</pre><div class="muted" id="job-status" style="margin-top:8px">' + t('Running…') + '</div>');
  let since = 0;
  const timer = setInterval(async () => {
    try {
      const d = await api('/api/jobs/' + id + '?since=' + since);
      const pre = document.getElementById('job-log');
      if (!pre) { clearInterval(timer); return; }
      if (d.log && d.log.length) {
        pre.textContent += (pre.textContent ? '\n' : '') + d.log.join('\n');
        pre.scrollTop = pre.scrollHeight;
      }
      since = d.total || since;
      const st = document.getElementById('job-status');
      if (d.status === 'running') st.textContent = t('Running…');
      else {
        st.textContent = d.status === 'done' ? t('✓ Done (exit 0)') : t('✗ Failed (exit ') + d.exit + ')';
        clearInterval(timer);
        toast(t('Task ') + name + ' ' + (d.status === 'done' ? t('done') : t('failed')), d.status === 'done' ? 'ok' : 'err');
      }
    } catch (e) { clearInterval(timer); }
  }, 1000);
}

/* =============== Known services save =============== */
async function saveKnown() {
  const lines = document.getElementById('known-editor').value.split('\n')
    .map(l => l.trim()).filter(Boolean);
  const list = [];
  for (const l of lines) {
    const parts = l.split(/\s+/);
    const port = parseInt(parts[0], 10);
    if (!port || port < 1 || port > 65535) { toast(t('Invalid port: ') + l, 'err'); return; }
    list.push({ port, name: parts[1] || (t('Port ') + parts[0]), url: parts.slice(2).join(' ') });
  }
  await api('/api/settings/save', 'POST', { known_services: list });
  toast(t('Known services saved (') + list.length + t(' items)'), 'ok');
}

/* =============== Bootstrap =============== */
(async function init() {
  wireEvents();
  window.addEventListener('hashchange', navigate);
  try {
    const d = await api('/api/me');
    ME = { user: d.user, csrf: d.csrf };
    enterPanel();
  } catch (e) {
    try {
      const st = await (await fetch('/api/setup-status')).json();
      if (st.needs_setup) showSetup(); else showLogin();
    } catch (e2) { showLogin(); }
  }
})();
