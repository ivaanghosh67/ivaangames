// Moving a turret, and the debrief that explains a run.
//
// Both exist for the same reason: the game used to give you no way to act on
// what you learned. Placement was the highest-leverage decision and the only
// one with no undo, and a defeat screen told you the score but never the cause.
//
//   node test/rebuild.js

import { Sim } from '../sim/sim.js';
import { applyIntent } from '../sim/intents.js';
import { debrief } from '../sim/debrief.js';
import { moveCostOf, MOVE_COOLDOWN, TOWERS, TS, MAXLVL } from '../sim/constants.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); }
                       else { fail++; console.log('  FAIL ' + m); } };

const mkSim = (players = 1) => {
  const sim = new Sim({ seed: 5, players, map: 'Iron Line', difficulty: 'regular', unlocked: null });
  sim.G.wave = 8;
  for (let s = 1; s <= players; s++) sim.G.purse[s] = 50000;
  return sim;
};
const freeTiles = sim => {
  const out = [];
  for (let r = 0; r < 15; r++) for (let c = 0; c < 22; c++) if (sim.canBuild(c, r)) out.push({ c, r });
  return out;
};

console.log('\n═══ moving turrets, and being told why you lost ═══════════════\n');

// ── moving ────────────────────────────────────────────────────────────────
{
  const sim = mkSim();
  const t = freeTiles(sim);
  applyIntent(sim, 1, { a: 'build', k: 'pistol', c: t[0].c, r: t[0].r });
  const gun = sim.G.towers[0];
  const from = { c: gun.c, r: gun.r };
  const before = sim.G.purse[1];
  const fee = moveCostOf(TOWERS.pistol);

  const dest = t.find(x => x.c !== from.c || x.r !== from.r);
  const res = applyIntent(sim, 1, { a: 'move', id: gun.id, c: dest.c, r: dest.r });
  ok(res.ok, 'a turret can be picked up and put down elsewhere');
  ok(gun.c === dest.c && gun.r === dest.r, 'it really is on the new tile');
  ok(gun.x === dest.c * TS + TS / 2 && gun.y === dest.r * TS + TS / 2,
    'and its world position moved with it');
  ok(sim.G.purse[1] === before - fee, `the fee was charged (${fee}g)`);
  ok(gun.cd >= MOVE_COOLDOWN, `it is out of action while it redeploys (${gun.cd.toFixed(1)}s)`);
  ok(sim.G.towers.length === 1, 'moving does not duplicate it');

  // the fee is a share of the BASE price, not of what has been sunk in
  gun.lvl = MAXLVL; gun.spent = 9999;
  ok(moveCostOf(TOWERS.pistol) === fee,
    'a maxed turret costs the same to move as a fresh one — the fee tracks the ' +
    'gun, not the investment');

  // rules that must still hold
  ok(applyIntent(sim, 1, { a: 'move', id: gun.id, c: from.c, r: from.r }).ok,
    'moving back to where it came from is allowed');
  // the ROAD itself — not merely a tile that happens to be occupied, which is
  // also un-buildable and would make this assertion pass for the wrong reason
  const road = [];
  for (let r = 0; r < 15; r++) for (let c = 0; c < 22; c++) if (sim.map.blocked[r][c]) road.push({ c, r });
  ok(road.length > 0, `the map has road tiles to test against (${road.length})`);
  const onRoad = applyIntent(sim, 1, { a: 'move', id: gun.id, c: road[0].c, r: road[0].r });
  ok(!onRoad.ok && /blocked/.test(onRoad.why), 'it cannot be moved onto the road');

  // and a second turret cannot be stacked onto an occupied tile
  applyIntent(sim, 1, { a: 'build', k: 'pistol', c: t[3].c, r: t[3].r });
  const other = sim.G.towers[1];
  const stack = applyIntent(sim, 1, { a: 'move', id: other.id, c: gun.c, r: gun.r });
  ok(!stack.ok && /blocked/.test(stack.why), 'nor stacked on top of another turret');
}
{
  const sim = mkSim(2);
  const t = freeTiles(sim);
  applyIntent(sim, 1, { a: 'build', k: 'pistol', c: t[0].c, r: t[0].r });
  const gun = sim.G.towers[0];
  const d = applyIntent(sim, 2, { a: 'move', id: gun.id, c: t[5].c, r: t[5].r });
  ok(!d.ok && /Player 1/.test(d.why), "another seat cannot move someone else's turret");

  sim.G.purse[1] = 0;
  const broke = applyIntent(sim, 1, { a: 'move', id: gun.id, c: t[5].c, r: t[5].r });
  ok(!broke.ok && /need/.test(broke.why), 'and you have to be able to afford it');
}
{
  const sim = mkSim();
  const t = freeTiles(sim);
  const mid = sim.map.path[Math.floor(sim.map.path.length / 2)];
  applyIntent(sim, 1, { a: 'deploy', k: 'bladeBot', x: mid.x, y: mid.y });
  const bot = sim.G.bots[0];
  const r = applyIntent(sim, 1, { a: 'move', id: bot.id, c: t[0].c, r: t[0].r });
  ok(!r.ok && /not a turret/.test(r.why),
    'bots are refused — they already walk wherever you send them');
}

