// Billboard audience dashboard
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = (path, opts) => fetch(path, opts).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = n => (n == null ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dur = s => s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
const ago = ts => { const s = Date.now() / 1000 - ts; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const TYPE_NAMES = { phone: 'Phone', computer: 'Computer', wearable: 'Wearable', audio: 'Audio', tv: 'TV / media',
  tracker: 'Tracker / tag', ap: 'Access point', other: 'Other / unknown' };
// Type swatch + best available description, e.g. "AirPods Pro · Audio"
function typeCell(d) {
  const t = d.dev_type || d.type || 'other';
  const title = d.name || d.model || d.vendor || '';
  const guess = d.confidence === 'low' ? ' (guess)' : '';
  return `<span class="tsw" style="background:${css('--t-' + t)}"></span>${esc(title) || '<span class="muted">Unknown</span>'}` +
    `<div class="muted small">${TYPE_NAMES[t] || 'Other'}${guess}${d.model && d.name && d.model !== d.name ? ' · ' + esc(d.model) : ''}</div>`;
}
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = { tab: 'overview', range: '24h', retDays: 14, devRange: '24h', charts: {}, data: {} };

// ---------------------------------------------------------------- theme
function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { t ? localStorage.setItem('theme', t) : localStorage.removeItem('theme'); } catch (e) {}
  rerenderCharts();
}
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(dark ? 'light' : 'dark');
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderCharts);

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
      ctx.save(); ctx.fillStyle = css('--text-2'); ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.fillText(`${ds.label} ${fmt(ds.data[ds.data.length - 1])}`, pt.x, pt.y - 8);
      ctx.restore();
    });
  },
};
Chart.register(crosshair, endLabels);

function baseOptions({ stacked = false, legend = false, horizontal = false } = {}) {
  const grid = css('--grid'), muted = css('--muted');
  const valueAxis = { stacked, beginAtZero: true, grid: { color: grid, drawTicks: false }, border: { display: false },
    ticks: { color: muted, padding: 6, precision: 0, maxTicksLimit: 5 } };
  const catAxis = { stacked, grid: { display: false }, border: { color: css('--axis') },
    ticks: { color: muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 } };
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, position: 'top', align: 'end',
        labels: { color: css('--text-2'), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 } },
      tooltip: { backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text-2'),
        borderColor: css('--border'), borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true },
      endLabels: { enabled: false },
    },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}

function lineDs(label, data, color) {
  return { label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0,
    pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: css('--surface'), tension: 0.25, fill: false };
}
function barDs(label, data, color) {
  return { label, data, backgroundColor: color, borderColor: css('--surface'), borderWidth: { top: 2 },
    borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, categoryPercentage: 0.85, barPercentage: 0.9 };
}

function draw(id, config) {
  if (state.charts[id]) state.charts[id].destroy();
  const el = document.getElementById(id);
  if (!el) return;
  state.charts[id] = new Chart(el, config);
}

function rerenderCharts() {
  requestAnimationFrame(() => {
    if (state.data.summary) renderSummary(state.data.summary);
    if (state.data.heatmap) renderHeatmap(state.data.heatmap);
    if (state.data.live) renderLive(state.data.live);
    if (state.data.retention) renderRetention(state.data.retention);
    if (typeof radarState !== 'undefined' && radarState.bands) { renderRings(radarState.bands); renderTypeBands(radarState.bands); }
  });
}

