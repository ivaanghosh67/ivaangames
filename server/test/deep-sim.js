// Deep simulation: drives the Sim class directly, with no network in the way,
// so a full 50-wave run takes seconds instead of an hour. This is where the
// long-tail bugs live — bosses, the three Ultra Bosses on wave 49, the win at
// 50, the loss when the line breaks, and anything that only goes wrong after
// thousands of ticks.
//
//   node test/deep-sim.js [runsPerParty] [maxMinutesOfGameTimePerRun]

import { Sim } from '../sim/sim.js';
import { applyIntent } from '../sim/intents.js';
import { encodeSnapshot } from '../sim/snapshot.js';
import {
  TOWERS, BOTS, HEALS, TKEYS, BKEYS, COLS, ROWS, MAXLVL, MAXLIVES, MAXWAVE, maxWaveFor,
  kitOf, canUse, statsOf,
} from '../sim/constants.js';

const RUNS = +(process.argv[2] || 3);
const MAX_GAME_MINUTES = +(process.argv[3] || 45);
const DT = 1 / 30;
const MAX_TICKS = Math.round(MAX_GAME_MINUTES * 60 * 30);

const violations = [];
const violate = (ctx, what, detail) => {
  if (violations.filter(v => v.what === what).length < 4)
    violations.push({ what, ctx, detail });
};

