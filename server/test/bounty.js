// Gold follows the damage.
//
// Last-hit attribution is arbitrary and it shows: a turret can grind a boss
// down to a sliver and earn nothing because somebody else's shot happened to
// land on the final tick. Worse, it rewards the wrong thing — a fast cheap gun
// snipes bounties off the heavy hitter standing beside it.
//
// These check the properties that actually matter, on the real sim rather than
// on a reimplementation of the formula:
//
//   1. Shares track damage, not who fired last.
//   2. Overkill does not count. A railgun finishing a grunt on 10 hp must not
//      book its full 1,200 and walk off with the bounty.
//   3. Not one gold piece is minted or destroyed by the rounding.
//   4. Damage nobody owns (the rampart guards) still pays the whole room.
//
//   node test/bounty.js

import { Sim } from '../sim/sim.js';
import { ENEMIES } from '../sim/constants.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); }
                       else { fail++; console.log('  FAIL ' + m); } };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (${a} vs ${b} ±${tol})`);

const mkSim = (players = 2) => {
  const sim = new Sim({ seed: 7, players, map: 'Iron Line', difficulty: 'regular', unlocked: null });
  sim.G.wave = 1;
  for (let s = 1; s <= players; s++) sim.G.purse[s] = 0;
  return sim;
};
// A stand-in for a turret: all hurt() cares about is `owner`.
const gun = owner => ({ owner, kills: 0, dmgDone: 0 });
const spawnOne = (sim, type = 'grunt') => {
  sim.spawn(type);
  return sim.G.enemies[sim.G.enemies.length - 1];
};
const purses = sim => [1, 2, 3, 4].slice(0, sim.players).map(s => sim.G.purse[s]);

console.log('\n═══ bounties follow the damage ═══════════════════════════════\n');

// ── 1. a 90/10 split pays 90/10, whoever lands the last hit ───────────────
{
  const sim = mkSim(2);
  const e = spawnOne(sim);
  const hp = e.hp;
  // seat 1 does 90% of the work; seat 2 lands the killing blow
  sim.hurt(e, hp * 0.9, true, gun(1));
  ok(sim.G.enemies.includes(e), 'the enemy survived the first 90%');
  sim.hurt(e, hp * 0.5, true, gun(2));       // overkills the last 10%
  const [p1, p2] = purses(sim);
  const total = p1 + p2;
  ok(total > 0, `a bounty was paid (${total})`);
  near(p1 / total, 0.9, 0.02, 'seat 1 took ~90% despite not landing the kill');
  near(p2 / total, 0.1, 0.02, 'seat 2 took ~10% despite landing it');
}

// ── 2. overkill is not damage ─────────────────────────────────────────────
{
  const sim = mkSim(2);
  const e = spawnOne(sim);
  const hp = e.hp;
  sim.hurt(e, hp * 0.5, true, gun(1));
  sim.hurt(e, hp * 100, true, gun(2));        // an absurd finishing blow
  const [p1, p2] = purses(sim);
  near(p1 / (p1 + p2), 0.5, 0.02,
    'a 100x overkill still only counts the half that was left');
  ok(e.dmgTot <= hp + 0.001, `recorded damage never exceeds the enemy's health (${e.dmgTot.toFixed(1)} ≤ ${hp.toFixed(1)})`);
}

// ── 3. rounding neither mints nor destroys gold ───────────────────────────
{
  // Awkward splits across every party size, many times over — if the
  // largest-remainder is wrong this drifts almost immediately.
  for (const players of [1, 2, 3, 4]) {
    const sim = mkSim(players);
    let paidOut = 0, dropped = 0;
    const realCredit = sim.payout.bind(sim);
    sim.payout = (e, drop, jack) => { dropped += drop; const o = realCredit(e, drop, jack); return o; };
    for (let i = 0; i < 400; i++) {
      const e = spawnOne(sim, i % 7 === 0 ? 'tank' : 'grunt');
      const hp = e.hp;
      // uneven, deliberately un-round shares
      let left = hp;
      for (let s = 1; s <= players; s++) {
        const cut = s === players ? left : hp * (0.13 * s + 0.07);
        const d = Math.min(left, cut);
        left -= d;
        sim.hurt(e, d, true, gun(s));
        if (!sim.G.enemies.includes(e)) break;
      }
      if (sim.G.enemies.includes(e)) sim.hurt(e, left + 1, true, gun(1));
    }
    paidOut = purses(sim).reduce((a, b) => a + b, 0);
    ok(paidOut === dropped,
      `${players}p: every gold piece landed in a purse (paid ${paidOut}, dropped ${dropped})`);
    ok(purses(sim).every(Number.isInteger), `${players}p: purses stayed whole numbers`);
  }
}

// ── 4. damage nobody owns still pays the room ─────────────────────────────
{
  const sim = mkSim(3);
  const e = spawnOne(sim);
  const keep = { };                            // the rampart guards own nothing
  sim.hurt(e, e.hp * 5, true, keep);
  const p = purses(sim);
  const total = p.reduce((a, b) => a + b, 0);
  ok(total > 0, `a guard kill still pays (${total})`);
  ok(Math.max(...p) - Math.min(...p) <= 1,
    `and splits it evenly across the room [${p.join(', ')}]`);
}

// ── 5. a mixed kill splits owned and unowned damage correctly ─────────────
{
  const sim = mkSim(2);
  const e = spawnOne(sim);
  const hp = e.hp;
  sim.hurt(e, hp * 0.5, true, gun(1));         // seat 1: half
  sim.hurt(e, hp * 0.5, true, {});             // guards: half, shared 25/25
  const [p1, p2] = purses(sim);
  const total = p1 + p2;
  near(p1 / total, 0.75, 0.02, 'seat 1 gets its own half plus its share of the guards\'');
  near(p2 / total, 0.25, 0.02, 'seat 2 gets only its share of the guards\'');
}

// ── 6. the scoreboard and quests follow damage, not the last hit ──────────
{
  const sim = mkSim(2);
  const e = spawnOne(sim, 'flyer');
  const hp = e.hp;
  sim.hurt(e, hp * 0.95, true, gun(1));
  sim.hurt(e, hp * 9, true, gun(2));           // seat 2 lands it, contributes 5%
  ok(sim.G.score[1] === 1 && sim.G.score[2] === 0,
    `the kill is scored to the seat that did the work (${sim.G.score[1]}/${sim.G.score[2]})`);
  ok(sim.G.quest[1].flyerKills === 1 && sim.G.quest[2].flyerKills === 0,
    'and so is quest progress');
}

// ── 7. per-unit damage is recorded for analytics ──────────────────────────
{
  const sim = mkSim(1);
  const e = spawnOne(sim);
  const g = gun(1);
  sim.hurt(e, e.hp * 0.4, true, g);
  const after = g.dmgDone;
  sim.hurt(e, e.hp * 50, true, g);
  ok(after > 0, `a unit banks the damage it deals (${after.toFixed(0)})`);
  ok(g.dmgDone > after && g.dmgDone <= e.maxhp + 0.001,
    `and never more than the enemy had (${g.dmgDone.toFixed(0)} ≤ ${e.maxhp.toFixed(0)})`);
  ok(g.kills === 1, 'a unit\'s own kill count still counts killing blows');
}

console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ all ' + pass + ' checks passed'}\n`);
process.exit(fail ? 1 : 0);
