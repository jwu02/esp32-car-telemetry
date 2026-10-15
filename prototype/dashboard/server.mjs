#!/usr/bin/env node
/**
 * PROTOTYPE — throwaway (issue #7). Not firmware, not production.
 *
 * Fake telemetry standing in for the car, plus all three candidate live
 * channels (SSE / WebSocket / long-lived polling) so the dashboard can be
 * designed by looking at it on a phone instead of imagining it.
 *
 *   node prototype/dashboard/server.mjs
 *   PORT=8787 HZ=10 node prototype/dashboard/server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const HZ = Number(process.env.HZ || 10);        // device sample rate: one poll per sample
let hz = HZ;                                    // changeable at runtime from the page's rate buttons
const ROLLUP_SEC = 60;                          // prototype-compressed 5-min rollup
const WINDOW_SEC = 300;                         // ignition-off export window
const RING = 1800;                              // ~3 min at 10 Hz, for backfill
const BATCH_URL = 'https://telemetry.example.invalid/api/v1/batches';

// ---------------------------------------------------------------- fake drive
// Phases are the shape of a short Camry hybrid run; eng: 0 off, 1 on, 2 cycling.
const PHASES = [
  { name: 'ev creep', sec: 12, from: 0, to: 18, eng: 0, rpm: 0 },
  { name: 'launch', sec: 10, from: 18, to: 60, eng: 1, rpm: 2200 },
  { name: 'city', sec: 28, from: 35, to: 55, eng: 2, rpm: 1500 },
  { name: 'highway', sec: 30, from: 100, to: 112, eng: 1, rpm: 1900 },
  { name: 'regen brake', sec: 10, from: 100, to: 12, eng: 0, rpm: 0 },
  { name: 'idle charge', sec: 14, from: 0, to: 0, eng: 1, rpm: 1250 },
];

let idc = 0;
const rid = (p) => `${p}${++idc}`;

// Two trips already on the device, as if earlier windows were missed.
function seededTrips() {
  const now = Date.now();
  const mk = (hoursAgo, mins, km, movingS, idleS, engOnS, evKm, maxKph, socA, socB) => ({
    id: rid('t'),
    startedAt: now - hoursAgo * 3600e3,
    endedAt: now - hoursAgo * 3600e3 + mins * 60e3,
    km: +km.toFixed(2),
    movingS, idleS, engOnS, engStarts: Math.max(1, Math.round(engOnS / 90)),
    evKm: +evKm.toFixed(2), maxKph, socStart: socA, socEnd: socB,
    samples: 0, // derivation is device-side: raw samples are not retained
  });
  return [
    mk(5.2, 24, 14.31, 1180, 260, 640, 4.2, 96, 61.2, 57.8),
    mk(2.1, 9, 3.87, 380, 160, 210, 1.9, 64, 57.8, 59.4),
  ];
}
function seededRollups(trips) {
  // one rollup per 4 minutes of each seeded trip, coarsely
  return trips.flatMap((t, i) =>
    [0, 1].map((k) => ({
      id: rid('r'),
      from: t.startedAt + k * 240e3,
      to: t.startedAt + (k + 1) * 240e3,
      km: +(t.km / 2).toFixed(2),
      movingS: Math.round(t.movingS / 2),
      idleS: Math.round(t.idleS / 2),
      engOnS: Math.round(t.engOnS / 2),
      engStarts: 1,
      socStart: k ? +((t.socStart + t.socEnd) / 2).toFixed(1) : t.socStart,
      socEnd: k ? t.socEnd : +((t.socStart + t.socEnd) / 2).toFixed(1),
    })),
  );
}

const sim = {
  sleeping: false,
  ignitionOffAt: null,
  windowLeft: WINDOW_SEC,
  uploading: false,
  // drive
  phase: 0,
  phaseStart: Date.now(),
  speed: 0, rpm: 0, eng: false, engRun: 0, engStarts: 0,
  soc: 59.4, socStartTrip: 59.4, hvV: 221, hvA: 0, coolant: 74, load: 0, amb: 19,
  odo: 24318.6, km: 0, movingS: 0, idleS: 0, engineOnS: 0, evKm: 0, maxKph: 0,
  startedAt: Date.now(), clockSet: false, skewMs: -(3 * 24 + 9) * 3600e3,   // boots at firmware build time
  rollups: [], rollupStart: Date.now(), rKm: 0, rMoving: 0, rIdle: 0, rEng: 0, rStarts: 0, rSocStart: 59.4,
  trips: [], events: [], seq: 0,
};
sim.trips = seededTrips();
sim.rollups = seededRollups(sim.trips);

function rollup() {
  const r = {
    id: rid('r'), from: sim.rollupStart, to: Date.now(),
    km: +sim.rKm.toFixed(2), movingS: Math.round(sim.rMoving), idleS: Math.round(sim.rIdle),
    engOnS: Math.round(sim.rEng), engStarts: sim.rStarts,
    socStart: +sim.rSocStart.toFixed(1), socEnd: +sim.soc.toFixed(1),
  };
  sim.rollups.push(r);
  sim.events.unshift({ t: r.to, kind: 'rollup', text: `rollup sealed · ${r.km} km` });
  sim.rollupStart = Date.now();
  sim.rKm = sim.rMoving = sim.rIdle = sim.rEng = sim.rStarts = 0;
  sim.rSocStart = sim.soc;
}

function sealTrip() {
  const t = {
    id: rid('t'), startedAt: sim.startedAt, endedAt: Date.now(),
    km: +sim.km.toFixed(2), movingS: Math.round(sim.movingS), idleS: Math.round(sim.idleS),
    engOnS: Math.round(sim.engineOnS), engStarts: sim.engStarts,
    evKm: +sim.evKm.toFixed(2), maxKph: sim.maxKph,
    socStart: +sim.socStartTrip.toFixed(1), socEnd: +sim.soc.toFixed(1), samples: 0,
  };
  sim.trips.push(t);
  sim.events.unshift({ t: t.endedAt, kind: 'trip', text: `trip sealed · ${t.km} km` });
  return t;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = (v) => Math.round(v * 10) / 10;

function step(now) {
  const dt = Math.min(0.5, (now - step.last) / 1000);
  step.last = now;
  if (sim.sleeping) return;
  if (sim.ignitionOffAt !== null) {
    // bus silence: the car is off, the drive has ended, the export window runs
    sim.speed = 0; sim.rpm = 0; sim.eng = false; sim.load = 0; sim.hvA = 0; sim.hvV = 0;
    const connected = [...clients.values()].some((c) => now - c.lastSeen < 15000) || sim.uploading;
    if (!connected) sim.windowLeft -= dt;
    if (sim.windowLeft <= 0) {
      sim.windowLeft = 0; sim.sleeping = true;
      sim.events.unshift({ t: now, kind: 'sleep', text: 'window expired · deep sleep' });
    }
    return;
  }
  const p = PHASES[sim.phase];
  if (now - sim.phaseStart > p.sec * 1000) {
    sim.phase = (sim.phase + 1) % PHASES.length;
    sim.phaseStart = now;
    sim.events.unshift({ t: now, kind: 'phase', text: `phase → ${PHASES[sim.phase].name}` });
  }
  const ph = PHASES[sim.phase];
  const prog = clamp((now - sim.phaseStart) / (ph.sec * 1000), 0, 1);
  const target = ph.from + (ph.to - ph.from) * prog;
  const slew = (target > sim.speed ? 11 : 20) * dt;             // regen brakes harder than it accelerates
  sim.speed = clamp(sim.speed + clamp(target - sim.speed, -slew, slew), 0, 130);

  const cyc = ((now - sim.phaseStart) / 1000) % 14;
  const wasEng = sim.eng;
  sim.eng = ph.eng === 1 ? true : ph.eng === 2 ? cyc < 9 : false;
  if (sim.eng && !wasEng) { sim.engRun = 0; sim.engStarts++; sim.rStarts++; sim.events.unshift({ t: now, kind: 'engine', text: 'engine started' }); }
  if (!sim.eng && wasEng) sim.events.unshift({ t: now, kind: 'engine', text: 'engine stopped · EV' });
  sim.engRun += sim.eng ? dt : 0;
  sim.engineOnS += sim.eng ? dt : 0;
  sim.rEng += sim.eng ? dt : 0;

  sim.rpm = sim.eng ? Math.round(ph.rpm + 120 * Math.sin(now / 700)) : 0;
  sim.hvV = 221 - sim.speed * 0.08;
  sim.hvA = sim.eng ? -17 - 6 * Math.sin(now / 900) : sim.speed > 1 ? 24 + sim.speed * 0.25 : 3;
  if (!sim.eng && target < sim.speed - 5) sim.hvA = -(sim.speed * 0.8);   // regen
  sim.load = sim.eng ? Math.round(clamp(30 + 30 * Math.sin(now / 4000) + sim.speed * 0.2, 10, 95)) : 0;
  sim.coolant = clamp(sim.coolant + ((sim.eng ? 89 : sim.amb) - sim.coolant) * 0.02 * dt, sim.amb, 102);
  sim.soc = clamp(sim.soc - sim.hvA * dt * 0.0016, 22, 88);

  const dkm = (sim.speed * dt) / 3600;
  sim.odo += dkm; sim.km += dkm; sim.rKm += dkm;
  if (sim.speed > 1) { sim.movingS += dt; sim.rMoving += dt; } else { sim.idleS += dt; sim.rIdle += dt; }
  if (!sim.eng && sim.speed > 1) sim.evKm += dkm;
  sim.maxKph = Math.max(sim.maxKph, sim.speed);

  if (now - sim.rollupStart > ROLLUP_SEC * 1000) rollup();
}

function message(now) {
  const engState = sim.speed < 1 ? (sim.eng ? 'IDLE' : 'OFF') : !sim.eng && sim.hvA < -6 ? 'REGEN' : sim.eng ? 'ENGINE' : 'EV';
  // The device has no RTC and no internet route, so its clock starts at the
  // firmware build time and is only ever corrected by an exporting browser.
  return {
    type: 't', seq: ++sim.seq, t: now + sim.skewMs, host: now, ck: sim.clockSet ? 1 : 0,
    sp: r1(sim.speed), rpm: sim.rpm, eng: sim.eng ? 1 : 0, es: engState,
    soc: r1(sim.soc), hvV: r1(sim.hvV), hvA: r1(sim.hvA), pwr: r1((sim.hvV * sim.hvA) / 1000),
    cool: Math.round(sim.coolant), load: sim.load, amb: sim.amb,
    km: +sim.km.toFixed(2), odo: r1(sim.odo), run: Math.round(sim.engRun),
    mov: Math.round(sim.movingS), idle: Math.round(sim.idleS),
    evKm: +sim.evKm.toFixed(2), maxKph: r1(sim.maxKph),
    ph: PHASES[sim.phase].name, home: sim.ignitionOffAt ? 1 : 0,
  };
}

// ---------------------------------------------------------------- transport
/** @type {Map<string, {kind:string, lastSeen:number, res?:any, socket?:any, sent:number, dropped:number}>} */
const clients = new Map();
const stats = { ws: 0, sse: 0, poll: 0, dropped: 0, ticks: 0, bytes: 0 };

