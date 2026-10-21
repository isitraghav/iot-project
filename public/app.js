// Billboard Fleet dashboard — vanilla JS + Chart.js rendered into the static shell in app/page.tsx.
// radar.js adds the live proximity radar on top of the helpers defined here.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = (path, opts) => fetch(path, opts).then(async r => {
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
});
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = n => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }));
const compact = n => n == null ? '–' : Math.abs(n) >= 1e4 ? (n / 1e3).toFixed(Math.abs(n) >= 1e5 ? 0 : 1) + 'K' : fmt(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dur = s => s == null ? '–' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
const ago = ts => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 10 ? 'just now' : s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago`
    : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const dateTime = ts => new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const hexA = (hex, a) => { const n = parseInt(hex.replace('#', ''), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TYPE_ORDER = ['phone', 'computer', 'wearable', 'audio', 'tv', 'tracker', 'ap', 'other'];
const TYPE_NAMES = { phone: 'Phone', computer: 'Computer', wearable: 'Wearable', audio: 'Audio', tv: 'TV / media',
  tracker: 'Tracker / tag', ap: 'Access point', other: 'Other / unknown' };
const typeColor = t => css(`--t-${TYPE_ORDER.includes(t) ? t : 'other'}`);
const radioName = k => k === 'ap' ? 'Access point' : k === 'wifi' ? 'WiFi' : 'BLE';

const svg = (d, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const SEV = {
  critical: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.2"/>', 'ico sev critical'),
  warning: svg('<path d="M10.3 4.6a2 2 0 0 1 3.4 0l7.4 12.6a2 2 0 0 1-1.7 3H4.6a2 2 0 0 1-1.7-3z"/><path d="M12 10v3.8M12 17v.2"/>', 'ico sev warning'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.2"/>', 'ico sev info'),
  ok: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16 9.6"/>', 'ico sev'),
};
const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>';
const CHECK = '<svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const STATUS = {
  online: 'Online', stale: 'Delayed', offline: 'Offline', pending: 'Not connected yet',
};
const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
const statusChip = st => `<span class="chip"><span class="status-dot ${st}"></span>${STATUS[st]}</span>`;

const state = {
  page: 'fleet', scope: null, range: '24h', retDays: 14, devRange: '24h',
  fleetFilter: 'all', fleetView: 'grid', fleetQuery: '',
  charts: {}, data: {}, fleet: null, settings: null, sheet: null,
};
try {
  state.scope = localStorage.getItem('scope') || null;
  state.fleetView = localStorage.getItem('fleetView') || 'grid';
} catch (e) {}

// Query string for scoped endpoints
const qs = (params = {}) => {
  const p = new URLSearchParams(params);
  if (state.scope) p.set('sensor', state.scope);
  return p.toString();
};
const sensorById = id => state.fleet?.sensors.find(s => s.id === id);
const sensorName = id => sensorById(id)?.name || (id ? `Sensor ${id.slice(0, 6)}` : 'Unassigned');

// ---------------------------------------------------------------- feedback: toast, dialog, tooltip
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.innerHTML = `${kind === 'error' ? SEV.critical : SEV.ok}<span>${esc(msg)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, kind === 'error' ? 5200 : 3200);
}
let lastNetErr = 0;
function netError(err) {
  console.error(err);
  if (Date.now() - lastNetErr > 20000) { lastNetErr = Date.now(); toast(`Couldn’t load data: ${err.message}`, 'error'); }
}

let dialogResolve = null;
function dialog({ title, body, confirm = 'OK', cancel = 'Cancel', danger = false, html = false }) {
  $('#dialog').innerHTML = `<h3>${esc(title)}</h3>${html ? body : `<p>${esc(body)}</p>`}
    <div class="actions-row">${cancel ? `<button type="button" class="btn" data-dlg="0">${esc(cancel)}</button>` : ''}
    <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-dlg="1">${esc(confirm)}</button></div>`;
  $('#dialogWrap').classList.add('show');
  $('#dialogWrap').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#dialog [data-dlg="1"]')?.focus(), 50);
  return new Promise(res => { dialogResolve = res; });
}
function closeDialog(v) {
  $('#dialogWrap').classList.remove('show');
  $('#dialogWrap').setAttribute('aria-hidden', 'true');
  dialogResolve?.(v); dialogResolve = null;
}
$('#dialogWrap').addEventListener('click', e => {
  const b = e.target.closest('[data-dlg]');
  if (b) closeDialog(b.dataset.dlg === '1');
  else if (e.target === $('#dialogWrap')) closeDialog(false);
});

const tip = $('#tooltip');
function placeTip(x, y) {
  tip.style.left = Math.max(8, Math.min(x + 12, innerWidth - tip.offsetWidth - 8)) + 'px';
  tip.style.top = (y + 16 + tip.offsetHeight > innerHeight ? y - tip.offsetHeight - 10 : y + 16) + 'px';
}
document.addEventListener('mousemove', e => {
  if (e.target.closest?.('#radarCanvas')) return;
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tip.classList.add('hidden'); return; }
  tip.textContent = t.dataset.tip;
  tip.classList.remove('hidden');
  placeTip(e.clientX, e.clientY);
});

// ---------------------------------------------------------------- popover (anchored to its trigger)
let popCleanup = null;
function openPopover(anchor, html, onPick) {
  const pop = $('#popover');
  pop.innerHTML = html;
  const r = anchor.getBoundingClientRect();
  pop.style.minWidth = Math.max(260, r.width) + 'px';
  pop.classList.add('show'); pop.setAttribute('aria-hidden', 'false');
  const w = pop.offsetWidth;
  const right = r.left + w > innerWidth - 12;
  pop.style.left = (right ? Math.max(12, r.right - w) : r.left) + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.setProperty('--origin', right ? 'top right' : 'top left');
  const onClick = e => {
    const item = e.target.closest('[data-pick]');
    if (item) { closePopover(); onPick(item.dataset.pick); return; }
    if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  setTimeout(() => document.addEventListener('click', onClick), 0);
  popCleanup = () => document.removeEventListener('click', onClick);
  ($('.pop-item.sel', pop) || $('.pop-item', pop))?.focus();
}
function closePopover() {
  const pop = $('#popover');
  if (!pop.classList.contains('show')) return false;
  pop.classList.remove('show'); pop.setAttribute('aria-hidden', 'true');
  popCleanup?.(); popCleanup = null;
  return true;
}

// ---------------------------------------------------------------- sheet (side panel; bottom sheet on phones)
let sheetReturnFocus = null;
function openSheet(kind, id = null) {
  state.sheet = { kind, id };
  if (!$('#sheet').classList.contains('open')) sheetReturnFocus = document.activeElement;
  $('#sheet').classList.add('open'); $('#sheet').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('show');
  $('#sheetBody').scrollTop = 0;
  setTimeout(() => $('#sheetClose').focus({ preventScroll: true }), 60);
}
function closeSheet() {
  if (!state.sheet) return false;
  state.sheet = null;
  $('#sheet').classList.remove('open'); $('#sheet').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('show');
  sheetReturnFocus?.focus?.({ preventScroll: true });
  return true;
}
const setSheetHead = (eyebrow, title) => { $('#sheetEyebrow').innerHTML = eyebrow; $('#sheetTitle').textContent = title; };
$('#sheetClose').onclick = closeSheet;
$('#scrim').onclick = closeSheet;
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (closePopover()) return;
  if (dialogResolve) { closeDialog(false); return; }
  closeSheet();
});

// ---------------------------------------------------------------- segmented controls (sliding thumb)
function moveThumb(seg) {
  const b = $('button.active', seg);
  if (!b || !b.offsetWidth) return;
  const first = !seg.dataset.ready;
  if (first) seg.classList.add('no-anim');
  seg.style.setProperty('--x', b.offsetLeft + 'px');
  seg.style.setProperty('--w', b.offsetWidth + 'px');
  if (first) { seg.dataset.ready = '1'; requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('no-anim'))); }
}
const syncThumbs = () => $$('.seg').forEach(moveThumb);
function setSeg(seg, value, attr) {
  $$('button', seg).forEach(b => {
    const on = b.dataset[attr] === String(value);
    b.classList.toggle('active', on); b.setAttribute('aria-checked', on);
  });
  moveThumb(seg);
}
function segment(sel, attr, onPick) {
  const seg = $(sel);
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.classList.contains('active')) return;
    setSeg(seg, b.dataset[attr], attr);
    onPick(b.dataset[attr]);
  });
}
addEventListener('resize', () => requestAnimationFrame(syncThumbs));
document.fonts?.ready.then(syncThumbs);

// ---------------------------------------------------------------- theme
const THEMES = ['auto', 'light', 'dark'];
const currentTheme = () => document.documentElement.dataset.theme || 'auto';
function setTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { t === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', t); } catch (e) {}
  $('#themeLabel').textContent = t[0].toUpperCase() + t.slice(1);
  const seg = $('#themeSeg');
  if (seg) setSeg(seg, t, 'theme');
  rerenderCharts();
}
$('#themeLabel').textContent = currentTheme()[0].toUpperCase() + currentTheme().slice(1);
$('#themeBtn').onclick = () => setTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % 3]);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderCharts);

// Toolbar scroll-edge: hairline + compact title fade in once the large title scrolls away
addEventListener('scroll', () => {
  $('.toolbar').style.setProperty('--edge', Math.min(1, Math.max(0, (scrollY - 24) / 40)).toFixed(2));
}, { passive: true });

