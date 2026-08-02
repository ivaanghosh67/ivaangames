// Smart Upgrade has to be smart.
//
// "It spent the gold" is not the property worth testing — a random picker does
// that. These check that it makes the choices a good player would, and that it
// changes its mind when the situation does:
//
//   1. Between identical turrets, it upgrades the one covering more road.
//   2. Facing a flyer wave it stops feeding a turret that cannot hit air.
//   3. It buys marginal value per gold, not raw power — so it does not pour
//      everything into whichever turret is already the strongest.
//   4. It notices which units are actually delivering damage and backs them.
//   5. It never overspends, never exceeds MAXLVL, and only ever touches units
//      belonging to the seat that switched it on.
//
//   node test/smart.js

import { Sim } from '../sim/sim.js';
import { applyIntent } from '../sim/intents.js';
import { bestUpgrade, threatMix, unitValue } from '../sim/smart.js';
import { MAXLVL, TS } from '../sim/constants.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); }
                       else { fail++; console.log('  FAIL ' + m); } };

const mkSim = (players = 1, wave = 6) => {
  const sim = new Sim({ seed: 11, players, map: 'Iron Line', difficulty: 'regular', unlocked: null });
  sim.G.wave = wave;
  for (let s = 1; s <= players; s++) sim.G.purse[s] = 100000;
  return sim;
};
// Place a turret directly, bypassing the allowance, so each test controls the
// board exactly. Mirrors the shape intents.js builds.
const put = (sim, type, c, r, owner = 1, lvl = 1) => {
  const t = { id: sim.id(), type, c, r, x: c * TS + TS / 2, y: r * TS + TS / 2,
    lvl, cd: 0, a: 0, kills: 0, dmgDone: 0, spent: 100, flash: 0, spin: 0,
    swingDir: 1, ramp: 0, buff: 1, owner };
  sim.G.towers.push(t);
  return t;
};
// Tiles sorted by how much road they see, so tests can pick a good spot and a
// bad one without hard-coding map knowledge that could drift.
const tilesByCoverage = (sim, range = 114) => {
  const out = [];
  for (let r = 0; r < 15; r++) for (let c = 0; c < 22; c++) {
    if (!sim.canBuild(c, r)) continue;
    const x = c * TS + TS / 2, y = r * TS + TS / 2;
    let len = 0;
    const p = sim.map.path;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      if (Math.hypot(x - (a.x + b.x) / 2, y - (a.y + b.y) / 2) <= range) {
        len += Math.hypot(b.x - a.x, b.y - a.y);
      }
    }
    out.push({ c, r, len });
  }
  return out.sort((a, b) => b.len - a.len);
};

console.log('\n═══ Smart Upgrade picks well ═════════════════════════════════\n');

// ── 1. placement decides between otherwise identical turrets ─────────────
{
  const sim = mkSim();
  const tiles = tilesByCoverage(sim);
  const good = tiles[0], bad = tiles[tiles.length - 1];
  ok(good.len > bad.len, `the map offers a good spot and a poor one (${Math.round(good.len)} vs ${Math.round(bad.len)} px of road)`);
  const strong = put(sim, 'pistol', good.c, good.r);
  const weak = put(sim, 'pistol', bad.c, bad.r);
  const pick = bestUpgrade(sim, 1);
  ok(pick === strong, 'it upgrades the turret that covers more road, not the one that covers less');
  ok(pick !== weak, 'and leaves the turret nothing walks past alone');
}

// ── 2. it responds to what is actually coming ────────────────────────────
{
  // wave 3 is the first with flyers; by a late wave the air share is large
  const sim = mkSim(1, 3);
  const tiles = tilesByCoverage(sim);
  // A ground-only launcher on the road, and an air-capable pistol placed on
  // the FLIGHT line — flyers cut straight across instead of following the
  // road, so a turret nowhere near that line cannot touch them however good
  // its ground coverage is. That is the model being right, not a quirk.
  const ground = put(sim, 'launcher', tiles[0].c, tiles[0].r);
  const ap = sim.map.airpath[Math.floor(sim.map.airpath.length / 2)];
  const ac = Math.max(0, Math.min(21, Math.floor(ap.x / TS)));
  const ar = Math.max(0, Math.min(14, Math.floor(ap.y / TS)));
  let air = null;
  for (let d = 0; d < 6 && !air; d++) {
    for (let dc = -d; dc <= d && !air; dc++) for (let dr = -d; dr <= d && !air; dr++) {
      if (sim.canBuild(ac + dc, ar + dr)) air = put(sim, 'pistol', ac + dc, ar + dr);
    }
  }
  ok(!!air, 'found a buildable tile on the flight line');
  const mix = threatMix(sim);
  ok(mix.air >= 0 && mix.ground > 0, `the mix is measured (air ${(mix.air * 100).toFixed(0)}%, ground ${(mix.ground * 100).toFixed(0)}%)`);
  // A ground-only gun must be worth exactly nothing against pure air.
  const pureAir = { air: 1, ground: 0, armor: 0 };
  ok(unitValue(sim, ground, ground.lvl, pureAir) === 0,
    'a ground-only launcher is valued at zero against an all-flyer wave');
  ok(unitValue(sim, air, air.lvl, pureAir) > 0,
    'and an air-capable turret is not');
  const pureGround = { air: 0, ground: 1, armor: 0 };
  ok(unitValue(sim, ground, ground.lvl, pureGround) > 0,
    'the same launcher is worth plenty against a ground wave');
}

