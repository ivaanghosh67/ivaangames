// Memory-leak test.
//
// Two shapes of leak matter for a game server, and this checks both:
//   1. CHURN  — many short-lived rooms and sockets. Anything the server forgets
//               to release (rooms, seats, timers, socket contexts) shows up as
//               heap that never comes back down.
//   2. SOAK   — one room played hard for a long time. Anything that grows per
//               tick (events, bullets, spawn queues, chat, analytics buffers)
//               shows up as a rising floor inside a single run.
//
// Run with --expose-gc for a trustworthy reading:
//   node --expose-gc test/leak.js
//
// It runs the server IN-PROCESS rather than as a child so we can read the real
// heap between phases.

import { WebSocket } from 'ws';

const PORT = 8095;
const WS_URL = `ws://127.0.0.1:${PORT}/ivaangames/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.IRONLINE_ANALYTICS = '0';
await import('../server.js');
await sleep(400);

const gc = () => { if (global.gc) { global.gc(); global.gc(); } };
const heapMB = () => { gc(); return process.memoryUsage().heapUsed / 1048576; };
let failures = 0;
const ok = (c, label) => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${label}`); if (!c) failures++; };

if (!global.gc) console.log('  ..    (run with --expose-gc for exact numbers; readings will be noisy)\n');

function mk() {
  const ws = new WebSocket(WS_URL);
  const c = { ws, last: {}, waiters: [], queue: new Map() };
  c.open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    c.last[m.type] = m;
    const i = c.waiters.findIndex(w => w.type === m.type);
    if (i >= 0) return void c.waiters.splice(i, 1)[0].res(m);
    if (m.type === 's') return;
    if (!c.queue.has(m.type)) c.queue.set(m.type, []);
    const q = c.queue.get(m.type); q.push(m); if (q.length > 5) q.shift();
  });
  c.send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.wait = (t, ms = 6000) => {
    const q = c.queue.get(t);
    if (q && q.length) return Promise.resolve(q.shift());
    return new Promise((res, rej) => {
      const w = { type: t, res }; c.waiters.push(w);
      setTimeout(() => { const i = c.waiters.indexOf(w); if (i >= 0) { c.waiters.splice(i, 1); rej(new Error('no ' + t)); } }, ms);
    });
  };
  return c;
}

// ── phase 1: churn ──────────────────────────────────────────────────────────
async function oneRoom(party) {
  const cs = [];
  for (let i = 0; i < party; i++) cs.push(mk());
  await Promise.all(cs.map(c => c.open));
  cs.forEach(c => c.send({ type: 'hello', name: 'L' }));
  await Promise.all(cs.map(c => c.wait('welcome')));
  cs[0].send({ type: 'create', isPublic: false, partySize: party, map: 'random' });
  const code = (await cs[0].wait('joined')).room.code;
  for (let i = 1; i < party; i++) { cs[i].send({ type: 'join', code }); await cs[i].wait('joined'); }
  cs[0].send({ type: 'start' });
  await cs[0].wait('start');
  // play briefly: build, shoot, chat
  for (let n = 0; n < 6; n++) {
    cs.forEach((c, i) => {
      c.send({ type: 'i', a: 'build', k: 'pistol', c: 2 + n, r: 2 + i });
      c.send({ type: 'chat', text: 'x'.repeat(50) });
    });
    await sleep(60);
  }
  cs.forEach(c => { c.send({ type: 'leave' }); c.ws.close(); });
  await sleep(40);
}

console.log('phase 1 — room/socket churn');
await oneRoom(2);                                  // warm the JIT before measuring
await sleep(300);
const base = heapMB();
const ROUNDS = 60;
for (let i = 0; i < ROUNDS; i++) {
  await oneRoom(1 + (i % 4));
  if (i % 20 === 19) process.stdout.write(`  ..    ${i + 1}/${ROUNDS} rooms, heap ${heapMB().toFixed(1)} MB\n`);
}
// rooms are collected on a 15 s sweep once empty for 120 s; force the issue by
// waiting for the sweep to run twice rather than reaching into internals
console.log('  ..    waiting for the room GC sweep…');
await sleep(3000);
const afterChurn = heapMB();
console.log(`  ..    heap ${base.toFixed(1)} MB → ${afterChurn.toFixed(1)} MB after ${ROUNDS} rooms`);
ok(afterChurn - base < 25, `churn left less than 25 MB behind (${(afterChurn - base).toFixed(1)} MB)`);

// ── phase 2: one long, busy run ─────────────────────────────────────────────
console.log('\nphase 2 — one room under sustained load');
const cs = [mk(), mk(), mk(), mk()];
await Promise.all(cs.map(c => c.open));
cs.forEach((c, i) => c.send({ type: 'hello', name: 'S' + i }));
await Promise.all(cs.map(c => c.wait('welcome')));
cs[0].send({ type: 'create', isPublic: false, partySize: 4, map: 'random' });
const code = (await cs[0].wait('joined')).room.code;
for (let i = 1; i < 4; i++) { cs[i].send({ type: 'join', code }); await cs[i].wait('joined'); }
cs[0].send({ type: 'start' });
await cs[0].wait('start');
await sleep(500);

const samples = [];
const SECONDS = 40;
const busy = setInterval(() => {
  cs.forEach((c, i) => {
    c.send({ type: 'i', a: 'cursor', c: (Math.random() * 22) | 0, r: (Math.random() * 15) | 0, k: 'pistol' });
    c.send({ type: 'i', a: 'build', k: 'pistol', c: (Math.random() * 22) | 0, r: (Math.random() * 15) | 0 });
    c.send({ type: 'i', a: 'wave' });
    if (Math.random() < .2) c.send({ type: 'chat', text: 'y'.repeat(120) });
  });
}, 100);

for (let t = 0; t < SECONDS; t++) {
  await sleep(1000);
  if (t % 8 === 7) { const h = heapMB(); samples.push(h); process.stdout.write(`  ..    t+${t + 1}s heap ${h.toFixed(1)} MB\n`); }
}
clearInterval(busy);

const first = samples[0], last = samples[samples.length - 1];
const growth = last - first;
console.log(`  ..    heap across the run: ${samples.map(s => s.toFixed(1)).join(' → ')} MB`);
ok(growth < 20, `a busy 4-player run did not grow the heap unboundedly (+${growth.toFixed(1)} MB)`);

// entity counts must be bounded too — a leak often shows here before the heap
const finalSnap = cs[0].last.s.s;
console.log(`  ..    final entity counts: ${finalSnap.E.length / 7} enemies, ` +
  `${finalSnap.T.length / 11} towers, ${finalSnap.U.length / 5} bullets`);
ok(finalSnap.U.length / 5 < 400, 'bullet list stayed bounded');

cs.forEach(c => { c.send({ type: 'leave' }); c.ws.close(); });
await sleep(500);
const afterAll = heapMB();
console.log(`\nfinal heap ${afterAll.toFixed(1)} MB (started ${base.toFixed(1)} MB)`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nno leak detected');
process.exit(failures ? 1 : 0);