// ---------------------------------------------------------------- charts
const crosshair = {
  id: 'crosshair',
  afterDraw(chart) {
    const a = chart.tooltip?.getActiveElements?.();
    if (!a || !a.length || chart.config.type !== 'line') return;
    const x = a[0].element.x, { top, bottom } = chart.chartArea, ctx = chart.ctx;
    ctx.save(); ctx.strokeStyle = css('--axis'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
  },
};
// Direct label at the end of each line series
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(chart, _, opts) {
    if (!opts?.enabled) return;
    const ctx = chart.ctx;
    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || !meta.data.length) return;
      const pt = meta.data[meta.data.length - 1];
      ctx.save(); ctx.fillStyle = css('--text-2'); ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.fillText(`${ds.label} ${fmt(ds.data[ds.data.length - 1])}`, pt.x, pt.y - 9);
      ctx.restore();
    });
  },
};
Chart.register(crosshair, endLabels);
Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function baseOptions({ stacked = false, legend = false, horizontal = false } = {}) {
  const grid = css('--grid'), muted = css('--muted');
  const valueAxis = { stacked, beginAtZero: true, grid: { color: grid, drawTicks: false }, border: { display: false },
    ticks: { color: muted, padding: 8, precision: 0, maxTicksLimit: 5, font: { size: 11 },
      callback: v => Math.abs(v) >= 1000 ? (v / 1000) + 'K' : v } };
  const catAxis = { stacked, grid: { display: false }, border: { color: css('--axis') },
    ticks: { color: muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 14, font: { size: 11 } } };
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 280, easing: 'easeOutQuart' },
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, position: 'top', align: 'end',
        labels: { color: css('--text-2'), boxWidth: 9, boxHeight: 9, useBorderRadius: true, borderRadius: 2, padding: 14, font: { size: 12 } } },
      tooltip: { backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text-2'),
        borderColor: css('--border-strong'), borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true, cornerRadius: 10,
        titleFont: { weight: '600' } },
      endLabels: { enabled: false },
    },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}
