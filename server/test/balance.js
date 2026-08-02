// Balance probe: measures WHY the game is easy, rather than guessing.
//
// For each wave it computes the two numbers that actually decide whether a
// wave is a threat:
//
//   THREAT  total effective health arriving that wave (health + armour soak)
//   POWER   total damage per second the defence can actually apply
//
// POWER/THREAT is the headroom ratio. Around 1 a wave is a real fight; at 3+
// the wave is a formality. Tracking it wave by wave shows exactly where the
// curve goes slack — and comparing party sizes shows whether co-op income
// outruns co-op difficulty.
//
//   node test/balance.js [partySizes] [maxWave]

import { Sim } from '../sim/sim.js';
import { applyIntent } from '../sim/intents.js';
import {
  TOWERS, BOTS, TKEYS, BKEYS, COLS, ROWS, MAXLVL,
  waveDef, hpScale, bossHp, armorOf, statsOf, botStats, ENEMIES, kitOf,
  diffOf, bossRamp, DKEYS,
} from '../sim/constants.js';

const PARTIES = (process.argv[2] || '1,2,4').split(',').map(Number);
const MAXW = +(process.argv[3] || 40);
const DIFF = process.argv[4] || 'regular';
const TRACE = +(process.argv[5] || 0);   // party size to trace wave by wave
const DT = 1 / 30;

function rngFor(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/** Effective health of one wave, counting armour as damage soaked per hit. */
function waveThreat(n, maxWave, players, diffKey) {
  const D = diffOf(diffKey);
  let hp = 0, count = 0;
  for (const g of waveDef(n, maxWave, players, diffKey)) {
    const base = ENEMIES[g.t];
    const each = (g.t === 'ultra' ? bossHp(n) * 4.5
               : g.t === 'boss' ? bossHp(n) * bossRamp(n)
               : base.hp * hpScale(n)) * D.hp;
    hp += each * g.c;
    count += g.c;
  }
  return { hp, count, armour: armorOf(0, n) };
}

/** What the defence can actually put out, allowing for armour and air cover. */
function defencePower(sim) {
  const G = sim.G;
  let dps = 0, airDps = 0;
  const armour = armorOf(0, Math.max(1, G.wave));
  for (const t of G.towers) {
    const B = TOWERS[t.type], s = statsOf(t.type, t.lvl);
    // crew buff
    let buff = 1;
    for (const b of G.bots) {
      const D = BOTS[b.kind];
      if (b.dead || !D.buff) continue;
      buff = Math.max(buff, 1 + D.buff * (1 + (b.lvl - 1) * .12));
    }
    const perHit = B.pierce ? s.dmg : Math.max(1, s.dmg - armour);
    // melee and splash hit several things at once; count a modest multiplier
    const spread = B.melee ? 3 : s.splash > 0 ? 2.5 : (B.multi || 1);
    const d = perHit * s.rate * buff * spread;
    dps += d;
    if (B.air) airDps += d;
  }
  for (const b of G.bots) {
    if (b.dead) continue;
    const D = BOTS[b.kind], s = botStats(b.kind, b.lvl);
    if (D.heal > 0) continue;
    const perHit = Math.max(1, s.dmg - armour);
    const d = perHit * s.rate * (D.range <= 40 ? 3 : 1);
    dps += d;
    if (D.air) airDps += d;
  }
  return { dps, airDps };
}

// A deliberately COMPETENT player: builds near the road, keeps air cover,
// upgrades hard, and calls waves early whenever it is comfortable. This is the
// player we should be balancing against, not a flailing one.
function makeGoodPlayer(sim, seat, partySize, rnd) {
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

    if (G.lives < 10 && gold > 300) {
      applyIntent(sim, seat, { a: 'heal', k: 'medkit' }); return;
    }
    // keep a floor of turrets, with air cover, then pour everything into levels
    const want = 6 + Math.floor(G.wave / 3);
    if (mine.length < want) {
      // prefer air-capable when short on anti-air
      const pool = (air < Math.max(2, mine.length / 3))
        ? towers.filter(k => TOWERS[k].air) : towers;
      const afford = pool.filter(k => TOWERS[k].cost <= gold)
        .sort((a, b) => TOWERS[b].cost - TOWERS[a].cost);
      for (const k of afford) {
        for (let i = 0; i < 40; i++) {
          const s = spots[Math.floor(rnd() * Math.min(spots.length, 70))];
          if (sim.canBuild(s.c, s.r)) { applyIntent(sim, seat, { a: 'build', k, c: s.c, r: s.r }); return; }
        }
      }
    }
    const up = mine.filter(u => u.lvl < MAXLVL).sort((a, b) => a.lvl - b.lvl);
    if (up.length && sim.upCost(up[0]) <= gold) {
      applyIntent(sim, seat, { a: 'upgrade', id: up[0].id }); return;
    }
    if (!G.waveActive && G.lives >= 15) applyIntent(sim, seat, { a: 'wave' });
  };
}