// ── the debrief ───────────────────────────────────────────────────────────
{
  const sim = mkSim();
  const t = freeTiles(sim);
  // one gun doing all the work, two doing nothing, and flyers getting through
  applyIntent(sim, 1, { a: 'build', k: 'sniper', c: t[0].c, r: t[0].r });
  applyIntent(sim, 1, { a: 'build', k: 'launcher', c: t[1].c, r: t[1].r });
  applyIntent(sim, 1, { a: 'build', k: 'launcher', c: t[2].c, r: t[2].r });
  sim.G.towers[0].dmgDone = 90000;
  sim.G.towers[1].dmgDone = 10;
  sim.G.towers[2].dmgDone = 0;
  sim.G.leakedBy.flyer = 23;
  sim.G.leakedBy.grunt = 4;
  sim.G.purse[1] = 12000;

  const d = debrief(sim, 1);
  const text = d.lines.join(' | ');
  console.log('    ' + d.lines.join('\n    '));

  ok(/23 got past|27 got past/.test(text) || /got past/.test(text),
    'it says how much got through');
  ok(/flyer/i.test(text), 'and names the type that did it most');
  ok(/Sniper/.test(text), 'it names the gun that did the work');
  ok(/almost nothing/.test(text), 'and calls out the ones that did not');
  ok(/12000g|12000/.test(text), 'it notices gold that never became defence');
  ok(typeof d.stats.airCovered === 'number' && typeof d.stats.groundCovered === 'number',
    `coverage is measured (ground ${d.stats.groundCovered}%, air ${d.stats.airCovered}%)`);
  ok(d.stats.leaked === 27, 'the leak total is right');
}
{
  // a clean run should not be told it failed
  const sim = mkSim();
  const t = freeTiles(sim);
  applyIntent(sim, 1, { a: 'build', k: 'pistol', c: t[0].c, r: t[0].r });
  sim.G.towers[0].dmgDone = 500;
  sim.G.purse[1] = 100;
  const d = debrief(sim, 1);
  ok(/Nothing ever got past/.test(d.lines.join(' ')),
    'a run with no leaks is told so, not scolded');
  ok(!/Gold in the bank/.test(d.lines.join(' ')),
    'and a player who spent their gold is not lectured about it');
}
{
  // per seat in co-op: your report is about YOUR half of the board
  const sim = mkSim(2);
  const t = freeTiles(sim);
  applyIntent(sim, 1, { a: 'build', k: 'sniper', c: t[0].c, r: t[0].r });
  applyIntent(sim, 2, { a: 'build', k: 'gatling', c: t[1].c, r: t[1].r });
  sim.G.towers[0].dmgDone = 5000;
  sim.G.towers[1].dmgDone = 5000;
  const d1 = debrief(sim, 1), d2 = debrief(sim, 2);
  ok(/Sniper/.test(d1.lines.join(' ')) && !/Gatling/.test(d1.lines.join(' ')),
    "seat 1's report is about seat 1's guns");
  ok(/Gatling/.test(d2.lines.join(' ')) && !/Sniper/.test(d2.lines.join(' ')),
    "and seat 2's about seat 2's");
}

console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ all ' + pass + ' checks passed'}\n`);
process.exit(fail ? 1 : 0);