function tickLabel(t, bucket) {
  const d = new Date(t * 1000);
  if (bucket >= 86400) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (bucket >= 3 * 3600) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.getHours() + ':00';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------- tabs
$$('.tabs button').forEach(b => b.onclick = () => {
  $$('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab));
  state.tab = b.dataset.tab;
  try { localStorage.setItem('tab', state.tab); } catch (e) {}
  refresh();
});
{
  let t = location.hash.slice(1);
  try { t = t || localStorage.getItem('tab'); } catch (e) {}
  if (t) $(`.tabs button[data-tab="${t}"]`)?.click();
}

function segment(sel, attr, onPick) {
  $$(sel + ' button').forEach(b => b.onclick = () => {
    $$(sel + ' button').forEach(x => x.classList.toggle('active', x === b));
    onPick(b.dataset[attr]);
  });
}
segment('#rangeSeg', 'range', r => { state.range = r; loadOverview(); });
segment('#retSeg', 'days', d => { state.retDays = +d; loadRetention(); });
segment('#devSeg', 'range', r => { state.devRange = r; $('#exportBtn').href = `/api/export/visits.csv?range=${r}`; loadDevices(); });

// ---------------------------------------------------------------- overview
const KPI_DEFS = [
  ['est_people', 'Est. people', v => fmt(v)],
  ['unique_devices', 'Unique devices', v => fmt(v)],
  ['viewers', 'Viewers (in view zone)', v => fmt(v)],
  ['impressions', 'Impressions', v => fmt(v)],
  ['avg_dwell', 'Avg view dwell', v => dur(v)],
  ['engagement_rate', 'Engagement rate', v => `${fmt(v)}%`],
  ['return_rate', 'Return rate', v => `${fmt(v)}%`],
];

function kpiTile(label, value, delta) {
  let d = '';
  if (delta != null && isFinite(delta)) {
    const cls = delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : '';
    const arrow = delta > 0.5 ? '▲' : delta < -0.5 ? '▼' : '•';
    d = `<div class="delta ${cls}">${arrow} ${Math.abs(delta).toFixed(0)}% vs prev.</div>`;
  }
  return `<div class="kpi"><div class="lbl">${label}</div><div class="val">${value}</div>${d}</div>`;
}

async function loadOverview() {
  const [s, h] = await Promise.all([api(`/api/summary?range=${state.range}`), api('/api/heatmap?days=28')]);
  state.data.summary = s; state.data.heatmap = h;
  renderSummary(s); renderHeatmap(h);
}

function renderSummary(s) {
  $('#bbName').textContent = s.settings.billboard_name;
  const k = s.kpis, p = s.prev;
  $('#kpis').innerHTML = KPI_DEFS.map(([key, label, f]) => {
    const delta = p && p[key] ? (100 * (k[key] - p[key]) / p[key]) : null;
    return kpiTile(label, f(k[key]), key === 'return_rate' ? null : delta);
  }).join('') + kpiTile('Peak', k.peak_t ? tickLabel(k.peak_t, s.bucket) : '–', null)
    + (k.heads_up_rate != null ? kpiTile(`Heads-up viewers <span class="muted" title="Share of iPhone viewers whose screen was off/idle — more likely looking up at the billboard than at their phone. Based on ${k.heads_up_n} classified viewers.">ⓘ</span>`, `${fmt(k.heads_up_rate)}%`, null) : '');
  $('#excludedNote').textContent = s.excluded ? `${s.excluded} ignored / fixture devices excluded` : '';

  const labels = s.series.map(r => tickLabel(r.t, s.bucket));
  const optsP = baseOptions();
  optsP.plugins.endLabels.enabled = true;
  optsP.layout = { padding: { top: 18 } };
  draw('cPeople', { type: 'line', data: { labels, datasets: [lineDs('People', s.series.map(r => r.people), css('--s3'))] }, options: optsP });
  draw('cZones', { type: 'bar', data: { labels, datasets: [
    barDs('Viewers', s.series.map(r => r.viewers), css('--s1')),
    barDs('Passers-by', s.series.map(r => r.passersby), css('--s2')),
  ] }, options: baseOptions({ stacked: true, legend: true }) });

  $('#tbl-people').innerHTML = table(['Time', 'Est. people'], s.series.map(r => [tickLabel(r.t, s.bucket), fmt(r.people)]));
  $('#tbl-zones').innerHTML = table(['Time', 'Viewers', 'Passers-by'], s.series.map(r => [tickLabel(r.t, s.bucket), r.viewers, r.passersby]));

  draw('cDwell', { type: 'bar', data: { labels: s.dwell.map(d => d.label), datasets: [
    barDs('Viewers', s.dwell.map(d => d.viewers), css('--s1')),
    barDs('Passers-by', s.dwell.map(d => d.passersby), css('--s2')),
  ] }, options: baseOptions({ stacked: true, legend: true }) });

  const vOpts = baseOptions({ horizontal: true });
  draw('cVendors', { type: 'bar', data: { labels: s.vendors.map(v => v.name), datasets: [
    { ...barDs('Devices', s.vendors.map(v => v.count), css('--s1')), borderSkipped: 'start', borderWidth: 0 },
  ] }, options: vOpts });
  $('#kindsNote').textContent = `WiFi ${fmt(s.kinds.wifi || 0)} · BLE ${fmt(s.kinds.ble || 0)}`;
}

function table(head, rows, numFrom = 1) {
  return `<table class="tbl"><thead><tr>${head.map((h, i) => `<th class="${i >= numFrom ? 'num' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i >= numFrom ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
$$('[data-table]').forEach(b => b.onclick = () => {
  const el = $('#tbl-' + b.dataset.table);
  el.classList.toggle('hidden');
  b.textContent = el.classList.contains('hidden') ? 'Table' : 'Hide table';
});

function renderHeatmap(h) {
  const max = Math.max(1, ...h.grid.flat());
  const steps = [1, 2, 3, 4, 5, 6, 7].map(i => css(`--seq-${i}`));
  const color = v => v <= 0 ? css('--seq-0') : steps[Math.min(6, Math.floor((v / max) * 7))];
  let html = '<div></div>' + Array.from({ length: 24 }, (_, i) => `<div class="hh">${i}</div>`).join('');
  h.grid.forEach((row, wd) => {
    html += `<div class="hl">${DOW[wd]}</div>` + row.map((v, hr) =>
      `<div class="cell" style="background:${color(v)}" data-tip="${DOW[wd]} ${hr}:00–${hr + 1}:00 · ${fmt(v)} people/hr"></div>`).join('');
  });
  const ramp = `<div class="legend-ramp" style="grid-column:1/-1"><span>0</span>${[css('--seq-0'), ...steps].map(c => `<span class="sw" style="background:${c}"></span>`).join('')}<span>${fmt(max)} people/hr</span></div>`;
  $('#heatmap').innerHTML = html + ramp;
}

// generic hover tooltip for [data-tip] elements
const tip = $('#tooltip');
document.addEventListener('mousemove', e => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tip.classList.add('hidden'); return; }
  tip.textContent = t.dataset.tip;
  tip.classList.remove('hidden');
  const x = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + 'px'; tip.style.top = (e.clientY + 14) + 'px';
});

// ---------------------------------------------------------------- live
async function loadLive() {
  const [l, st] = await Promise.all([api('/api/live'), api('/api/status')]);
  state.data.live = l; state.data.status = st;
  renderLive(l); renderStatus(st);
}

function rssiCell(r) {
  const pct = Math.max(0, Math.min(100, (r + 100) * 2));
  return `<span class="rssi-bar"><i style="width:${pct}%"></i></span>${r} dBm`;
}
const zoneSw = z => z === 'viewer' ? `<span class="sw-inline" style="background:${css('--s1')}"></span>Viewer`
  : z === 'passerby' ? `<span class="sw-inline" style="background:${css('--s2')}"></span>Passer-by` : '<span class="muted">Far</span>';

function renderLive(l) {
  $('#liveNow').textContent = fmt(l.est_people_now);
  $('#liveZones').innerHTML = `<span><b>${l.zones.viewer}</b>viewers</span><span><b>${l.zones.passerby}</b>passers-by</span><span><b>${l.zones.far}</b>far</span>`;
  draw('cLive', { type: 'bar', data: { labels: l.minutes.map(m => tickLabel(m.t, 60)), datasets: [
    barDs('Viewers', l.minutes.map(m => m.viewers), css('--s1')),
    barDs('Passers-by', l.minutes.map(m => m.passersby), css('--s2')),
  ] }, options: { ...baseOptions({ stacked: true, legend: true }), animation: false } });
  $('#liveTable').innerHTML = `<thead><tr><th>Device</th><th>Label</th><th>Radio</th><th>Device</th><th>Signal</th><th>Zone</th><th>Seen</th></tr></thead><tbody>` +
    (l.devices.length ? l.devices.map(d => `<tr class="click" data-dev="${d.id}"><td class="mono">${d.id}</td><td>${esc(d.label) || '<span class="muted">–</span>'}</td>
      <td>${d.kind === 'wifi' ? 'WiFi' : 'BLE'}${d.randomized ? ' <span class="tag">random</span>' : ''}</td><td>${typeCell(d)}</td>
      <td>${rssiCell(d.last_rssi)}</td><td>${zoneSw(d.zone)}</td><td class="muted">${ago(d.last_seen)}</td></tr>`).join('')
      : '<tr><td colspan="7" class="muted">No devices in range</td></tr>') + '</tbody>';
}

function renderStatus(st) {
  const pill = $('#status');
  const live = st.connected && !st.stale;
  pill.className = 'pill ' + (live ? 'ok' : st.connected ? 'warn' : 'bad');
  pill.querySelector('.txt').textContent = st.source === 'simulator' ? 'Simulated sensor'
    : live ? `Sensor live · ${st.port}` : st.connected ? 'Connected, waiting for data' : (st.error || 'Sensor offline');
  $('#sensorInfo').innerHTML = [
    ['Source', st.source], ['Port', st.port || '–'], ['Firmware', st.fw || '–'], ['Chip', st.chip || '–'],
    ['Last heartbeat', st.last_hb ? ago(st.last_hb) : '–'], ['Cycles', fmt(st.cycles)],
    ['Free heap', st.heap ? `${fmt(st.heap / 1024)} KB` : '–'], ['Sensor uptime', st.uptime != null ? dur(st.uptime) : '–'],
    ['Dropped (table full)', fmt(st.dropped)], ...(st.error ? [['Error', st.error]] : []),
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

// ---------------------------------------------------------------- retention
async function loadRetention() {
  const r = await api(`/api/retention?days=${state.retDays}`);
  state.data.retention = r;
  renderRetention(r);
}

function renderRetention(r) {
  const totalNew = r.daily.reduce((a, d) => a + d.new, 0), totalRet = r.daily.reduce((a, d) => a + d.returning, 0);
  const d1 = r.cohorts.filter(c => c.ret[0] != null), d7 = r.cohorts.filter(c => c.ret[6] != null);
  const avg = (arr, i) => arr.length ? arr.reduce((a, c) => a + c.ret[i] * c.size, 0) / arr.reduce((a, c) => a + c.size, 0) : null;
  const a1 = avg(d1, 0), a7 = avg(d7, 6);
  $('#retKpis').innerHTML = [
    kpiTile('Tracked devices', fmt(r.total)),
    kpiTile('Repeat visitors', `${fmt(r.repeat_rate)}%`),
    kpiTile('Day-1 retention', a1 == null ? '–' : `${a1.toFixed(1)}%`),
    kpiTile('Day-7 retention', a7 == null ? '–' : `${a7.toFixed(1)}%`),
    kpiTile('New device-days', fmt(totalNew)),
    kpiTile('Returning device-days', fmt(totalRet)),
  ].join('');
  $('#retNote').textContent = r.stable_only
    ? 'Only non-rotating addresses and tagged devices count (phones rotate random MACs, which looks like churn)'
    : 'Includes rotating random addresses — retention will be understated';
  const labels = r.daily.map(d => tickLabel(d.t, 86400));
  draw('cNewRet', { type: 'bar', data: { labels, datasets: [
    barDs('New', r.daily.map(d => d.new), css('--s1')),
    barDs('Returning', r.daily.map(d => d.returning), css('--s2')),
  ] }, options: baseOptions({ stacked: true, legend: true }) });
  draw('cFreq', { type: 'bar', data: { labels: r.frequency.map(f => f.label), datasets: [
    barDs('Devices', r.frequency.map(f => f.count), css('--s1')),
  ] }, options: baseOptions() });

  const steps = [1, 2, 3, 4, 5, 6, 7].map(i => css(`--seq-${i}`));
  const maxRet = Math.max(1, ...r.cohorts.flatMap(c => c.ret.filter(x => x != null)));
  const cell = v => {
    if (v == null) return '<td class="c"></td>';
    const i = Math.min(6, Math.floor((v / maxRet) * 7));
    const bg = v <= 0 ? css('--seq-0') : steps[i];
    const ink = i >= 4 ? '#fff' : css('--text');
    return `<td class="c" style="background:${bg};color:${ink}" data-tip="${fmt(v)}% returned">${fmt(v)}%</td>`;
  };
  $('#cohortTable').innerHTML = `<thead><tr><th>First seen</th><th class="num">Devices</th>${[1, 2, 3, 4, 5, 6, 7].map(k => `<th class="num">D${k}</th>`).join('')}</tr></thead><tbody>` +
    (r.cohorts.length ? r.cohorts.slice().reverse().map(c => `<tr><td>${tickLabel(c.t, 86400)}</td><td class="num">${c.size}</td>${c.ret.map(cell).join('')}</tr>`).join('')
      : '<tr><td colspan="9" class="muted">Not enough data yet</td></tr>') + '</tbody>';
}

// ---------------------------------------------------------------- devices
let searchTimer;
$('#devSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadDevices, 250); };
$('#taggedOnly').onchange = loadDevices;
$('#devKind').onchange = loadDevices;
$('#devType').onchange = loadDevices;
$('#devType').innerHTML = '<option value="">All types</option>' + ['phone', 'computer', 'wearable', 'audio', 'tv', 'tracker', 'ap', 'other']
  .map(t => `<option value="${t}">${TYPE_NAMES[t]}</option>`).join('');

async function loadDevices() {
  const q = encodeURIComponent($('#devSearch').value.trim());
  const rows = await api(`/api/devices?range=${state.devRange}&q=${q}&tagged=${$('#taggedOnly').checked}&kind=${$('#devKind').value}&type=${$('#devType').value}`);
  // don't clobber a label the user is typing
  if (document.activeElement?.closest('#devTable')) return;
  $('#devTable').innerHTML = `<thead><tr><th>Device</th><th>Label (tag)</th><th>Device / type</th><th>Radio</th><th>Vendor</th><th class="num">Dist.</th><th class="num">Visits</th><th class="num">Days</th>
    <th class="num">Time in range</th><th class="num">Peak</th><th>First seen</th><th>Last seen</th><th>Ignore</th></tr></thead><tbody>` +
    (rows.length ? rows.map(d => `<tr class="click" data-dev="${d.id}">
      <td class="mono">${d.id}</td>
      <td><input type="text" data-label="${d.id}" value="${esc(d.label)}" placeholder="add tag…"></td>
      <td>${typeCell(d)}</td>
      <td>${d.kind === 'ap' ? 'AP' : d.kind === 'wifi' ? 'WiFi' : 'BLE'} ${d.randomized ? '<span class="tag">random</span>' : '<span class="tag">stable</span>'}${d.fixture ? '<span class="tag">fixture</span>' : ''}${d.details?.connected ? '<span class="tag">connected</span>' : ''}</td>
      <td>${esc(d.vendor) || '<span class="muted">–</span>'}</td>
      <td class="num">${d.distance != null ? fmt(d.distance) + ' m' : '–'}</td>
      <td class="num">${d.visits}</td><td class="num">${d.days_seen}</td><td class="num">${dur(d.total_dwell)}</td>
      <td class="num">${d.peak_rssi ?? '–'} dBm</td>
      <td class="muted">${new Date(d.first_seen * 1000).toLocaleString()}</td><td class="muted">${ago(d.last_seen)}</td>
      <td><input type="checkbox" data-ignore="${d.id}" ${d.ignored ? 'checked' : ''} aria-label="Ignore device"></td></tr>`).join('')
      : '<tr><td colspan="13" class="muted">No devices</td></tr>') + '</tbody>';
}

$('#devTable').addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.label) await patchDevice(t.dataset.label, { label: t.value });
  if (t.dataset.ignore) await patchDevice(t.dataset.ignore, { ignored: t.checked });
});
$('#devTable').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.label) e.target.blur(); });
const patchDevice = (id, body) => fetch(`/api/devices/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

document.addEventListener('click', e => {
  const row = e.target.closest('tr[data-dev]');
  if (row && !e.target.closest('input')) openDevice(row.dataset.dev);
});
$('#drawerClose').onclick = () => $('#drawer').classList.add('hidden');
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#drawer').classList.add('hidden'); });

async function openDevice(id) {
  const d = await api(`/api/devices/${id}`);
  const dev = d.device;
  const x = dev.details || {};
  $('#drawerTitle').textContent = dev.label || dev.name || dev.model || dev.id;
  $('#drawerInfo').innerHTML = [
    ['Type', `${TYPE_NAMES[dev.dev_type] || 'Other'}${dev.confidence === 'low' ? ' (guess)' : ''}`],
    ['Model / identified as', dev.model || '–'], ['Name', dev.name || '–'],
    ['ID', dev.id], ['Radio', `${dev.kind === 'ap' ? 'Access point' : dev.kind === 'wifi' ? 'WiFi' : 'BLE'}${dev.randomized ? ' (random address)' : ''}`],
    ['Vendor', dev.vendor || '–'], ['Est. distance now', dev.distance != null ? `≈ ${fmt(dev.distance)} m (${dev.last_rssi} dBm)` : '–'],
    ...(x.activity_label ? [['Phone state (last seen)', x.activity_label]] : []),
    ...(dev.linked_addresses > 1 ? [['Grouped addresses', `${dev.linked_addresses} rotating addresses linked as one device`]] : []),
    ...(dev.linked_from ? [['Linked from', `${dev.linked_from} (score ${fmt(dev.link_score)})`]] : []),
    ...(x.wifi_gen ? [['WiFi standard', x.wifi_gen]] : []),
    ...(x.ssids?.length ? [['Networks it looks for', x.ssids.join(', ')]] : []),
    ...(x.connected ? [['Connected to', `AP ${x.bssid || ''}`]] : []),
    ...(x.wps_name || x.wps_model ? [['WPS device', [x.wps_name, x.wps_model].filter(Boolean).join(' · ')]] : []),
    ...(x.vendor_ies?.length ? [['Chipset / vendor tags', x.vendor_ies.join(', ')]] : []),
    ...(x.services?.length ? [['BLE services', x.services.join(', ')]] : []),
    ...(x.appearance ? [['BLE appearance', x.appearance]] : []),
    ...(x.tx_power != null ? [['Advertised TX power', `${x.tx_power} dBm`]] : []),
    ...(x.ssid ? [['Network name', x.ssid]] : []),
    ...(x.channel ? [['Channel', x.channel]] : []),
    ['Fingerprint', dev.fp || '–'],
    ['First seen', new Date(dev.first_seen * 1000).toLocaleString()], ['Last seen', ago(dev.last_seen)],
    ['Visits', d.visits.length >= 100 ? '100+' : d.visits.length],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  $('#drawer').classList.remove('hidden');
  const o = baseOptions();
  o.scales.y.beginAtZero = false;
  o.scales.y.suggestedMin = -100; o.scales.y.suggestedMax = -30;
  draw('cDevice', { type: 'line', data: { labels: d.rssi.map(r => tickLabel(r.t, 60)), datasets: [
    { ...lineDs('RSSI (dBm)', d.rssi.map(r => r.rssi), css('--s1')), spanGaps: false, pointRadius: d.rssi.length < 30 ? 3 : 0 },
  ] }, options: o });
  $('#drawerVisits').innerHTML = table(['Start', 'Dwell', 'Peak', 'Phone'], d.visits.slice(0, 30).map(v =>
    [new Date(v.start * 1000).toLocaleString(), dur(v.dwell), `${v.max_rssi} dBm`, phoneState(v)]), 1);
}

// Per-visit phone-attention summary from idle/in-use sighting counts
function phoneState(v) {
  if (!v.phone_idle && !v.phone_use) return '<span class="muted">–</span>';
  if (v.phone_idle >= v.phone_use) return '<span title="screen off / idle — likely heads-up">🔒 heads-up</span>';
  return '<span title="screen on / in use — likely distracted">📱 in use</span>';
}

// ---------------------------------------------------------------- settings
const SETTINGS = [
  ['billboard_name', 'Billboard name', 'Shown in the header', 'text'],
  ['viewer_rssi', 'Viewer zone threshold (dBm)', 'Peak signal at or above this = close enough to view the billboard. Calibrate by standing where viewers stand.', 'number'],
  ['passer_rssi', 'Passer-by threshold (dBm)', 'Weaker sightings are ignored entirely', 'number'],
  ['visit_gap_s', 'Visit timeout (s)', 'A device unseen for this long has left; next sighting starts a new visit', 'number'],
  ['min_dwell_s', 'Min. dwell for an impression (s)', 'Viewer visits shorter than this don\'t count as impressions', 'number'],
  ['devices_per_person', 'Devices per person', 'Average detectable radios a person carries (phone, watch, earbuds). Divides device counts into people.', 'number'],
  ['auto_exclude_fixtures', 'Auto-exclude fixtures', 'Ignore devices that are almost always present (shop TVs, routers)', 'bool'],
  ['fixture_minutes_6h', 'Fixture threshold (min / 6 h)', 'Present this many minutes in the last 360 = fixture', 'number'],
  ['retention_stable_only', 'Retention: stable IDs only', 'Exclude rotating random addresses from retention', 'bool'],
  ['link_addresses', 'Link rotated addresses', 'Group random addresses that rotate on the same phone, so one person counts once (more accurate people counts and dwell)', 'bool'],
  ['rssi_1m_ble', 'BLE signal at 1 m (dBm)', 'Radar distance model: hold a phone 1 m from the sensor and read its BLE RSSI', 'number'],
  ['rssi_1m_wifi', 'WiFi signal at 1 m (dBm)', 'Same, for WiFi probes / traffic', 'number'],
  ['path_loss_n', 'Path-loss exponent', '2 = open air, 2.7–3.5 = street with people and walls. Higher = distances shrink', 'number'],
];

async function loadSettings() {
  const s = await api('/api/settings');
  $('#settingsForm').innerHTML = SETTINGS.map(([k, label, help, type]) => `<div class="row"><div><label for="set-${k}">${label}</label><div class="help">${help}</div></div>
    ${type === 'bool' ? `<input id="set-${k}" name="${k}" type="checkbox" ${+s[k] ? 'checked' : ''}>`
      : `<input id="set-${k}" name="${k}" type="${type}" step="any" value="${esc(s[k])}">`}</div>`).join('') +
    '<div class="actions"><button class="primary" type="submit">Save</button><span class="muted small" id="saveMsg"></span></div>';
}
$('#settingsForm').onsubmit = async e => {
  e.preventDefault();
  const body = {};
  SETTINGS.forEach(([k, , , type]) => { const el = $(`[name="${k}"]`); body[k] = type === 'bool' ? (el.checked ? 1 : 0) : el.value; });
  await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('#saveMsg').textContent = 'Saved — history re-classified with new thresholds';
  setTimeout(() => $('#saveMsg').textContent = '', 3000);
};

// ---------------------------------------------------------------- refresh loop
function refresh() {
  const t = state.tab;
  const p = t === 'overview' ? loadOverview() : t === 'live' ? loadLive() : t === 'retention' ? loadRetention()
    : t === 'radar' ? (typeof loadRadar === 'function' ? loadRadar() : null)
    : t === 'devices' ? loadDevices() : t === 'settings' ? loadSettings() : null;
  p?.catch(err => console.error(err));
  api('/api/status').then(renderStatus).catch(() => {});
}

let lastOverview = 0;
function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.status) renderStatus({ ...m.status, stale: false });
    if (state.tab === 'live') loadLive().catch(() => {});
    else if (state.tab === 'overview' && Date.now() - lastOverview > 15000) { lastOverview = Date.now(); loadOverview().catch(() => {}); }
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}
connectWs();
api('/api/settings').then(s => $('#bbName').textContent = s.billboard_name).catch(() => {});
setInterval(() => { if (state.tab === 'devices') loadDevices().catch(() => {}); api('/api/status').then(renderStatus).catch(() => {}); }, 10000);
refresh();
