// Where does a perfect defence finally break?
//
// The complaint that started this: "after a few levels the gameplay is really,
// really easy." deep-sim confirmed it — a bot that saturates the map reaches
// wave 56 with 90 towers, zero leaks and 87,665 banked gold. Nothing is at
// stake because nothing can get through.
//
// So measure the ceiling directly. Build the strongest board the rules allow
// (every buildable tile filled with the best gun, everything at MAXLVL, squads
// maxed) and push waves at it until enemies start leaking. That wave number is
// the honest answer to "how hard does this game ever get".
//
//   node test/ceiling.js [--party N] [--diff regular] [--from 20] [--to 120]
//
// A healthy curve leaks *somewhere*. If it never leaks, the late game has no
// fail state and the difficulty work is not done.

import { Sim } from '../sim/sim.js';
import { applyIntent } from '../sim/intents.js';
import {
  TOWERS, TKEYS, BOTS, BKEYS, MAXLVL, COLS, ROWS, MAXLIVES, maxWaveFor,
} from '../sim/constants.js';

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const PARTY = +arg('party', 1);
const DIFF  = arg('diff', 'regular');
const FROM  = +arg('from', 10);
const TO    = +arg('to', 120);
const TICK  = 1 / 30;

// The best gun available, judged by raw damage-per-second, so the board is not
// biased by my own taste in turrets.
const dpsOf = k => {
  const d = TOWERS[k];
  return (d.dmg || 0) * (d.rate || 0) * (d.targets || 1);
};
const BEST = [...TKEYS].sort((a, b) => dpsOf(b) - dpsOf(a));

function godBoard(sim, limit) {
  // fill every legal tile, cycling the top guns so anti-air is covered too.
  // With a limit, prefer tiles nearest the road — that is what a good player
  // builds, so a capped board should be measured at its best, not its average.
  const air = BEST.filter(k => TOWERS[k].air);
  const any = BEST;
  let built = 0;
  const tiles = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) tiles.push({ c, r });
  if (limit) {
    const near = ({ c, r }) => Math.min(...sim.map.path.map(
      p => Math.hypot(p.x - (c * 40 + 20), p.y - (r * 40 + 20))));
    for (const t of tiles) t.d = near(t);
    tiles.sort((a, b) => a.d - b.d);
  }
  {
    for (const { c, r } of tiles) {
      if (limit && built >= limit) break;
      if (!sim.canBuild(c, r)) continue;
      // every third tile is a dedicated anti-air gun
      const pool = built % 3 === 0 && air.length ? air : any;
      const k = pool[built % pool.length];
      const seat = (built % sim.players) + 1;
      sim.G.purse[seat] = 1e9;
      applyIntent(sim, seat, { a: 'build', k, c, r });
      built++;
    }
  }
  // max everything out
  for (const t of sim.G.towers) t.lvl = MAXLVL;

  // and fill the squad slots with the priciest bots
  if (process.argv.includes('--nobots')) return { towers: sim.G.towers.length, bots: 0 };
  const bots = [...BKEYS].sort((a, b) => BOTS[b].cost - BOTS[a].cost);
  const mid = sim.map.path[Math.floor(sim.map.path.length / 2)];
  for (let i = 0; i < sim.maxSquads() * sim.players; i++) {
    const seat = (i % sim.players) + 1;
    sim.G.purse[seat] = 1e9;
    applyIntent(sim, seat, {
      a: 'deploy', k: bots[i % bots.length],
      x: mid.x + ((i % 5) - 2) * 22, y: mid.y + (Math.floor(i / 5) - 2) * 22,
    });
  }
  for (const b of sim.G.bots) b.lvl = MAXLVL;
  return { towers: sim.G.towers.length, bots: sim.G.bots.length };
}

function runWave(wave, limit) {
  const sim = new Sim({
    players: PARTY, seed: 4242, map: 'Iron Line',
    difficulty: DIFF, unlocked: null, endless: true,
  });
  // Jump to the wave under test BEFORE building. The turret allowance grows
  // with the wave, so a board assembled at wave 0 would be held to the opening
  // allowance and understate what a real late-game player actually fields.
  sim.G.wave = wave - 1;
  sim.G.lives = MAXLIVES;
  for (let s = 1; s <= PARTY; s++) sim.G.purse[s] = 1e9;

  const board = godBoard(sim, limit);

  applyIntent(sim, 1, { a: 'wave' });
  const startLives = sim.G.lives;

  let ticks = 0;
  const LIMIT = 30 * 60 * 6;                 // six game-minutes is plenty
  while (ticks < LIMIT) {
    sim.update(TICK);
    ticks++;
    if (sim.G.over) break;
    if (ticks > 30 && !sim.G.waveActive && sim.G.enemies.length === 0) break;
  }
  const leaked = startLives - sim.G.lives;
  return {
    wave, leaked, board,
    secs: +(ticks / 30).toFixed(1),
    peak: sim.G.killed,
    dead: sim.G.over,
  };
}

// --towers may be a single number or a comma list, so one run can compare caps
const CAPS = String(arg('towers', '0')).split(',').map(Number);

console.log(`\n═══ ceiling probe — party ${PARTY}, ${DIFF} ════════════════`);
console.log(`the strongest board the rules allow, one wave at a time\n`);

for (const cap of CAPS) {
  const b0 = runWave(FROM, cap).board;
  console.log(`── ${cap ? cap + '-tower cap' : 'no cap'}: ` +
    `${b0.towers} towers at L${MAXLVL}, ${b0.bots} bots at L${MAXLVL} ──`);
  console.log('wave   leaked   cleared in   killed');

  let firstLeak = null, first10 = null;
  for (let w = FROM; w <= TO; w += (w < 40 ? 5 : 10)) {
    const r = runWave(w, cap);
    if (r.leaked > 0 && firstLeak === null) firstLeak = w;
    if (r.leaked >= 10 && first10 === null) first10 = w;
    console.log(
      String(w).padEnd(6) +
      String(r.leaked ? '-' + r.leaked : 'none').padStart(7) +
      String(r.secs + 's').padStart(13) +
      String(r.peak).padStart(9) +
      (r.dead ? '   ← BOARD FELL' : ''),
    );
  }
  if (firstLeak === null) {
    console.log(`✗ nothing got through by wave ${TO} — no fail state.\n`);
    process.exitCode = 1;
  } else {
    console.log(`✓ first leak at wave ${firstLeak}` +
      (first10 ? `, real damage (10+) at wave ${first10}` : '') + '\n');
  }
}
console.log(`solo finishes at wave ${maxWaveFor(1)}, a party at ${maxWaveFor(2)}\n`);