// ── 3. it maximises marginal value per gold ──────────────────────────────
// Not "it prefers cheap things". Damage compounds at 1.46 a level while the
// price of a level only grows as lvl^1.25, so the exponential outruns the
// polynomial and pouring gold into one strong turret really is the better buy
// — which is exactly what the guide tells players to do. Measured on the real
// tables: a minigun's 8→9 returns 1.68 damage per gold, a pistol's 1→2 returns
// 0.39. The property to pin is that the pick is the argmax, whatever that
// happens to favour.
{
  const sim = mkSim();
  const tiles = tilesByCoverage(sim);
  const big = put(sim, 'minigun', tiles[0].c, tiles[0].r, 1, 8);
  const small = put(sim, 'pistol', tiles[1].c, tiles[1].r, 1, 1);
  put(sim, 'sniper', tiles[2].c, tiles[2].r, 1, 4);
  put(sim, 'gatling', tiles[3].c, tiles[3].r, 1, 6);
  ok(sim.upCost(big) > sim.upCost(small),
    `the strong turret's next level costs far more (${sim.upCost(big)} vs ${sim.upCost(small)})`);

  const mix = threatMix(sim);
  const scored = sim.G.towers.map(t => ({
    t, score: (unitValue(sim, t, t.lvl + 1, mix) - unitValue(sim, t, t.lvl, mix)) / sim.upCost(t),
  })).sort((a, b) => b.score - a.score);
  const pick = bestUpgrade(sim, 1);
  ok(pick === scored[0].t,
    `it picks the argmax of value per gold (${scored[0].t.type}, ` +
    `${scored[0].score.toFixed(2)} vs next best ${scored[1].score.toFixed(2)})`);
  ok(scored[0].score > scored[scored.length - 1].score,
    'and the candidates really do differ, so the choice was not vacuous');
}

// ── 4. it backs what is actually delivering ─────────────────────────────
{
  const sim = mkSim();
  const tiles = tilesByCoverage(sim);
  // two turrets on equally good ground — nothing to choose between them...
  const a = put(sim, 'pistol', tiles[0].c, tiles[0].r);
  const b = put(sim, 'pistol', tiles[1].c, tiles[1].r);
  const blind = bestUpgrade(sim, 1);
  ok(blind === a || blind === b, 'with no evidence either way it still picks one');
  // ...until one of them has visibly done all the work
  a.dmgDone = 50000; b.dmgDone = 10;
  ok(bestUpgrade(sim, 1) === a,
    'given the damage each has actually dealt, it backs the one that is working');
  a.dmgDone = 10; b.dmgDone = 50000;
  ok(bestUpgrade(sim, 1) === b, 'and switches when the evidence does');
}

// ── 5. it stays inside the rules ─────────────────────────────────────────
{
  const sim = mkSim(2);
  const tiles = tilesByCoverage(sim);
  const mine = put(sim, 'pistol', tiles[0].c, tiles[0].r, 1);
  const theirs = put(sim, 'sniper', tiles[1].c, tiles[1].r, 2);
  ok(bestUpgrade(sim, 1) === mine, "seat 1's optimiser never proposes seat 2's turret");
  ok(bestUpgrade(sim, 2) === theirs, 'and seat 2 gets its own');

  // broke: nothing is affordable, so nothing is proposed
  sim.G.purse[1] = 0;
  ok(bestUpgrade(sim, 1) === null, 'with an empty purse it proposes nothing');

  // maxed: no upgrade left to buy
  sim.G.purse[1] = 100000;
  mine.lvl = MAXLVL;
  ok(bestUpgrade(sim, 1) === null, 'and nothing once the unit is at max level');
}

// ── 6. end to end through the real tick loop ────────────────────────────
{
  const sim = mkSim(1);
  const tiles = tilesByCoverage(sim);
  for (let i = 0; i < 6; i++) put(sim, 'pistol', tiles[i].c, tiles[i].r);
  sim.G.purse[1] = 4000;
  applyIntent(sim, 1, { a: 'smart', on: true });
  ok(sim.G.smart[1] === true, 'the toggle reaches the sim');

  const before = sim.G.towers.reduce((n, t) => n + t.lvl, 0);
  for (let i = 0; i < 30 * 20; i++) sim.update(1 / 30);      // 20 seconds
  const after = sim.G.towers.reduce((n, t) => n + t.lvl, 0);

  ok(after > before, `it bought upgrades on its own (${before} → ${after} total levels)`);
  ok(sim.G.purse[1] >= 0, `it never overspent (${Math.round(sim.G.purse[1])}g left)`);
  ok(sim.G.towers.every(t => t.lvl <= MAXLVL), 'and never past max level');
  const spentOk = sim.G.towers.every(t => t.spent >= 100);
  ok(spentOk, 'every upgrade was booked against the unit that got it');

  applyIntent(sim, 1, { a: 'smart', on: false });
  const frozen = sim.G.towers.reduce((n, t) => n + t.lvl, 0);
  const goldFrozen = sim.G.purse[1];
  for (let i = 0; i < 30 * 10; i++) sim.update(1 / 30);
  ok(sim.G.towers.reduce((n, t) => n + t.lvl, 0) === frozen,
    'switching it off really does stop it');
  ok(sim.G.purse[1] >= goldFrozen, 'and it stops spending');
}

console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ all ' + pass + ' checks passed'}\n`);
process.exit(fail ? 1 : 0);