console.log(`POWER/THREAT headroom  —  difficulty: ${diffOf(DIFF).name}`);
console.log('  ~1.0 a real fight · 2.0 comfortable · 3.0+ the wave is a formality\n');

const rows = {};
for (const party of PARTIES) {
  const sim = new Sim({ seed: 4242, players: party, map: 'Iron Line', difficulty: DIFF });
  const rnd = rngFor(99);
  const acts = [];
  for (let s = 1; s <= party; s++) acts.push(makeGoodPlayer(sim, s, party, rnd));
  const series = [];
  let ticks = 0, lastWave = 0;

  while (ticks < 30 * 60 * 120 && !sim.G.over && sim.G.wave <= MAXW) {
    sim.update(DT); sim.drainEvents(); ticks++;
    if (ticks % 6 === 0) for (const a of acts) a();
    if (sim.G.wave !== lastWave && sim.G.wave > 0) {
      lastWave = sim.G.wave;
      const th = waveThreat(sim.G.wave, sim.maxWave, party, DIFF);
      const pw = defencePower(sim);
      // a wave lasts roughly its spawn spread; 25 s is a fair working figure
      const applied = pw.dps * 25;
      if (TRACE && party === TRACE) {
        const wd = waveDef(sim.G.wave, sim.maxWave, party, DIFF);
        const n = wd.reduce((a, g) => a + g.c, 0);
        const span = Math.max(...wd.map(g => g.c * g.g));
        console.log(`   w${String(sim.G.wave).padStart(2)}  ${String(n).padStart(4)} enemies` +
          ` over ${span.toFixed(0).padStart(3)}s   lives ${String(sim.G.lives).padStart(3)}` +
          `   leaked ${String(sim.G.leaked).padStart(3)}   gold ${String(Math.round(Object.values(sim.G.purse).slice(0,party).reduce((a,b)=>a+b,0))).padStart(5)}` +
          `   towers ${String(sim.G.towers.length).padStart(3)}` +
          `   avgLvl ${(sim.G.towers.reduce((a,t)=>a+t.lvl,0)/Math.max(1,sim.G.towers.length)).toFixed(1)}`);
      }
      series.push({
        w: sim.G.wave,
        ratio: applied / th.hp,
        gold: Math.round(Object.values(sim.G.purse).slice(0, party).reduce((a, b) => a + b, 0)),
        towers: sim.G.towers.length,
        avgLvl: +(sim.G.towers.reduce((a, t) => a + t.lvl, 0) / Math.max(1, sim.G.towers.length)).toFixed(1),
        lives: sim.G.lives,
      });
    }
  }
  rows[party] = { series, over: sim.G.over, wave: sim.G.wave, lives: sim.G.lives };
}

const marks = [1, 5, 10, 15, 20, 25, 30, 35, 40].filter(w => w <= MAXW);
console.log('wave   ' + PARTIES.map(p => `${p}p headroom  ${p}p gold`).join('   '));
for (const w of marks) {
  let line = String(w).padEnd(7);
  for (const p of PARTIES) {
    const r = rows[p].series.find(x => x.w === w);
    line += (r ? r.ratio.toFixed(1).padStart(11) : '     —'.padStart(11));
    line += (r ? String(r.gold).padStart(10) : '     —'.padStart(10));
    line += '   ';
  }
  console.log(line);
}
console.log();
for (const p of PARTIES) {
  const r = rows[p];
  const s = r.series;
  const mid = s.filter(x => x.w >= 10 && x.w <= 25);
  const avg = mid.length ? mid.reduce((a, x) => a + x.ratio, 0) / mid.length : 0;
  console.log(`${p} player(s): reached wave ${r.wave}${r.over ? ' (lost)' : ''}, ` +
    `${r.lives} lives left, mean headroom waves 10-25 = ${avg.toFixed(1)}×`);
}
console.log('\nIncome comparison at wave 20 (total gold banked across the party):');
for (const p of PARTIES) {
  const r = rows[p].series.find(x => x.w === 20);
  if (r) console.log(`  ${p}p  ${String(r.gold).padStart(7)} gold   ${r.towers} towers at avg level ${r.avgLvl}`);
}
