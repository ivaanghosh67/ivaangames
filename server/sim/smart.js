// Smart Upgrade — spend the next gold piece where it buys the most.
//
// The honest framing first: this is an optimiser, not a neural network. The
// question "which of my ~18 units should take the next upgrade" has a
// well-defined objective, a handful of inputs the simulation already knows
// exactly, and a search space small enough to evaluate exhaustively thirty
// times a second. A learned model would be approximating a function we can
// simply compute — slower, worse, and impossible to explain to the player.
//
// What it DOES do is learn, in the sense that matters here: it measures how
// each unit is actually performing in this run and corrects its own estimate
// with that. Theory says a turret's worth is its damage times how much road it
// covers; reality says the one you tucked behind the keep has dealt nothing in
// forty waves. The measured term is what tells those apart, and it is only
// possible because every unit now banks the damage it deals.
//
// ── the model ─────────────────────────────────────────────────────────────
//
// A turret's value is the damage it expects to land on one enemy walking past:
//
//     value = effectiveDamagePerSecond x timeTheEnemySpendsInRange
//
// Time in range is proportional to the LENGTH OF ROAD the turret covers, which
// is why a sniper on a hairpin is worth several of the same sniper on a
// straight. Ground enemies follow the road and flyers cut across it, so the two
// are measured against their own paths and weighted by what the next wave
// actually sends. A Grenade Launcher is worth nothing against a flyer wave and
// a Flak Cannon is worth nothing against a ground one; the model says so
// rather than being told.
//
// Score is the DIFFERENCE that one level makes, divided by what that level
// costs. Marginal value per gold — never absolute value, or it would pour
// everything into whichever turret is already strongest.

import {
  TOWERS, BOTS, MAXLVL, statsOf, botStats, waveDef, ENEMIES, armorOf, dist,
} from './constants.js';

const isBotUnit = u => !!(u && u.kind);
const defOf = u => (isBotUnit(u) ? BOTS[u.kind] : TOWERS[u.type]);

/**
 * How much road this unit covers, in pixels of path length.
 *
 * This is the term that makes placement matter. Two identical turrets score
 * very differently if one sits on a switchback and the other on a straight,
 * because the enemy is inside the first one's circle for far longer.
 */
const COVER_STEP = 10;                 // px between samples along a path
function roadCovered(pts, x, y, range) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const seg = Math.hypot(dx, dy);
    if (seg <= 0) continue;
    // Sample by DISTANCE, not by vertex. Testing one midpoint per stored
    // segment works for the road, which is finely sampled, but the flight path
    // is two points — one off each edge of the map — so a single midpoint test
    // credited a turret either the entire 960 px crossing or nothing at all,
    // purely on whether it sat near the middle of the map.
    const n = Math.max(1, Math.ceil(seg / COVER_STEP));
    const dl = seg / n;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      if (dist(x, y, a.x + dx * t, a.y + dy * t) <= range) len += dl;
    }
  }
  return len;
}

/**
 * What the next wave is made of, as a split between what walks and what flies,
 * plus the armour it will be wearing. Both change what a turret is worth:
 * armour is subtracted from every non-piercing hit, which quietly guts fast
 * low-damage guns in the late game.
 */
export function threatMix(sim) {
  const G = sim.G;
  const next = Math.min(sim.maxWave, G.wave + (G.waveActive ? 0 : 1));
  // campaignWave, not maxWave: the sim spawns waves against the length of the
  // campaign, and in endless maxWave is the 400-wave backstop instead. Reading
  // the wrong one had Smart Upgrade sizing an endless wave off a curve nothing
  // was ever spawned from.
  const w = waveDef(Math.max(1, next), sim.campaignWave, sim.players, sim.diffKey);
  let air = 0, ground = 0;
  for (const g of w) {
    const e = ENEMIES[g.t];
    if (!e) continue;
    // Weight by health, not headcount: one boss is far more of the wave's
    // total substance than a dozen runners, and it is the thing you actually
    // need the damage for.
    const bulk = g.c * e.hp;
    if (e.fly) air += bulk; else ground += bulk;
  }
  const tot = air + ground;
  return {
    air: tot > 0 ? air / tot : 0,
    ground: tot > 0 ? ground / tot : 1,
    armor: armorOf(0, Math.max(1, next), sim.campaignWave),
  };
}

