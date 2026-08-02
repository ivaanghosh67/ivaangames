// Parameter sweep for the party-size difficulty coefficient.
//
// The aim is that a party is neither free nor punished: the same reference
// player should get roughly as far solo as in a group. This runs the same
// competent bot across several coefficients and party sizes and reports how
// deep each run got, so the coefficient is chosen from evidence.
//
//   node test/sweep.js [coefficients] [runsPerCell]

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Sim } from '../sim/sim.js';
import { applyIntent } from '../sim/intents.js';
import { TOWERS, COLS, ROWS, MAXLVL, kitOf, PARTY_COEFF } from '../sim/constants.js';

const COEFFS = (process.argv[2] || '0.15,0.3,0.45,0.6,0.8').split(',').map(Number);
const RUNS = +(process.argv[3] || 3);
const PARTIES = [1, 2, 3, 4];
const DT = 1 / 30;
const CAP_MIN = 30;                       // give up after this much game time

function rngFor(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function makePlayer(sim, seat, partySize, rnd) {
  const kit = kitOf(seat, partySize);
  const towers = kit.filter(k => TOWERS[k] && !TOWERS[k].lock);
  const spots = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (sim.map.blocked[r][c]) continue;
    let best = 1e9;
    for (const p of sim.map.path) {
      const d = Math.hypot(p.x - (c * 40 + 20), p.y - (r * 40 + 20));
      if (d < best) best = d;
    }
    spots.push({ c, r, d: best });
  }
  spots.sort((a, b) => a.d - b.d);
  return function act() {
    const G = sim.G;
    if (G.over) return;
    const gold = G.purse[seat];
    const mine = G.towers.filter(t => t.owner === seat);
    const air = mine.filter(t => TOWERS[t.type].air).length;
    if (G.lives < 10 && gold > 300) { applyIntent(sim, seat, { a:'heal', k:'medkit' }); return; }
    const want = 6 + Math.floor(G.wave / 3);
    if (mine.length < want) {
      const pool = (air < Math.max(2, mine.length / 3)) ? towers.filter(k => TOWERS[k].air) : towers;
      const afford = pool.filter(k => TOWERS[k].cost <= gold).sort((a, b) => TOWERS[b].cost - TOWERS[a].cost);
      for (const k of afford) for (let i = 0; i < 40; i++) {
        const s = spots[Math.floor(rnd() * Math.min(spots.length, 70))];
        if (sim.canBuild(s.c, s.r)) { applyIntent(sim, seat, { a:'build', k, c:s.c, r:s.r }); return; }
      }
    }
    const up = mine.filter(u => u.lvl < MAXLVL).sort((a, b) => a.lvl - b.lvl);
    if (up.length && sim.upCost(up[0]) <= gold) { applyIntent(sim, seat, { a:'upgrade', id:up[0].id }); return; }
    if (!G.waveActive && G.lives >= 15) applyIntent(sim, seat, { a:'wave' });
  };
}

function runOne(party, seed) {
  // A FIXED map. Random maps vary wildly in path length and corner count, and
  // that variance swamped the parameter being measured — an early sweep swung
  // between wave 5 and wave 44 for the same coefficient.
  const sim = new Sim({ seed, players: party, map: 'Iron Line' });
  const rnd = rngFor(seed ^ 0x5bf03635);
  const acts = [];
  for (let s = 1; s <= party; s++) acts.push(makePlayer(sim, s, party, rnd));
  let ticks = 0;
  const max = CAP_MIN * 60 * 30;
  while (ticks < max && !sim.G.over) {
    sim.update(DT); sim.drainEvents(); ticks++;
    if (ticks % 6 === 0) for (const a of acts) a();
  }
  return { wave: sim.G.wave, won: sim.G.won, over: sim.G.over };
}

// An ES module namespace is immutable, so the coefficient cannot be swapped in
// place. Each pass re-runs this file in a child process with the coefficient in
// the environment; the child prints one row of results and exits.
if (process.env.IRONLINE_SWEEP_CHILD) {
  const row = PARTIES.map(p => {
    let sum = 0;
    for (let i = 0; i < RUNS; i++) sum += runOne(p, 1000 + i * 7919 + p * 13).wave;
    return +(sum / RUNS).toFixed(1);
  });
  console.log(JSON.stringify(row));
} else {
  console.log('Party-scaling sweep — how deep the same reference bot gets.');
  console.log('Want the four columns roughly level: co-op neither free nor punished.\n');
  console.log('coeff    solo      2p      3p      4p    spread');
  const self = fileURLToPath(import.meta.url);
  const results = [];
  for (const k of COEFFS) {
    const r = spawnSync(process.execPath, [self, String(k), String(RUNS)], {
      env: { ...process.env, IRONLINE_SWEEP_CHILD: '1',
             IRONLINE_PARTY_COEFF: String(k), IRONLINE_ANALYTICS: '0' },
      encoding: 'utf8', maxBuffer: 1 << 24,
    });
    const line = (r.stdout || '').trim().split('\n').pop();
    let row;
    try { row = JSON.parse(line); }
    catch { console.log(String(k).padEnd(9) + 'failed: ' + (r.stderr || '').slice(0, 90)); continue; }
    const spread = Math.max(...row) - Math.min(...row);
    results.push({ k, row, spread });
    console.log(String(k).padEnd(9) + row.map(v => v.toFixed(1).padStart(6)).join('  ') +
      '  ' + spread.toFixed(1).padStart(6));
  }
  if (results.length) {
    const best = results.slice().sort((a, b) => a.spread - b.spread)[0];
    console.log(`\nFlattest spread at coefficient ${best.k} ` +
      `(solo ${best.row[0].toFixed(1)} → 4p ${best.row[3].toFixed(1)})`);
  }
}
