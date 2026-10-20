// Radar tab: live proximity radar, traffic rings, type × distance table
const TYPE_ORDER = ['phone', 'computer', 'wearable', 'audio', 'tv', 'tracker', 'ap', 'other'];
const TYPE_LABEL = { phone: 'Phone', computer: 'Computer', wearable: 'Wearable', audio: 'Audio', tv: 'TV / media',
  tracker: 'Tracker / tag', ap: 'Access point', other: 'Other / unknown' };
const typeColor = t => css(`--t-${TYPE_ORDER.includes(t) ? t : 'other'}`);
const RINGS_M = [1, 2, 5, 10, 20, 40];
const MAX_M = 60;

const radarState = { win: 60, band: '24h', data: null, hidden: new Set(), dots: new Map(), hover: null, raf: null, sweep: 0 };

// Stable pseudo-random angle per device so it doesn't jump between refreshes
function angleFor(id) {
  let h = 2166136261;
  for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}
// log scale so near devices get room: 0 m at centre, MAX_M at edge
const radiusFor = (m, R) => R * Math.log1p(Math.min(m, MAX_M)) / Math.log1p(MAX_M);

function deviceTitle(d) {
  return d.label || d.name || d.model || (d.vendor ? `${d.vendor} device` : (d.kind === 'ble' ? 'BLE device' : 'WiFi device'));
}

// ---------------------------------------------------------------- data
async function loadRadar() {
  const ap = $('#rAp').checked;
  const [r, b] = await Promise.all([
    api(`/api/radar?window=${radarState.win}&ap=${ap}`),
    radarState.bandsLoaded && Date.now() - radarState.bandsLoaded < 30000 ? Promise.resolve(radarState.bands) : api(`/api/bands?range=${radarState.band}`),
  ]);
  radarState.data = r;
  if (b !== radarState.bands) { radarState.bands = b; radarState.bandsLoaded = Date.now(); renderRings(b); renderTypeBands(b); }
  syncDots();
  renderNear();
  renderTypeLegend();
  startRadar();
}

function visibleDevices() {
  const d = radarState.data?.devices || [];
  return d.filter(x => !radarState.hidden.has(x.type)
    && (x.kind !== 'wifi' || $('#rWifi').checked) && (x.kind !== 'ble' || $('#rBle').checked)
    && (x.kind !== 'ap' || $('#rAp').checked));
}

function syncDots() {
  const seen = new Set();
  for (const d of visibleDevices()) {
    seen.add(d.id);
    const dot = radarState.dots.get(d.id);
    if (dot) { dot.target = d.distance; dot.d = d; }
    else radarState.dots.set(d.id, { cur: d.distance * 1.4 + 3, target: d.distance, d, born: performance.now() });
  }
  for (const id of radarState.dots.keys()) if (!seen.has(id)) radarState.dots.delete(id);
}

// ---------------------------------------------------------------- radar canvas
function startRadar() {
  if (radarState.raf) return;
  const frame = t => {
    if (state.tab !== 'radar') { radarState.raf = null; return; }
    drawRadar(t);
    radarState.raf = requestAnimationFrame(frame);
  };
  radarState.raf = requestAnimationFrame(frame);
}

