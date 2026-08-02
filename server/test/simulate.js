// Full-game simulation across every party size.
//
// Spawns the real server, then plays complete co-op runs with synthetic players
// that behave like people: they build from their own kit, upgrade, sell, order
// bots around, buy medical supplies and rush waves. Every snapshot is checked
// against a set of invariants, so a bug shows up as a named violation with the
// party size and wave it happened on rather than as "it felt weird".
//
//   node test/simulate.js [runsPerParty] [secondsPerRun]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  TOWERS, BOTS, HEALS, TKEYS, BKEYS, COLS, ROWS, TS, MAXLVL, MAXLIVES,
  kitOf, canUse,
} from '../sim/constants.js';
import { loadMap } from '../sim/map.js';

const RUNS = +(process.argv[2] || 2);
const SECS = +(process.argv[3] || 45);
const PORT = 8097;
const WS_URL = `ws://127.0.0.1:${PORT}/ivaangames/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Deterministic-ish randomness so a failing run can be re-read from the log.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const ri = n => Math.floor(rnd() * n);

const violations = [];
const violate = (ctx, what, detail) => {
  const key = `${what}`;
  if (violations.filter(v => v.what === key).length < 5)   // cap the spam per class
    violations.push({ what: key, ctx, detail });
};

// ── server ──────────────────────────────────────────────────────────────────
const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  cwd: fileURLToPath(new globalThis.URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderrLines = [];
child.stdout.on('data', () => {});
child.stderr.on('data', d => { stderrLines.push(String(d)); process.stderr.write('[srv!] ' + d); });

// ── a client that speaks the real protocol ──────────────────────────────────
function mkClient(name) {
  const ws = new WebSocket(WS_URL);
  const c = {
    name, ws, last: {}, snaps: 0, denies: {}, waiters: [], queue: new Map(),
    bytes: 0, seat: 0, info: null,
  };
  c.open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', raw => {
    c.bytes += raw.length;
    const m = JSON.parse(raw);
    c.last[m.type] = m;
    if (m.type === 's') c.snaps++;
    if (m.type === 'deny') c.denies[m.why] = (c.denies[m.why] || 0) + 1;
    if (m.type === 'joined') { c.seat = m.seat; }
    if (m.type === 'start') c.info = m.info;
    const i = c.waiters.findIndex(w => w.type === m.type);
    if (i >= 0) return void c.waiters.splice(i, 1)[0].res(m);
    if (m.type === 's') return;
    if (!c.queue.has(m.type)) c.queue.set(m.type, []);
    const q = c.queue.get(m.type); q.push(m); if (q.length > 20) q.shift();
  });
  c.send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.act = o => c.send({ type: 'i', ...o });
  c.wait = (type, ms = 8000) => {
    const q = c.queue.get(type);
    if (q && q.length) return Promise.resolve(q.shift());
    return new Promise((res, rej) => {
      const w = { type, res }; c.waiters.push(w);
      setTimeout(() => {
        const i = c.waiters.indexOf(w);
        if (i >= 0) { c.waiters.splice(i, 1); rej(new Error(`${name}: no '${type}'`)); }
      }, ms);
    });
  };
  return c;
}

// ── invariant checks, run against every snapshot ────────────────────────────
const STRIDE = { E: 7, T: 11, B: 14, U: 5, Gd: 4, C: 4 };

function checkSnapshot(s, ctx, map, partySize) {
  // wire format
  for (const [k, n] of Object.entries(STRIDE)) {
    if (!Array.isArray(s[k])) { violate(ctx, `snapshot.${k} missing`); continue; }
    if (s[k].length % n !== 0)
      violate(ctx, `snapshot.${k} stride`, `length ${s[k].length} not a multiple of ${n}`);
  }
  for (const v of [s.l, s.w, s.p, s.k, s.lk]) {
    if (!Number.isFinite(v)) violate(ctx, 'non-finite scalar', JSON.stringify({ l:s.l, w:s.w, p:s.p }));
  }

  // economy — one purse per seat
  if (!Array.isArray(s.gp) || s.gp.length !== 4) violate(ctx, 'purse array malformed', JSON.stringify(s.gp));
  else for (let i = 0; i < partySize; i++) {
    if (!Number.isFinite(s.gp[i])) violate(ctx, 'non-finite purse', `seat ${i + 1} = ${s.gp[i]}`);
    if (s.gp[i] < 0) violate(ctx, 'negative purse', `seat ${i + 1} = ${s.gp[i]}`);
  }
  if (s.l < 0) violate(ctx, 'negative lives', `lives=${s.l}`);
  if (s.l > MAXLIVES) violate(ctx, 'lives above cap', `lives=${s.l} cap=${MAXLIVES}`);
  // 50 waves solo, 100 with a party
  const cap = partySize > 1 ? 100 : 50;
  if (s.w < 0 || s.w > cap) violate(ctx, 'wave out of range', `wave=${s.w} cap=${cap}`);

  // towers: unique ids, one per tile, never on the path, kit-legal, sane level
  const ids = new Set(), tiles = new Set();
  for (let i = 0; i < s.T.length; i += STRIDE.T) {
    const [id, ti, c, r, lvl, , owner] = s.T.slice(i, i + 7);
    const key = TKEYS[ti];
    if (ids.has(id)) violate(ctx, 'duplicate tower id', `id=${id}`);
    ids.add(id);
    const tk = c + ',' + r;
    if (tiles.has(tk)) violate(ctx, 'two towers on one tile', `tile=${tk}`);
    tiles.add(tk);
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) violate(ctx, 'tower off-grid', `c=${c} r=${r}`);
    else if (map.blocked[r][c]) violate(ctx, 'tower on the enemy path', `tile=${tk} map=${map.name}`);
    if (!key) violate(ctx, 'unknown tower type index', `ti=${ti}`);
    if (lvl < 1 || lvl > MAXLVL) violate(ctx, 'tower level out of range', `lvl=${lvl}`);
    if (owner < 1 || owner > partySize) violate(ctx, 'tower owner out of range', `owner=${owner} party=${partySize}`);
    else if (key && !canUse(owner, key, partySize))
      violate(ctx, 'tower outside its owner kit', `seat ${owner} owns ${key} in a ${partySize}-player game`);
  }

  // bots
  const bids = new Set();
  for (let i = 0; i < s.B.length; i += STRIDE.B) {
    const [id, bi, x, y, , , lvl, hp, , owner] = s.B.slice(i, i + 10);
    const kind = BKEYS[bi];
    if (bids.has(id)) violate(ctx, 'duplicate bot id', `id=${id}`);
    bids.add(id);
    if (!kind) violate(ctx, 'unknown bot kind index', `bi=${bi}`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) violate(ctx, 'bot NaN position', `id=${id}`);
    if (hp < 0) violate(ctx, 'negative bot hp', `id=${id} hp=${hp}`);
    if (lvl < 1 || lvl > MAXLVL) violate(ctx, 'bot level out of range', `lvl=${lvl}`);
    if (owner < 1 || owner > partySize) violate(ctx, 'bot owner out of range', `owner=${owner}`);
    else if (kind && !canUse(owner, kind, partySize))
      violate(ctx, 'bot outside its owner kit', `seat ${owner} owns ${kind} in a ${partySize}-player game`);
  }
  if (ids.size !== new Set([...ids, ...bids]).size - bids.size)
    violate(ctx, 'tower and bot ids collide');

  // enemies
  for (let i = 0; i < s.E.length; i += STRIDE.E) {
    const [id, , x, y, hp, , blockId] = s.E.slice(i, i + 7);
    if (!Number.isFinite(x) || !Number.isFinite(y)) violate(ctx, 'enemy NaN position', `id=${id}`);
    if (hp < 0 || hp > 255) violate(ctx, 'enemy hp byte out of range', `hp=${hp}`);
    if (x < -200 || x > 1200 || y < -200 || y > 900) violate(ctx, 'enemy far off-board', `x=${x} y=${y}`);
    if (blockId && !bids.has(blockId)) violate(ctx, 'enemy blocked by a bot that does not exist', `blockId=${blockId}`);
  }

  // cursors
  for (let i = 0; i < s.C.length; i += STRIDE.C) {
    const [seat, c, r, code] = s.C.slice(i, i + 4);
    if (seat < 1 || seat > partySize) violate(ctx, 'cursor seat out of range', `seat=${seat}`);
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) violate(ctx, 'cursor off-grid', `c=${c} r=${r}`);
    if (code >= 0) {
      const key = code >= 100 ? BKEYS[code - 100] : TKEYS[code];
      if (!key) violate(ctx, 'cursor references unknown build', `code=${code}`);
      else if (!canUse(seat, key, partySize))
        violate(ctx, 'cursor shows a build outside that seat kit', `seat ${seat} → ${key}`);
    }
  }

  // score sanity
  if (!Array.isArray(s.sc) || s.sc.length !== 4) violate(ctx, 'score array malformed');
  else for (const v of s.sc) if (v < 0 || !Number.isFinite(v)) violate(ctx, 'bad score value', `${s.sc}`);

}

// ── a synthetic player ──────────────────────────────────────────────────────
function makeActor(c, seat, partySize, map) {
  const kit = kitOf(seat, partySize);
  const towerKeys = kit.filter(k => TOWERS[k]);
  const botKeys = kit.filter(k => BOTS[k]);
  const mine = { towers: [], bots: [] };
  return function act(snap) {
    if (!snap) return;
    // refresh what we own from the authoritative snapshot
    mine.towers = []; mine.bots = [];
    for (let i = 0; i < snap.T.length; i += STRIDE.T)
      if (snap.T[i + 6] === seat) mine.towers.push({ id: snap.T[i], lvl: snap.T[i + 4] });
    for (let i = 0; i < snap.B.length; i += STRIDE.B)
      if (snap.B[i + 9] === seat) mine.bots.push({ id: snap.B[i], lvl: snap.B[i + 6] });

    const gold = (snap.gp || [])[seat - 1] || 0;
    const roll = rnd();

    // find an empty, unblocked tile
    const freeTile = () => {
      for (let tries = 0; tries < 30; tries++) {
        const c2 = ri(COLS), r2 = ri(ROWS);
        if (map.blocked[r2][c2]) continue;
        let taken = false;
        for (let i = 0; i < snap.T.length; i += STRIDE.T)
          if (snap.T[i + 2] === c2 && snap.T[i + 3] === r2) { taken = true; break; }
        if (!taken) return { c: c2, r: r2 };
      }
      return null;
    };

    if (roll < 0.42 && towerKeys.length) {
      const affordable = towerKeys.filter(k => TOWERS[k].cost <= gold);
      if (affordable.length) {
        const t = freeTile();
        if (t) { c.act({ a: 'build', k: pick(affordable), c: t.c, r: t.r }); return; }
      }
    }
    if (roll < 0.58 && botKeys.length) {
      const affordable = botKeys.filter(k => BOTS[k].cost <= gold);
      if (affordable.length) {
        c.act({ a: 'deploy', k: pick(affordable), x: 40 + ri(800), y: 40 + ri(520) });
        return;
      }
    }
    if (roll < 0.72) {
      const all = [...mine.towers, ...mine.bots].filter(u => u.lvl < MAXLVL);
      if (all.length) { c.act({ a: 'upgrade', id: pick(all).id }); return; }
    }
    if (roll < 0.78) {
      const all = [...mine.towers, ...mine.bots];
      if (all.length) { c.act({ a: 'sell', id: pick(all).id }); return; }
    }
    if (roll < 0.86 && mine.bots.length) {
      c.act({ a: 'order', id: pick(mine.bots).id, x: 40 + ri(800), y: 40 + ri(520) });
      return;
    }
    if (roll < 0.90 && snap.l < MAXLIVES) {
      c.act({ a: 'heal', k: pick(Object.keys(HEALS)) }); return;
    }
    if (roll < 0.95) {
      c.act({ a: 'cursor', c: ri(COLS), r: ri(ROWS), k: pick(kit) }); return;
    }
    c.act({ a: 'wave' });
  };
}

// ── one full run ────────────────────────────────────────────────────────────
async function runGame(partySize, runNo) {
  const label = `${partySize}p#${runNo}`;
  const clients = [];
  for (let i = 0; i < partySize; i++) clients.push(mkClient(`${label}-s${i + 1}`));
  await Promise.all(clients.map(c => c.open));
  clients.forEach((c, i) => c.send({ type: 'hello', name: `Sim${i + 1}` }));
  await Promise.all(clients.map(c => c.wait('welcome')));

  clients[0].send({ type: 'create', name: `sim ${label}`, isPublic: false, partySize, map: 'random' });
  const created = await clients[0].wait('joined');
  const code = created.room.code;
  if (created.seat !== 1) violate(label, 'host did not get seat 1', `seat=${created.seat}`);

  for (let i = 1; i < partySize; i++) {
    clients[i].send({ type: 'join', code });
    const j = await clients[i].wait('joined');
    if (j.seat !== i + 1) violate(label, 'seat assignment out of order', `expected ${i + 1} got ${j.seat}`);
  }

  clients[0].send({ type: 'start' });
  const started = await clients[0].wait('start');
  const map = loadMap({ name: started.info.map.name, way: started.info.map.way });
  if (started.info.players !== partySize)
    violate(label, 'party size mismatch at start', `${started.info.players} vs ${partySize}`);

  // every non-host must also receive the start
  for (let i = 1; i < partySize; i++) await clients[i].wait('start');

  const actors = clients.map((c, i) => makeActor(c, i + 1, partySize, map));

  let checks = 0, maxWave = 0, ended = false;
  const watcher = setInterval(() => {
    const m = clients[0].last.s;
    if (!m) return;
    const s = m.s;
    checks++;
    maxWave = Math.max(maxWave, s.w);
    checkSnapshot(s, `${label} w${s.w}`, map, partySize);
    if (s.f & 4) ended = true;

    // every client must be seeing the same world (snapshots are broadcast, so
    // any disagreement beyond a tick of lag means the fan-out is broken)
    for (let i = 1; i < partySize; i++) {
      const o = clients[i].last.s;
      if (!o || Math.abs(o.s.t - s.t) > 4) continue;
      if (o.s.l !== s.l || o.s.w !== s.w)
        violate(label, 'clients disagree on shared state',
          `seat1 wave=${s.w} lives=${s.l} vs seat${i + 1} wave=${o.s.w} lives=${o.s.l}`);
    }
  }, 250);

  const driver = setInterval(() => {
    const s = clients[0].last.s && clients[0].last.s.s;
    for (const [i, act] of actors.entries()) act(clients[i].last.s ? clients[i].last.s.s : s);
  }, 380);

  await sleep(SECS * 1000);
  clearInterval(watcher); clearInterval(driver);

  const s = clients[0].last.s.s;
  const result = {
    label, partySize, code, map: started.info.map.name,
    wave: s.w, maxWave, killed: s.k, leaked: s.lk,
    gold: (s.gp || []).slice(0, partySize).join('/'), lives: s.l,
    towers: s.T.length / STRIDE.T, bots: s.B.length / STRIDE.B,
    score: s.sc.slice(0, partySize), ended,
    snaps: clients[0].snaps, checks,
    kbps: +(clients[0].bytes / SECS / 1024).toFixed(1),
    denies: clients.reduce((acc, c) => {
      for (const [k, v] of Object.entries(c.denies)) acc[k] = (acc[k] || 0) + v;
      return acc;
    }, {}),
  };

  clients.forEach(c => { c.send({ type: 'leave' }); c.ws.close(); });
  await sleep(250);
  return result;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  for (let i = 0; i < 80; i++) {
    try {
      const p = new WebSocket(WS_URL);
      await new Promise((res, rej) => { p.once('open', res); p.once('error', rej); });
      p.close(); break;
    } catch { await sleep(100); }
  }

  const results = [];
  for (const partySize of [1, 2, 3, 4]) {
    for (let run = 1; run <= RUNS; run++) {
      process.stdout.write(`running ${partySize}-player run ${run}/${RUNS}… `);
      const r = await runGame(partySize, run);
      results.push(r);
      console.log(`wave ${r.wave}, ${r.killed} kills, ${r.towers} towers, ${r.bots} bots, ${r.checks} snapshot checks`);
    }
  }

  console.log('\n═══ results ═══════════════════════════════════════════════════');
  console.log('party  run  map           wave  kills  leak  towers bots  gold  lives  KB/s  score');
  for (const r of results) {
    console.log(
      String(r.partySize).padEnd(6) +
      r.label.split('#')[1].padEnd(5) +
      String(r.map).slice(0, 13).padEnd(14) +
      String(r.wave).padEnd(6) +
      String(r.killed).padEnd(7) +
      String(r.leaked).padEnd(6) +
      String(r.towers).padEnd(7) +
      String(r.bots).padEnd(6) +
      String(r.gold).padEnd(18) +
      String(r.lives).padEnd(7) +
      String(r.kbps).padEnd(6) +
      JSON.stringify(r.score));
  }

  const allDenies = {};
  for (const r of results) for (const [k, v] of Object.entries(r.denies)) allDenies[k] = (allDenies[k] || 0) + v;
  console.log('\ndenials (expected — these are the server refusing illegal or unaffordable asks):');
  for (const [k, v] of Object.entries(allDenies).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);

  console.log('\n═══ invariant violations ══════════════════════════════════════');
  if (!violations.length) console.log('  none — every snapshot in every run was internally consistent');
  else {
    const grouped = {};
    for (const v of violations) (grouped[v.what] ||= []).push(v);
    for (const [what, list] of Object.entries(grouped)) {
      console.log(`  ✗ ${what}  (${list.length}${list.length >= 5 ? '+' : ''})`);
      for (const v of list.slice(0, 3)) console.log(`      ${v.ctx}  ${v.detail || ''}`);
    }
  }
  if (stderrLines.length) {
    console.log('\n═══ server stderr ═════════════════════════════════════════════');
    console.log(stderrLines.join('').slice(0, 3000));
  }

  const bad = violations.length > 0 || stderrLines.length > 0;
  console.log('\n' + (bad ? 'SIMULATION FOUND PROBLEMS' : 'all simulations clean'));
  return bad ? 1 : 0;
}

main()
  .then(code => { child.kill('SIGTERM'); setTimeout(() => process.exit(code), 400); })
  .catch(e => { console.error('simulation crashed:', e); child.kill('SIGTERM'); process.exit(1); });