function rngFor(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

// ── invariants checked against the live sim ─────────────────────────────────
function checkSim(sim, ctx, partySize) {
  const G = sim.G;
  for (let s = 1; s <= partySize; s++) {
    const p = G.purse[s];
    if (!Number.isFinite(p)) violate(ctx, 'purse is not finite', `seat ${s} = ${p}`);
    if (p < 0) violate(ctx, 'negative purse', `seat ${s} = ${p}`);
  }
  if (!Number.isFinite(G.lives)) violate(ctx, 'lives is not finite', String(G.lives));
  if (G.lives < 0) violate(ctx, 'negative lives', `${G.lives}`);
  if (G.lives > MAXLIVES) violate(ctx, 'lives above cap', `${G.lives}`);
  if (G.wave < 0 || G.wave > sim.maxWave) violate(ctx, 'wave out of range', `${G.wave}/${sim.maxWave}`);

  const tiles = new Set(), ids = new Set();
  for (const t of G.towers) {
    if (ids.has(t.id)) violate(ctx, 'duplicate unit id', `tower ${t.id}`);
    ids.add(t.id);
    const k = t.c + ',' + t.r;
    if (tiles.has(k)) violate(ctx, 'two towers on one tile', k);
    tiles.add(k);
    if (sim.map.blocked[t.r][t.c]) violate(ctx, 'tower on the enemy path', `${k} on ${sim.map.name}`);
    if (t.lvl < 1 || t.lvl > MAXLVL) violate(ctx, 'tower level out of range', `${t.lvl}`);
    if (!canUse(t.owner, t.type, partySize))
      violate(ctx, 'tower outside owner kit', `seat ${t.owner} → ${t.type}`);
    if (!Number.isFinite(t.a)) violate(ctx, 'tower angle NaN', `${t.type}`);
    if (!Number.isFinite(t.cd)) violate(ctx, 'tower cooldown NaN', `${t.type}`);
    if (t.spent < 0) violate(ctx, 'negative spent', `${t.spent}`);
  }
  for (const b of G.bots) {
    if (ids.has(b.id)) violate(ctx, 'duplicate unit id', `bot ${b.id}`);
    ids.add(b.id);
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) violate(ctx, 'bot NaN position', `${b.kind}`);
    if (!Number.isFinite(b.hp)) violate(ctx, 'bot hp NaN', `${b.kind}`);
    if (b.hp < 0 && !b.dead) violate(ctx, 'live bot with negative hp', `${b.kind} hp=${b.hp}`);
    if (!canUse(b.owner, b.kind, partySize))
      violate(ctx, 'bot outside owner kit', `seat ${b.owner} → ${b.kind}`);
    if (b.dead && b.respawn > 12) violate(ctx, 'respawn timer too long', `${b.respawn}`);
  }
  if (G.bots.length > sim.maxSquads())
    violate(ctx, 'squad cap exceeded', `${G.bots.length} > ${sim.maxSquads()}`);
  // The turret allowance is the one thing standing between the late game and
  // the state the telemetry caught it in: 112 turrets on the board and not a
  // single leak for the last 56 waves of a real run. If this ever stops
  // holding, the game quietly stops having a fail state again.
  for (let s = 1; s <= partySize; s++) {
    const owned = G.towers.reduce((n, t) => n + (t.owner === s ? 1 : 0), 0);
    const cap = sim.towerCap(s);
    if (owned > cap) violate(ctx, 'turret allowance exceeded', `seat ${s}: ${owned} > ${cap}`);
  }

  const path = sim.map.path, air = sim.map.airpath;
  for (const e of G.enemies) {
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) violate(ctx, 'enemy NaN position', e.type);
    if (!Number.isFinite(e.hp)) violate(ctx, 'enemy hp NaN', e.type);
    if (e.maxhp <= 0) violate(ctx, 'enemy maxhp non-positive', `${e.type} ${e.maxhp}`);
    if (e.wp > (e.fly ? air.length : path.length))
      violate(ctx, 'enemy waypoint past the end of the path', `${e.type} wp=${e.wp}`);
    if (e.block && !G.bots.includes(e.block))
      violate(ctx, 'enemy blocked by a bot no longer in the game', e.type);
    if (e.slowF <= 0 || e.slowF > 1) violate(ctx, 'slow factor out of range', `${e.slowF}`);
  }
  for (const b of G.bullets) {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) violate(ctx, 'bullet NaN position', b.type);
    if (b.tgt && !G.enemies.includes(b.tgt)) violate(ctx, 'bullet still targets a dead enemy', b.type);
    if (b.life < -1) violate(ctx, 'bullet outlived its life budget', `${b.life}`);
  }
  for (let s = 1; s <= partySize; s++) {
    if (!Number.isFinite(G.score[s]) || G.score[s] < 0)
      violate(ctx, 'bad score', `seat ${s} = ${G.score[s]}`);
  }

  // the snapshot encoder must survive whatever state we are in
  try {
    const snap = encodeSnapshot(sim, 0);
    if (snap.T.length % 12) violate(ctx, 'snapshot tower stride broken', `${snap.T.length}`);
    if (snap.B.length % 14) violate(ctx, 'snapshot bot stride broken', `${snap.B.length}`);
    if (snap.E.length % 7) violate(ctx, 'snapshot enemy stride broken', `${snap.E.length}`);
    if (snap.U.length % 5) violate(ctx, 'snapshot bullet stride broken', `${snap.U.length}`);
    const json = JSON.stringify(snap);
    if (json.includes('null,') || json.includes('NaN'))
      violate(ctx, 'snapshot contains null/NaN', json.slice(0, 200));
  } catch (err) {
    violate(ctx, 'snapshot encoding threw', err.message);
  }
}

