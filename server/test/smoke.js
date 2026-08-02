// End-to-end smoke test: spins up the real server in-process, connects two
// clients, and drives a room through create → join → start → build → wave.
// Run with `npm run smoke` from server/. Exits non-zero on the first failure.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const PORT = 8099;
const WS_URL = `ws://127.0.0.1:${PORT}/ivaangames/ws`;

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${label}`);
  if (!cond) failures++;
};

// ── a tiny promise-friendly client ──────────────────────────────────────────
class Client {
  constructor(name) {
    this.name = name;
    this.ws = new WebSocket(WS_URL);
    this.waiters = [];
    this.last = {};
    // Messages that arrived before anyone asked for them get queued, so a
    // wait() issued a moment "too late" still sees its message instead of
    // hanging. Snapshots are deliberately not queued — only the newest matters.
    this.queue = new Map();
    this.snapshots = 0;
    this.ready = new Promise(res => this.ws.once('open', res));
    this.ws.on('message', raw => {
      const m = JSON.parse(raw);
      this.last[m.type] = m;
      if (m.type === 's') this.snapshots++;
      const i = this.waiters.findIndex(w => w.type === m.type);
      if (i >= 0) { this.waiters.splice(i, 1)[0].res(m); return; }
      if (m.type === 's') return;               // only the newest snapshot matters
      if (!this.queue.has(m.type)) this.queue.set(m.type, []);
      this.queue.get(m.type).push(m);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(type, ms = 4000) {
    const q = this.queue.get(type);
    if (q && q.length) return Promise.resolve(q.shift());
    return new Promise((res, rej) => {
      const w = { type, res };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); rej(new Error(`${this.name}: timed out waiting for '${type}'`)); }
      }, ms);
    });
  }
  /** Discards anything queued for `type` so a later wait() only sees fresh ones. */
  flush(type) { this.queue.delete(type); }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── boot the real server as a child process ─────────────────────────────────
const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  cwd: fileURLToPath(new globalThis.URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => process.stdout.write('[srv] ' + d));
child.stderr.on('data', d => process.stderr.write('[srv!] ' + d));

async function main() {
  // wait for listen
  for (let i = 0; i < 60; i++) {
    try {
      const probe = new WebSocket(WS_URL);
      await new Promise((res, rej) => { probe.once('open', res); probe.once('error', rej); });
      probe.close(); break;
    } catch { await sleep(100); }
  }

  const host = new Client('host');
  const guest = new Client('guest');
  await Promise.all([host.ready, guest.ready]);

  // ── handshake ──
  host.send({ type: 'hello', name: 'Hosty' });
  const hw = await host.wait('welcome');
  ok(!!hw.token, 'host gets a token');
  ok(Array.isArray(hw.maps) && hw.maps.length > 0, 'server advertises maps');
  ok(Array.isArray(hw.difficulties) && hw.difficulties.length === 4,
    `server advertises the four difficulty tiers (${(hw.difficulties||[]).map(d=>d.name).join('/')})`);

  guest.send({ type: 'hello', name: 'Guesty' });
  await guest.wait('welcome');

  // ── create a public duo room ──
  host.send({ type: 'create', name: 'Smoke Test', isPublic: true, partySize: 2,
              map: 'Iron Line', difficulty: 'veteran' });
  const created = await host.wait('joined');
  ok(created.seat === 1, 'host takes seat 1');
  ok(created.isHost === true, 'host is flagged as host');
  ok(/^[A-Z0-9]{5}$/.test(created.room.code), `room code looks right (${created.room.code})`);
  const code = created.room.code;

  // ── it shows up in the public browser ──
  guest.send({ type: 'list' });
  const listed = await guest.wait('rooms');
  ok(listed.rooms.some(r => r.code === code), 'room appears in the public list');

  // ── guest joins ──
  guest.send({ type: 'join', code });
  const joined = await guest.wait('joined');
  ok(joined.seat === 2, 'guest takes seat 2');
  ok(joined.isHost === false, 'guest is not host');
  const hostLobby = await host.wait('lobby');
  ok(hostLobby.roster.length === 2, 'host sees both seats filled');

  // ── only the host may start ──
  guest.send({ type: 'start' });
  const denied = await guest.wait('deny');
  ok(/host/.test(denied.why), 'guest cannot start the run');

  host.send({ type: 'start' });
  const started = await host.wait('start');
  ok(started.info.players === 2, 'run starts as a duo');
  ok(started.info.map.name === 'Iron Line', 'requested map was honoured');
  ok(started.info.defs.TKEYS.length > 0, 'definition tables shipped to the client');
  ok(started.info.difficulty && started.info.difficulty.key === 'veteran',
    `the chosen difficulty reached the run (${started.info.difficulty && started.info.difficulty.name})`);
  await guest.wait('start');

  // ── snapshots flow ──
  const s1 = await host.wait('s');
  ok(s1.s.gp[0] === 250 && s1.s.gp[1] === 250,
    `each seat starts with its own 250 gold (got ${s1.s.gp.slice(0, 2)})`);
  ok(s1.s.l === 16, `Veteran starts with 16 lives, not 20 (got ${s1.s.l})`);

  // ── shared arsenal: every seat can build anything ──
  // (a sniper at 130g, not a railgun — you only start with 250)
  guest.send({ type: 'i', a: 'build', k: 'sniper', c: 8, r: 6 });
  await sleep(300);
  ok(guest.last.s.s.T.length >= 12, 'seat 2 can build a gun (arsenal is shared)');
  ok(guest.last.s.s.T[1] === started.info.defs.TKEYS.indexOf('sniper'), 'and it really is the sniper');
  guest.send({ type: 'i', a: 'sell', id: guest.last.s.s.T[0] });
  await sleep(300);

  // ── a legal build by each seat ──
  host.send({ type: 'i', a: 'build', k: 'pistol', c: 3, r: 3 });
  await sleep(300);
  let snap = host.last.s.s;
  const towerIdx = [...Array(snap.T.length / 12).keys()].find(i => snap.T[i * 12 + 3] === 3);
  ok(towerIdx !== undefined, 'host tower exists in the snapshot');
  const towerId = snap.T[towerIdx * 12];
  ok(snap.T[towerIdx * 12 + 6] === 1, 'tower is attributed to seat 1');

  // per-player purses: seat 2 pays for seat 2's blade, seat 1 is untouched
  const before = host.last.s.s.gp.slice();
  guest.send({ type: 'i', a: 'build', k: 'blade', c: 5, r: 3 });
  await sleep(300);
  snap = guest.last.s.s;
  ok(snap.gp[1] === before[1] - 70, `seat 2 paid 70 for the blade (${before[1]} → ${snap.gp[1]})`);
  ok(snap.gp[0] === before[0], "seat 1's purse was untouched by seat 2's purchase");

  // ── you cannot build on an occupied tile ──
  host.send({ type: 'i', a: 'build', k: 'pistol', c: 3, r: 3 });
  const blocked = await host.wait('deny');
  ok(/blocked/.test(blocked.why), 'cannot stack two towers on one tile');

  // ── your units are yours: nobody else may upgrade or sell them ──
  const beforeUp = host.last.s.s.gp.slice();
  guest.send({ type: 'i', a: 'upgrade', id: towerId });
  const upDeny = await guest.wait('deny');
  ok(/Player 1/.test(upDeny.why), "seat 2 cannot upgrade seat 1's tower");
  guest.send({ type: 'i', a: 'sell', id: towerId });
  const sellDeny = await guest.wait('deny');
  ok(/Player 1/.test(sellDeny.why), "seat 2 cannot sell seat 1's tower");
  await sleep(300);
  ok(host.last.s.s.gp.join() === beforeUp.join(), 'and neither purse moved');

  // the owner can, and pays for it themselves
  host.send({ type: 'i', a: 'upgrade', id: towerId });
  await sleep(300);
  snap = host.last.s.s;
  const upIdx = [...Array(snap.T.length / 12).keys()].find(i => snap.T[i * 12] === towerId);
  ok(upIdx !== undefined && snap.T[upIdx * 12 + 4] === 2, 'the owner upgraded it to level 2');
  ok(snap.gp[0] < beforeUp[0], "and it came out of the owner's purse");
  ok(snap.gp[1] === beforeUp[1], "seat 2's purse was untouched");

  // ── start a wave early and watch enemies appear ──
  host.send({ type: 'i', a: 'wave' });
  await sleep(1500);
  snap = host.last.s.s;
  ok(snap.w === 1, 'wave counter advanced to 1');
  ok(snap.E.length > 0, 'enemies are on the field');
  ok((snap.f & 1) === 1, 'waveActive flag is set');

  // ── endless mode is a room option and reaches the run ──
  {
    const e = new Client('endless');
    await e.ready;
    e.send({ type: 'hello', name: 'Endless' });
    await e.wait('welcome');
    e.send({ type: 'create', name: 'endless', isPublic: false, partySize: 1,
             map: 'Iron Line', endless: true });
    await e.wait('joined');
    e.send({ type: 'start' });
    const st = await e.wait('start');
    ok(st.info.endless === true, 'endless reaches the run');
    ok(st.info.consts.MAXWAVE > st.info.consts.CAMPAIGN,
      `the finish line is removed (cap ${st.info.consts.MAXWAVE} vs campaign ${st.info.consts.CAMPAIGN})`);
    e.close();
  }

  // ── targeting priority ──
  {
    const idx = [...Array(host.last.s.s.T.length / 12).keys()].find(i => host.last.s.s.T[i * 12] === towerId);
    ok(idx !== undefined && host.last.s.s.T[idx * 12 + 11] === 0, 'turrets default to First targeting');
    host.send({ type: 'i', a: 'target', id: towerId, mode: 2 });
    await sleep(300);
    const snap2 = host.last.s.s;
    const i2 = [...Array(snap2.T.length / 12).keys()].find(i => snap2.T[i * 12] === towerId);
    ok(i2 !== undefined && snap2.T[i2 * 12 + 11] === 2, 'targeting priority changes to Strongest');
    guest.send({ type: 'i', a: 'target', id: towerId, mode: 1 });
    const td = await guest.wait('deny');
    ok(/Player 1/.test(td.why), "another seat cannot retarget someone else's turret");
    host.send({ type: 'i', a: 'target', id: towerId, mode: 0 });
    await sleep(200);
  }

  // ── quests gate the heavy weapons, per seat ──
  host.send({ type: 'i', a: 'build', k: 'plasma', c: 12, r: 9 });
  const qDeny = await host.wait('deny');
  ok(/quest/i.test(qDeny.why), 'a quest-locked gun is refused before its quest is done');
  ok(started.info.defs.QUESTS.length === 4, 'the four quests ship to the client');
  ok(started.info.defs.QUESTS.every(q => q.gun && q.target > 0 && q.desc),
    'every quest has a gun, a target and a description');
  // quest progress is reported per seat and starts at zero
  ok(Array.isArray(host.last.s.s.qp) && host.last.s.s.qp.length === 8,
    'per-seat quest counters are on the wire');
  ok(host.last.s.s.qp.every(v => v === 0), 'and they start at zero');

  // ── auto-wave: shared, and it really advances waves on its own ──
  ok((host.last.s.s.f & 16) === 0, 'auto starts off');
  guest.send({ type: 'i', a: 'auto', on: true });
  await sleep(400);
  ok((host.last.s.s.f & 16) === 16, 'either seat can turn auto on, and both see it');
  const waveAtAuto = host.last.s.s.w;
  // wave 1 is already running; let it clear and confirm the next one starts
  // without anybody pressing anything
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && host.last.s.s.w <= waveAtAuto) await sleep(500);
  ok(host.last.s.s.w > waveAtAuto,
    `auto rolled straight into wave ${host.last.s.s.w} with no input`);
  host.send({ type: 'i', a: 'auto', on: false });
  await sleep(400);
  ok((guest.last.s.s.f & 16) === 0, 'turning auto off propagates to the other seat too');

  // ── cursors propagate between players ──
  guest.send({ type: 'i', a: 'cursor', c: 9, r: 4, k: 'blade' });
  await sleep(300);
  snap = host.last.s.s;
  const cIdx = snap.C.indexOf(2);
  ok(cIdx >= 0 && snap.C[cIdx + 1] === 9 && snap.C[cIdx + 2] === 4, "host sees the guest's cursor move");

  // ── chat ──
  guest.send({ type: 'chat', text: 'hold the left flank' });
  const chat = await host.wait('chat');
  ok(chat.line.text === 'hold the left flank' && chat.line.seat === 2, 'chat relays with the right seat');

  // ── selling refunds the owner who sold it ──
  const beforeSell = host.last.s.s.gp.slice();
  host.send({ type: 'i', a: 'sell', id: towerId });
  await sleep(300);
  snap = host.last.s.s;
  ok(snap.gp[0] > beforeSell[0], 'selling refunded the owner');
  ok(snap.gp[1] === beforeSell[1], "the other seat's purse was untouched");

  // ── reconnect keeps the seat ──
  const guestToken = guest.last.welcome.token;
  guest.close();
  await sleep(400);
  const guest2 = new Client('guest2');
  await guest2.ready;
  guest2.send({ type: 'hello', token: guestToken, name: 'Guesty' });
  await guest2.wait('welcome');
  guest2.send({ type: 'join', code });
  const back = await guest2.wait('joined');
  ok(back.seat === 2 && back.resumed === true, 'a dropped player reclaims their seat');
  const resumeInfo = await guest2.wait('start');
  ok(!!resumeInfo.info, 'rejoining mid-run replays the static info');

  ok(host.snapshots > 10, `host received a steady snapshot stream (${host.snapshots})`);

  // ── a player who HAS finished a quest may build that gun ──
  const earned = new Client('earned');
  await earned.ready;
  // Flak at 175g is affordable from the starting 250; plasma/railgun are not,
  // and would fail on price rather than on the lock we are trying to test.
  earned.send({ type: 'hello', name: 'Veteran', unlocked: ['flak'] });
  await earned.wait('welcome');
  earned.send({ type: 'create', name: 'quests', isPublic: false, partySize: 1, map: 'Iron Line' });
  await earned.wait('joined');
  earned.send({ type: 'start' });
  await earned.wait('start');
  await earned.wait('s');
  earned.send({ type: 'i', a: 'build', k: 'flak', c: 3, r: 3 });
  await sleep(500);
  ok(earned.last.s.s.T.length >= 12, 'a player who earned the Flak Cannon can build it');
  earned.send({ type: 'i', a: 'build', k: 'laser', c: 5, r: 5 });
  const stillLocked = await earned.wait('deny');
  ok(/quest/i.test(stillLocked.why), 'but a gun they have NOT earned is still refused');
  earned.close();

  host.close(); guest2.close();
  await sleep(200);
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    child.kill('SIGTERM');
    process.exit(failures ? 1 : 0);
  })
  .catch(err => {
    console.error('\nsmoke test crashed:', err.message);
    child.kill('SIGTERM');
    process.exit(1);
  });