function drawRadar(now) {
  const canvas = $('#radarCanvas');
  const wrap = $('#radarWrap');
  const size = wrap.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const c = size / 2, R = size / 2 - 18;
  const grid = css('--grid'), muted = css('--muted'), text2 = css('--text-2'), surface = css('--surface');

  // zone shading: viewer disc and passer-by annulus (BLE model, approximate)
  const z = radarState.data?.zones;
  if (z) {
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = css('--s2');
    ctx.beginPath(); ctx.arc(c, c, radiusFor(z.passer_m, R), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = css('--s1');
    ctx.beginPath(); ctx.arc(c, c, radiusFor(z.viewer_m, R), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // range rings + spokes
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  for (const m of [...RINGS_M, MAX_M]) {
    ctx.beginPath(); ctx.arc(c, c, radiusFor(m, R), 0, Math.PI * 2); ctx.stroke();
  }
  for (let a = 0; a < 12; a++) {
    const ang = a * Math.PI / 6;
    ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.cos(ang) * R, c + Math.sin(ang) * R); ctx.stroke();
  }
  ctx.fillStyle = muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
  for (const m of [...RINGS_M, MAX_M]) ctx.fillText(`${m}${m === MAX_M ? '+' : ''} m`, c + 4, c - radiusFor(m, R) + 12);

  // sweep
  radarState.sweep = (now / 4000) * Math.PI * 2;
  if (ctx.createConicGradient) {
    const g = ctx.createConicGradient(radarState.sweep - Math.PI / 3, c, c);
    const accent = css('--s3');
    g.addColorStop(0, 'transparent');
    g.addColorStop(1 / 6, accent + '33');
    g.addColorStop(1 / 6 + 0.0001, 'transparent');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fill();
  }

  // centre: the sensor
  ctx.fillStyle = css('--text');
  ctx.beginPath(); ctx.arc(c, c, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.fillText('sensor', c, c + 16);

  // devices
  const win = radarState.data?.window_s || 60;
  const labels = [];
  const placed = [];
  for (const [id, dot] of radarState.dots) {
    dot.cur += (dot.target - dot.cur) * 0.08;
    const d = dot.d;
    const ang = angleFor(id);
    const r = radiusFor(dot.cur, R);
    const x = c + Math.cos(ang) * r, y = c + Math.sin(ang) * r;
    dot.x = x; dot.y = y;
    const fade = Math.max(0.3, 1 - Math.max(0, d.age - 8) / win);
    const born = Math.max(0.05, Math.min(1, (now - dot.born) / 400));  // rAF time can precede dot.born
    const hovered = radarState.hover === id;
    const s = (hovered ? 7 : 5) * born;
    ctx.globalAlpha = fade;
    ctx.fillStyle = typeColor(d.type);
    ctx.strokeStyle = surface; ctx.lineWidth = 2;
    ctx.beginPath();
    if (d.kind === 'ble') ctx.arc(x, y, s, 0, Math.PI * 2);
    else if (d.kind === 'wifi') ctx.roundRect ? ctx.roundRect(x - s, y - s, 2 * s, 2 * s, 2) : ctx.rect(x - s, y - s, 2 * s, 2 * s);
    else { ctx.moveTo(x, y - s - 1); ctx.lineTo(x + s + 1, y); ctx.lineTo(x, y + s + 1); ctx.lineTo(x - s - 1, y); ctx.closePath(); }
    if (d.excluded) { ctx.lineWidth = 2; ctx.strokeStyle = typeColor(d.type); ctx.stroke(); }
    else { ctx.stroke(); ctx.fill(); }
    if (d.label) { // tagged users get a ring
      ctx.lineWidth = 1.5; ctx.strokeStyle = css('--text');
      ctx.beginPath(); ctx.arc(x, y, s + 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const name = d.label || d.name;
    if ((name && $('#rLabels').checked) || hovered) labels.push({ x, y, text: hovered ? deviceTitle(d) : name, fade: hovered ? 1 : fade });
  }

  // labels, skipping ones that would collide
  ctx.font = '11.5px system-ui, sans-serif'; ctx.textAlign = 'left';
  for (const l of labels.sort((a, b) => b.fade - a.fade)) {
    const w = ctx.measureText(l.text).width;
    const box = { x: l.x + 9, y: l.y - 8, w, h: 14 };
    if (box.x + w > size) box.x = l.x - 9 - w;
    if (placed.some(p => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y)) continue;
    placed.push(box);
    ctx.globalAlpha = l.fade;
    ctx.fillStyle = surface; ctx.fillRect(box.x - 2, box.y - 1, w + 4, 15);
    ctx.fillStyle = text2; ctx.fillText(l.text, box.x, box.y + 11);
  }
  ctx.globalAlpha = 1;
}

function dotAt(ev) {
  const rect = $('#radarCanvas').getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  let best = null, bd = 12;
  for (const [id, dot] of radarState.dots) {
    const dd = Math.hypot(dot.x - mx, dot.y - my);
    if (dd < bd) { bd = dd; best = id; }
  }
  return best;
}
$('#radarCanvas').addEventListener('mousemove', ev => {
  const id = dotAt(ev);
  radarState.hover = id;
  if (!id) { tip.classList.add('hidden'); return; }
  const d = radarState.dots.get(id).d;
  tip.innerHTML = `<b>${esc(deviceTitle(d))}</b><br>${TYPE_LABEL[d.type] || 'Other'}${d.confidence === 'low' ? ' (guess)' : ''} · ${d.kind === 'ap' ? 'Access point' : d.kind.toUpperCase()}<br>` +
    `≈ ${fmt(d.distance)} m · ${d.rssi} dBm · ${d.zone}` +
    (d.activity_label ? `<br>Phone: ${esc(d.activity_label)}` : '') +
    (d.vendor ? `<br>${esc(d.vendor)}` : '') + (d.wifi_gen ? ` · ${d.wifi_gen}` : '') +
    (d.ssids.length ? `<br>Looking for: ${esc(d.ssids.slice(0, 3).join(', '))}` : '') +
    `<br><span class="muted">seen ${Math.round(d.age)}s ago</span>`;
  tip.classList.remove('hidden');
  tip.style.left = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (ev.clientY + 14) + 'px';
});
$('#radarCanvas').addEventListener('mouseleave', () => { radarState.hover = null; tip.classList.add('hidden'); });
$('#radarCanvas').addEventListener('click', ev => { const id = dotAt(ev); if (id) openDevice(id); });

// ---------------------------------------------------------------- side list + legend
function renderNear() {
  const list = visibleDevices();
  $('#nearCount').textContent = `${list.length} in range`;
  $('#radarMeta').textContent = `seen in the last ${radarState.win >= 60 ? radarState.win / 60 + ' min' : radarState.win + ' s'}`;
  $('#nearTable').innerHTML = `<thead><tr><th>Device</th><th>Radio</th><th class="num">Dist.</th><th class="num">RSSI</th></tr></thead><tbody>` +
    (list.length ? list.slice(0, 80).map(d => `<tr class="click" data-dev="${d.id}">
      <td><span class="tsw" style="background:${typeColor(d.type)}"></span>${esc(deviceTitle(d))}
        <div class="muted small ${d.confidence === 'low' ? 'conf-low' : ''}">${TYPE_LABEL[d.type] || 'Other'}${d.confidence === 'low' ? ' (guess)' : ''}${d.label ? ' · tagged' : ''}</div></td>
      <td>${d.kind === 'ap' ? 'AP' : d.kind === 'wifi' ? 'WiFi' : 'BLE'}</td>
      <td class="num">${fmt(d.distance)} m</td><td class="num">${d.rssi}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">Nothing in range</td></tr>') + '</tbody>';
}

function renderTypeLegend() {
  const counts = {};
  for (const d of radarState.data?.devices || []) counts[d.type] = (counts[d.type] || 0) + 1;
  $('#typeLegend').innerHTML = TYPE_ORDER.filter(t => t !== 'ap' || $('#rAp').checked).map(t =>
    `<button data-type="${t}" class="${radarState.hidden.has(t) ? 'off' : ''}" title="Show / hide">
      <span class="sw" style="background:${typeColor(t)}"></span>${TYPE_LABEL[t]} <span class="muted">${counts[t] || 0}</span></button>`).join('');
}
$('#typeLegend').addEventListener('click', e => {
  const b = e.target.closest('button[data-type]');
  if (!b) return;
  const t = b.dataset.type;
  radarState.hidden.has(t) ? radarState.hidden.delete(t) : radarState.hidden.add(t);
  syncDots(); renderNear(); renderTypeLegend();
});

// ---------------------------------------------------------------- traffic rings (SVG)
function sector(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

function renderRings(b) {
  const cx = 210, cy = 210, inner = 26, outer = 196, n = b.bands.length;
  const step = (outer - inner) / n;
  const max = Math.max(1, ...b.wifi, ...b.ble);
  const steps = [1, 2, 3, 4, 5, 6, 7].map(i => css(`--seq-${i}`));
  const fill = v => v <= 0 ? css('--seq-0') : steps[Math.min(6, Math.floor((v / max) * 7))];
  const ink = v => v > 0 && Math.floor((v / max) * 7) >= 4 ? '#fff' : css('--text');
  const gap = 0.012; // radians of surface between the two halves
  let svg = '';
  b.bands.forEach((band, i) => {
    const r0 = inner + i * step + 1, r1 = inner + (i + 1) * step - 1;
    const mid = (r0 + r1) / 2;
    // left half = WiFi (90°..270°), right half = BLE (-90°..90°)
    for (const [kind, a0, a1, lx] of [['wifi', Math.PI / 2 + gap, Math.PI * 1.5 - gap, cx - mid], ['ble', -Math.PI / 2 + gap, Math.PI / 2 - gap, cx + mid]]) {
      const v = b[kind][i];
      svg += `<path d="${sector(cx, cy, r0, r1, a0, a1)}" fill="${fill(v)}" data-tip="${kind === 'wifi' ? 'WiFi' : 'BLE'} · ${band.label}: ${fmt(v)} devices"/>`;
      if (step > 16) svg += `<text x="${lx}" y="${cy + 4}" text-anchor="middle" font-size="11" fill="${ink(v)}" pointer-events="none">${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}</text>`;
    }
    svg += `<text x="${cx}" y="${cy - mid + 4}" text-anchor="middle" font-size="10" fill="${css('--muted')}" pointer-events="none">${band.label}</text>`;
  });
  svg += `<text x="${cx - outer + 6}" y="22" font-size="13" font-weight="600" fill="${css('--text-2')}">WiFi ${fmt(b.wifi.reduce((a, x) => a + x, 0))}</text>`;
  svg += `<text x="${cx + outer - 6}" y="22" text-anchor="end" font-size="13" font-weight="600" fill="${css('--text-2')}">BLE ${fmt(b.ble.reduce((a, x) => a + x, 0))}</text>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="4" fill="${css('--text')}"/>`;
  $('#rings').innerHTML = svg;
  $('#ringsLegend').innerHTML = `<span>0</span>${[css('--seq-0'), ...steps].map(c => `<span class="sw" style="background:${c}"></span>`).join('')}<span>${fmt(max)} devices</span>`;
}

function renderTypeBands(b) {
  const max = Math.max(1, ...b.types.flatMap(t => t.bands));
  const steps = [1, 2, 3, 4, 5, 6, 7].map(i => css(`--seq-${i}`));
  const cell = v => {
    const i = Math.min(6, Math.floor((v / max) * 7));
    const bg = v <= 0 ? css('--seq-0') : steps[i];
    return `<td class="c" style="background:${bg};color:${v > 0 && i >= 4 ? '#fff' : css('--text')}">${fmt(v)}</td>`;
  };
  const types = b.types.slice().sort((x, y) => TYPE_ORDER.indexOf(x.key) - TYPE_ORDER.indexOf(y.key));
  $('#typeBands').innerHTML = `<thead><tr><th>Type</th>${b.bands.map(x => `<th class="num">${x.label}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>` +
    (types.length ? types.map(t => `<tr><td><span class="tsw" style="background:${typeColor(t.key)}"></span>${t.label}</td>${t.bands.map(cell).join('')}<td class="num"><b>${fmt(t.total)}</b></td></tr>`).join('')
      : `<tr><td colspan="${b.bands.length + 2}" class="muted">No traffic yet</td></tr>`) + '</tbody>';
}

// ---------------------------------------------------------------- controls
segment('#radarWin', 'win', w => { radarState.win = +w; loadRadar().catch(console.error); });
segment('#bandSeg', 'range', r => { radarState.band = r; radarState.bandsLoaded = 0; loadRadar().catch(console.error); });
['#rWifi', '#rBle', '#rLabels'].forEach(s => $(s).addEventListener('change', () => { syncDots(); renderNear(); }));
$('#rAp').addEventListener('change', () => loadRadar().catch(console.error));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => radarState.bands && (renderRings(radarState.bands), renderTypeBands(radarState.bands)));

setInterval(() => { if (state.tab === 'radar') loadRadar().catch(() => {}); }, 3000);
if (state.tab === 'radar') loadRadar().catch(console.error);