// ── a competent player, so runs actually get deep ───────────────────────────
function makeStrategy(sim, seat, partySize, rnd) {
  const kit = kitOf(seat, partySize);
  const towerKeys = kit.filter(k => TOWERS[k]).sort((a, b) => TOWERS[b].cost - TOWERS[a].cost);
  const botKeys = kit.filter(k => BOTS[k]);

  // Spots near the path are worth more; precompute a ranked list once.
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
    const gold = G.purse[seat];               // your own purse funds your own line
    const mineT = G.towers.filter(t => t.owner === seat);
    const mineB = G.bots.filter(b => b.owner === seat);

    // 1. keep the line alive first
    if (G.lives < 8 && gold > 200) {
      applyIntent(sim, seat, { a: 'heal', k: gold > 400 ? 'medkit' : 'bandage' });
      return;
    }
    // 2. build out to a solid footprint before upgrading
    const wantTowers = 5 + Math.floor(G.wave / 2);
    // At the allowance with money to burn, buy room rather than sit on gold —
    // this is the path a rich late-game player takes, so it needs exercising.
    if (mineT.length >= sim.towerCap(seat) && gold > sim.permitCost(seat) * 2) {
      applyIntent(sim, seat, { a: 'permit' });
      return;
    }
    if (towerKeys.length && mineT.length < wantTowers) {
      for (const k of towerKeys) {
        if (TOWERS[k].cost > gold) continue;
        for (let i = 0; i < 60; i++) {
          const s = spots[Math.floor(rnd() * Math.min(spots.length, 90))];
          if (sim.canBuild(s.c, s.r)) {
            applyIntent(sim, seat, { a: 'build', k, c: s.c, r: s.r });
            return;
          }
        }
      }
    }
    // 3. a couple of bots on the field
    if (botKeys.length && mineB.length < 3) {
      for (const k of botKeys) {
        if (BOTS[k].cost <= gold) {
          const p = sim.map.path[Math.floor(sim.map.path.length / 2)];
          applyIntent(sim, seat, { a: 'deploy', k, x: p.x + (rnd() - .5) * 90, y: p.y + (rnd() - .5) * 90 });
          return;
        }
      }
    }
    // 4. otherwise pour money into what is already there
    const upgradable = [...mineT, ...mineB].filter(u => u.lvl < MAXLVL);
    if (upgradable.length) {
      const u = upgradable[Math.floor(rnd() * upgradable.length)];
      if (sim.upCost(u) <= gold) { applyIntent(sim, seat, { a: 'upgrade', id: u.id }); return; }
    }
    // 5. rush the countdown when we are comfortable
    if (!G.waveActive && G.lives > 12) applyIntent(sim, seat, { a: 'wave' });
  };
}