/** A turret's expected damage to one passing enemy, at a given level. */
function towerValue(sim, t, lvl, mix) {
  const D = TOWERS[t.type];
  if (!D) return 0;
  const s = statsOf(t.type, lvl);

  // Armour is flat damage reduction per hit, so it punishes many small hits far
  // harder than a few big ones. Piercing weapons ignore it entirely, which is
  // most of why a Sniper stays relevant when a Gatling stops being.
  const perHit = D.pierce ? s.dmg : Math.max(1, s.dmg - mix.armor);

  // How many things one shot touches.
  let targets = D.multi || 1;
  if (s.splash > 0) targets *= 1 + s.splash / 50;   // splash catches the group
  if (D.line) targets *= 4;                          // railgun spears a column
  if (D.melee) targets *= 3;                         // sweeps everything adjacent

  let dps = perHit * s.rate * targets;
  if (D.spinup) dps *= 0.75;      // a gatling spends its first shots winding up
  if (D.slow || s.slow) dps *= 1 + (s.slow || 0);   // slowing helps every gun

  const canGround = !D.noGround;
  const canAir = !!D.air;
  const gCov = canGround ? roadCovered(sim.map.path, t.x, t.y, s.range) : 0;
  const aCov = canAir ? roadCovered(sim.map.airpath, t.x, t.y, s.range) : 0;

  // Expected damage delivered = dps x road covered, split by what is coming.
  // Divided by 100 only to keep the numbers readable in logs.
  return dps * (mix.ground * gCov + mix.air * aCov) / 100;
}

/** A bot's value, which is a different job for each of the four. */
function botValue(sim, b, lvl, mix) {
  const D = BOTS[b.kind];
  if (!D) return 0;
  const s = botStats(b.kind, lvl);

  if (D.heal > 0) {
    // A medic is worth what it keeps alive, so it scales with how many bots
    // there are to patch — and is close to worthless as the only one.
    const mates = sim.G.bots.filter(o => o.owner === b.owner && o !== b).length;
    return s.heal * s.rate * Math.min(4, mates) * 0.8;
  }
  if (D.crew) {
    // A Gun Crew is worth 35% of whatever it is standing next to, so its value
    // is entirely a function of the turrets in range — upgrading it is only
    // worth it if it is actually near your good guns.
    let near = 0;
    for (const t of sim.G.towers) {
      if (t.owner !== b.owner) continue;
      if (dist(b.x, b.y, t.x, t.y) > s.range) continue;
      near += towerValue(sim, t, t.lvl, mix);
    }
    return near * (D.buff || 0.35);
  }

  const perHit = Math.max(1, s.dmg - (D.air ? 0 : mix.armor));
  let v = perHit * s.rate * (D.air ? 1 : mix.ground);
  if (D.block) {
    // A blocking bot's real contribution is the time it buys, which is its
    // health divided by how hard the wave hits back. That is why blade bots
    // stop being walls in the late game: e.dps has grown and their hp has not.
    const incoming = Math.max(1, ENEMIES.boss.dps * (sim.G.wave > 10 ? 1 : 0.4));
    v += s.hp / incoming * 12;
  }
  return v;
}

export function unitValue(sim, u, lvl, mix) {
  return isBotUnit(u) ? botValue(sim, u, lvl, mix) : towerValue(sim, u, lvl, mix);
}

/**
 * The single upgrade this seat should buy next, or null if none is worth it.
 *
 * Exhaustive over the seat's own units — there are at most a couple of dozen,
 * so there is no reason to be clever about the search.
 */
export function bestUpgrade(sim, seat) {
  const G = sim.G;
  const purse = G.purse[seat] || 0;
  if (!(purse > 0)) return null;

  const mine = [];
  for (const t of G.towers) if (t.owner === seat && t.lvl < MAXLVL) mine.push(t);
  for (const b of G.bots) if (b.owner === seat && b.lvl < MAXLVL) mine.push(b);
  if (!mine.length) return null;

  const mix = threatMix(sim);

  // How each unit is ACTUALLY doing, in damage per gold sunk into it. This is
  // the correction the theory cannot supply: it knows a turret's range and
  // rate, but not that you put it somewhere nothing walks past.
  let effSum = 0, effN = 0;
  const eff = new Map();
  for (const u of mine) {
    const e = (u.dmgDone || 0) / Math.max(1, u.spent);
    eff.set(u, e);
    if (u.dmgDone > 0) { effSum += e; effN++; }
  }
  const effAvg = effN > 0 ? effSum / effN : 0;

  let best = null, bestScore = 0;
  for (const u of mine) {
    const cost = sim.upCost(u);
    if (cost > purse) continue;
    const gain = unitValue(sim, u, u.lvl + 1, mix) - unitValue(sim, u, u.lvl, mix);
    if (!(gain > 0)) continue;
    let score = gain / cost;
    // Blend measured performance in at half weight, clamped so one lucky
    // turret cannot monopolise the budget and a cold start (everything at
    // zero damage) leaves the theoretical ranking untouched.
    if (effAvg > 0) {
      score *= 0.5 + 0.5 * Math.min(2, (eff.get(u) || 0) / effAvg);
    }
    if (score > bestScore) { bestScore = score; best = u; }
  }
  return best;
}