function broadcast(now) {
  const msg = message(now);
  stats.ticks++;
  hist.push(msg);
  if (hist.length > RING) hist.shift();
  const frame = 'id: ' + msg.seq + '\ndata: ' + JSON.stringify(msg) + '\n\n';
  const text = JSON.stringify(msg);
  for (const [id, c] of clients) {
    // a socket that died without emitting close would otherwise hold the export window open forever
    if (now - c.lastSeen > 30000) { clients.delete(id); continue; }
    try {
      if (c.kind === 'sse') {
        if (c.res.writableLength > 65536) { c.dropped++; stats.dropped++; continue; } // back-pressure: drop, as firmware must
        c.res.write(frame); c.sent++;
      } else if (c.kind === 'ws') {
        if (c.socket.writableLength > 65536) { c.dropped++; stats.dropped++; continue; }
        c.socket.write(wsFrame(text)); c.sent++;
      } else continue;   // poll: pull-only, presence refreshed by /api/latest
      c.lastSeen = now;
    } catch { clients.delete(id); }
  }
  stats.bytes += text.length * clients.size;
  last.msg = msg;
}
const last = { msg: null };
const hist = [];   // ring of recent messages, for SSE resume via Last-Event-ID

function wsFrame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
const wsAccept = (key) => crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

