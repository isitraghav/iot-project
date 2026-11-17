// Simulation tab. Uses helpers from app.js ($, css, fmt, api, qs, state, toast, tip, placeTip, draw, ...),
// so it starts once app.js is ready, in whichever order the two load.
//
// Simulation mode runs entirely in the browser: people with devices walk past (or are dragged onto) a street with
// the billboard sensor in the middle. Every 4 s "sensor cycle" each device is heard with an RSSI from the same
// log-distance model and thresholds the server uses (Settings), and visits are built the way lib/ingest.ts does.
// Real-world mode places the devices the sensors actually heard (/api/radar) around the billboard, read-only.
window.initSim = function initSim() {
  if (window.Sim) return;

  // ---------------------------------------------------------------- world (metres)
  const W = 60, H = 36;                 // scene size
  const SX = 30, SY = 18;               // sensor, mounted on the billboard
  const BOARD = { w: 12, h: 1.8 };
  const PATHS = [
    { y0: 20.5, y1: 24.5, front: true, weight: 0.65 },   // sidewalk in front of the billboard face
    { y0: 8.5, y1: 11.5, front: false, weight: 0.35 },   // footpath behind it
  ];
  const ROAD = { y0: 26.5, y1: 34.5 };
  const CYCLE = 4;                       // firmware cycle, seconds
  const WINDOW = 60;                     // "in range now" window, as on the Live page
  const FLOOR = -95;                     // weakest RSSI the ESP32 radio reports

  const DEVICES = {
    phone: { label: 'Phone', type: 'phone', kind: 'wifi', p: 0.75 },     // p: chance it's heard in a given cycle
    watch: { label: 'Smartwatch', type: 'wearable', kind: 'ble', p: 0.95 },
    earbuds: { label: 'Earbuds', type: 'audio', kind: 'ble', p: 0.95 },
    laptop: { label: 'Laptop', type: 'computer', kind: 'wifi', p: 0.45 },
    tracker: { label: 'Tracker tag', type: 'tracker', kind: 'ble', p: 0.9 },
  };
  const PRESETS = [
    { key: 'phone', label: 'Phone only', devices: ['phone'], weight: 45 },
    { key: 'phone_watch', label: 'Phone + watch', devices: ['phone', 'watch'], weight: 20 },
    { key: 'phone_buds', label: 'Phone + earbuds', devices: ['phone', 'earbuds'], weight: 20 },
    { key: 'commuter', label: 'Phone + laptop', devices: ['phone', 'laptop'], weight: 5 },
    { key: 'none', label: 'No devices', devices: [], weight: 10 },
  ];
  const DEFAULTS = { viewer_rssi: -60, passer_rssi: -80, visit_gap_s: 300, min_dwell_s: 5, devices_per_person: 1.6,
    rssi_1m_ble: -59, rssi_1m_wifi: -45, path_loss_n: 2.7 };
  const S = () => {
    const s = { ...DEFAULTS };
    for (const k in DEFAULTS) if (state.settings && state.settings[k] != null && !Number.isNaN(+state.settings[k])) s[k] = +state.settings[k];
    return s;
  };

  // ---------------------------------------------------------------- radio model (mirrors lib/classify.ts distanceM)
  const refFor = (kind, s) => kind === 'ble' ? s.rssi_1m_ble : s.rssi_1m_wifi;
  const pathN = s => Math.max(s.path_loss_n, 1.5);
  const rssiAt = (m, kind, s) => refFor(kind, s) - 10 * pathN(s) * Math.log10(Math.max(m, 0.3));
  const distFor = (rssi, kind, s) => Math.min(Math.max(10 ** ((refFor(kind, s) - rssi) / (10 * pathN(s))), 0.3), 300);
  const zoneFor = (rssi, s) => rssi == null ? 'far' : rssi >= s.viewer_rssi ? 'viewer' : rssi >= s.passer_rssi ? 'passerby' : 'far';
  const ZONE_NAMES = { viewer: 'Viewer', passerby: 'Passer-by', far: 'Too far' };
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  const round1 = n => Math.round(n * 10) / 10;
  const clock = t => { t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };

  // ---------------------------------------------------------------- state
  const sim = {
    mode: 'sim', playing: true, speed: 1, rate: 6, noise: true,
    t: 0, nextCycle: CYCLE, cyc: 0, people: [], devs: new Map(), nextPerson: 1, nextDev: 1,
    selected: null, hover: null, dropHover: null, drag: null,
    pulses: [], series: [], realSeries: [], visits: [], feed: [],
    real: null, realDots: new Map(), realSel: null, realLoading: false,
    raf: null, last: 0, dirty: true, lastUi: 0, spawnAcc: 0,
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function newDevice(key, owner) {
    const def = DEVICES[key];
    const b = hex(6);
    if (def.type === 'phone') b[0] = ((parseInt(b[0], 16) | 2) & 0xfe).toString(16).padStart(2, '0'); // randomized MAC
    const d = { id: 'd' + sim.nextDev++, key, owner, mac: b.join(':'), fp: hex(4).join(''),
      mfr: key === 'tracker' ? 89 : Math.random() < 0.6 ? 76 : 117, rssi: null, last_seen: -Infinity, visit: null };
    sim.devs.set(d.id, d);
    return d;
  }
  function addPerson(presetKey, x, y, { walker = false, select = true, devices = null } = {}) {
    const pr = PRESETS.find(p => p.key === presetKey) || PRESETS[0];
    const p = { id: 'p' + sim.nextPerson, name: `Person ${sim.nextPerson++}`, preset: pr.key, x, y, ty: y, baseY: y,
      vx: 0, dir: 1, walker, state: walker ? 'walking' : 'standing', front: y > SY, willLook: false, looked: false, lookUntil: 0, devices: [] };
    p.devices = (devices || pr.devices).filter(k => DEVICES[k]).map(k => newDevice(k, p));
    sim.people.push(p);
    if (select) sim.selected = p.id;
    sim.dirty = true;
    return p;
  }
  function spawnWalker() {
    let r = Math.random(), path = PATHS[0];
    for (const pa of PATHS) { if (r < pa.weight) { path = pa; break; } r -= pa.weight; }
    let w = Math.random() * PRESETS.reduce((a, p) => a + p.weight, 0), preset = PRESETS[0];
    for (const pr of PRESETS) { if (w < pr.weight) { preset = pr; break; } w -= pr.weight; }
    const dir = Math.random() < 0.5 ? 1 : -1;
    const y = path.y0 + Math.random() * (path.y1 - path.y0);
    const p = addPerson(preset.key, dir > 0 ? -1 : W + 1, y, { walker: true, select: false });
    p.dir = dir; p.vx = dir * (1.0 + Math.random() * 0.6);
    p.front = path.front;
    p.willLook = path.front && Math.random() < 0.35;
    p.lookAt = SX + (Math.random() - 0.5) * 5;
  }
  function removePerson(p) {
    sim.people = sim.people.filter(x => x !== p);
    p.gone = true;              // its devices stay in sim.devs until their visit times out, like the server
    if (sim.selected === p.id) sim.selected = null;
    sim.dirty = true;
  }
  const personById = id => sim.people.find(p => p.id === id);

  // ---------------------------------------------------------------- simulation step
  function move(dt) {
    for (const p of [...sim.people]) {
      if (!p.walker || sim.drag?.p === p) continue;
      if (p.state === 'looking') {
        if (sim.t >= p.lookUntil) { p.state = 'walking'; p.ty = p.baseY; }
      } else {
        p.x += p.vx * dt;
        if (p.willLook && !p.looked && Math.abs(p.x - p.lookAt) < Math.abs(p.vx * dt) + 0.05) {
          p.looked = true; p.state = 'looking';
          p.lookUntil = sim.t + 4 + Math.random() * 22;
          p.ty = SY + BOARD.h / 2 + 1 + Math.random() * 1.5;   // step up to the billboard
        }
      }
      p.y += (p.ty - p.y) * Math.min(1, dt * 1.6);
      if (p.x < -3 || p.x > W + 3) removePerson(p);
    }
  }
  function advance(dt) {
    sim.spawnAcc += dt * sim.rate / 60 * (0.6 + Math.random() * 0.8);
    while (sim.spawnAcc >= 1) { sim.spawnAcc -= 1; spawnWalker(); }
    let left = dt;
    while (left > 1e-6) {
      const step = Math.min(left, 0.25, sim.nextCycle - sim.t);
      move(step); sim.t += step; left -= step;
      if (sim.t >= sim.nextCycle - 1e-9) { cycle(); sim.nextCycle += CYCLE; }
    }
  }

  // One firmware cycle: hear devices, aggregate into JSON lines, update visits
  function cycle() {
    const s = S(), lines = [], now = performance.now();
    for (const p of sim.people) for (const d of p.devices) {
      const def = DEVICES[d.key];
      const m = Math.hypot(p.x - SX, p.y - SY);
      let r = rssiAt(m, def.kind, s) + (sim.noise ? gauss() * 4 : 0);
      r = Math.round(Math.min(r, -20));
      if (r < FLOOR || Math.random() > def.p) continue;
      d.rssi = r; d.last_seen = sim.t;
      if (d.visit && sim.t - d.visit.end > s.visit_gap_s) closeVisit(d, s);
      if (!d.visit) d.visit = { start: sim.t, end: sim.t, peak: r };
      else { d.visit.end = sim.t; d.visit.peak = Math.max(d.visit.peak, r); }
      if (!reduceMotion.matches && sim.speed <= 5) sim.pulses.push({ x: p.x, y: p.y, born: now, type: def.type });
      lines.push(JSON.stringify(def.kind === 'wifi'
        ? { t: 'w', m: d.mac, r, n: 1 + Math.floor(Math.random() * 3), ch: 1 + Math.floor(Math.random() * 13), rnd: def.type === 'phone' ? 1 : 0, fp: d.fp, ssid: '' }
        : { t: 'b', m: d.mac, r, n: 4 + Math.floor(Math.random() * 10), at: 1, mfr: d.mfr, name: '' }));
    }
    sim.cyc++;
    lines.push(JSON.stringify({ t: 'hb', cyc: sim.cyc, up: Math.round(sim.t), heap: 158000 + Math.floor(Math.random() * 6000), dev: lines.length, drop: 0 }));
    sim.feed = lines;
    // close visits that went quiet; forget devices whose owner left and whose visit is done
    for (const d of sim.devs.values()) {
      if (d.visit && sim.t - d.visit.end > s.visit_gap_s) closeVisit(d, s);
      if (!d.visit && d.owner.gone) sim.devs.delete(d.id);
    }
    const st = stats(s);
    sim.series.push({ t: sim.t, actual: st.actual, est: st.est, viewers: st.viewers });
    if (sim.series.length > 90) sim.series.shift();
    sim.dirty = true;
  }
  function closeVisit(d, s) {
    const v = d.visit; d.visit = null;
    const dwell = v.end - v.start;
    sim.visits.unshift({ dev: d, who: d.owner.name, start: v.start, dwell, peak: v.peak, zone: zoneFor(v.peak, s), counted: dwell >= s.min_dwell_s });
    if (sim.visits.length > 60) sim.visits.pop();
  }

  // What the dashboard would show right now vs. the truth
  function stats(s = S()) {
    const heard = [...sim.devs.values()].filter(d => sim.t - d.last_seen <= WINDOW);
    const viewers = heard.filter(d => zoneFor(d.rssi, s) === 'viewer').length;
    const passers = heard.filter(d => zoneFor(d.rssi, s) === 'passerby').length;
    const rangeM = distFor(s.passer_rssi, 'wifi', s);
    const near = sim.people.filter(p => Math.hypot(p.x - SX, p.y - SY) <= rangeM);
    const done = sim.visits.filter(v => v.counted);
    return {
      heard: heard.length, viewers, passers, actual: near.length, inScene: sim.people.length,
      noDevice: near.filter(p => !p.devices.length).length, rangeM,
      est: round1((viewers + passers) / Math.max(s.devices_per_person, 0.1)),
      visits: done.length, avgDwell: done.length ? done.reduce((a, v) => a + v.dwell, 0) / done.length : null,
    };
  }
  const deviceZone = (d, s) => sim.t - d.last_seen <= WINDOW ? zoneFor(d.rssi, s) : null;
  function personZone(p, s) {
    const zs = p.devices.map(d => deviceZone(d, s));
    return zs.includes('viewer') ? 'viewer' : zs.includes('passerby') ? 'passerby' : zs.includes('far') ? 'far' : null;
  }

  // ---------------------------------------------------------------- real-world data
  function angleFor(id) {
    let h = 2166136261;
    for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return ((h >>> 0) / 4294967296) * Math.PI * 2;
  }
  async function loadReal() {
    if (sim.realLoading || sim.mode !== 'real') return;
    sim.realLoading = true;
    try {
      sim.real = await api(`/api/radar?${qs({ window: WINDOW })}`);
      const seen = new Set();
      for (const d of sim.real.devices) {
        if (d.kind === 'ap') continue;
        seen.add(d.id);
        const dot = sim.realDots.get(d.id), dist = d.distance ?? 60;
        if (dot) { dot.target = dist; dot.d = d; }
        else sim.realDots.set(d.id, { cur: reduceMotion.matches ? dist : dist * 1.3 + 3, target: dist, d, ang: angleFor(d.id) });
      }
      for (const id of sim.realDots.keys()) if (!seen.has(id)) sim.realDots.delete(id);
      if (sim.realSel && !sim.realDots.has(sim.realSel)) sim.realSel = null;
      const st = realStats();
      sim.realSeries.push({ t: Date.now() / 1000, est: st.est, viewers: st.viewers });
      if (sim.realSeries.length > 90) sim.realSeries.shift();
      sim.dirty = true;
    } catch (err) { netError(err); }
    finally { sim.realLoading = false; }
  }
  function realStats() {
    const s = S(), list = [...sim.realDots.values()].map(x => x.d).filter(d => !d.excluded);
    const viewers = list.filter(d => d.zone === 'viewer').length, passers = list.filter(d => d.zone === 'passerby').length;
    return { heard: list.length, viewers, passers, est: round1((viewers + passers) / Math.max(s.devices_per_person, 0.1)),
      nearest: list.length ? Math.min(...list.map(d => d.distance ?? 999)) : null };
  }
  const realTitle = d => d.label || d.name || d.model || (d.vendor ? `${d.vendor} device` : d.kind === 'ble' ? 'BLE device' : 'WiFi device');

  // ---------------------------------------------------------------- canvas
  const stage = $('#simStage'), cv = $('#simCanvas');
  let k = 10;  // px per metre
  function start() {
    if (sim.raf) return;
    sim.last = 0;
    const frame = now => {
      if (state.page !== 'simulation' || document.hidden) { sim.raf = null; return; }
      const dt = sim.last ? Math.min(0.1, (now - sim.last) / 1000) : 0;
      sim.last = now;
      if (sim.mode === 'sim' && sim.playing) advance(dt * sim.speed);
      render(now);
      if (sim.dirty && now - sim.lastUi > 400) { sim.lastUi = now; sim.dirty = false; updateUi(); }
      sim.raf = requestAnimationFrame(frame);
    };
    sim.raf = requestAnimationFrame(frame);
  }

  function render(now) {
    const w = stage.clientWidth;
    if (!w) return;
    const h = w * H / W, dpr = window.devicePixelRatio || 1;
    k = w / W;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = { text: css('--text'), text2: css('--text-2'), muted: css('--muted'), surface: css('--surface'), bg2: css('--surface-2'),
      bg3: css('--surface-3'), grid: css('--grid'), axis: css('--axis'), accent: css('--accent'), s1: css('--s1'), s2: css('--s2'), crit: css('--critical') };
    const s = S(), X = x => x * k, Y = y => y * k, rr = (x, y, ww, hh, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, ww, hh, r) : ctx.rect(x, y, ww, hh); };

    // ground, footpaths, road
    ctx.fillStyle = c.bg2; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = c.surface;
    for (const pa of PATHS) ctx.fillRect(0, Y(pa.y0), w, Y(pa.y1 - pa.y0));
    ctx.fillStyle = c.bg3; ctx.fillRect(0, Y(ROAD.y0), w, Y(ROAD.y1 - ROAD.y0));
    ctx.strokeStyle = c.axis; ctx.lineWidth = Math.max(1, k * 0.15); ctx.setLineDash([k * 2, k * 2]);
    ctx.beginPath(); ctx.moveTo(0, Y((ROAD.y0 + ROAD.y1) / 2)); ctx.lineTo(w, Y((ROAD.y0 + ROAD.y1) / 2)); ctx.stroke();
    ctx.setLineDash([]);

    // zones: shaded for phones (WiFi), dashed for BLE wearables
    const zw = { v: distFor(s.viewer_rssi, 'wifi', s), p: distFor(s.passer_rssi, 'wifi', s) };
    const zb = { v: distFor(s.viewer_rssi, 'ble', s), p: distFor(s.passer_rssi, 'ble', s) };
    ctx.save();
    ctx.globalAlpha = 0.09; ctx.fillStyle = c.s2; ctx.beginPath(); ctx.arc(X(SX), Y(SY), X(zw.p), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.14; ctx.fillStyle = c.s1; ctx.beginPath(); ctx.arc(X(SX), Y(SY), X(zw.v), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.55; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.strokeStyle = c.s2; ctx.beginPath(); ctx.arc(X(SX), Y(SY), X(zb.p), 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = c.s1; ctx.beginPath(); ctx.arc(X(SX), Y(SY), Math.max(X(zb.v), 3), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = c.muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right';
    const ringLbl = (m, t) => { const y = Y(SY) - X(m) * 0.7071; if (y > 12) ctx.fillText(t, X(SX) - X(m) * 0.7071 - 4, y); };
    ringLbl(zw.p, `passer-by ≤ ${fmt(round1(zw.p))} m`);
    if (X(zw.v) > 30) ringLbl(zw.v, `viewer ≤ ${fmt(round1(zw.v))} m`);

    // signal pulses: each heard device "talks" to the sensor
    sim.pulses = sim.pulses.filter(pu => now - pu.born < 700);
    for (const pu of sim.pulses) {
      const a = 1 - (now - pu.born) / 700;
      ctx.globalAlpha = a * 0.45; ctx.strokeStyle = typeColor(pu.type); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(pu.x), Y(pu.y)); ctx.lineTo(X(SX), Y(SY)); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // billboard (top-down) with its face toward the sidewalk
    const bx = X(SX - BOARD.w / 2), by = Y(SY - BOARD.h / 2), bw = X(BOARD.w), bh = Math.max(Y(BOARD.h), 14);
    ctx.fillStyle = c.text2;   // posts
    for (const f of [0.25, 0.75]) ctx.fillRect(bx + bw * f - 2, by - 5, 4, 5);
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
    ctx.fillStyle = c.text; rr(bx, by, bw, bh, 4); ctx.fill(); ctx.restore();
    const faceH = Math.max(3, bh * 0.2);   // lit face, toward the sidewalk
    ctx.fillStyle = c.accent; rr(bx + 4, by + bh - faceH - 2, bw - 8, faceH, 2); ctx.fill();
    ctx.fillStyle = c.surface; ctx.font = `700 ${Math.max(9, Math.min(14, bh * 0.5))}px system-ui, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText('BILLBOARD', X(SX), by + (bh - faceH) * 0.66);
    // sensor, at the centre of the board
    const sx = X(SX), sy = by - 9;
    const pulse = reduceMotion.matches ? 0 : (now % 2000) / 2000;
    ctx.strokeStyle = c.accent; ctx.globalAlpha = 1 - pulse; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sx, sy, 3 + pulse * 12, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = c.accent; ctx.strokeStyle = c.surface; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
    if (w > 520) { ctx.fillStyle = c.muted; ctx.font = '10px system-ui, sans-serif'; ctx.fillText('ESP32 sensor', sx, sy - 9); }

    if (sim.mode === 'sim') drawPeople(ctx, c, s, now); else drawReal(ctx, c);
  }

  const personR = () => Math.max(8, Math.min(13, k * 0.95));
  function drawPeople(ctx, c, s, now) {
    const R = personR();
    const labels = [];
    for (const p of sim.people) {
      const x = p.x * k, y = p.y * k, z = personZone(p, s);
      const sel = sim.selected === p.id, target = sim.dropHover === p.id, hov = sim.hover === p.id;
      // looking: view cone toward the billboard
      if (p.state === 'looking') {
        ctx.fillStyle = hexA(c.s1, 0.16);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(SX * k - 18, SY * k + 4); ctx.lineTo(SX * k + 18, SY * k + 4); ctx.closePath(); ctx.fill();
      }
      // zone ring (what the dashboard counts them as)
      if (z === 'viewer' || z === 'passerby') {
        ctx.strokeStyle = z === 'viewer' ? c.s1 : c.s2; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x, y, R + 4, 0, Math.PI * 2); ctx.stroke();
      }
      if (sel || target) {
        ctx.strokeStyle = c.accent; ctx.lineWidth = 2; ctx.setLineDash(target ? [4, 3] : []);
        ctx.beginPath(); ctx.arc(x, y, R + 9, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
      // body: shoulders + head, facing the walking direction
      const face = p.state === 'looking' ? Math.atan2(SY - p.y, SX - p.x) : p.walker ? (p.dir > 0 ? 0 : Math.PI) : -Math.PI / 2;
      ctx.save(); ctx.translate(x, y); ctx.rotate(face + Math.PI / 2);
      ctx.globalAlpha = p.devices.length ? 1 : 0.55;
      ctx.fillStyle = c.muted; ctx.beginPath(); ctx.ellipse(0, R * 0.1, R, R * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.text2; ctx.beginPath(); ctx.arc(0, -R * 0.1, R * 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.restore(); ctx.globalAlpha = 1;
      // devices orbiting the person; hollow = not heard in the last minute
      p.devices.forEach((d, i) => {
        const a = -Math.PI / 2 + (i - (p.devices.length - 1) / 2) * 0.9;
        const dx = x + Math.cos(a) * (R + 5), dy = y + Math.sin(a) * (R + 5), col = typeColor(DEVICES[d.key].type);
        const heard = sim.t - d.last_seen <= WINDOW;
        ctx.beginPath();
        if (DEVICES[d.key].kind === 'wifi') ctx.rect(dx - 3.5, dy - 3.5, 7, 7); else ctx.arc(dx, dy, 3.8, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        if (heard) { ctx.fillStyle = col; ctx.strokeStyle = c.surface; ctx.stroke(); ctx.fill(); }
        else { ctx.fillStyle = c.surface; ctx.strokeStyle = col; ctx.fill(); ctx.stroke(); }
      });
      if (sel || hov || target) labels.push({ x, y: y - R - 14, text: p.name });
    }
    ctx.font = '600 11.5px system-ui, sans-serif'; ctx.textAlign = 'center';
    for (const l of labels) {
      const tw = ctx.measureText(l.text).width;
      ctx.fillStyle = c.surface; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(l.x - tw / 2 - 5, l.y - 11, tw + 10, 16, 5) : ctx.rect(l.x - tw / 2 - 5, l.y - 11, tw + 10, 16); ctx.fill();
      ctx.fillStyle = c.text; ctx.fillText(l.text, l.x, l.y + 1);
    }
  }
  function realPos(dot) {
    const m = Math.min(dot.cur, 80);
    let x = SX + Math.cos(dot.ang) * m, y = SY + Math.sin(dot.ang) * m * 0.9;
    const cx = Math.max(1, Math.min(W - 1, x)), cy = Math.max(1, Math.min(H - 1, y));
    return { x: cx, y: cy, clipped: cx !== x || cy !== y };
  }
  function drawReal(ctx, c) {
    for (const [id, dot] of sim.realDots) {
      dot.cur += (dot.target - dot.cur) * 0.08;
      const d = dot.d, pos = realPos(dot), x = pos.x * k, y = pos.y * k;
      dot.px = x; dot.py = y;
      const fade = Math.max(0.35, 1 - Math.max(0, d.age - 8) / WINDOW), sz = sim.hover === id || sim.realSel === id ? 7 : 5;
      ctx.globalAlpha = fade;
      if (d.zone === 'viewer' || d.zone === 'passerby') {
        ctx.strokeStyle = d.zone === 'viewer' ? c.s1 : c.s2; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, sz + 5, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = typeColor(d.type); ctx.strokeStyle = c.surface; ctx.lineWidth = 2;
      ctx.beginPath();
      if (d.kind === 'ble') ctx.arc(x, y, sz, 0, Math.PI * 2); else ctx.rect(x - sz, y - sz, sz * 2, sz * 2);
      if (d.excluded) { ctx.strokeStyle = typeColor(d.type); ctx.stroke(); } else { ctx.stroke(); ctx.fill(); }
      if (pos.clipped) { ctx.fillStyle = c.muted; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${fmt(d.distance)}m`, x, y + sz + 12); }
      if (sim.realSel === id) { ctx.strokeStyle = c.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, sz + 9, 0, Math.PI * 2); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------- hit testing + pointer
  const local = ev => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top, r }; };
  const toWorld = ev => { const l = local(ev); return { x: l.x / k, y: l.y / k }; };
  const overStage = ev => { const r = stage.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom; };
  function personAt(ev, skip = null) {
    const l = local(ev), lim = Math.max(personR() + 6, ev.pointerType === 'touch' ? 24 : 0);
    let best = null, bd = lim;
    for (const p of sim.people) {
      if (p === skip) continue;
      const dd = Math.hypot(p.x * k - l.x, p.y * k - l.y);
      if (dd < bd) { bd = dd; best = p; }
    }
    return best;
  }
  function realAt(ev) {
    const l = local(ev);
    let best = null, bd = ev.pointerType === 'touch' ? 22 : 12;
    for (const [id, dot] of sim.realDots) { const dd = Math.hypot(dot.px - l.x, dot.py - l.y); if (dd < bd) { bd = dd; best = id; } }
    return best;
  }

  cv.addEventListener('pointerdown', ev => {
    if (ev.button) return;
    tip.classList.add('hidden');
    if (sim.mode === 'real') { sim.realSel = realAt(ev); renderInspector(); return; }
    const p = personAt(ev);
    sim.selected = p ? p.id : null;
    renderInspector();
    if (!p) return;
    ev.preventDefault();
    cv.setPointerCapture(ev.pointerId);
    const w = toWorld(ev);
    sim.drag = { p, dx: p.x - w.x, dy: p.y - w.y, sx: ev.clientX, sy: ev.clientY, moved: false };
  });
  cv.addEventListener('pointermove', ev => {
    const dr = sim.drag;
    if (dr) {
      if (!dr.moved && Math.hypot(ev.clientX - dr.sx, ev.clientY - dr.sy) < 4) return;
      if (!dr.moved) { dr.moved = true; dr.p.walker = false; dr.p.state = 'standing'; cv.style.cursor = 'grabbing'; }
      const w = toWorld(ev);
      dr.p.x = w.x + dr.dx; dr.p.y = dr.p.ty = dr.p.baseY = w.y + dr.dy;
      stage.classList.toggle('drop-remove', !overStage(ev));
      return;
    }
    if (sim.mode === 'real') {
      const id = realAt(ev);
      sim.hover = id; cv.style.cursor = id ? 'pointer' : 'default';
      if (!id) { tip.classList.add('hidden'); return; }
      const d = sim.realDots.get(id).d;
      tip.innerHTML = `<b>${esc(realTitle(d))}</b><br>${TYPE_NAMES[d.type] || 'Other'} · ${radioName(d.kind)}<br>≈ ${fmt(d.distance)} m · ${d.rssi} dBm · ${ZONE_NAMES[d.zone] || d.zone}<br><span class="muted">Seen ${Math.round(d.age)}s ago</span>`;
    } else {
      const p = personAt(ev);
      sim.hover = p ? p.id : null; cv.style.cursor = p ? 'grab' : 'default';
      if (!p) { tip.classList.add('hidden'); return; }
      const s = S(), z = personZone(p, s);
      tip.innerHTML = `<b>${esc(p.name)}</b> · ${esc(stateLabel(p))}<br>${fmt(round1(Math.hypot(p.x - SX, p.y - SY)))} m from the billboard<br>` +
        (p.devices.length ? `${plural(p.devices.length, 'device')} · ${z ? 'counted as ' + ZONE_NAMES[z].toLowerCase() : 'not heard yet'}` : 'No devices: invisible to the sensor');
    }
    tip.classList.remove('hidden');
    placeTip(ev.clientX, ev.clientY);
  });
  const endDrag = ev => {
    const dr = sim.drag;
    if (!dr) return;
    sim.drag = null; cv.style.cursor = 'grab';
    stage.classList.remove('drop-remove');
    if (dr.moved && ev.type === 'pointerup' && !overStage(ev)) { removePerson(dr.p); toast(`${dr.p.name} removed`); }
    else if (dr.moved) { dr.p.x = Math.max(0.5, Math.min(W - 0.5, dr.p.x)); dr.p.y = dr.p.ty = dr.p.baseY = Math.max(0.5, Math.min(H - 0.5, dr.p.y)); }
    sim.dirty = true; save();
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => { if (!sim.drag) { sim.hover = null; tip.classList.add('hidden'); } });

  // ---------------------------------------------------------------- palette (drag or tap)
  const AVATAR = svg('<circle cx="12" cy="7.8" r="3.6"/><path d="M5 20.5a7 7 0 0 1 14 0"/>', 'ico sim-avatar');
  const devDot = key => `<i class="${DEVICES[key].kind}" style="background:${typeColor(DEVICES[key].type)}"></i>`;
  function renderPalette() {
    $('#simPeople').innerHTML = PRESETS.map(p => `<button type="button" class="sim-item" data-preset="${p.key}" title="Drag onto the street">
      ${AVATAR}<span>${p.label}</span><span class="dots">${p.devices.map(devDot).join('') || '<em class="muted small">invisible</em>'}</span></button>`).join('');
    $('#simDevices').innerHTML = Object.entries(DEVICES).map(([key, d]) => `<button type="button" class="sim-item" data-device="${key}" title="Drag onto a person">
      <span class="dots">${devDot(key)}</span>${d.label}</button>`).join('');
    $$('#simPeople .sim-item, #simDevices .sim-item').forEach(paletteDrag);
  }
  function paletteDrag(el) {
    el.addEventListener('pointerdown', ev => {
      if (sim.mode !== 'sim' || ev.button) return;
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      const sx = ev.clientX, sy = ev.clientY, isDev = !!el.dataset.device;
      let ghost = null;
      const move = e => {
        if (!ghost) {
          if (Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
          ghost = el.cloneNode(true); ghost.classList.add('sim-ghost'); ghost.removeAttribute('title');
          document.body.appendChild(ghost);
        }
        ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
        const over = overStage(e);
        stage.classList.toggle('drop-ok', over);
        sim.dropHover = isDev && over ? personAt(e)?.id ?? null : null;
      };
      const up = e => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        stage.classList.remove('drop-ok'); sim.dropHover = null;
        if (!ghost) return;          // a tap: the click handler adds it
        ghost.remove(); el.dataset.dragged = '1';
        if (e.type !== 'pointerup' || !overStage(e)) return;
        const w = toWorld(e);
        if (!isDev) { addPerson(el.dataset.preset, Math.max(0.5, Math.min(W - 0.5, w.x)), Math.max(0.5, Math.min(H - 0.5, w.y))); save(); renderInspector(); return; }
        const p = personAt(e);
        if (p) giveDevice(p, el.dataset.device); else toast('Drop the device onto a person', 'error');
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    el.addEventListener('click', () => {
      if (el.dataset.dragged) { delete el.dataset.dragged; return; }
      if (sim.mode !== 'sim') return;
      if (el.dataset.preset) {
        const pa = PATHS[0];
        addPerson(el.dataset.preset, 12 + Math.random() * 36, pa.y0 + 0.5 + Math.random() * (pa.y1 - pa.y0 - 1));
        save(); renderInspector();
      } else {
        const p = personById(sim.selected);
        if (p) giveDevice(p, el.dataset.device); else toast('Select a person first, or drag the device onto one', 'error');
      }
    });
  }
  function giveDevice(p, key) {
    if (p.devices.length >= 5) { toast(`${p.name} is carrying enough already`, 'error'); return; }
    p.devices.push(newDevice(key, p));
    sim.selected = p.id; sim.dirty = true;
    toast(`${DEVICES[key].label} given to ${p.name}`);
    save(); renderInspector();
  }

  // ---------------------------------------------------------------- side panels, KPIs, chart, feed, visits
  const stateLabel = p => p.state === 'looking' ? 'Looking at the billboard' : p.walker ? 'Walking past' : 'Standing';
  const zoneChip = z => z === 'viewer' || z === 'passerby'
    ? `<span class="chip"><span class="sw-inline" style="background:${css(z === 'viewer' ? '--s1' : '--s2')}"></span>${ZONE_NAMES[z]}</span>`
    : `<span class="chip muted">${z ? ZONE_NAMES[z] : 'Not heard'}</span>`;
  const facts = rows => `<dl class="sim-facts">${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>`;
  const CLOSE = svg('<path d="M6 6l12 12M18 6L6 18"/>');

  function renderInspector() {
    const el = $('#simInspect'), s = S();
    if (sim.mode === 'real') {
      const dot = sim.realSel && sim.realDots.get(sim.realSel);
      if (!dot) {
        const st = realStats();
        el.innerHTML = `<h3>Live from ${esc(sensorById(state.scope)?.name || 'all billboards')}</h3>
          <p class="sub">Devices heard in the last minute, placed by estimated distance. Direction is arbitrary: one sensor can&rsquo;t tell it.</p>
          ${facts([['Devices heard', fmt(st.heard)], ['Nearest', st.nearest != null ? `${fmt(st.nearest)} m` : '–']])}
          <p class="muted small">Click a device for details. Use the billboard picker in the toolbar to switch sensor.</p>`;
        return;
      }
      const d = dot.d;
      el.innerHTML = `<div class="sim-insp-h"><div><div class="sheet-eyebrow">${TYPE_NAMES[d.type] || 'Device'}</div><h3>${esc(realTitle(d))}</h3></div></div>
        ${facts([['Radio', radioName(d.kind)], ['Signal', `${d.rssi} dBm`], ['Distance', `≈ ${fmt(d.distance)} m`], ['Zone', zoneChip(d.zone)],
          ['Seen', `${Math.round(d.age)} s ago`], ['Address', d.randomized ? 'Random' : 'Stable'], ...(d.excluded ? [['Counted', 'No, excluded']] : [])])}
        <button type="button" class="btn sm block" data-sim="open">Open device</button>`;
      return;
    }
    const p = personById(sim.selected);
    if (!p) {
      const st = stats(s);
      el.innerHTML = `<h3>Scene</h3>
        ${facts([['People on the street', fmt(st.inScene)], ['Within sensor range', fmt(st.actual)], ['Sim time', clock(sim.t)]])}
        <ul class="sim-tips">
          <li>Drag a person closer to the billboard: the signal gets stronger and they turn from passer-by into viewer.</li>
          <li>Someone carrying a phone and a watch is heard twice. The dashboard divides by <b>${fmt(s.devices_per_person)}</b> devices per person to estimate people.</li>
          <li>People with no device are never counted.</li>
          <li>A visit ends after ${dur(s.visit_gap_s)} unheard, so counts lag behind people walking off.</li>
        </ul>`;
      return;
    }
    const m = Math.hypot(p.x - SX, p.y - SY), z = personZone(p, s);
    el.innerHTML = `<div class="sim-insp-h"><div><div class="sheet-eyebrow">${esc(PRESETS.find(x => x.key === p.preset)?.label || 'Person')}</div><h3>${esc(p.name)}</h3></div>
        <button type="button" class="icon-btn" data-sim="remove" aria-label="Remove ${esc(p.name)}">${CLOSE}</button></div>
      ${facts([['Status', stateLabel(p)], ['To billboard', `${fmt(round1(m))} m`], ['Counted as', p.devices.length ? zoneChip(z) : '<span class="chip muted">Invisible</span>']])}
      <h4 class="sim-h4">Devices <span class="muted">${p.devices.length}</span></h4>
      ${p.devices.length ? `<ul class="sim-devlist">${p.devices.map(d => {
        const def = DEVICES[d.key], heard = sim.t - d.last_seen <= WINDOW;
        return `<li><span class="tsw" style="background:${typeColor(def.type)}"></span><div><div>${def.label}</div>
          <div class="meta">${radioName(def.kind)} · ${heard ? `${d.rssi} dBm · reads ≈ ${fmt(round1(distFor(d.rssi, def.kind, s)))} m` : 'not heard'}</div></div>
          <button type="button" class="icon-btn" data-sim-rm="${d.id}" aria-label="Remove ${def.label}">${CLOSE}</button></li>`;
      }).join('')}</ul>` : '<p class="muted small sim-none">No devices: the sensor can&rsquo;t see this person. Drag a device onto them.</p>'}
      <button type="button" class="btn sm block" data-sim="walk">${p.walker ? 'Stand still' : 'Walk past'}</button>`;
  }
  $('#simInspect').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.sim === 'open' && sim.realSel) { openDevice(sim.realSel); return; }
    const p = personById(sim.selected);
    if (!p) return;
    if (b.dataset.sim === 'remove') removePerson(p);
    else if (b.dataset.sim === 'walk') {
      p.walker = !p.walker;
      if (p.walker) {
        p.dir = p.x < SX ? 1 : -1; p.vx = p.dir * 1.3; p.state = 'walking';
        p.front = p.y > SY; p.willLook = false; p.looked = true;
      } else p.state = 'standing';
    } else if (b.dataset.simRm) {
      const d = p.devices.find(x => x.id === b.dataset.simRm);
      p.devices = p.devices.filter(x => x !== d);
      if (d) { d.owner = { gone: true, name: p.name }; }   // its open visit still times out normally
    }
    sim.dirty = true; save(); renderInspector();
  });

  function updateUi() {
    const s = S();
    if (sim.mode === 'sim') {
      const st = stats(s), err = st.actual && sim.cyc ? Math.round((st.est - st.actual) / st.actual * 100) : null;
      $('#simKpis').innerHTML = [
        kpiTile('People in range', fmt(st.actual), `<span class="delta">${plural(st.inScene, 'person', 'people')} on the street</span>`, `Ground truth: people within ${fmt(round1(st.rangeM))} m, the phone passer-by range`),
        kpiTile('Estimated people', fmt(st.est), `<span class="delta ${err == null ? '' : Math.abs(err) <= 20 ? 'up' : 'down'}">${err == null ? (sim.cyc ? 'Nobody in range' : 'Waiting for first cycle') : `${err > 0 ? '+' : ''}${err}% vs actual`}</span>`, 'What the dashboard shows: viewer + passer-by devices ÷ devices per person'),
        kpiTile('Devices heard', fmt(st.heard), `<span class="delta">Last ${WINDOW} s</span>`, 'Devices heard by the sensor in the last minute'),
        kpiTile('Viewers', fmt(st.viewers), `<span class="delta">≥ ${s.viewer_rssi} dBm</span>`, 'Devices close enough to see the billboard'),
        kpiTile('Passers-by', fmt(st.passers), `<span class="delta">≥ ${s.passer_rssi} dBm</span>`, 'Devices only in sensor range'),
        kpiTile('Visits', fmt(st.visits), `<span class="delta">Avg dwell ${dur(st.avgDwell)}</span>`, `Finished visits of at least ${dur(s.min_dwell_s)}`),
      ].join('');
      $('#simClock').textContent = `Sim time ${clock(sim.t)} · ${sim.playing ? sim.speed + '×' : 'paused'}`;
      $('#simFeed').textContent = sim.feed.length ? sim.feed.join('\n') : 'Waiting for the first 4 s cycle…';
      renderVisits(s);
    } else {
      const st = realStats();
      $('#simKpis').innerHTML = [
        kpiTile('Estimated people', fmt(st.est), '<span class="delta">Right now</span>', 'Viewer + passer-by devices ÷ devices per person'),
        kpiTile('Devices heard', fmt(st.heard), `<span class="delta">Last ${WINDOW} s</span>`),
        kpiTile('Viewers', fmt(st.viewers), `<span class="delta">≥ ${s.viewer_rssi} dBm</span>`),
        kpiTile('Passers-by', fmt(st.passers), `<span class="delta">≥ ${s.passer_rssi} dBm</span>`),
        kpiTile('Nearest', st.nearest != null ? `${fmt(st.nearest)}<small>m</small>` : '–', '<span class="delta">Estimated from signal</span>'),
      ].join('');
      $('#simClock').textContent = sim.real ? `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Loading…';
      const msg = $('#simMsg');
      msg.classList.toggle('hidden', !sim.real || sim.realDots.size > 0);
      msg.textContent = 'Nothing heard in the last minute';
    }
    redrawChart();
    if (!(sim.mode === 'sim' && sim.drag)) renderInspector();
  }
  function renderVisits(s) {
    const open = [...sim.devs.values()].filter(d => d.visit).map(d => ({ dev: d, who: d.owner.name, start: d.visit.start,
      dwell: d.visit.end - d.visit.start, peak: d.visit.peak, zone: zoneFor(d.visit.peak, s), open: true }));
    const rows = [...open.sort((a, b) => b.start - a.start), ...sim.visits].slice(0, 40);
    $('#simVisitNote').textContent = `${open.length} in progress · a visit closes after ${dur(s.visit_gap_s)} unheard`;
    $('#simVisits').innerHTML = `<thead><tr><th>Device</th><th>Person</th><th>Started</th><th class="num">Dwell</th><th class="num">Peak</th><th>Zone</th><th>Status</th></tr></thead><tbody>` +
      (rows.length ? rows.map(v => { const def = DEVICES[v.dev.key];
        return `<tr><td><span class="tsw" style="background:${typeColor(def.type)}"></span>${def.label} <span class="muted small">${radioName(def.kind)}</span></td>
          <td>${esc(v.who)}</td><td>${clock(v.start)}</td><td class="num">${dur(v.dwell)}</td><td class="num">${v.peak} dBm</td><td>${zoneChip(v.zone)}</td>
          <td>${v.open ? '<span class="tag">in progress</span>' : v.counted ? 'Counted' : `<span class="muted">Too short</span>`}</td></tr>`; }).join('')
        : '<tr class="empty-row"><td colspan="7">No visits yet. Add people or wait for walkers.</td></tr>') + '</tbody>';
  }
  function redrawChart() {
    if (state.page !== 'simulation') return;
    const real = sim.mode === 'real', rows = real ? sim.realSeries : sim.series;
    const labels = rows.map(r => real ? new Date(r.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : clock(r.t));
    const datasets = [
      ...(real ? [] : [lineDs('Actual', rows.map(r => r.actual), css('--text-2'))]),
      lineDs('Estimated', rows.map(r => r.est), css('--s3'), true),
      lineDs('Viewer devices', rows.map(r => r.viewers), css('--s1')),
    ];
    const opts = baseOptions({ legend: true });
    opts.animation = false;
    draw('cSim', { type: 'line', data: { labels, datasets }, options: opts }, { live: true });
    $('#simChartNote').textContent = real ? 'Every 3 s poll' : 'Every 4 s sensor cycle';
  }
  function renderLegend() {
    const sw = (col, t, sq) => `<span class="it"><span class="sw" style="background:${col};border-radius:${sq ? '2px' : '50%'}"></span>${t}</span>`;
    $('#simLegend').innerHTML = sw(css('--s1'), 'Viewer') + sw(css('--s2'), 'Passer-by') +
      Object.values(DEVICES).map(d => sw(typeColor(d.type), d.label, d.kind === 'wifi')).join('') +
      `<span class="it muted">■ WiFi ● BLE · hollow = ${sim.mode === 'real' ? 'excluded' : 'not heard'}</span>`;
  }

  // ---------------------------------------------------------------- controls
  function setMode(m) {
    sim.mode = m;
    sim.hover = null; sim.selected = sim.mode === 'sim' ? sim.selected : null;
    $('#simPalette').classList.toggle('locked', m === 'real');
    $('#simStageTitle').textContent = m === 'real' ? 'Real devices' : 'Street';
    $('#simLede').textContent = m === 'real'
      ? 'What your sensors hear right now, placed around the billboard by estimated distance.'
      : 'Drag people onto the street to see what the sensor would hear and how they’d be counted.';
    $('#simFoot').textContent = m === 'real'
      ? 'Distance comes from signal strength and is rough (±50%). Angle is arbitrary. Devices beyond the edge are pinned to it with their distance.'
      : 'Shaded circles are the viewer and passer-by zones for phones (WiFi). Dashed circles are the zones for BLE wearables. Drag a person off the street to remove them.';
    $('#simFeed').textContent = m === 'real' ? 'Raw sensor batches aren’t stored. See the Live page for what was heard.' : '';
    $('#simVisits').closest('.card').classList.toggle('hidden', m === 'real');
    $('#simMsg').classList.add('hidden');
    if (state.page === 'simulation') $('#scopeBtn').classList.toggle('hidden', m === 'sim');
    if (m === 'real' && state.page === 'simulation') loadReal();
    renderLegend();
    sim.dirty = true; save();
    updateUi();
  }
  segment('#simMode', 'mode', setMode);
  segment('#simSpeed', 'speed', v => { sim.speed = +v; sim.dirty = true; save(); });
  $('#simPlay').onclick = () => {
    sim.playing = !sim.playing;
    $('#simPlay').textContent = sim.playing ? 'Pause' : 'Play';
    $('#simPlay').setAttribute('aria-pressed', sim.playing);
    sim.dirty = true;
  };
  $('#simRate').addEventListener('input', e => { sim.rate = +e.target.value; $('#simRateVal').textContent = sim.rate; save(); });
  $('#simNoise').addEventListener('change', e => { sim.noise = e.target.checked; save(); });
  $('#simClear').onclick = () => {
    sim.people.forEach(p => { p.gone = true; });
    sim.people = []; sim.devs.clear(); sim.visits = []; sim.series = []; sim.feed = []; sim.selected = null;
    sim.t = 0; sim.nextCycle = CYCLE; sim.cyc = 0;
    sim.dirty = true; save(); updateUi();
  };
  document.addEventListener('keydown', e => {
    if (state.page !== 'simulation' || sim.mode !== 'sim' || e.target.closest?.('input, textarea, select')) return;
    const p = personById(sim.selected);
    if (p && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removePerson(p); save(); renderInspector(); }
  });
  setInterval(() => { if (state.page === 'simulation' && sim.mode === 'real' && !document.hidden) loadReal(); }, 3000);

  // ---------------------------------------------------------------- persistence (per-viewer convenience only)
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem('sim', JSON.stringify({ mode: sim.mode, speed: sim.speed, rate: sim.rate, noise: sim.noise,
          people: sim.people.filter(p => !p.walker).map(p => ({ preset: p.preset, x: round1(p.x), y: round1(p.y), devices: p.devices.map(d => d.key) })) }));
      } catch (e) {}
    }, 300);
  }
  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('sim') || 'null'); } catch (e) {}
    if (saved) {
      sim.speed = [1, 5, 20].includes(saved.speed) ? saved.speed : 1;
      sim.rate = Math.max(0, Math.min(40, +saved.rate || 0));
      sim.noise = saved.noise !== false;
      for (const p of saved.people || []) addPerson(p.preset, +p.x || SX, +p.y || SY + 4, { select: false, devices: Array.isArray(p.devices) ? p.devices : null });
    } else {
      // a starter scene: someone at the billboard, someone near, someone without a phone
      addPerson('phone_watch', SX - 1, SY + 2.2, { select: false });
      addPerson('phone', SX + 9, 22.5, { select: false });
      addPerson('none', SX - 12, 23, { select: false });
    }
    setSeg($('#simSpeed'), sim.speed, 'speed');
    $('#simRate').value = sim.rate; $('#simRateVal').textContent = sim.rate;
    $('#simNoise').checked = sim.noise;
    if (saved?.mode === 'real') setSeg($('#simMode'), 'real', 'mode');
    setMode(saved?.mode === 'real' ? 'real' : 'sim');
  }

  function activate() {
    $('#scopeBtn').classList.toggle('hidden', sim.mode === 'sim');
    renderLegend();
    if (sim.mode === 'real') loadReal();
    sim.dirty = true;
    start();
  }

  renderPalette();
  restore();
  window.Sim = { activate, redrawChart };
  if (state.page === 'simulation') activate();
};
if (window.appReady) window.initSim();
