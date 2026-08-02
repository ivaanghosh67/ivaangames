// Persistence test: does progress actually survive?
//
// The whole point of the database is that clearing your browser, or moving to
// another machine, no longer costs you your unlocks. This proves it end to end
// against a real MySQL, and also proves the game still works when the database
// is switched off.
//
//   node test/persist.js

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { WebSocket } from 'ws';

const PORT = 8094;
const WS_URL = `ws://127.0.0.1:${PORT}/ivaangames/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (c, label) => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${label}`); if (!c) failures++; };

// Read the credentials the deploy wrote, so this test uses the real database.
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', IRONLINE_ANALYTICS: '0' };
try {
  for (const line of fs.readFileSync('/opt/ironline/.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
} catch { console.log('  ..    /opt/ironline/.env not readable; expecting no persistence'); }

function startServer(extra = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...env, ...extra },
    cwd: fileURLToPath(new globalThis.URL('..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { if (/persistence|db\]/.test(String(d))) process.stdout.write('  [srv] ' + d); });
  child.stderr.on('data', d => process.stderr.write('  [srv!] ' + d));
  return child;
}

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
    c.queue.get(m.type).push(m);
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

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const p = new WebSocket(WS_URL);
      await new Promise((r, j) => { p.once('open', r); p.once('error', j); }); p.close(); return true; }
    catch { await sleep(120); }
  }
  return false;
}

async function main() {
  // A token unique to this run, so repeated test runs never collide.
  const token = 'ptest' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ── phase 1: with the database ──
  let srv = startServer();
  await waitUp();

  const a = mk(); await a.open;
  a.send({ type: 'hello', name: 'Persist', token,
           progress: { flyerKills: 42, bossKills: 7, bestWave: 19 } });
  const w = await a.wait('welcome');
  ok(w.persistence === true, 'server reports persistence is available');
  const p1 = await a.wait('progress');
  ok(!!p1.progress, 'the server returned a progress record');
  ok(p1.progress.flyerKills === 42 && p1.progress.bossKills === 7 && p1.progress.bestWave === 19,
    `local progress was merged up (${JSON.stringify(p1.progress && {
      f: p1.progress.flyerKills, b: p1.progress.bossKills, w: p1.progress.bestWave })})`);
  a.ws.close();
  await sleep(300);

  // ── a DIFFERENT browser with the same account token: progress follows ──
  const b = mk(); await b.open;
  b.send({ type: 'hello', name: 'Persist', token });   // no local progress at all
  await b.wait('welcome');
  const p2 = await b.wait('progress');
  ok(p2.progress && p2.progress.flyerKills === 42 && p2.progress.bestWave === 19,
    'a fresh browser with the same token gets the saved progress back');

  // ── merging takes the maximum, never a regression ──
  b.ws.close(); await sleep(200);
  const c = mk(); await c.open;
  c.send({ type: 'hello', name: 'Persist', token,
           progress: { flyerKills: 5, bossKills: 99, bestWave: 3 } });
  await c.wait('welcome');
  const p3 = await c.wait('progress');
  ok(p3.progress.flyerKills === 42, 'a lower local count does not overwrite the saved one');
  ok(p3.progress.bossKills === 99, 'a higher local count is taken');
  ok(p3.progress.bestWave === 19, 'best wave never regresses');

  // ── leaderboard responds ──
  c.send({ type: 'board', difficulty: 'regular', partySize: 1 });
  const board = await c.wait('board');
  ok(Array.isArray(board.rows), `leaderboard returns rows (${(board.rows || []).length})`);

  // ── profile responds ──
  c.send({ type: 'profile' });
  const prof = await c.wait('profile');
  ok(prof.profile && prof.profile.totals, 'profile returns totals');

  // ── a finished run is recorded ──
  c.send({ type: 'create', name: 'persist', isPublic: false, partySize: 1, map: 'Iron Line' });
  await c.wait('joined');
  c.send({ type: 'start' });
  await c.wait('start');
  await sleep(400);
  c.send({ type: 'i', a: 'build', k: 'pistol', c: 3, r: 3 });
  await sleep(400);
  c.ws.close();
  await sleep(300);
  srv.kill('SIGTERM');
  await sleep(900);

  // ── phase 2: restart and confirm it is all still there ──
  srv = startServer();
  await waitUp();
  const d = mk(); await d.open;
  d.send({ type: 'hello', name: 'Persist', token });
  await d.wait('welcome');
  const p4 = await d.wait('progress');
  ok(p4.progress && p4.progress.flyerKills === 42 && p4.progress.bossKills === 99,
    'progress survives a full server restart');
  d.ws.close();
  srv.kill('SIGTERM');
  await sleep(800);

  // ── phase 3: the game must still work with NO database ──
  srv = startServer({ IRONLINE_DB_DISABLE: '1' });
  await waitUp();
  const e = mk(); await e.open;
  e.send({ type: 'hello', name: 'NoDb', token });
  const w2 = await e.wait('welcome');
  ok(w2.persistence === false, 'server reports persistence unavailable when the database is off');
  e.send({ type: 'create', name: 'nodb', isPublic: false, partySize: 1, map: 'Iron Line' });
  const j = await e.wait('joined');
  ok(!!j.room.code, 'a room can still be created with no database');
  e.send({ type: 'start' });
  const st = await e.wait('start');
  ok(!!st.info, 'a run still starts with no database');
  const snap = await e.wait('s');
  ok(snap.s.gp[0] === 250, 'the game plays normally with no database');
  e.send({ type: 'board', difficulty: 'regular', partySize: 1 });
  const b2 = await e.wait('board');
  ok(b2.rows === null, 'leaderboards degrade gracefully rather than erroring');
  e.ws.close();
  srv.kill('SIGTERM');
  await sleep(500);
}

main()
  .then(() => { console.log(failures ? `\n${failures} check(s) FAILED` : '\nprogress persists, and the game survives without a database'); process.exit(failures ? 1 : 0); })
  .catch(e => { console.error('\npersist test crashed:', e.message); process.exit(1); });