const snapshot = (now = Date.now()) => ({
  awake: !sim.sleeping, sleeping: sim.sleeping, ignitionOffAt: sim.ignitionOffAt,
  skewMs: sim.skewMs, clockSet: sim.clockSet,
  windowLeft: Math.max(0, Math.round(sim.windowLeft)),
  suspended: sim.ignitionOffAt !== null && ([...clients.values()].some((c) => now - c.lastSeen < 15000) || sim.uploading),
  uploading: sim.uploading,
  rollupSec: ROLLUP_SEC,
  phase: PHASES[sim.phase].name,
  current: sim.ignitionOffAt === null && !sim.sleeping
    ? { startedAt: sim.startedAt, km: +sim.km.toFixed(2), movingS: Math.round(sim.movingS), idleS: Math.round(sim.idleS), engOnS: Math.round(sim.engineOnS), evKm: +sim.evKm.toFixed(2) }
    : null,
  trips: sim.trips, rollups: sim.rollups, events: sim.events.slice(0, 12),
  batchUrl: BATCH_URL,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/snapshot') return json(res, 200, snapshot());

  if (p === '/api/latest') {
    stats.poll++;
    if (!last.msg) return json(res, 200, { type: 'wait' });
    const c = clients.get('poll') || { kind: 'poll', sent: 0, dropped: 0 };
    c.lastSeen = Date.now(); c.sent++; c.kind = 'poll';
    clients.set('poll', c);
    return json(res, 200, last.msg);
  }

  if (p === '/api/stream') {
    stats.sse++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1500\n\n');
    const id = `sse${++idc}`;
    clients.set(id, { kind: 'sse', res, lastSeen: Date.now(), sent: 0, dropped: 0 });
    res.write('event: hello\ndata: ' + JSON.stringify({ type: 'hello', hz, rollupSec: ROLLUP_SEC, windowSec: WINDOW_SEC }) + '\n\n');
    // resume only when the browser actually reconnects (Last-Event-ID); a fresh
    // client must not be handed the whole ring — that is a 500 kB burst into a
    // device with 512 kB of SRAM.
    const since = Number(req.headers['last-event-id'] || 0);
    if (since > 0) {
      const tail = hist.slice(-60 * hz);   // a reconnect fills at most a minute of gap
      for (const m of tail) if (m.seq > since) res.write('id: ' + m.seq + '\ndata: ' + JSON.stringify(m) + '\n\n');
    }
    req.on('close', () => clients.delete(id));
    return;
  }

  if (p === '/api/rate' && req.method === 'POST') {   // the device's sample rate, not the browser's
    const { hz: h } = await readBody(req);
    hz = Math.min(20, Math.max(1, Number(h) || 10));
    startTimer();
    return json(res, 200, { hz });
  }
  if (p === '/api/ignition-off' && req.method === 'POST') {
    if (sim.ignitionOffAt === null && !sim.sleeping) {
      sealTrip();
      sim.ignitionOffAt = Date.now();
      sim.windowLeft = WINDOW_SEC;
      sim.events.unshift({ t: Date.now(), kind: 'ignition', text: 'bus silence 5 min · trip sealed, export window open' });
    }
    return json(res, 200, snapshot());
  }
  if (p === '/api/settime' && req.method === 'POST') {
    const { time } = await readBody(req);
    sim.skewMs = Number(time) - Date.now();
    sim.clockSet = true;
    sim.events.unshift({ t: Date.now() + sim.skewMs, kind: 'clock', text: 'clock set from the paired browser at export' });
    return json(res, 200, { skewMs: sim.skewMs });
  }
  if (p === '/api/wake' && req.method === 'POST') {
    const now = Date.now();
    sim.sleeping = false; sim.ignitionOffAt = null; sim.windowLeft = WINDOW_SEC;
    sim.clockSet = false; sim.skewMs = -(3 * 24 + 9) * 3600e3;   // a reboot loses the clock again
    sim.phase = 0; sim.phaseStart = now; sim.startedAt = now;
    Object.assign(sim, { speed: 0, rpm: 0, eng: false, engRun: 0, engStarts: 0, km: 0, movingS: 0, idleS: 0, engineOnS: 0, evKm: 0, maxKph: 0, rKm: 0, rMoving: 0, rIdle: 0, rEng: 0, rStarts: 0 });
    sim.socStartTrip = sim.soc; sim.rollupStart = now; sim.rSocStart = sim.soc;
    sim.events.unshift({ t: now, kind: 'wake', text: 'CAN activity · wake from deep sleep' });
    return json(res, 200, snapshot());
  }
  if (p === '/api/uploading' && req.method === 'POST') {
    const b = await readBody(req);
    sim.uploading = !!b.on;
    return json(res, 200, snapshot());
  }
  if (p === '/api/delete' && req.method === 'POST') {
    const { ids = [] } = await readBody(req);
    const before = sim.trips.length + sim.rollups.length;
    sim.trips = sim.trips.filter((t) => !ids.includes(t.id));
    sim.rollups = sim.rollups.filter((r) => !ids.includes(r.id));
    const n = before - sim.trips.length - sim.rollups.length;
    sim.events.unshift({ t: Date.now(), kind: 'delete', text: `confirmation received · ${n} record(s) deleted` });
    return json(res, 200, { deleted: n, ...snapshot() });
  }

  // static
  let f = p === '/' ? '/index.html' : p;
  const file = path.join(PUBLIC, path.normalize(f).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  return res.end(fs.readFileSync(file));
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !req.headers['sec-websocket-key']) return socket.destroy();
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n',
  );
  const id = `ws${++idc}`;
  stats.ws++;
  clients.set(id, { kind: 'ws', socket, lastSeen: Date.now(), sent: 0, dropped: 0 });
  socket.on('data', (buf) => { clients.get(id) && (clients.get(id).lastSeen = Date.now()); }); // inbound frames ignored
  const bye = () => clients.delete(id);
  socket.on('close', bye); socket.on('error', bye);
});

