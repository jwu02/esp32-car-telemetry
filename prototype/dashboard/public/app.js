/* PROTOTYPE — throwaway (issue #7). Fake-data live dashboard.
   Four views x three live channels, so the dashboard gets designed by looking
   at it on a phone. Nothing here is production code and nothing here is
   expected to survive this ticket. */

const q = new URLSearchParams(location.search);
const cfg = { v: q.get('v') || 'a', ch: q.get('ch') || 'sse', hz: Number(q.get('hz') || 10) };

// ───────────────────────────────────────────────────────────── state
const KEYS = ['sp', 'rpm', 'pwr', 'soc', 'hvA', 'cool', 'load', 'km'];
const RING = 900;                                   // ~90 s at 10 Hz
const buf = Object.fromEntries(KEYS.map((k) => [k, []]));
let latest = null;
let snap = null;

const GET = {
  sp: (m) => m.sp, rpm: (m) => m.rpm, pwr: (m) => m.pwr, soc: (m) => m.soc, hvA: (m) => m.hvA,
  cool: (m) => m.cool, load: (m) => m.load, km: (m) => m.km, odo: (m) => m.odo,
  run: (m) => m.run, mov: (m) => m.mov, idle: (m) => m.idle, evKm: (m) => m.evKm,
  maxKph: (m) => m.maxKph, hvV: (m) => m.hvV, amb: (m) => m.amb,
};
const DIGITS = { sp: 0, rpm: 0, pwr: 1, soc: 1, hvA: 0, cool: 0, load: 0, km: 2, odo: 1, evKm: 2, maxKph: 0, hvV: 1, amb: 0 };

const metrics = {
  msgs: 0, bytes: 0, gaps: 0, reconnects: 0, lastSeq: null, live: false,
  jitter: [], lastArrival: 0, latency: 0, since: Date.now(),
};
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const dur = (ms) => { const h = Math.round(ms / 3600e3); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`; };
const fmt = (v, d = 0) => (v === undefined || v === null ? '--' : Number(v).toFixed(d));

function onMessage(m) {
  if (!m || m.type !== 't') return;
  const now = performance.now();
  metrics.msgs++;
  metrics.bytes += JSON.stringify(m).length;
  if (metrics.lastSeq !== null && m.seq > metrics.lastSeq + 1) metrics.gaps += m.seq - metrics.lastSeq - 1;
  metrics.lastSeq = m.seq;
  if (metrics.lastArrival) {
    metrics.jitter.push(now - metrics.lastArrival);
    if (metrics.jitter.length > 80) metrics.jitter.shift();
  }
  metrics.lastArrival = now;
  metrics.live = true;
  latest = m;
  for (const k of KEYS) {
    const b = buf[k];
    b.push(GET[k](m));
    if (b.length > RING) b.shift();
  }
  render();
}

// ───────────────────────────────────────────────────────────── channels
function setLive(on) {
  if (on && !metrics.live) metrics.since = Date.now();
  metrics.live = on;
  pullSnapshot();
}
const getJSON = (u, o) => fetch(u, { cache: 'no-store', ...o }).then((r) => r.json());

function channelSSE() {
  const es = new EventSource(`/api/stream?hz=${cfg.hz}`);
  es.addEventListener('open', () => setLive(true));
  es.addEventListener('error', () => { metrics.reconnects++; setLive(false); });
  es.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));
  return { close: () => es.close(), name: 'EventSource (auto-reconnect, id: resume)' };
}
function channelWS() {
  let sock = null, stop = false, backoff = 300;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    sock = new WebSocket(`${proto}://${location.host}/ws`);
    sock.addEventListener('open', () => { backoff = 300; setLive(true); });
    sock.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));
    sock.addEventListener('close', () => {
      setLive(false);
      if (stop) return;
      metrics.reconnects++;
      setTimeout(open, (backoff = Math.min(5000, backoff * 1.8)));
    });
  };
  open();
  return { close: () => { stop = true; sock && sock.close(); }, name: 'WebSocket (hand-rolled, no ping/pong)' };
}
function channelPoll() {
  let stop = false, t = 0;
  const loop = async () => {
    if (stop) return;
    const t0 = performance.now();
    try {
      const m = await getJSON('/api/latest');
      metrics.latency = performance.now() - t0;
      if (m.type === 't') onMessage(m); else setLive(false);
      setLive(true);
    } catch { setLive(false); metrics.reconnects++; }
    t = setTimeout(loop, Math.max(20, 1000 / cfg.hz - (performance.now() - t0)));
  };
  loop();
  return { close: () => { stop = true; clearTimeout(t); }, name: `polling ${cfg.hz}/s (one request each)` };
}

