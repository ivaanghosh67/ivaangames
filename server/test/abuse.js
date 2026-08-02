// Abuse test: behaves like a player with an edited client and checks the server
// refuses everything it should. Each case here is a bug that was actually found
// and fixed, so this file is the regression net for them.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const PORT = 8096;
const WS_URL = `ws://127.0.0.1:${PORT}/ivaangames/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (c, label) => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${label}`); if (!c) failures++; };

const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', IRONLINE_ANALYTICS: '0' },
  cwd: fileURLToPath(new globalThis.URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErrors = 0;
child.stdout.on('data', () => {});
child.stderr.on('data', d => { srvErrors++; process.stderr.write('[srv!] ' + d); });

function mk() {
  const ws = new WebSocket(WS_URL);
  const c = { ws, last: {}, queue: new Map(), waiters: [], closed: false };
  c.open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('close', () => { c.closed = true; });
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    c.last[m.type] = m;
    const i = c.waiters.findIndex(w => w.type === m.type);
    if (i >= 0) return void c.waiters.splice(i, 1)[0].res(m);
    if (m.type === 's') return;
    if (!c.queue.has(m.type)) c.queue.set(m.type, []);
    c.queue.get(m.type).push(m);
  });
  c.send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  /** Drop anything already queued for `type`, so the next wait() sees a fresh one. */
  c.flush = t => c.queue.delete(t);
  c.wait = (type, ms = 5000) => {
    const q = c.queue.get(type);
    if (q && q.length) return Promise.resolve(q.shift());
    return new Promise((res, rej) => {
      const w = { type, res }; c.waiters.push(w);
      setTimeout(() => { const i = c.waiters.indexOf(w); if (i >= 0) { c.waiters.splice(i, 1); rej(new Error('no ' + type)); } }, ms);
    });
  };
  return c;
}

async function main() {
  for (let i = 0; i < 80; i++) {
    try { const p = new WebSocket(WS_URL); await new Promise((r, j) => { p.once('open', r); p.once('error', j); }); p.close(); break; }
    catch { await sleep(100); }
  }

  const a = mk(), b = mk();
  await Promise.all([a.open, b.open]);
  a.send({ type: 'hello', name: 'Attacker' });
  await a.wait('welcome');
  b.send({ type: 'hello', name: 'Victim' });
  await b.wait('welcome');

  a.send({ type: 'create', name: 'abuse', isPublic: false, partySize: 2, map: 'Iron Line' });
  const room = (await a.wait('joined')).room.code;
  b.send({ type: 'join', code: room });
  await b.wait('joined');
  a.send({ type: 'start' });
  await a.wait('start');
  await a.wait('s');

  // ── prototype-chain keys must not slip past the definition lookups ──
  const POISON = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  for (const k of POISON) {
    a.send({ type: 'i', a: 'build', k, c: 2, r: 2 });
    a.send({ type: 'i', a: 'deploy', k, x: 200, y: 200 });
    a.send({ type: 'i', a: 'heal', k });
  }
  await sleep(600);
  let s = a.last.s.s;
  ok(s.gp.every(Number.isFinite), `purses stayed numeric after prototype-key spam (${s.gp})`);
  ok(Number.isFinite(s.l) && s.l > 0, `lives stayed numeric (${s.l})`);
  ok(s.T.length === 0, 'no phantom tower was created');
  ok(s.B.length === 0, 'no phantom bot was deployed');

  // ── quest-locked weapons are refused to a player who has not earned them ──
  a.flush('deny');                      // the prototype spam above left denials queued
  a.send({ type: 'i', a: 'build', k: 'railgun', c: 9, r: 9 });
  const lockDeny = await a.wait('deny');
  ok(/quest/i.test(lockDeny.why), 'a quest-locked gun is refused without the quest');

  // ── you cannot spend what you do not have ──
  // (minigun at 500g — expensive but not quest-locked)
  const before = a.last.s.s.gp[0];
  for (let i = 0; i < 30; i++) a.send({ type: 'i', a: 'build', k: 'minigun', c: 2 + (i % 15), r: 2 });
  await sleep(600);
  s = a.last.s.s;
  ok(s.gp[0] >= 0, `purse never went negative buying miniguns (${s.gp[0]})`);
  ok(s.T.length / 11 <= Math.floor(before / 500), 'no more towers than the purse could pay for');

  // ── negative and absurd numbers ──
  a.send({ type: 'i', a: 'build', k: 'pistol', c: -5, r: -5 });
  a.send({ type: 'i', a: 'build', k: 'pistol', c: 1e9, r: 1e9 });
  a.send({ type: 'i', a: 'deploy', k: 'rifleBot', x: -1e9, y: NaN });
  a.send({ type: 'i', a: 'upgrade', id: -1 });
  a.send({ type: 'i', a: 'sell', id: 999999 });
  a.send({ type: 'i', a: 'cursor', c: -99, r: 1e9 });
  await sleep(500);
  s = a.last.s.s;
  ok(s.gp.every(Number.isFinite) && Number.isFinite(s.l), 'garbage numbers did not poison the game state');
  ok(!a.closed, 'server did not drop the connection over malformed input');

  // ── you cannot act in a room you are not in ──
  const c = mk();
  await c.open;
  c.send({ type: 'hello', name: 'Outsider' });
  await c.wait('welcome');
  const towers = a.last.s.s.T.length;
  for (let i = 0; i < 10; i++) c.send({ type: 'i', a: 'sell', id: a.last.s.s.T[0] });
  await sleep(400);
  ok(a.last.s.s.T.length === towers, 'a socket outside the room cannot sell its towers');

  // ── only the host starts/restarts ──
  b.send({ type: 'restart' });
  const d1 = await b.wait('deny');
  ok(/host/.test(d1.why), 'a non-host cannot restart the run');

  // ── create flood is capped ──
  const f = mk();
  await f.open;
  f.send({ type: 'hello', name: 'Flooder' });
  await f.wait('welcome');
  for (let i = 0; i < 40; i++) f.send({ type: 'create', isPublic: false, partySize: 1 });
  await sleep(800);
  ok(!!f.last.error && /too many/i.test(f.last.error.why), 'room-creation flood is throttled');

  // ── message flood gets the socket hung up on ──
  const g = mk();
  await g.open;
  g.send({ type: 'hello', name: 'Flood2' });
  await g.wait('welcome');
  for (let i = 0; i < 3000; i++) g.send({ type: 'list' });
  await sleep(1500);
  ok(g.closed, 'a socket flooding the server is disconnected');

  // ── the real game survived all of it ──
  await sleep(500);
  ok(!!a.last.s && a.last.s.s.w >= 0, 'the victim room is still running normally');
  ok(srvErrors === 0, `server logged no errors (${srvErrors})`);

  [a, b, c, f, g].forEach(x => { try { x.ws.close(); } catch {} });
  await sleep(200);
}

main()
  .then(() => { console.log(failures ? `\n${failures} check(s) FAILED` : '\nno abuse vector got through'); child.kill('SIGTERM'); setTimeout(() => process.exit(failures ? 1 : 0), 300); })
  .catch(e => { console.error('abuse test crashed:', e.message); child.kill('SIGTERM'); process.exit(1); });