step.last = Date.now();
let timer = null;
function loop() {
  const now = Date.now();
  step(now);
  if (!sim.sleeping) broadcast(now);
  else if (now - (broadcast.lastHeartbeat || 0) > 2000) { broadcast.lastHeartbeat = now; last.msg = { ...message(now), asleep: 1 }; }
}
function startTimer() { clearInterval(timer); timer = setInterval(loop, 1000 / hz); }
startTimer();

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\n  PROTOTYPE — fake telemetry dashboard (issue #7)\n`);
  console.log(`  local    http://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  phone    http://${ip}:${PORT}/   ← same Wi-Fi/hotspot as this machine`);
  console.log(`\n  ${hz} Hz sample rate · back-pressure drops over 64 KB · stats: ${JSON.stringify(stats)}\n`);
  setInterval(() => console.log(`  ${new Date().toISOString().slice(11, 19)}  phase=${PHASES[sim.phase].name.padEnd(12)} clients=${clients.size} sent=${[...clients.values()].reduce((a, c) => a + c.sent, 0)} dropped=${stats.dropped} trips=${sim.trips.length} rollups=${sim.rollups.length}${sim.sleeping ? ' SLEEP' : ''}${sim.ignitionOffAt ? ` window=${Math.round(sim.windowLeft)}s${snapshot().suspended ? ' (held)' : ''}` : ''}`), 4000);
});