let channel = null;
function connect() {
  if (channel) channel.close();
  metrics.live = false;
  channel = cfg.ch === 'ws' ? channelWS() : cfg.ch === 'poll' ? channelPoll() : channelSSE();
}

// ───────────────────────────────────────────────────────────── drawing
function spark(canvas, data, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 40;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  let lo = Math.min(...data), hi = Math.max(...data);
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  g.beginPath();
  g.moveTo(0, y(data[0]));
  for (let i = 1; i < data.length; i++) g.lineTo(x(i), y(data[i]));
  g.strokeStyle = color; g.lineWidth = 1.6; g.stroke();
  g.lineTo(w, h); g.lineTo(0, h); g.closePath();
  g.fillStyle = color + '22'; g.fill();
}

function drawTrace() {
  const c = document.getElementById('trace');
  if (!c || c.offsetParent === null) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight || 200;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const n = Math.min(buf.sp.length, Math.round(cfg.hz * 60));
  const sp = buf.sp.slice(-n), rpm = buf.rpm.slice(-n), pwr = buf.pwr.slice(-n);
  if (n < 2) return;
  const X = (i) => (i / (n - 1)) * w;

  // engine-on + regen bands behind the traces
  for (let i = 1; i < n; i++) {
    if (rpm[i] > 0) { g.fillStyle = '#f7b95522'; g.fillRect(X(i - 1), 0, Math.max(1, w / n), h); }
    else if (pwr[i] < -1) { g.fillStyle = '#63b3ff22'; g.fillRect(X(i - 1), 0, Math.max(1, w / n), h); }
  }
  const line = (data, max, color, dash) => {
    g.beginPath();
    g.setLineDash(dash || []);
    data.forEach((v, i) => (i ? g.lineTo(X(i), h - (v / max) * h) : g.moveTo(X(i), h - (v / max) * h)));
    g.strokeStyle = color; g.lineWidth = 1.8; g.stroke();
    g.setLineDash([]);
  };
  line(rpm, 4000, '#f7b95588', [4, 3]);
  line(sp, 130, '#4ade80');
  g.fillStyle = '#7d8996'; g.font = '10px ui-monospace, monospace';
  g.fillText('60 s', 6, h - 6);
  g.fillText('speed 130', w - 62, 12);
}

function render() {
  if (!latest) return;
  const m = latest;
  // every [data-metric] the current view has on screen
  for (const el of document.querySelectorAll('[data-metric]')) {
    const k = el.dataset.metric;
    const g = GET[k];
    el.textContent = g && latest ? fmt(g(latest), DIGITS[k] ?? 0) : '--';
  }
  const pill = document.getElementById('eng-pill');
  pill.textContent = m.es;
  pill.dataset.engine = m.es;
  // the device has no RTC and no route to NTP: its clock is the firmware build time
  const skew = Date.now() - m.t;
  const chip = document.getElementById('clock-chip');
  chip.hidden = Math.abs(skew) < 60000;
  if (!chip.hidden) chip.textContent = `device clock ${skew > 0 ? '−' : '+'}${dur(Math.abs(skew))}`;
  document.getElementById('home-badge').hidden = !m.home;
  document.getElementById('dev').textContent = m.asleep
    ? `asleep · ${fmt(metrics.bytes / 1024, 1)} kB received`
    : `${cfg.ch} · ${fmt(metrics.bytes / 1024, 0)} kB${metrics.reconnects ? ` · ✕${metrics.reconnects}` : ''}` +
      `${metrics.live ? '' : ' · LOST'}`;

  for (const el of document.querySelectorAll('[data-spark]')) {
    if (el.offsetParent === null) continue;
    const k = el.dataset.spark;
    spark(el, buf[k], k === 'pwr' ? '#63b3ff' : k === 'soc' ? '#b18cff' : k === 'rpm' ? '#f7b955' : '#4ade80');
  }
  drawTrace();
}