function lineDs(label, data, color, fill = false) {
  return { label, data, borderColor: color, backgroundColor: fill ? hexA(color, 0.1) : color, borderWidth: 2, pointRadius: 0,
    pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: css('--surface'), pointHoverBackgroundColor: color,
    tension: 0.3, fill, borderJoinStyle: 'round', borderCapStyle: 'round' };
}
function barDs(label, data, color) {
  return { label, data, backgroundColor: color, borderColor: css('--surface'), borderWidth: { top: 2 },
    borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24, categoryPercentage: 0.86, barPercentage: 0.9 };
}
// Create, or update in place (no flicker on polling) when the canvas is unchanged
function draw(id, config, { live = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const ch = state.charts[id];
  if (ch && ch.canvas === el && ch.config.type === config.type) {
    ch.data = config.data; ch.options = config.options; ch.update(live ? 'none' : undefined);
    return;
  }
  ch?.destroy();
  state.charts[id] = new Chart(el, config);
}
function rerenderCharts() {
  requestAnimationFrame(() => {
    Object.values(state.charts).forEach(c => c.destroy());
    state.charts = {};
    if (state.data.summary) renderSummary(state.data.summary);
    if (state.data.heatmap) renderHeatmap(state.data.heatmap);
    if (state.data.bands) { renderRings(state.data.bands); renderTypeBands(state.data.bands); }
    if (state.data.live) renderLive(state.data.live);
    if (state.data.retention) renderRetention(state.data.retention);
    if (state.sheet?.kind === 'sensor') renderSensorLive();
    if (state.sheet?.kind === 'device' && state.data.device) renderDeviceChart(state.data.device);
  });
}
function tickLabel(t, bucket) {
  const d = new Date(t * 1000);
  if (bucket >= 86400) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (bucket >= 3 * 3600) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.getHours() + ':00';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function table(head, rows, numFrom = 1) {
  return `<table class="tbl"><thead><tr>${head.map((h, i) => `<th class="${i >= numFrom ? 'num' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map(r => `<tr>${r.map((c, i) => `<td class="${i >= numFrom ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')
      : `<tr class="empty-row"><td colspan="${head.length}">No data yet</td></tr>`}</tbody></table>`;
}
const seqSteps = () => [1, 2, 3, 4, 5, 6, 7].map(i => css(`--seq-${i}`));
const seqCell = (v, max, steps) => {
  const i = Math.min(6, Math.floor((v / max) * 7));
  return { bg: v <= 0 ? css('--seq-0') : steps[i], ink: v > 0 && i >= 4 ? '#fff' : css('--text') };
};

// 24-column bar sparkline (hourly), current hour in the accent
function spark(values, endTs = Date.now() / 1000, unit = 'people') {
  const n = values.length, W = 240, H = 44, gap = 2, bw = (W - gap * (n - 1)) / n;
  const max = Math.max(1, ...values);
  const h0 = Math.floor(endTs / 3600) * 3600 - (n - 1) * 3600;
  const hh = t => new Date(t * 1000).getHours().toString().padStart(2, '0') + ':00';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Hourly ${unit}, last ${n} hours">` +
    values.map((v, i) => {
      const x = i * (bw + gap), h = v > 0 ? Math.max(2, (v / max) * (H - 2)) : 1;
      const t = h0 + i * 3600;
      return `<g data-tip="${hh(t)}–${hh(t + 3600)} · ${fmt(v)} ${unit}"><rect class="hit" x="${x}" y="0" width="${bw + gap}" height="${H}"/>` +
        `<rect class="b${i === n - 1 ? ' cur' : ''}" x="${x}" y="${H - h}" width="${bw}" height="${h}" rx="${Math.min(1.5, h / 2)}" style="${v > 0 ? '' : 'fill:var(--grid)'}"/></g>`;
    }).join('') + '</svg>';
}

// ---------------------------------------------------------------- navigation
const PAGES = ['fleet', 'audience', 'live', 'retention', 'devices', 'settings'];
const TITLES = { fleet: 'Fleet', audience: 'Audience', live: 'Live', retention: 'Retention', devices: 'Devices', settings: 'Settings' };
function go(page) {
  if (!PAGES.includes(page)) page = 'fleet';
  const changed = state.page !== page;
  state.page = page;
  $$('.nav button').forEach(b => { const on = b.dataset.page === page; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  $('#toolbarTitle').textContent = TITLES[page];
  document.title = `${TITLES[page]} · Billboard Fleet`;
  $('#scopeBtn').classList.toggle('hidden', page === 'fleet' || page === 'settings');
  if (changed) scrollTo({ top: 0 });
  syncThumbs();
  refresh();
}
$$('.nav button').forEach(b => b.onclick = () => {
  if (location.hash.slice(1) === b.dataset.page) go(b.dataset.page); else location.hash = b.dataset.page;
});
addEventListener('hashchange', () => go(location.hash.slice(1)));

// ---------------------------------------------------------------- scope (which billboard the analytics cover)
function setScope(id) {
  state.scope = id || null;
  try { state.scope ? localStorage.setItem('scope', state.scope) : localStorage.removeItem('scope'); } catch (e) {}
  if (window.Radar) Radar.reset();
  renderScope();
  refresh();
}
const fleetDot = t => !t || !t.sensors ? 'pending' : t.online === t.sensors ? 'online' : t.online ? 'mixed' : 'offline';
function renderScope() {
  const f = state.fleet;
  if (state.scope && f && !sensorById(state.scope)) { state.scope = null; try { localStorage.removeItem('scope'); } catch (e) {} }
  const s = sensorById(state.scope);
  $('#scopeName').textContent = s ? s.name : 'All billboards';
  $('#scopeDot').className = 'status-dot ' + (s ? s.status : fleetDot(f?.totals));
  $('#exportBtn').href = `/api/export/visits.csv?${qs({ range: state.devRange })}`;
  $('#liveScope').textContent = s ? s.name : 'your billboards';
}
$('#scopeBtn').onclick = e => {
  if ($('#popover').classList.contains('show')) { closePopover(); return; }
  const f = state.fleet;
  const sensors = f?.sensors || [];
  const html = `<button type="button" class="pop-item ${!state.scope ? 'sel' : ''}" data-pick="">
      <span class="status-dot ${fleetDot(f?.totals)}"></span>
      <span class="t"><div>All billboards</div><div>${sensors.length} sensor${sensors.length === 1 ? '' : 's'}, combined</div></span>${CHECK}</button>
    ${sensors.length ? '<div class="pop-sep"></div>' : ''}` +
    sensors.map(s => `<button type="button" class="pop-item ${state.scope === s.id ? 'sel' : ''}" data-pick="${s.id}">
      <span class="status-dot ${s.status}"></span>
      <span class="t"><div>${esc(s.name)}</div><div>${esc(s.location || STATUS[s.status])}</div></span>${CHECK}</button>`).join('');
  openPopover(e.currentTarget, html, id => setScope(id));
};

// ---------------------------------------------------------------- fleet chrome (sidebar, pill, badge)
function renderPill(c) {
  const pill = $('#statusPill');
  let cls, txt;
  if (!c.sensors) { cls = 'pending'; txt = 'No sensors yet'; }
  else if (c.online === c.sensors) { cls = 'online'; txt = c.sensors === 1 ? 'Sensor online' : `All ${c.sensors} online`; }
  else if (c.online) { cls = 'mixed'; txt = `${c.online} of ${c.sensors} online`; }
  else { cls = c.pending === c.sensors ? 'pending' : 'offline'; txt = c.pending === c.sensors ? 'Awaiting first check-in' : 'All sensors offline'; }
  pill.querySelector('.status-dot').className = 'status-dot ' + cls;
  pill.querySelector('.txt').textContent = txt;
  $('#fleetHealthSub').textContent = c.sensors ? `${c.sensors} billboard${c.sensors === 1 ? '' : 's'} · ${c.online} online` : 'No billboards yet';
}
function renderFleetChrome(f) {
  renderPill(f.totals);
  const badge = $('#issueBadge');
  const n = f.sensors.filter(s => s.issues.some(i => i.severity !== 'info')).length;
  badge.textContent = n; badge.classList.toggle('hidden', !n);
  badge.setAttribute('aria-label', `${n} billboards need attention`);
  renderScope();
}

// ---------------------------------------------------------------- fleet page
async function loadFleet() {
  const f = await api('/api/fleet');
  state.fleet = f;
  renderFleetChrome(f);
  if (state.page === 'fleet') renderFleet(f);
  if (state.sheet?.kind === 'sensor') renderSensorLive();
  if (state.sheet?.kind === 'add') renderAddWaiting();
}

const worstIssue = s => ['critical', 'warning', 'info'].map(sev => s.issues.find(i => i.severity === sev)).find(Boolean);
const needsAttention = s => s.issues.some(i => i.severity !== 'info');
const shortFw = fw => fw ? fw.replace(/^billboard-(cloud\/)?/, 'v') : '–';
function deltaHtml(cur, prev, label = '') {
  if (!prev) return `<span class="delta">${label ? 'No earlier data' : ''}</span>`;
  const d = 100 * (cur - prev) / prev;
  const cls = d > 0.5 ? 'up' : d < -0.5 ? 'down' : '';
  const arrow = d > 0.5 ? '<svg viewBox="0 0 10 10"><path d="M5 1.5l4 6H1z"/></svg>' : d < -0.5 ? '<svg viewBox="0 0 10 10"><path d="M5 8.5l4-6H1z"/></svg>' : '';
  return `<span class="delta ${cls}">${arrow}${Math.abs(d).toFixed(0)}%${label ? ' ' + label : ''}</span>`;
}

function renderFleet(f) {
  const t = f.totals, list = f.sensors;
  $('#fleetLede').textContent = t.sensors
    ? `${t.sensors} billboard${t.sensors === 1 ? '' : 's'} · ${t.online} online${t.offline ? ` · ${t.offline} offline` : ''}${t.pending ? ` · ${t.pending} not connected yet` : ''}`
    : 'Add your first billboard sensor to start measuring its audience.';
  const hasAny = list.length > 0;
  $('#fleetSummary').classList.toggle('hidden', !hasAny);
  $('.toolbar-row', $('#page-fleet')).classList.toggle('hidden', !hasAny);
  if (!hasAny) {
    $('#attention').innerHTML = '';
    $('#fleetList').innerHTML = `<div class="empty">
      ${svg('<rect x="3" y="4.5" width="18" height="10.5" rx="2.2"/><path d="M8.5 15v4.5M15.5 15v4.5"/>', 'ico')}
      <h3>No billboards yet</h3><p>Each billboard has one ESP32 sensor. Add one to get a ready-to-flash <code>config.h</code> with WiFi and server details filled in.</p>
      <button type="button" class="btn primary" data-action="add">Add billboard</button></div>`;
    return;
  }

  // Summary: one hero figure, then four stat tiles
  const seg = (n, color) => n ? `<i style="flex:${n};background:${color}"></i>` : '';
  const attentionN = list.filter(needsAttention).length;
  $('#fleetSummary').innerHTML = `
    <div class="card fleet-hero">
      <div>
        <div class="hero-lbl">People near your billboards now</div>
        <div class="hero-num">${fmt(t.people_now)}</div>
        <div class="hero-meta"><span><b>${fmt(t.devices_now)}</b>${t.devices_now === 1 ? 'device' : 'devices'} in range</span><span><b>${fmt(t.viewers_now)}</b>in viewing distance</span></div>
      </div>
      <div>
        <div class="hero-lbl" style="margin-bottom:6px">People per hour, whole fleet</div>
        ${spark(t.spark, f.now)}
        <div class="spark-axis"><span>24h ago</span><span>12h</span><span>Now</span></div>
      </div>
    </div>
    <div class="fleet-tiles">
      <div class="kpi"><div class="lbl">Sensors online</div>
        <div class="val">${t.online}<small>of ${t.sensors}</small></div>
        <div class="meter" role="img" aria-label="${t.online} online, ${t.stale} delayed, ${t.offline} offline, ${t.pending} not connected">
          ${seg(t.online, css('--good'))}${seg(t.stale, css('--warning'))}${seg(t.offline, css('--critical'))}${seg(t.pending, css('--axis'))}</div>
        <div class="meter-legend">${[['online', t.online], ['stale', t.stale], ['offline', t.offline], ['pending', t.pending]]
          .filter(([, n]) => n).map(([k, n]) => `<span><span class="status-dot ${k}"></span>${n} ${STATUS[k].toLowerCase()}</span>`).join('')}</div>
      </div>
      <div class="kpi"><div class="lbl">People, last 24 h</div><div class="val">${compact(t.people_24h)}</div>${deltaHtml(t.people_24h, t.people_prev_24h, 'vs previous 24 h')}</div>
      <div class="kpi"><div class="lbl">Impressions, last 24 h <span class="info-tip" data-tip="Visits inside viewing distance that lasted at least the minimum dwell time">i</span></div>
        <div class="val">${compact(t.impressions_24h)}</div><span class="delta">${t.avg_dwell ? `Average dwell ${dur(t.avg_dwell)}` : 'No impressions yet'}</span></div>
      <div class="kpi"><div class="lbl">Needs attention</div><div class="val">${attentionN}<small>${attentionN === 1 ? 'billboard' : 'billboards'}</small></div>
        <span class="delta">${attentionN ? 'Offline, delayed or degraded' : 'Everything’s healthy'}</span></div>
    </div>`;

  // Attention list: critical first, then warnings
  const rank = { critical: 0, warning: 1 };
  const rows = list.flatMap(s => s.issues.filter(i => i.severity !== 'info').map(i => ({ s, i })))
    .sort((a, b) => rank[a.i.severity] - rank[b.i.severity]);
  $('#attention').innerHTML = rows.length ? `<div class="card flush attention">
      <div class="attention-h"><h3>Needs attention</h3><span class="muted small">${rows.length} issue${rows.length === 1 ? '' : 's'}</span></div>
      ${rows.map(({ s, i }) => `<button type="button" class="issue-row" data-sensor="${s.id}">${SEV[i.severity]}
        <span class="who">${esc(s.name)}</span><span class="what">${esc(i.text)}</span>${CHEV}</button>`).join('')}
    </div>` : '';

  // Billboard list
  const q = state.fleetQuery.toLowerCase();
  const shown = list.filter(s => (!q || `${s.name} ${s.location || ''} ${s.id}`.toLowerCase().includes(q)) && (
    state.fleetFilter === 'all' ? true : state.fleetFilter === 'attention' ? needsAttention(s)
      : state.fleetFilter === 'online' ? s.status === 'online' : s.status === 'offline' || s.status === 'stale'));
  if (!shown.length) {
    $('#fleetList').innerHTML = `<div class="empty"><h3>No matching billboards</h3><p>Try a different search or filter.</p></div>`;
    return;
  }
  $('#fleetList').innerHTML = state.fleetView === 'table' ? fleetTable(shown, f) : `<div class="sensor-grid">${shown.map(s => sensorCard(s, f)).join('')}</div>`;
}

function sensorCard(s, f) {
  const issue = worstIssue(s);
  const live = s.status === 'online' || s.status === 'stale';
  return `<article class="card sensor-card ${s.status}" data-sensor="${s.id}" tabindex="0" role="button" aria-label="${esc(s.name)}, ${STATUS[s.status]}">
    <div class="top">
      <div><div class="name">${esc(s.name)}</div><div class="loc">${esc(s.location) || 'No location set'}</div></div>
      ${statusChip(s.status)}
    </div>
    <div class="figs">
      <div class="fig"><div class="v">${live ? fmt(s.people_now) : '–'}</div><div class="l">People now</div></div>
      <div class="fig"><div class="v">${compact(s.people_24h)}</div><div class="l">Last 24 h</div></div>
      <div>${spark(s.spark, f.now)}</div>
    </div>
    ${issue ? `<div class="issue-line">${SEV[issue.severity]}<span>${esc(issue.text)}</span></div>` : ''}
    <div class="health">
      <div><div class="k">Checked in</div><div class="v">${s.last_seen ? ago(s.last_seen) : 'Never'}</div></div>
      <div><div class="k">Uptime</div><div class="v">${live && s.uptime != null ? dur(s.uptime) : '–'}</div></div>
      <div><div class="k">Free memory</div><div class="v ${s.heap != null && s.heap < 40960 ? 'warn' : ''}">${s.heap != null ? Math.round(s.heap / 1024) + ' KB' : '–'}</div></div>
      <div><div class="k">Firmware</div><div class="v" title="${esc(s.fw || '')}">${esc(shortFw(s.fw))}</div></div>
    </div>
  </article>`;
}

function fleetTable(list, f) {
  const maxP = Math.max(1, ...list.map(s => s.people_24h));
  return `<div class="card flush"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Billboard</th><th>Status</th><th>Checked in</th><th class="num">Now</th><th class="num">People 24 h</th><th class="num">Change</th>
      <th class="num">Impressions</th><th class="num">Avg dwell</th><th class="num">Uptime</th><th class="num">Memory</th><th>Firmware</th><th>Issues</th></tr></thead>
    <tbody>${list.map(s => {
      const issue = worstIssue(s), live = s.status === 'online' || s.status === 'stale';
      return `<tr class="click" data-sensor="${s.id}">
        <td><div class="strong">${esc(s.name)}</div><div class="muted small">${esc(s.location) || '–'}</div></td>
        <td>${statusChip(s.status)}</td>
        <td class="muted">${s.last_seen ? ago(s.last_seen) : 'Never'}</td>
        <td class="num">${live ? fmt(s.people_now) : '–'}</td>
        <td class="num"><span class="cell-bar"><i style="width:${Math.round(56 * s.people_24h / maxP)}px"></i>${fmt(s.people_24h)}</span></td>
        <td class="num">${deltaHtml(s.people_24h, s.people_prev_24h)}</td>
        <td class="num">${fmt(s.impressions_24h)}</td>
        <td class="num">${s.avg_dwell ? dur(s.avg_dwell) : '–'}</td>
        <td class="num">${live && s.uptime != null ? dur(s.uptime) : '–'}</td>
        <td class="num">${s.heap != null ? Math.round(s.heap / 1024) + ' KB' : '–'}</td>
        <td class="mono">${esc(shortFw(s.fw))}</td>
        <td class="wrap">${issue ? `<span class="issue-line" style="display:flex;gap:6px;align-items:center">${SEV[issue.severity]}<span class="small">${esc(issue.text)}</span></span>` : '<span class="muted">–</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
}

$('#page-fleet').addEventListener('click', e => {
  if (e.target.closest('[data-action="add"]')) { openAddSensor(); return; }
  const el = e.target.closest('[data-sensor]');
  if (el) openSensor(el.dataset.sensor);
});
$('#page-fleet').addEventListener('keydown', e => {
  const el = e.target.closest('article[data-sensor]');
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSensor(el.dataset.sensor); }
});
$('#addSensorBtn').onclick = () => openAddSensor();
$('#fleetSearch').oninput = e => { state.fleetQuery = e.target.value.trim(); state.fleet && renderFleet(state.fleet); };
segment('#fleetFilter', 'filter', v => { state.fleetFilter = v; state.fleet && renderFleet(state.fleet); });
setSeg($('#fleetView'), state.fleetView, 'view');
segment('#fleetView', 'view', v => {
  state.fleetView = v;
  try { localStorage.setItem('fleetView', v); } catch (e) {}
  state.fleet && renderFleet(state.fleet);
});

// ---------------------------------------------------------------- sensor sheet
function openSensor(id) {
  const s = sensorById(id);
  if (!s) return;
  openSheet('sensor', id);
  $('#sheetBody').innerHTML = `
    <section class="actions-row">
      <button type="button" class="btn primary" data-act="audience">View audience</button>
      <button type="button" class="btn" data-act="live">Live</button>
      <a class="btn" href="/api/fleet/${s.id}/config.h" download="config.h">Download config.h</a>
    </section>
    <div id="sensorLive"></div>
    <section>
      <h4>Details</h4>
      <form class="form" id="sensorForm">
        <div class="field"><label for="sfName">Name</label><input id="sfName" type="text" required maxlength="80" value="${esc(s.name)}"></div>
        <div class="field"><label for="sfLoc">Location</label><input id="sfLoc" type="text" maxlength="160" value="${esc(s.location || '')}" placeholder="Street address or landmark"></div>
        <div class="actions-row"><button type="submit" class="btn primary" disabled>Save changes</button></div>
      </form>
    </section>
    <section>
      <h4>Access</h4>
      <dl class="kv group">
        <dt>Sensor ID</dt><dd class="mono">${s.id}</dd>
        <dt>Added</dt><dd>${dateTime(s.created_at)}</dd>
        <dt>API key</dt><dd><button type="button" class="link" data-act="rotate">Rotate key…</button></dd>
      </dl>
      <p class="sub foot">The key is baked into config.h. Rotating it disconnects the sensor until you flash a new config.h.</p>
    </section>
    <section>
      <h4>Remove</h4>
      <button type="button" class="btn danger-quiet" data-act="delete">Delete billboard…</button>
      <p class="sub foot">Its audience history stays in the database, but the sensor can no longer report.</p>
    </section>`;
  renderSensorLive();
  const form = $('#sensorForm');
  const dirty = () => { form.querySelector('[type=submit]').disabled = $('#sfName').value.trim() === s.name && $('#sfLoc').value.trim() === (s.location || '') || !$('#sfName').value.trim(); };
  form.oninput = dirty;
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      await api(`/api/fleet/${s.id}`, json('PATCH', { name: $('#sfName').value, location: $('#sfLoc').value }));
      s.name = $('#sfName').value.trim(); s.location = $('#sfLoc').value.trim() || null;
      dirty(); toast('Billboard updated'); loadFleet().catch(netError);
    } catch (err) { toast(err.message, 'error'); }
  };
}
function renderSensorLive() {
  const id = state.sheet?.id, s = sensorById(id);
  const box = $('#sensorLive');
  if (!s || !box) return;
  const live = s.status === 'online' || s.status === 'stale';
  setSheetHead(`${statusChip(s.status)}<span>${s.last_seen ? `Checked in ${ago(s.last_seen)}` : 'Never checked in'}</span>`, s.name);
  const kv = rows => `<dl class="kv group">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const tablePct = s.table_pct;
  box.innerHTML = `
    ${s.issues.length ? `<section style="display:grid;gap:8px">${s.issues.map(i => `<div class="callout">${SEV[i.severity]}<span>${esc(i.text)}</span></div>`).join('')}</section>` : ''}
    <section>
      <h4>Audience</h4>
      <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:12px">
        <div class="kpi"><div class="lbl">People now</div><div class="val">${live ? fmt(s.people_now) : '–'}</div></div>
        <div class="kpi"><div class="lbl">Last 24 h</div><div class="val">${compact(s.people_24h)}</div>${deltaHtml(s.people_24h, s.people_prev_24h)}</div>
        <div class="kpi"><div class="lbl">Impressions</div><div class="val">${compact(s.impressions_24h)}</div><span class="delta">${s.avg_dwell ? `avg ${dur(s.avg_dwell)}` : '24 h'}</span></div>
      </div>
      <div class="chart small"><canvas id="cSensor"></canvas></div>
    </section>
    <section>
      <h4>Health</h4>
      ${kv([
        ['Last check-in', s.last_seen ? `${ago(s.last_seen)} · ${dateTime(s.last_seen)}` : 'Never'],
        ['Uptime', live && s.uptime != null ? dur(s.uptime) : '–'],
        ['Last restart', s.booted_at ? dateTime(s.booted_at) : '–'],
        ['Restarts recorded', fmt(s.reboots)],
        ['Free memory', s.heap != null ? `${Math.round(s.heap / 1024)} KB` : '–'],
        ['Device table', tablePct != null ? `<span class="rssi-bar" style="width:72px"><i style="width:${Math.min(100, tablePct)}%;background:${tablePct >= 90 ? css('--critical') : tablePct >= 70 ? css('--warning') : css('--good')}"></i></span>${s.dev_count} of 160` : '–'],
        ['Dropped last cycle', s.dropped != null ? fmt(s.dropped) : '–'],
        ['Scan cycles', s.cycles != null ? fmt(s.cycles) : '–'],
        ['Firmware', esc(s.fw || '–')],
        ['Chip', esc(s.chip || '–')],
        ['Sensor MAC', s.mac ? `<span class="mono">${esc(s.mac)}</span>` : '–'],
      ])}
    </section>`;
  const o = baseOptions();
  o.plugins.tooltip.callbacks = { label: c => ` ${fmt(c.raw)} people` };
  const h0 = Math.floor(state.fleet.now / 3600) * 3600 - 23 * 3600;
  draw('cSensor', { type: 'bar', data: {
    labels: s.spark.map((_, i) => tickLabel(h0 + i * 3600, 3600)),
    datasets: [{ ...barDs('People', s.spark, css('--s1')), borderWidth: 0 }],
  }, options: o }, { live: true });
}
$('#sheetBody').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || state.sheet?.kind !== 'sensor') return;
  const s = sensorById(state.sheet.id);
  if (!s) return;
  if (act === 'audience' || act === 'live') { setScope(s.id); closeSheet(); location.hash = act; }
  if (act === 'rotate') rotateKey(s);
  if (act === 'delete') {
    const ok = await dialog({ title: `Delete “${s.name}”?`, body: 'The sensor will stop being able to report. Its audience history stays in the database. This can’t be undone.', confirm: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api(`/api/fleet/${s.id}`, { method: 'DELETE' });
      if (state.scope === s.id) setScope(null);
      closeSheet(); toast(`Deleted ${s.name}`); loadFleet().catch(netError);
    } catch (err) { toast(err.message, 'error'); }
  }
});
async function rotateKey(s) {
  const ok = await dialog({ title: 'Rotate API key?', body: `${s.name} will stop reporting until you flash a config.h with the new key.`, confirm: 'Rotate key', danger: true });
  if (!ok) return;
  try {
    const { api_key } = await api(`/api/fleet/${s.id}/rotate-key`, { method: 'POST' });
    const masked = api_key.slice(0, 6) + '•'.repeat(12) + api_key.slice(-4);
    const p = dialog({ title: 'New key issued', html: true, cancel: null, confirm: 'Done',
      body: `<p>Download the new config.h and flash it to the sensor. The old key no longer works.</p>
        <div class="secret" style="margin-top:14px"><span>${masked}</span><button type="button" class="btn sm" id="copyKey">Copy</button></div>
        <div class="actions-row" style="justify-content:flex-start;margin-top:12px"><a class="btn primary" href="/api/fleet/${s.id}/config.h" download="config.h">Download config.h</a></div>` });
    $('#copyKey').onclick = () => navigator.clipboard.writeText(api_key).then(() => toast('Key copied'), () => toast('Couldn’t copy', 'error'));
    await p;
  } catch (err) { toast(err.message, 'error'); }
}

// ---------------------------------------------------------------- add billboard (onboarding)
function openAddSensor() {
  openSheet('add');
  setSheetHead('New sensor', 'Add a billboard');
  $('#sheetBody').innerHTML = `
    <section><p class="sub" style="margin-top:0">You’ll get a <code>config.h</code> with this billboard’s key, WiFi and server address filled in. Flash it to an ESP32 and it reports on its own.</p></section>
    <section>
      <form class="form" id="addForm">
        <div class="field"><label for="afName">Billboard name</label><input id="afName" type="text" required maxlength="80" placeholder="Main Street, northbound" autocomplete="off">
          <div class="help">Shown across the dashboard. You can rename it later.</div></div>
        <div class="field"><label for="afLoc">Location <span class="muted">(optional)</span></label><input id="afLoc" type="text" maxlength="160" placeholder="123 Main St, opposite the station" autocomplete="off"></div>
        <button type="submit" class="btn primary block">Create and download config.h</button>
      </form>
    </section>`;
  setTimeout(() => $('#afName')?.focus(), 380);
  $('#addForm').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const s = await api('/api/fleet', json('POST', { name: $('#afName').value.trim(), location: $('#afLoc').value.trim() }));
      downloadConfig(s.id);
      state.sheet.id = s.id;
      setSheetHead(statusChip('pending'), s.name);
      $('#sheetBody').innerHTML = `
        <section><div class="callout">${SEV.ok}<span><b>config.h downloaded.</b> Three steps to get ${esc(s.name)} on the air:</span></div></section>
        <section><ol class="steps">
          <li><span>Put the downloaded <code>config.h</code> in <code>firmware/src/</code>, replacing the one there.</span></li>
          <li><span>Connect the ESP32 by USB and run <b>flash.bat</b> (or <code>./flash.sh</code>).</span></li>
          <li><span>Mount it at the billboard and power it on. It joins WiFi and checks in by itself.</span></li>
        </ol></section>
        <section id="addWaiting"></section>
        <section class="actions-row">
          <button type="button" class="btn" id="againBtn">Download config.h again</button>
          <button type="button" class="btn primary" id="doneBtn">Done</button>
        </section>`;
      $('#againBtn').onclick = () => downloadConfig(s.id);
      $('#doneBtn').onclick = () => { const id = s.id; closeSheet(); if (sensorById(id)) openSensor(id); };
      await loadFleet();
      renderAddWaiting();
    } catch (err) { btn.disabled = false; toast(err.message, 'error'); }
  };
}
function downloadConfig(id) {
  const a = document.createElement('a');
  a.href = `/api/fleet/${id}/config.h`; a.download = 'config.h'; a.click();
}
function renderAddWaiting() {
  const box = $('#addWaiting'), s = sensorById(state.sheet?.id);
  if (!box || !s) return;
  const live = s.status !== 'pending';
  setSheetHead(statusChip(s.status), s.name);
  box.innerHTML = live
    ? `<div class="callout">${SEV.ok}<span><b>Connected.</b> ${esc(s.name)} checked in ${ago(s.last_seen)} and is sending data.</span></div>`
    : `<div class="waiting"><span class="spinner"></span>Waiting for the first check-in…</div>`;
}

// ---------------------------------------------------------------- audience
const KPI_DEFS = [
  ['est_people', 'People', v => fmt(v), 'Unique identities divided by devices per person'],
  ['unique_devices', 'Unique devices', v => fmt(v), 'Distinct radios heard above the passer-by threshold'],
  ['viewers', 'Viewers', v => fmt(v), 'Identities that came within viewing distance'],
  ['impressions', 'Impressions', v => fmt(v), 'Viewer visits lasting at least the minimum dwell'],
  ['avg_dwell', 'Avg view dwell', v => dur(v), 'Mean length of an impression'],
  ['engagement_rate', 'Engagement', v => `${fmt(v)}%`, 'Viewers as a share of everyone in range'],
  ['return_rate', 'Return rate', v => `${fmt(v)}%`, 'Stable devices in range that were first seen before this period', true],
];
const RANGE_PREV = { '1h': 'previous hour', today: 'same time yesterday', '24h': 'previous 24 h', '7d': 'previous 7 days', '30d': 'previous 30 days' };
function kpiTile(label, value, delta = '', tipText = '') {
  return `<div class="kpi"><div class="lbl">${label}${tipText ? ` <span class="info-tip" data-tip="${esc(tipText)}">i</span>` : ''}</div><div class="val">${value}</div>${delta}</div>`;
}

async function loadAudience() {
  const [s, h, b] = await Promise.all([
    api(`/api/summary?${qs({ range: state.range })}`),
    api(`/api/heatmap?${qs({ days: 28 })}`),
    api(`/api/bands?${qs({ range: state.range === 'today' ? '24h' : state.range })}`),
  ]);
  Object.assign(state.data, { summary: s, heatmap: h, bands: b });
  renderSummary(s); renderHeatmap(h); renderRings(b); renderTypeBands(b);
}

function renderSummary(s) {
  const k = s.kpis, p = s.prev;
  const scopeTxt = state.scope ? sensorName(state.scope) : 'all billboards';
  $('#audLede').textContent = `${scopeTxt[0].toUpperCase() + scopeTxt.slice(1)}${s.excluded ? ` · ${s.excluded} staff or fixed devices excluded` : ''}`;
  // Heads-up share rides on the Viewers tile so the grid stays 4 + 4
  const headsUp = k.heads_up_rate != null
    ? `<span class="delta" data-tip="Share of ${plural(k.heads_up_n, 'iPhone viewer')} whose screen was off or idle: more likely looking up at the billboard than at their phone">${fmt(k.heads_up_rate)}% heads-up</span>` : '';
  $('#kpis').innerHTML = KPI_DEFS.map(([key, label, f, t, noDelta]) =>
    kpiTile(label, f(k[key]), (noDelta ? '<span class="delta">Stable IDs only</span>' : deltaHtml(k[key], p?.[key], `vs ${RANGE_PREV[s.range] || 'previous'}`))
      + (key === 'viewers' && headsUp ? `<div>${headsUp}</div>` : ''), t)).join('')
    + kpiTile('Busiest', k.peak_t ? tickLabel(k.peak_t, s.bucket) : '–', k.peak_t ? `<span class="delta">${plural(k.peak_people, 'person', 'people')}</span>` : '', 'The time bucket with the most people');

  // Billboard comparison (fleet scope, 2+ sensors)
  const by = (s.by_sensor || []).filter(r => r.id || r.est_people);
  const showCompare = !state.scope && (state.fleet?.sensors.length || 0) > 1;
  $('#compareCard').classList.toggle('hidden', !showCompare);
  if (showCompare) {
    const rows = (state.fleet.sensors.map(x => by.find(r => r.id === x.id) || { id: x.id, est_people: 0, viewers: 0, impressions: 0, avg_dwell: 0, engagement_rate: 0 }))
      .concat(by.filter(r => !r.id)).sort((a, b) => b.est_people - a.est_people);
    const max = Math.max(1, ...rows.map(r => r.est_people));
    $('#compareNote').textContent = 'Select a row to focus on that billboard';
    $('#compareTable').innerHTML = `<thead><tr><th>Billboard</th><th class="num">People</th><th class="num">Viewers</th><th class="num">Impressions</th><th class="num">Avg dwell</th><th class="num">Engagement</th></tr></thead><tbody>` +
      rows.map(r => `<tr class="${r.id ? 'click' : ''}" ${r.id ? `data-scope="${r.id}"` : ''}>
        <td>${r.id ? `<span class="status-dot ${sensorById(r.id)?.status || 'pending'}" style="display:inline-block;margin-right:8px"></span>` : ''}<span class="strong">${esc(sensorName(r.id))}</span></td>
        <td class="num"><span class="cell-bar"><i style="width:${Math.round(90 * r.est_people / max)}px"></i>${fmt(r.est_people)}</span></td>
        <td class="num">${fmt(r.viewers)}</td><td class="num">${fmt(r.impressions)}</td>
        <td class="num">${r.avg_dwell ? dur(r.avg_dwell) : '–'}</td><td class="num">${fmt(r.engagement_rate)}%</td></tr>`).join('') + '</tbody>';
  }

  const labels = s.series.map(r => tickLabel(r.t, s.bucket));
  const optsP = baseOptions();
  optsP.plugins.endLabels.enabled = true;
  optsP.layout = { padding: { top: 20 } };
  draw('cPeople', { type: 'line', data: { labels, datasets: [lineDs('People', s.series.map(r => r.people), css('--s3'), true)] }, options: optsP });
  draw('cZones', { type: 'bar', data: { labels, datasets: [
    barDs('Viewers', s.series.map(r => r.viewers), css('--s1')),
    barDs('Passers-by', s.series.map(r => r.passersby), css('--s2')),
  ] }, options: baseOptions({ stacked: true, legend: true }) });
  $('#tbl-people').innerHTML = table(['Time', 'People'], s.series.map(r => [tickLabel(r.t, s.bucket), fmt(r.people)]));
  $('#tbl-zones').innerHTML = table(['Time', 'Viewers', 'Passers-by'], s.series.map(r => [tickLabel(r.t, s.bucket), r.viewers, r.passersby]));

  draw('cDwell', { type: 'bar', data: { labels: s.dwell.map(d => d.label), datasets: [
    barDs('Viewers', s.dwell.map(d => d.viewers), css('--s1')),
    barDs('Passers-by', s.dwell.map(d => d.passersby), css('--s2')),
  ] }, options: baseOptions({ stacked: true, legend: true }) });
  draw('cVendors', { type: 'bar', data: { labels: s.vendors.map(v => v.name), datasets: [
    { ...barDs('Devices', s.vendors.map(v => v.count), css('--s1')), borderWidth: 0 },
  ] }, options: baseOptions({ horizontal: true }) });
  $('#kindsNote').textContent = `WiFi ${fmt(s.kinds.wifi || 0)} · BLE ${fmt(s.kinds.ble || 0)}`;
}
$('#compareTable').addEventListener('click', e => { const r = e.target.closest('[data-scope]'); if (r) setScope(r.dataset.scope); });
$$('[data-table]').forEach(b => b.onclick = () => {
  const el = $('#tbl-' + b.dataset.table);
  el.classList.toggle('hidden');
  b.textContent = el.classList.contains('hidden') ? 'Show table' : 'Hide table';
});
segment('#rangeSeg', 'range', r => { state.range = r; loadAudience().catch(netError); });

function renderHeatmap(h) {
  const max = Math.max(1, ...h.grid.flat());
  const steps = seqSteps();
  let html = '<div></div>' + Array.from({ length: 24 }, (_, i) => `<div class="hh">${i}</div>`).join('');
  h.grid.forEach((row, wd) => {
    html += `<div class="hl">${DOW[wd]}</div>` + row.map((v, hr) =>
      `<div class="cell" style="background:${seqCell(v, max, steps).bg}" data-tip="${DOW[wd]} ${hr}:00–${hr + 1}:00 · ${fmt(v)} people per hour"></div>`).join('');
  });
  const ramp = `<div class="legend-ramp" style="grid-column:1/-1"><span>0</span>${[css('--seq-0'), ...steps].map(c => `<span class="sw" style="background:${c}"></span>`).join('')}<span>${fmt(max)} people per hour</span></div>`;
  $('#heatmap').innerHTML = html + ramp;
}

// Traffic rings: unique devices per distance band, WiFi left half, BLE right half
function sector(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}
function renderRings(b) {
  const cx = 210, cy = 210, inner = 26, outer = 196, n = b.bands.length;
  const step = (outer - inner) / n;
  const max = Math.max(1, ...b.wifi, ...b.ble);
  const steps = seqSteps();
  const gap = 0.012;
  let out = '';
  b.bands.forEach((band, i) => {
    const r0 = inner + i * step + 1, r1 = inner + (i + 1) * step - 1, mid = (r0 + r1) / 2;
    for (const [kind, a0, a1, lx] of [['wifi', Math.PI / 2 + gap, Math.PI * 1.5 - gap, cx - mid], ['ble', -Math.PI / 2 + gap, Math.PI / 2 - gap, cx + mid]]) {
      const v = b[kind][i], c = seqCell(v, max, steps);
      out += `<path d="${sector(cx, cy, r0, r1, a0, a1)}" fill="${c.bg}" data-tip="${kind === 'wifi' ? 'WiFi' : 'BLE'} · ${band.label}: ${fmt(v)} devices"/>`;
      if (step > 16) out += `<text x="${lx}" y="${cy + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="${c.ink}" pointer-events="none">${v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v}</text>`;
    }
    out += `<text x="${cx}" y="${cy - mid + 4}" text-anchor="middle" font-size="10" fill="${css('--muted')}" pointer-events="none">${band.label}</text>`;
  });
  out += `<text x="${cx - outer + 6}" y="22" font-size="13" font-weight="600" fill="${css('--text-2')}">WiFi ${fmt(b.wifi.reduce((a, x) => a + x, 0))}</text>`;
  out += `<text x="${cx + outer - 6}" y="22" text-anchor="end" font-size="13" font-weight="600" fill="${css('--text-2')}">BLE ${fmt(b.ble.reduce((a, x) => a + x, 0))}</text>`;
  out += `<circle cx="${cx}" cy="${cy}" r="4" fill="${css('--text')}"/>`;
  $('#rings').innerHTML = out;
  $('#ringsLegend').innerHTML = `<span>0</span>${[css('--seq-0'), ...steps].map(c => `<span class="sw" style="background:${c}"></span>`).join('')}<span>${fmt(max)} devices</span>`;
}
function renderTypeBands(b) {
  const max = Math.max(1, ...b.types.flatMap(t => t.bands));
  const steps = seqSteps();
  const cell = v => { const c = seqCell(v, max, steps); return `<td class="c" style="background:${c.bg};color:${c.ink}">${fmt(v)}</td>`; };
  const types = b.types.slice().sort((x, y) => TYPE_ORDER.indexOf(x.key) - TYPE_ORDER.indexOf(y.key));
  $('#typeBands').innerHTML = `<thead><tr><th>Type</th>${b.bands.map(x => `<th class="num">${x.label}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>` +
    (types.length ? types.map(t => `<tr><td><span class="tsw" style="background:${typeColor(t.key)}"></span>${t.label}</td>${t.bands.map(cell).join('')}<td class="num strong">${fmt(t.total)}</td></tr>`).join('')
      : `<tr class="empty-row"><td colspan="${b.bands.length + 2}">No traffic yet</td></tr>`) + '</tbody>';
}

// ---------------------------------------------------------------- live
async function loadLive() {
  const l = await api(`/api/live?${qs()}`);
  state.data.live = l;
  renderLive(l);
}
function rssiCell(r) {
  const pct = Math.max(0, Math.min(100, (r + 100) * 2));
  return `<span class="rssi-bar"><i style="width:${pct}%"></i></span>${r} dBm`;
}
const zoneSw = z => z === 'viewer' ? `<span class="sw-inline" style="background:${css('--s1')}"></span>Viewer`
  : z === 'passerby' ? `<span class="sw-inline" style="background:${css('--s2')}"></span>Passer-by` : '<span class="muted">Far</span>';
function typeCell(d) {
  const t = d.dev_type || d.type || 'other';
  const title = d.name || d.model || d.vendor || '';
  return `<span class="tsw" style="background:${typeColor(t)}"></span>${esc(title) || '<span class="muted">Unknown</span>'}` +
    `<div class="muted small">${TYPE_NAMES[t] || 'Other'}${d.confidence === 'low' ? ' (guess)' : ''}${d.model && d.name && d.model !== d.name ? ' · ' + esc(d.model) : ''}</div>`;
}
function renderLive(l) {
  $('#liveNow').textContent = fmt(l.est_people_now);
  $('#liveZones').innerHTML = `<span><span class="sw-inline" style="background:${css('--s1')}"></span><b>${l.zones.viewer}</b>viewers</span>
    <span><span class="sw-inline" style="background:${css('--s2')}"></span><b>${l.zones.passerby}</b>passers-by</span><span><b>${l.zones.far}</b>far</span>`;
  draw('cLive', { type: 'bar', data: { labels: l.minutes.map(m => tickLabel(m.t, 60)), datasets: [
    barDs('Viewers', l.minutes.map(m => m.viewers), css('--s1')),
    barDs('Passers-by', l.minutes.map(m => m.passersby), css('--s2')),
  ] }, options: { ...baseOptions({ stacked: true, legend: true }), animation: false } }, { live: true });
  $('#liveTable').innerHTML = `<thead><tr><th>Device</th><th>Tag</th><th>Radio</th><th>Signal</th><th>Zone</th><th>Seen</th></tr></thead><tbody>` +
    (l.devices.length ? l.devices.map(d => `<tr class="click" data-dev="${d.id}">
      <td>${typeCell(d)}</td><td>${esc(d.label) || '<span class="muted">–</span>'}</td>
      <td>${d.kind === 'wifi' ? 'WiFi' : 'BLE'}${d.randomized ? ' <span class="tag">random</span>' : ''}</td>
      <td>${rssiCell(d.last_rssi)}</td><td>${zoneSw(d.zone)}</td><td class="muted">${ago(d.last_seen)}</td></tr>`).join('')
      : `<tr class="empty-row"><td colspan="6">Nobody in range right now</td></tr>`) + '</tbody>';
}

// ---------------------------------------------------------------- retention
async function loadRetention() {
  const r = await api(`/api/retention?${qs({ days: state.retDays })}`);
  state.data.retention = r;
  renderRetention(r);
}
function renderRetention(r) {
  const totalNew = r.daily.reduce((a, d) => a + d.new, 0), totalRet = r.daily.reduce((a, d) => a + d.returning, 0);
  const d1 = r.cohorts.filter(c => c.ret[0] != null), d7 = r.cohorts.filter(c => c.ret[6] != null);
  const avg = (arr, i) => arr.length ? arr.reduce((a, c) => a + c.ret[i] * c.size, 0) / arr.reduce((a, c) => a + c.size, 0) : null;
  const a1 = avg(d1, 0), a7 = avg(d7, 6);
  $('#retKpis').innerHTML = [
    kpiTile('Tracked devices', fmt(r.total), '', 'Devices with a stable identity seen in this period'),
    kpiTile('Repeat visitors', `${fmt(r.repeat_rate)}%`, '', 'Seen on more than one day'),
    kpiTile('Day-1 retention', a1 == null ? '–' : `${a1.toFixed(1)}%`, '', 'Share of new devices seen again the next day'),
    kpiTile('Day-7 retention', a7 == null ? '–' : `${a7.toFixed(1)}%`, '', 'Share of new devices seen again 7 days later'),
    kpiTile('New device-days', fmt(totalNew)),
    kpiTile('Returning device-days', fmt(totalRet)),
  ].join('');
  $('#retNote').textContent = r.stable_only
    ? 'Only non-rotating addresses and tagged devices count here. Phones rotate random addresses, which would look like churn.'
    : 'Includes rotating random addresses, so retention will read lower than it really is.';
  const labels = r.daily.map(d => tickLabel(d.t, 86400));
  draw('cNewRet', { type: 'bar', data: { labels, datasets: [
    barDs('New', r.daily.map(d => d.new), css('--s1')),
    barDs('Returning', r.daily.map(d => d.returning), css('--s2')),
  ] }, options: baseOptions({ stacked: true, legend: true }) });
  draw('cFreq', { type: 'bar', data: { labels: r.frequency.map(f => f.label), datasets: [
    barDs('Devices', r.frequency.map(f => f.count), css('--s1')),
  ] }, options: baseOptions() });
  const steps = seqSteps();
  const maxRet = Math.max(1, ...r.cohorts.flatMap(c => c.ret.filter(x => x != null)));
  const cell = v => {
    if (v == null) return '<td class="c"></td>';
    const c = seqCell(v, maxRet, steps);
    return `<td class="c" style="background:${c.bg};color:${c.ink}" data-tip="${fmt(v)}% came back">${fmt(v)}%</td>`;
  };
  $('#cohortTable').innerHTML = `<thead><tr><th>First seen</th><th class="num">Devices</th>${[1, 2, 3, 4, 5, 6, 7].map(k => `<th class="num">D${k}</th>`).join('')}</tr></thead><tbody>` +
    (r.cohorts.length ? r.cohorts.slice().reverse().map(c => `<tr><td>${tickLabel(c.t, 86400)}</td><td class="num">${c.size}</td>${c.ret.map(cell).join('')}</tr>`).join('')
      : '<tr class="empty-row"><td colspan="9">Not enough history yet</td></tr>') + '</tbody>';
}
segment('#retSeg', 'days', d => { state.retDays = +d; loadRetention().catch(netError); });

// ---------------------------------------------------------------- devices
let searchTimer;
$('#devSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadDevices().catch(netError), 250); };
['#taggedOnly', '#devKind', '#devType'].forEach(s => $(s).onchange = () => loadDevices().catch(netError));
$('#devType').innerHTML = '<option value="">All types</option>' + TYPE_ORDER.map(t => `<option value="${t}">${TYPE_NAMES[t]}</option>`).join('');
segment('#devSeg', 'range', r => { state.devRange = r; renderScope(); loadDevices().catch(netError); });

async function loadDevices({ force = false } = {}) {
  const params = { range: state.devRange, q: $('#devSearch').value.trim(), tagged: $('#taggedOnly').checked, kind: $('#devKind').value, type: $('#devType').value };
  const rows = await api(`/api/devices?${qs(params)}`);
  // don't clobber a tag the user is typing
  if (!force && document.activeElement?.closest('#devTable')) return;
  $('#devCount').textContent = `${fmt(rows.length)}${rows.length >= 500 ? '+' : ''} device${rows.length === 1 ? '' : 's'}`;
  $('#devTable').innerHTML = `<thead><tr><th>Device</th><th>Tag</th><th>Radio</th><th>Vendor</th><th class="num">Distance</th><th class="num">Visits</th><th class="num">Days</th>
    <th class="num">Time in range</th><th class="num">Peak</th><th>First seen</th><th>Last seen</th><th>Ignore</th></tr></thead><tbody>` +
    (rows.length ? rows.map(d => `<tr class="click" data-dev="${d.id}">
      <td>${typeCell(d)}</td>
      <td><input type="text" data-label="${d.id}" value="${esc(d.label)}" placeholder="Add tag" aria-label="Tag for device ${d.id}"></td>
      <td>${radioName(d.kind)} ${d.randomized ? '<span class="tag">random</span>' : '<span class="tag">stable</span>'}${d.fixture ? '<span class="tag">fixture</span>' : ''}${d.details?.connected ? '<span class="tag">connected</span>' : ''}</td>
      <td>${esc(d.vendor) || '<span class="muted">–</span>'}</td>
      <td class="num">${d.distance != null ? fmt(d.distance) + ' m' : '–'}</td>
      <td class="num">${d.visits}</td><td class="num">${d.days_seen}</td><td class="num">${dur(d.total_dwell)}</td>
      <td class="num">${d.peak_rssi != null ? d.peak_rssi + ' dBm' : '–'}</td>
      <td class="muted">${dateTime(d.first_seen)}</td><td class="muted">${ago(d.last_seen)}</td>
      <td><input type="checkbox" data-ignore="${d.id}" ${d.ignored ? 'checked' : ''} aria-label="Ignore device ${d.id}"></td></tr>`).join('')
      : `<tr class="empty-row"><td colspan="12">No devices match</td></tr>`) + '</tbody>';
}
const patchDevice = (id, body) => api(`/api/devices/${id}`, json('PATCH', body))
  .then(() => toast(body.label !== undefined ? (body.label ? `Tagged “${body.label}”` : 'Tag removed') : body.ignored ? 'Device ignored' : 'Device counted again'))
  .catch(err => toast(err.message, 'error'));
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.label) patchDevice(t.dataset.label, { label: t.value.trim() });
  if (t.dataset.ignore) patchDevice(t.dataset.ignore, { ignored: t.checked });
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset?.label) e.target.blur(); });
document.addEventListener('click', e => {
  const row = e.target.closest('tr[data-dev]');
  if (row && !e.target.closest('input')) openDevice(row.dataset.dev);
});

async function openDevice(id) {
  let d;
  try { d = await api(`/api/devices/${id}`); } catch (err) { toast(err.message, 'error'); return; }
  state.data.device = d;
  const dev = d.device, x = dev.details || {};
  const t = dev.dev_type || 'other';
  openSheet('device', id);
  setSheetHead(`<span class="chip"><span class="tsw" style="background:${typeColor(t)};margin:0"></span>${TYPE_NAMES[t] || 'Other'}${dev.confidence === 'low' ? ' (guess)' : ''}</span><span>${radioName(dev.kind)}${dev.randomized ? ' · random address' : ''}</span>`,
    dev.label || dev.name || dev.model || dev.id);
  const rows = [
    ['Identified as', dev.model || '–'], ['Name', dev.name || '–'], ['Vendor', dev.vendor || '–'],
    ['Distance now', dev.distance != null ? `≈ ${fmt(dev.distance)} m (${dev.last_rssi} dBm)` : '–'],
    ...(x.activity_label ? [['Phone state', x.activity_label]] : []),
    ...(dev.linked_addresses > 1 ? [['Grouped addresses', `${dev.linked_addresses} rotating addresses linked as one device`]] : []),
    ...(dev.linked_from ? [['Linked from', `${dev.linked_from} (score ${fmt(dev.link_score)})`]] : []),
    ...(x.wifi_gen ? [['WiFi standard', x.wifi_gen]] : []),
    ...(x.ssids?.length ? [['Looks for networks', x.ssids.join(', ')]] : []),
    ...(x.connected ? [['Connected to', `AP ${x.bssid || ''}`]] : []),
    ...(x.wps_name || x.wps_model ? [['WPS device', [x.wps_name, x.wps_model].filter(Boolean).join(' · ')]] : []),
    ...(x.vendor_ies?.length ? [['Chipset tags', x.vendor_ies.join(', ')]] : []),
    ...(x.services?.length ? [['BLE services', x.services.join(', ')]] : []),
    ...(x.appearance ? [['BLE appearance', x.appearance]] : []),
    ...(x.tx_power != null ? [['Advertised TX power', `${x.tx_power} dBm`]] : []),
    ...(x.ssid ? [['Network name', x.ssid]] : []),
    ...(x.channel ? [['Channel', x.channel]] : []),
    ['First seen', dateTime(dev.first_seen)], ['Last seen', ago(dev.last_seen)],
    ['Visits', d.visits.length >= 100 ? '100+' : d.visits.length],
    ['Fingerprint', dev.fp || '–'], ['Device ID', dev.id],
  ];
  $('#sheetBody').innerHTML = `
    <section>
      <div class="form">
        <div class="field"><label for="dvLabel">Tag</label><input id="dvLabel" type="text" data-label="${dev.id}" value="${esc(dev.label)}" placeholder="e.g. Shop staff 1"></div>
        <div class="set-row group" style="padding:12px 14px">
          <div><label for="dvIgnore">Ignore this device</label><div class="help">Leave it out of every audience number: staff, your own phone, fixed equipment.</div></div>
          <span class="switch"><input type="checkbox" id="dvIgnore" data-ignore="${dev.id}" ${dev.ignored ? 'checked' : ''}><span class="track"></span><span class="knob"></span></span>
        </div>
      </div>
    </section>
    <section><h4>Signal, last 24 h</h4><div class="chart small"><canvas id="cDevice"></canvas></div></section>
    <section><h4>About</h4><dl class="kv group">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>
    <section><h4>Recent visits</h4><div class="group" style="padding:2px 10px">${table(['Start', 'Dwell', 'Peak', 'Phone'],
      d.visits.slice(0, 30).map(v => [dateTime(v.start), dur(v.dwell), `${v.max_rssi} dBm`, phoneState(v)]), 1)}</div></section>`;
  renderDeviceChart(d);
}
function renderDeviceChart(d) {
  const o = baseOptions();
  o.scales.y.beginAtZero = false;
  o.scales.y.suggestedMin = -100; o.scales.y.suggestedMax = -30;
  o.scales.y.ticks.callback = v => v;
  draw('cDevice', { type: 'line', data: { labels: d.rssi.map(r => tickLabel(r.t, 60)), datasets: [
    { ...lineDs('Signal (dBm)', d.rssi.map(r => r.rssi), css('--s1')), spanGaps: false, pointRadius: d.rssi.length < 30 ? 4 : 0, pointBackgroundColor: css('--s1'), pointBorderColor: css('--surface'), pointBorderWidth: 2 },
  ] }, options: o });
}
// Per-visit phone-attention summary from idle/in-use sighting counts
function phoneState(v) {
  if (!v.phone_idle && !v.phone_use) return '<span class="muted">–</span>';
  return v.phone_idle >= v.phone_use ? '<span title="Screen off or idle: likely heads-up">Heads-up</span>' : '<span title="Screen on: likely looking at the phone">In use</span>';
}

// ---------------------------------------------------------------- settings
const SETTING_GROUPS = [
  ['General', [
    ['billboard_name', 'Network name', 'Shown at the top of the sidebar', 'text'],
  ]],
  ['Audience zones', [
    ['viewer_rssi', 'Viewer threshold', 'Peak signal at or above this counts as close enough to see the billboard. Calibrate by standing where viewers stand.', 'number', 'dBm'],
    ['passer_rssi', 'Passer-by threshold', 'Weaker sightings are ignored entirely.', 'number', 'dBm'],
  ]],
  ['Visits', [
    ['visit_gap_s', 'Visit timeout', 'A device unseen this long has left; its next sighting starts a new visit.', 'number', 's'],
    ['min_dwell_s', 'Minimum dwell for an impression', 'Viewer visits shorter than this don’t count as impressions.', 'number', 's'],
  ]],
  ['People estimate', [
    ['devices_per_person', 'Devices per person', 'Average detectable radios a person carries (phone, watch, earbuds). Device counts are divided by this.', 'number'],
    ['link_addresses', 'Link rotating addresses', 'Group random addresses that rotate on the same phone so one person counts once.', 'bool'],
  ]],
  ['Exclusions', [
    ['auto_exclude_fixtures', 'Auto-exclude fixtures', 'Ignore devices that are almost always present, like shop TVs and routers.', 'bool'],
    ['fixture_minutes_6h', 'Fixture threshold', 'Present this many minutes out of the last 360 makes a device a fixture.', 'number', 'min'],
  ]],
  ['Retention', [
    ['retention_stable_only', 'Stable IDs only', 'Leave rotating random addresses out of retention.', 'bool'],
  ]],
  ['Radar calibration', [
    ['rssi_1m_ble', 'BLE signal at 1 m', 'Hold a phone 1 m from the sensor and read its BLE signal.', 'number', 'dBm'],
    ['rssi_1m_wifi', 'WiFi signal at 1 m', 'The same, for WiFi probes.', 'number', 'dBm'],
    ['path_loss_n', 'Path-loss exponent', '2 is open air; 2.7–3.5 is a street with people and walls. Higher values shrink distances.', 'number'],
  ]],
];
const ALL_SETTINGS = SETTING_GROUPS.flatMap(([, rows]) => rows);
function renderOrgName(s) {
  $('#orgName').textContent = s.billboard_name && s.billboard_name !== 'Billboard #1' ? s.billboard_name : 'Billboard Fleet';
}
async function loadSettings() {
  const s = await api('/api/settings');
  state.settings = s;
  renderOrgName(s);
  if (state.page !== 'settings' || $('#settingsForm').dataset.dirty) return;
  const input = ([k, label, help, type, unit]) => type === 'bool'
    ? `<span class="switch"><input id="set-${k}" name="${k}" type="checkbox" ${+s[k] ? 'checked' : ''}><span class="track"></span><span class="knob"></span></span>`
    : `<span><input id="set-${k}" name="${k}" type="${type}" ${type === 'number' ? 'step="any" inputmode="decimal"' : ''} value="${esc(s[k])}">${type === 'number' ? `<span class="unit">${unit || ''}</span>` : ''}</span>`;
  $('#settingsForm').innerHTML = `
    <div class="set-group"><h4>Appearance</h4><div class="card"><div class="set-row">
      <div><label>Theme</label><div class="help">Saved on this device only.</div></div>
      <div class="seg" id="themeSeg"><span class="seg-thumb"></span>${THEMES.map(t => `<button type="button" data-theme="${t}" class="${currentTheme() === t ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    </div></div></div>` +
    SETTING_GROUPS.map(([title, rows]) => `<div class="set-group"><h4>${title}</h4><div class="card">${rows.map(r =>
      `<div class="set-row"><div><label for="set-${r[0]}">${r[1]}</label><div class="help">${r[2]}</div></div>${input(r)}</div>`).join('')}</div></div>`).join('') +
    `<div class="save-bar" id="saveBar"><span class="small">Unsaved changes</span><div class="actions-row">
      <button type="button" class="btn" id="revertBtn">Revert</button><button type="submit" class="btn primary">Save</button></div></div>`;
  segment('#themeSeg', 'theme', setTheme);
  syncThumbs();
  $('#revertBtn').onclick = () => { delete $('#settingsForm').dataset.dirty; loadSettings().catch(netError); };
}
$('#settingsForm').addEventListener('input', e => {
  if (!e.target.name) return;
  $('#settingsForm').dataset.dirty = '1';
  $('#saveBar').classList.add('show');
});
$('#settingsForm').onsubmit = async e => {
  e.preventDefault();
  const body = {};
  ALL_SETTINGS.forEach(([k, , , type]) => { const el = $(`[name="${k}"]`); body[k] = type === 'bool' ? (el.checked ? 1 : 0) : el.value; });
  try {
    const s = await api('/api/settings', json('PUT', body));
    state.settings = s; renderOrgName(s);
    delete $('#settingsForm').dataset.dirty;
    $('#saveBar').classList.remove('show');
    toast('Saved. History re-classified with the new thresholds.');
  } catch (err) { toast(err.message, 'error'); }
};

// ---------------------------------------------------------------- refresh loop
function refresh() {
  const p = state.page;
  const job = p === 'fleet' ? loadFleet() : p === 'audience' ? loadAudience() : p === 'live' ? loadLive()
    : p === 'retention' ? loadRetention() : p === 'devices' ? loadDevices() : p === 'settings' ? loadSettings() : null;
  if (p === 'live') window.Radar?.load();
  job?.catch(netError);
}
function skeleton() {
  $('#fleetSummary').innerHTML = '<div class="skeleton" style="height:236px"></div><div class="skeleton" style="height:236px"></div>';
  $('#fleetList').innerHTML = '<div class="sensor-grid">' + '<div class="skeleton" style="height:248px"></div>'.repeat(3) + '</div>';
}

// Poll at a pace that matches how fast each page's data changes
let tick = 0;
setInterval(() => {
  if (document.hidden) return;
  tick++;
  const p = state.page, add = state.sheet?.kind === 'add';
  if (p === 'live') loadLive().catch(() => {});
  if (p === 'fleet' || add || state.sheet?.kind === 'sensor' ? tick % 2 === 0 : tick % 6 === 0) loadFleet().catch(() => {});
  if (p === 'audience' && tick % 8 === 0) loadAudience().catch(() => {});
  if (p === 'devices' && tick % 4 === 0) loadDevices().catch(() => {});
}, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

skeleton();
api('/api/settings').then(s => { state.settings = s; renderOrgName(s); }).catch(() => {});
// Fleet first so the scope picker and names are ready, then the requested page
loadFleet().catch(netError).finally(() => go(location.hash.slice(1) || 'fleet'));
window.appReady = true;
if (window.initRadar) window.initRadar();
