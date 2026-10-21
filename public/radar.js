// Live proximity radar. Uses helpers from app.js, so it starts once app.js is ready, in whichever order the two load.
window.initRadar = function initRadar() {
  if (window.Radar) return;
  const RINGS_M = [1, 2, 5, 10, 20, 40];
  const MAX_M = 60;
  const rs = { win: 60, data: null, hidden: new Set(), dots: new Map(), hover: null, raf: null, loading: false };

  // Stable pseudo-random angle per device so it doesn't jump between refreshes
  function angleFor(id) {
    let h = 2166136261;
    for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return ((h >>> 0) / 4294967296) * Math.PI * 2;
  }
  // log scale so near devices get room: 0 m at centre, MAX_M at edge
  const radiusFor = (m, R) => R * Math.log1p(Math.min(m, MAX_M)) / Math.log1p(MAX_M);
  const deviceTitle = d => d.label || d.name || d.model || (d.vendor ? `${d.vendor} device` : (d.kind === 'ble' ? 'BLE device' : 'WiFi device'));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // ---------------------------------------------------------------- data
  async function load() {
    if (rs.loading) return;
    rs.loading = true;
    try {
      rs.data = await api(`/api/radar?${qs({ window: rs.win, ap: $('#rAp').checked })}`);
      syncDots(); renderNear(); renderTypeLegend(); start();
    } catch (err) { netError(err); }
    finally { rs.loading = false; }
  }
  function reset() { rs.dots.clear(); rs.data = null; }

  function visibleDevices() {
    return (rs.data?.devices || []).filter(x => !rs.hidden.has(x.type)
      && (x.kind !== 'wifi' || $('#rWifi').checked) && (x.kind !== 'ble' || $('#rBle').checked)
      && (x.kind !== 'ap' || $('#rAp').checked));
  }
  function syncDots() {
    const seen = new Set();
    for (const d of visibleDevices()) {
      seen.add(d.id);
      const dot = rs.dots.get(d.id);
      if (dot) { dot.target = d.distance; dot.d = d; }
      else rs.dots.set(d.id, { cur: reduceMotion.matches ? d.distance : d.distance * 1.4 + 3, target: d.distance, d, born: performance.now() });
    }
    for (const id of rs.dots.keys()) if (!seen.has(id)) rs.dots.delete(id);
  }

  // ---------------------------------------------------------------- canvas
  function start() {
    if (rs.raf) return;
    const frame = t => {
      if (state.page !== 'live' || document.hidden) { rs.raf = null; return; }
      drawRadar(t);
      rs.raf = requestAnimationFrame(frame);
    };
    rs.raf = requestAnimationFrame(frame);
  }

  function drawRadar(now) {
    const canvas = $('#radarCanvas'), wrap = $('#radarWrap');
    const size = wrap.clientWidth;
    if (!size) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const c = size / 2, R = size / 2 - 18;
    const grid = css('--grid'), muted = css('--muted'), text2 = css('--text-2'), surface = css('--surface');

    // zone shading: viewer disc and passer-by annulus (BLE model, approximate)
    const z = rs.data?.zones;
    if (z) {
      ctx.save();
      ctx.globalAlpha = 0.07; ctx.fillStyle = css('--s2');
      ctx.beginPath(); ctx.arc(c, c, radiusFor(z.passer_m, R), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.12; ctx.fillStyle = css('--s1');
      ctx.beginPath(); ctx.arc(c, c, radiusFor(z.viewer_m, R), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // range rings + spokes
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (const m of [...RINGS_M, MAX_M]) { ctx.beginPath(); ctx.arc(c, c, radiusFor(m, R), 0, Math.PI * 2); ctx.stroke(); }
    for (let a = 0; a < 12; a++) {
      const ang = a * Math.PI / 6;
      ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.cos(ang) * R, c + Math.sin(ang) * R); ctx.stroke();
    }
    ctx.fillStyle = muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
    for (const m of [...RINGS_M, MAX_M]) ctx.fillText(`${m}${m === MAX_M ? '+' : ''} m`, c + 4, c - radiusFor(m, R) + 12);

    // sweep (skipped for reduced motion)
    if (ctx.createConicGradient && !reduceMotion.matches) {
      const g = ctx.createConicGradient((now / 4000) * Math.PI * 2 - Math.PI / 3, c, c);
      const accent = css('--s3');
      g.addColorStop(0, 'transparent');
      g.addColorStop(1 / 6, hexA(accent, 0.2));
      g.addColorStop(1 / 6 + 0.0001, 'transparent');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fill();
    }

    // centre: the sensor
    ctx.fillStyle = css('--text');
    ctx.beginPath(); ctx.arc(c, c, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.fillText('sensor', c, c + 17);

    // devices
    const win = rs.data?.window_s || 60;
    const labels = [], placed = [];
    for (const [id, dot] of rs.dots) {
      dot.cur += (dot.target - dot.cur) * 0.08;
      const d = dot.d;
      const ang = angleFor(id), r = radiusFor(dot.cur, R);
      const x = c + Math.cos(ang) * r, y = c + Math.sin(ang) * r;
      dot.x = x; dot.y = y;
      const fade = Math.max(0.3, 1 - Math.max(0, d.age - 8) / win);
      const born = reduceMotion.matches ? 1 : Math.max(0.05, Math.min(1, (now - dot.born) / 400));  // rAF time can precede dot.born
      const hovered = rs.hover === id;
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
    ctx.font = '500 11.5px system-ui, sans-serif'; ctx.textAlign = 'left';
    for (const l of labels.sort((a, b) => b.fade - a.fade)) {
      const w = ctx.measureText(l.text).width;
      const box = { x: l.x + 10, y: l.y - 8, w, h: 15 };
      if (box.x + w > size) box.x = l.x - 10 - w;
      if (placed.some(p => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y)) continue;
      placed.push(box);
      ctx.globalAlpha = l.fade;
      ctx.fillStyle = surface;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(box.x - 3, box.y - 1, w + 6, 16, 4) : ctx.rect(box.x - 3, box.y - 1, w + 6, 16); ctx.fill();
      ctx.fillStyle = text2; ctx.fillText(l.text, box.x, box.y + 11);
    }
    ctx.globalAlpha = 1;
  }

  function dotAt(ev) {
    const rect = $('#radarCanvas').getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    let best = null, bd = ev.pointerType === 'touch' ? 22 : 12;
    for (const [id, dot] of rs.dots) {
      const dd = Math.hypot(dot.x - mx, dot.y - my);
      if (dd < bd) { bd = dd; best = id; }
    }
    return best;
  }
  const canvas = $('#radarCanvas');
  canvas.addEventListener('pointermove', ev => {
    const id = dotAt(ev);
    rs.hover = id;
    canvas.style.cursor = id ? 'pointer' : 'crosshair';
    if (!id) { tip.classList.add('hidden'); return; }
    const d = rs.dots.get(id).d;
    tip.innerHTML = `<b>${esc(deviceTitle(d))}</b><br>${TYPE_NAMES[d.type] || 'Other'}${d.confidence === 'low' ? ' (guess)' : ''} · ${radioName(d.kind)}<br>` +
      `≈ ${fmt(d.distance)} m · ${d.rssi} dBm · ${d.zone === 'passerby' ? 'passer-by' : d.zone}` +
      (d.activity_label ? `<br>Phone: ${esc(d.activity_label)}` : '') +
      (d.vendor ? `<br>${esc(d.vendor)}` : '') + (d.wifi_gen ? ` · ${esc(d.wifi_gen)}` : '') +
      (d.ssids.length ? `<br>Looking for: ${esc(d.ssids.slice(0, 3).join(', '))}` : '') +
      `<br><span class="muted">Seen ${Math.round(d.age)}s ago</span>`;
    tip.classList.remove('hidden');
    placeTip(ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointerleave', () => { rs.hover = null; tip.classList.add('hidden'); });
  canvas.addEventListener('click', ev => { const id = dotAt(ev); if (id) openDevice(id); });

  // ---------------------------------------------------------------- side list + legend
  function renderNear() {
    const list = visibleDevices();
    $('#nearCount').textContent = `${list.length} in the last ${rs.win >= 60 ? rs.win / 60 + ' min' : rs.win + ' s'}`;
    $('#nearTable').innerHTML = `<thead><tr><th>Device</th><th>Radio</th><th class="num">Distance</th><th class="num">Signal</th></tr></thead><tbody>` +
      (list.length ? list.slice(0, 80).map(d => `<tr class="click" data-dev="${d.id}">
        <td><span class="tsw" style="background:${typeColor(d.type)}"></span>${esc(deviceTitle(d))}
          <div class="muted small ${d.confidence === 'low' ? 'conf-low' : ''}">${TYPE_NAMES[d.type] || 'Other'}${d.confidence === 'low' ? ' (guess)' : ''}${d.label ? ' · tagged' : ''}</div></td>
        <td>${d.kind === 'ap' ? 'AP' : radioName(d.kind)}</td>
        <td class="num">${fmt(d.distance)} m</td><td class="num">${d.rssi}</td></tr>`).join('')
        : '<tr class="empty-row"><td colspan="4">Nothing in range</td></tr>') + '</tbody>';
  }
  function renderTypeLegend() {
    const counts = {};
    for (const d of rs.data?.devices || []) counts[d.type] = (counts[d.type] || 0) + 1;
    $('#typeLegend').innerHTML = TYPE_ORDER.filter(t => t !== 'ap' || $('#rAp').checked).map(t =>
      `<button type="button" data-type="${t}" class="${rs.hidden.has(t) ? 'off' : ''}" aria-pressed="${!rs.hidden.has(t)}">
        <span class="sw" style="background:${typeColor(t)}"></span>${TYPE_NAMES[t]} <span class="muted">${counts[t] || 0}</span></button>`).join('');
  }
  $('#typeLegend').addEventListener('click', e => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    const t = b.dataset.type;
    rs.hidden.has(t) ? rs.hidden.delete(t) : rs.hidden.add(t);
    syncDots(); renderNear(); renderTypeLegend();
  });

  // ---------------------------------------------------------------- controls
  segment('#radarWin', 'win', w => { rs.win = +w; load(); });
  ['#rWifi', '#rBle', '#rLabels'].forEach(s => $(s).addEventListener('change', () => { syncDots(); renderNear(); }));
  $('#rAp').addEventListener('change', load);
  setInterval(() => { if (state.page === 'live' && !document.hidden) load(); }, 3000);

  window.Radar = { load, reset };
  if (state.page === 'live') load();
};
if (window.appReady) window.initRadar();