// ───────────────────────────────────────────────────────────── export
const exp = { state: 'idle', mode: 'ok', pct: 0, result: '', deleted: 0, recs: [], bytes: 0 };

function batch() {
  const trips = snap.trips.map((t) => ({ id: t.id, kind: 'trip', at: t.startedAt, km: t.km }));
  const rolls = snap.rollups.map((r) => ({ id: r.id, kind: 'rollup', at: r.from, km: r.km }));
  return [...trips, ...rolls];
}
const liveTrip = () => (snap.current ? [{ id: 'live', kind: 'in progress', at: snap.current.startedAt, km: snap.current.km }] : []);

async function openExport() {
  snap = await getJSON('/api/snapshot');
  exp.state = 'idle'; exp.pct = 0; exp.result = ''; exp.deleted = 0;
  // freeze what the batch was: after a successful delete the device no longer knows about it
  exp.recs = batch();
  exp.bytes = JSON.stringify({ trips: snap.trips, rollups: snap.rollups }).length;
  document.getElementById('export').hidden = false;
  renderExport();
}

function renderExport() {
  const recs = exp.recs;
  const bytes = exp.bytes;
  const win = clock(snap.windowLeft);
  const body = document.getElementById('export-body');

  const windowLine = snap.ignitionOffAt === null
    ? `The device is still recording. Anything exported now leaves the trip in progress behind.`
    : snap.windowLeft <= 0 ? `The ignition-off window has expired — export is no longer possible until the next trip.`
    : `${win} left in the ignition-off window` + (snap.suspended ? ` — held open while this page is connected (the device will not sleep under you).` : ` — nothing is connected, so the device sleeps when it runs out.`);

  body.innerHTML = `
    <h2>On the device</h2>
    <ul class="facts">
      <li><span>trip records</span><span class="v">${snap.trips.length}</span></li>
      <li><span>${snap.rollupSec / 60}-minute rollups</span><span class="v">${snap.rollups.length}</span></li>
      <li><span>raw samples</span><span class="v">none — derived on the device</span></li>
      <li><span>payload</span><span class="v">${(bytes / 1024).toFixed(1)} kB</span></li>
      <li><span>device clock</span><span class="v">${snap.clockSet ? 'set by this phone' : `unset, ${dur(Math.abs(snap.skewMs))} off`}</span></li>
      <li><span>trip in progress (not exported)</span><span class="v">${snap.current ? snap.current.km.toFixed(2) + ' km' : 'none'}</span></li>
    </ul>
    <p class="note">${windowLine}</p>
    <h2>What happens when you press the button</h2>
    <p class="note">
      This page fetches the ${recs.length} records over the device's access point, then POSTs them itself to
      <b>${snap.batchUrl}</b> using the phone's own connection. The device never has an internet route and never
      holds a database credential. On HTTP 2xx this page tells the device which records were accepted, and only then
      does the device delete them.
      It also hands the device the phone's clock here — the device has no RTC and no NTP, so its timestamps are the
      firmware build time until a browser syncs it.
    </p>
    <div class="big-warn">Nothing is deleted on the attempt. If the upload fails, the records stay on the device and wait for the next window.</div>
    ${exp.state === 'idle' ? `
      <div class="codes"><span class="lbl">simulate the endpoint:</span>
        ${[['ok', '2xx all'], ['partial', '2xx some'], ['500', 'HTTP 500'], ['drop', 'connection drop']]
          .map(([k, l]) => `<button data-mode="${k}" class="${exp.mode === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <button class="primary" id="go">Upload ${recs.length} records</button>` : ''}
    ${exp.state === 'uploading' ? `<div class="bar"><i style="width:${exp.pct}%"></i></div><p class="note">${exp.result}</p>` : ''}
    ${exp.state === 'done' ? `<div class="ok">${exp.result}</div>` : ''}
    ${exp.state === 'error' ? `<div class="big-warn">${exp.result}</div>
      <button class="primary" id="go">Try again</button>` : ''}
    <h2>The records ${exp.state === 'done' ? '— now deleted' : 'this batch carries'}</h2>
    <ul class="recs">${[...liveTrip(), ...recs].map((r) => `
      <li><span class="tag">${r.kind}</span><span>${new Date(r.at).toLocaleTimeString()} · ${r.km} km</span></li>`).join('')}</ul>
  `;

  body.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { exp.mode = b.dataset.mode; renderExport(); }));
  const go = body.querySelector('#go');
  if (go) go.onclick = runUpload;
}

async function runUpload() {
  const recs = exp.recs;
  const ids = recs.map((r) => r.id);
  exp.state = 'uploading'; exp.result = 'fetching the batch over the access point…'; exp.pct = 0;
  renderExport();
  const tick = (pct, note) => new Promise((r) => setTimeout(() => { exp.pct = pct; exp.result = note; renderExport(); r(); }, 420));

  await tick(8, 'syncing the device clock from this phone');
  await getJSON('/api/settime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ time: Date.now() }) });
  await tick(15, `fetched ${(JSON.stringify(snap).length / 1024).toFixed(1)} kB from the device`);
  await tick(35, `uploading to ${snap.batchUrl}…`);
  await fetch('/api/uploading', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });

  if (exp.mode === 'drop') {
    await tick(42, 'no response — the phone lost its connection');
    await fetch('/api/uploading', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) });
    exp.state = 'error'; exp.result = 'The upload stopped at 42%. Nothing was deleted, and the device cannot tell the difference between this and a power cut. The batch stays on the device and is offered again in the next window. The page shows a retry so the human does not have to know that.';
    return renderExport();
  }
  if (exp.mode === '500') {
    await tick(60, 'endpoint returned HTTP 500');
    await fetch('/api/uploading', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) });
    exp.state = 'error'; exp.result = 'The endpoint refused the batch (HTTP 500). A failure is not a confirmation, so nothing was deleted. Retrying is free: the same records go again, and the endpoint is responsible for making a repeated batch harmless.';
    return renderExport();
  }

  const accepted = exp.mode === 'partial' ? ids.slice(0, Math.max(1, Math.floor(ids.length / 2))) : ids;
  await tick(80, exp.mode === 'partial' ? `endpoint accepted ${accepted.length} of ${ids.length} records (2xx)` : 'endpoint accepted the batch (2xx)');
  const r = await getJSON('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: accepted }) });
  snap = r;
  await fetch('/api/uploading', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) });
  exp.state = 'done'; exp.pct = 100; exp.deleted = r.deleted;
  exp.result = exp.mode === 'partial'
    ? `Uploaded and deleted ${r.deleted} of ${ids.length} records. The rest are still on the device — a partial accept is the failure mode that silently loses nothing, but only because the page said which records landed.`
    : `Uploaded ${r.deleted} records and deleted them from the device. The device hears "confirmed" once, then normally goes back to sleep.`;
  renderExport();
}

// ───────────────────────────────────────────────────────────── panels
function renderLedger() {
  if (!snap) return;
  const rows = [];
  if (snap.current) rows.push(`<li><span class="live">in progress</span><span class="sub">${snap.current.km.toFixed(2)} km · ${clock(snap.current.movingS)} moving · ${clock(snap.current.engOnS)} engine on</span></li>`);
  rows.push(...snap.trips.slice().reverse().map((t) => `<li><span class="tag">trip</span><span class="sub">${new Date(t.startedAt).toLocaleTimeString()} · ${t.km} km · ${clock(t.movingS)} moving · ${clock(t.idleS)} idle · ${clock(t.engOnS)} engine on</span></li>`));
  rows.push(...snap.rollups.slice(-4).reverse().map((r) => `<li><span class="tag">${snap.rollupSec / 60}-min rollup</span><span class="sub">${r.km} km · SOC ${r.socStart}→${r.socEnd}%</span></li>`));
  const el = document.getElementById('recs');
  if (el) el.innerHTML = rows.join('');
  const ev = document.getElementById('events');
  if (ev) ev.innerHTML = snap.events.map((e) => `<li><span class="k">${new Date(e.t).toLocaleTimeString()}</span><span>${e.text}</span></li>`).join('');
}

function renderState() {
  const body = document.getElementById('state-body');
  const jitter = metrics.jitter.length ? metrics.jitter.reduce((a, b) => a + b, 0) / metrics.jitter.length : 0;
  const external = performance.getEntriesByType('resource').filter((r) => { try { return new URL(r.name).origin !== location.origin; } catch { return false; } }).length;
  body.innerHTML = `
    <h2>channel</h2>
    <ul class="facts">
      <li><span>mechanism</span><span class="v">${channel.name}</span></li>
      <li><span>state</span><span class="v">${metrics.live ? 'live' : 'disconnected'}</span></li>
      <li><span>messages / bytes</span><span class="v">${metrics.msgs} / ${(metrics.bytes / 1024).toFixed(1)} kB</span></li>
      <li><span>avg interval / jitter</span><span class="v">${jitter.toFixed(0)} ms</span></li>
      <li><span>sequence gaps</span><span class="v">${metrics.gaps}</span></li>
      <li><span>reconnects</span><span class="v">${metrics.reconnects}</span></li>
      <li><span>poll round trip</span><span class="v">${cfg.ch === 'poll' ? metrics.latency.toFixed(0) + ' ms' : 'n/a'}</span></li>
      <li><span>requests off-device</span><span class="v">${external}${external ? ' ⚠ page is not self-contained' : ''}</span></li>
      <li><span>device clock</span><span class="v">${snap.clockSet ? 'synced' : `${dur(Math.abs(snap.skewMs))} off (no RTC, no NTP)`}</span></li>
    </ul>
    <h2>device</h2>
    <pre>${JSON.stringify(snap, null, 1)}</pre>
    <h2>last message</h2>
    <pre>${JSON.stringify(latest, null, 1)}</pre>
    <h2>notes</h2>
    <p class="note">A phone that leaves the access point loses the stream; reconnection behaviour differs per channel and is the thing to compare here.</p>
  `;
}

async function pullSnapshot() {
  try { snap = await getJSON('/api/snapshot'); } catch { return; }
  renderLedger();
  if (document.getElementById('state').hidden === false) renderState();
  if (document.getElementById('export').hidden === false && exp.state !== 'uploading') renderExport();
  const w = document.getElementById('btn-wake');
  w.hidden = !snap.sleeping;
  document.getElementById('btn-ignition').disabled = snap.ignitionOffAt !== null || snap.sleeping;
}

// ───────────────────────────────────────────────────────────── wiring
const params = () => history.replaceState(null, '', `?v=${cfg.v}&ch=${cfg.ch}&hz=${cfg.hz}`);
function setCfg(key, val) {
  cfg[key] = key === 'hz' ? Number(val) : val;
  document.body.dataset.v = cfg.v;
  for (const b of document.querySelectorAll('[data-set]')) b.classList.toggle('on', String(cfg[b.dataset.set]) === String(b.dataset.val));
  params();
  if (key === 'hz') getJSON('/api/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hz: cfg.hz }) }).then(connect);
  else if (key === 'ch') connect();
  if (key === 'v') requestAnimationFrame(() => { render(); renderLedger(); });
}
document.querySelectorAll('[data-set]').forEach((b) => (b.onclick = () => setCfg(b.dataset.set, b.dataset.val)));
document.getElementById('export-cta').onclick = openExport;
document.getElementById('export-cta2').onclick = openExport;
document.getElementById('export-close').onclick = () => (document.getElementById('export').hidden = true);
document.getElementById('state-close').onclick = () => (document.getElementById('state').hidden = true);
document.getElementById('btn-state').onclick = () => {
  const s = document.getElementById('state');
  s.hidden = !s.hidden;
  if (!s.hidden) renderState();
};
document.getElementById('btn-ignition').onclick = async () => { snap = await getJSON('/api/ignition-off', { method: 'POST' }); renderLedger(); openExport(); };
document.getElementById('btn-wake').onclick = async () => { snap = await getJSON('/api/wake', { method: 'POST' }); renderLedger(); };

addEventListener('resize', () => requestAnimationFrame(render));
setCfg('v', cfg.v);
// the device has one sample rate, so the page sets it before opening a channel
getJSON('/api/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hz: cfg.hz }) }).finally(connect);
setInterval(pullSnapshot, 1000);
pullSnapshot();