// ── one run ─────────────────────────────────────────────────────────────────
function runOne(partySize, seed) {
  const ctx = `${partySize}p/seed${seed}`;
  const sim = new Sim({ seed, players: partySize, map: 'random' });
  const rnd = rngFor(seed ^ 0x9e3779b9);
  const acts = [];
  for (let s = 1; s <= partySize; s++) acts.push(makeStrategy(sim, s, partySize, rnd));

  let ticks = 0, lastWave = 0, stuckTicks = 0, peakEnemies = 0, peakBullets = 0;
  let sawBoss = false, sawUltra = false, prevKilled = 0, prevScoreSum = 0;

  while (ticks < MAX_TICKS && !sim.G.over) {
    sim.update(DT);
    sim.drainEvents();                        // events would otherwise grow forever
    ticks++;

    if (ticks % 6 === 0) for (const a of acts) a();

    for (const e of sim.G.enemies) {
      if (e.type === 'boss') sawBoss = true;
      if (e.type === 'ultra') sawUltra = true;
    }
    peakEnemies = Math.max(peakEnemies, sim.G.enemies.length);
    peakBullets = Math.max(peakBullets, sim.G.bullets.length);

    // monotonicity: kills and per-seat score must never go backwards
    if (sim.G.killed < prevKilled) violate(ctx, 'kill counter went backwards', `${prevKilled} → ${sim.G.killed}`);
    prevKilled = sim.G.killed;
    const scoreSum = Object.values(sim.G.score).reduce((a, b) => a + b, 0);
    if (scoreSum < prevScoreSum) violate(ctx, 'score went backwards', `${prevScoreSum} → ${scoreSum}`);
    prevScoreSum = scoreSum;

    if (ticks % 90 === 0) checkSim(sim, `${ctx} w${sim.G.wave}`, partySize);

    // progress watchdog: a wave that neither advances nor ends is a hang
    if (sim.G.wave === lastWave) {
      stuckTicks++;
      if (stuckTicks > 30 * 60 * 6) {          // six game-minutes on one wave
        violate(ctx, 'wave made no progress for six minutes',
          `wave ${sim.G.wave}, ${sim.G.enemies.length} enemies, spawning=${sim.G.spawning}, queued=${sim.G.spawnQ.length}`);
        break;
      }
    } else { lastWave = sim.G.wave; stuckTicks = 0; }
  }

  checkSim(sim, `${ctx} final`, partySize);
  const G = sim.G;
  // Hitting the ceiling is only a bug if the run had also STOPPED progressing —
  // the stuck-watchdog above catches that. A 100-wave run that is still
  // clearing waves when the harness runs out of budget is just a long game.
  if (!G.over && ticks >= MAX_TICKS && stuckTicks > 30 * 60 * 3)
    violate(ctx, 'run stalled and never ended', `stuck on wave ${G.wave} for ${(stuckTicks / 30 / 60).toFixed(1)} game-min`);
  else if (!G.over && ticks >= MAX_TICKS)
    console.log(`      (${ctx} was still progressing at wave ${G.wave} when the ${MAX_GAME_MINUTES}-min budget ran out)`);
  if (G.over && G.won && G.wave !== sim.maxWave)
    violate(ctx, 'won on the wrong wave', `${G.wave}`);
  if (G.over && !G.won && G.lives > 0)
    violate(ctx, 'lost with lives remaining', `${G.lives}`);

  return {
    partySize, seed, map: sim.map.name, maxWave: sim.maxWave,
    wave: G.wave, won: G.won, over: G.over, lives: G.lives,
    gold: Array.from({ length: partySize }, (_, i) => Math.round(G.purse[i + 1])).join('/'),
    killed: G.killed, leaked: G.leaked, towers: G.towers.length, bots: G.bots.length,
    score: Array.from({ length: partySize }, (_, i) => G.score[i + 1]),
    minutes: +(ticks / 30 / 60).toFixed(1), sawBoss, sawUltra, peakEnemies, peakBullets,
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const results = [];
const t0 = Date.now();
for (const partySize of [1, 2, 3, 4]) {
  for (let i = 0; i < RUNS; i++) {
    const seed = (1000 + partySize * 97 + i * 7919) >>> 0;
    process.stdout.write(`deep run ${partySize}p seed ${seed}… `);
    const r = runOne(partySize, seed);
    results.push(r);
    console.log(`${r.won ? 'WON ' : r.over ? 'lost' : 'open'} at wave ${r.wave}/${r.maxWave} ` +
                `after ${r.minutes} game-min (${r.killed} kills, ${r.leaked} leaks, ${r.towers} towers)`);
  }
}

console.log('\n═══ deep simulation results ═══════════════════════════════════');
console.log('party seed   map           outcome wave lives gold   kills leak towers bots peakE peakB boss ultra score');
for (const r of results) {
  console.log(
    String(r.partySize).padEnd(6) +
    String(r.seed).padEnd(7) +
    String(r.map).slice(0, 13).padEnd(14) +
    (r.won ? 'WON' : r.over ? 'lost' : 'open').padEnd(8) +
    String(r.wave).padEnd(5) +
    String(r.lives).padEnd(6) +
    String(r.gold).padEnd(16) +
    String(r.killed).padEnd(6) +
    String(r.leaked).padEnd(5) +
    String(r.towers).padEnd(7) +
    String(r.bots).padEnd(5) +
    String(r.peakEnemies).padEnd(6) +
    String(r.peakBullets).padEnd(6) +
    (r.sawBoss ? 'y' : '·').padEnd(5) +
    (r.sawUltra ? 'y' : '·').padEnd(6) +
    JSON.stringify(r.score));
}

const wins = results.filter(r => r.won).length;
console.log(`\n${wins}/${results.length} runs went the distance (50 solo / 100 in a party); ` +
  `${results.filter(r => r.sawBoss).length} met a boss, ${results.filter(r => r.sawUltra).length} met the Ultra Bosses.`);
console.log(`wall clock ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log('\n═══ invariant violations ══════════════════════════════════════');
if (!violations.length) console.log('  none');
else {
  const grouped = {};
  for (const v of violations) (grouped[v.what] ||= []).push(v);
  for (const [what, list] of Object.entries(grouped)) {
    console.log(`  ✗ ${what}  (${list.length}${list.length >= 4 ? '+' : ''})`);
    for (const v of list.slice(0, 3)) console.log(`      ${v.ctx}  ${v.detail || ''}`);
  }
}
process.exit(violations.length ? 1 : 0);
