// The record of a run has to survive the run being large.
//
// A flat 2 KB line cap was applied to every analytics event. `run_end` carries
// one entry per turret and bot, so a full board pushed it over and the WHOLE
// line was discarded — silently, because the drop counter never said what it
// had dropped. Production bore this out exactly: every run of 1-6 waves had a
// run_end; the runs of 37, 39, 84 and 100 waves did not. The most valuable
// question we log for — how did the long games actually end — had no data at
// all, and it read as players abandoning their sessions.
//
//   node test/telemetry.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ironline-tel-'));
process.env.IRONLINE_DATA_DIR = DIR;
process.env.IRONLINE_ANALYTICS = '1';

const { default: A, track } = await import('../analytics.js');
const { Sim } = await import('../sim/sim.js');
const { applyIntent } = await import('../sim/intents.js');
const { MAXLVL, COLS, ROWS } = await import('../sim/constants.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); }
                       else { fail++; console.log('  FAIL ' + m); } };

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The writer is a stream, so a flush() is not on disk the instant it returns.
// Poll briefly rather than racing it — a test that reads too early reports an
// empty file, and every `.every()` assertion over it passes vacuously.
const read = async (minRows = 0) => {
  const f = path.join(DIR, `runs-${new Date().toISOString().slice(0, 10)}.jsonl`);
  for (let i = 0; i < 40; i++) {
    A.flush();
    await sleep(25);
    if (!fs.existsSync(f)) continue;
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    if (rows.length >= minRows) return rows;
  }
  return fs.existsSync(f)
    ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
};

console.log('\n═══ a big run still records how it ended ═════════════════════\n');

// Build the largest board the rules allow for a 4-player room, which is the
// shape that was being dropped.
const sim = new Sim({ seed: 3, players: 4, map: 'Iron Line', difficulty: 'regular', unlocked: null });
sim.G.wave = 60;
for (let s = 1; s <= 4; s++) sim.G.purse[s] = 1e9;

// Build through the real intent path first, so the entries have exactly the
// shape the game produces...
let built = 0;
outer:
for (let r = 0; r < ROWS && built < 8; r++) {
  for (let c = 0; c < COLS; c++) {
    if (!sim.canBuild(c, r)) continue;
    if (applyIntent(sim, 1, { a: 'build', k: 'gatling', c, r }).ok) { built++; continue outer; }
  }
}
ok(built > 0, `the real build path produced entries to copy (${built})`);
// ...then clone them up to the size a long 4-player run reaches. Doing this
// directly keeps the test about the line cap rather than about the economy.
const proto = sim.G.towers[0];
let free = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (sim.canBuild(c, r)) free.push({ c, r });
for (let i = 0; i < Math.min(free.length, 100 - sim.G.towers.length); i++) {
  sim.G.towers.push({ ...proto, id: sim.id(), c: free[i].c, r: free[i].r, owner: (i % 4) + 1 });
}
for (const t of sim.G.towers) { t.lvl = MAXLVL; t.kills = 4321; t.dmgDone = 987654.321; }
const mid = sim.map.path[Math.floor(sim.map.path.length / 2)];
for (let i = 0; i < 4; i++) applyIntent(sim, i + 1, { a: 'deploy', k: 'rifleBot', x: mid.x + i, y: mid.y });
const bproto = sim.G.bots[0];
for (let i = sim.G.bots.length; i < 20; i++) {
  sim.G.bots.push({ ...bproto, id: sim.id(), owner: (i % 4) + 1 });
}
for (const b of sim.G.bots) { b.kills = 999; b.dmgDone = 123456.789; }

ok(sim.G.towers.length + sim.G.bots.length > 60,
  `a long run's board to log (${sim.G.towers.length} turrets, ${sim.G.bots.length} bots)`);

const room = { code: 'TESTR', allUnlocked: false, isPublic: false,
  roster: () => [1, 2, 3, 4].map(s => ({ seat: s, name: 'Player' + s })),
  seats: new Map([[1, { token: 'a' }], [2, { token: 'b' }], [3, { token: 'c' }], [4, { token: 'd' }]]) };

track.runStart('BIGRUN', room, sim);
track.runEnd('BIGRUN', sim, 'lost');

const rows = await read(2);
const start = rows.find(r => r.e === 'run_start' && r.run === 'BIGRUN');
const end = rows.find(r => r.e === 'run_end' && r.run === 'BIGRUN');

ok(!!start, 'run_start was written');
ok(!!end, 'run_end was written for a full board — the case that used to vanish');
if (end) {
  ok(Array.isArray(end.standing) && end.standing.length === sim.G.towers.length + sim.G.bots.length,
    `every unit is in the standing (${end.standing ? end.standing.length : 0})`);
  ok(end.standing.every(u => typeof u.dmg === 'number'),
    'each unit records the damage it dealt, not only its killing blows');
  const line = JSON.stringify(end);
  ok(line.length > 2048,
    `and the record is genuinely bigger than the old cap (${line.length} chars)`);
}

// The tight cap must still hold for anything carrying client text.
{
  const before = rows.length;
  track.action('BIGRUN', 1, 'build', { k: 'x'.repeat(50000), wave: 3 }, false, 'nope');
  track.action('BIGRUN', 1, 'build', { k: 'pistol', wave: 3 }, true);
  const rows2 = await read(before + 1);
  const acts = rows2.filter(r => r.e === 'action');
  ok(acts.length > 0, `an ordinary action was still recorded (${acts.length})`);
  ok(acts.every(a => JSON.stringify(a).length <= 2048),
    'but a 50 KB client string cannot write an oversized line');
  ok(!acts.some(a => typeof a.k === 'string' && a.k.length > 64),
    'and it was clipped to 32 chars rather than dropped, so the row survives');

  // Something that really does breach the cap, to prove a drop is now
  // attributable. A bare count gave no way to notice that one event type was
  // being discarded every single time, which is exactly how run_end went
  // missing for months without anyone seeing it.
  A.emit('action', { run: 'BIGRUN', pad: 'z'.repeat(4000) });
  const rows3 = await read(rows2.length + 1);
  const dropped = rows3.filter(r => r.e === 'dropped');
  ok(dropped.length > 0 && dropped.some(d => d.by && d.by.action >= 1),
    `a drop now names WHAT was dropped (${JSON.stringify(dropped.map(d => d.by))})`);
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ all ' + pass + ' checks passed'}\n`);
process.exit(fail ? 1 : 0);
