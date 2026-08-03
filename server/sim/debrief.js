// What just happened, and what to do about it.
//
// A run used to end with "Overrun. The line broke on wave 27." — the score,
// and nothing you could act on. You saw the symptom (lives at zero) a long way
// from the cause (a bend nothing covered, or no anti-air worth the name), so a
// loss taught you nothing and the next run repeated it.
//
// Everything needed to explain a defeat is already recorded: what leaked and
// what type it was, how much damage every single unit dealt, and where each
// turret stands relative to the road. This turns that into three or four
// sentences a ten-year-old can act on.
//
// Deliberately blunt about the weakest link. "Your two launchers did 3% of
// your damage between them" is the sentence that changes what someone builds
// next time; a balanced summary is not.

import { TOWERS, BOTS, ENEMIES, statsOf, dist } from './constants.js';

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const nameOf = u => (u.kind ? BOTS[u.kind] : TOWERS[u.type]).name;

/**
 * How much of a path has ANY gun able to reach it.
 *
 * Not a damage figure — simply whether a stretch of road is covered at all.
 * The most common way a run dies is a section nobody is watching, and that is
 * a yes/no question, not a matter of degree.
 */
function covered(pts, towers, air, step = 12) {
  let total = 0, seen = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y, seg = Math.hypot(dx, dy);
    if (seg <= 0) continue;
    const n = Math.max(1, Math.ceil(seg / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, x = a.x + dx * t, y = a.y + dy * t;
      total++;
      for (const u of towers) {
        const D = TOWERS[u.type];
        if (air ? !D.air : D.noGround) continue;
        if (dist(x, y, u.x, u.y) <= statsOf(u.type, u.lvl).range) { seen++; break; }
      }
    }
  }
  return pct(seen, total);
}

/**
 * @param sim   the finished simulation
 * @param seat  whose report this is; 0 or undefined for the whole room
 * @returns {{lines:string[], stats:object}}
 */
export function debrief(sim, seat) {
  const G = sim.G;
  const mine = u => !seat || u.owner === seat;
  const towers = G.towers.filter(mine);
  const units = [...towers, ...G.bots.filter(mine)];
  const totalDmg = units.reduce((n, u) => n + (u.dmgDone || 0), 0);

  const ranked = units
    .map(u => ({ u, dmg: u.dmgDone || 0, spent: u.spent || 1 }))
    .sort((a, b) => b.dmg - a.dmg);

  const ground = covered(sim.map.path, towers, false);
  const air = covered(sim.map.airpath, towers, true);

  const leaks = Object.entries(G.leakedBy || {})
    .sort((a, b) => b[1] - a[1]);
  const leakTotal = leaks.reduce((n, [, c]) => n + c, 0);

  const lines = [];

  // 1. What actually got through, worst first.
  if (leakTotal > 0) {
    const [worstType, worstCount] = leaks[0];
    const label = (ENEMIES[worstType] || { name: worstType }).name;
    lines.push(`${leakTotal} got past you — mostly ${label.toLowerCase()}` +
      (worstCount > 1 ? `s (${worstCount} of them)` : ''));
    // Flyers leaking is nearly always an anti-air problem, and it is the
    // single most common way a board that looks strong dies.
    if (worstType === 'flyer' && air < 70) {
      lines.push(`Flyers cut straight across the map and your guns that can shoot up ` +
        `only reach ${air}% of that line. That is the hole.`);
    }
  } else {
    lines.push('Nothing ever got past your guns.');
  }

  // 2. Where the road was unwatched.
  if (ground < 90) {
    lines.push(`${100 - ground}% of the road had no gun covering it at all.`);
  }

  // 3. What earned its keep, and what did not.
  if (ranked.length && totalDmg > 0) {
    const best = ranked[0];
    lines.push(`Your best was the ${nameOf(best.u)} — ${pct(best.dmg, totalDmg)}% of everything you did.`);
    const idle = ranked.filter(r => r.dmg / totalDmg < 0.02 && r.spent >= 40);
    if (idle.length) {
      const wasted = idle.reduce((n, r) => n + r.spent, 0);
      const names = [...new Set(idle.map(r => nameOf(r.u)))].slice(0, 3).join(', ');
      lines.push(`${idle.length} of your units did almost nothing (${names}) — ` +
        `${wasted}g sat in guns that never fired at much. Move them nearer the road.`);
    }
  }

  // 4. Money that never became defence.
  const purse = seat ? (G.purse[seat] || 0)
    : [1, 2, 3, 4].slice(0, sim.players).reduce((n, s) => n + (G.purse[s] || 0), 0);
  if (purse > 800) {
    lines.push(`You finished holding ${Math.round(purse)}g. Gold in the bank ` +
      `defends nothing — spend it before the wave, not after.`);
  }

  return {
    lines,
    stats: {
      groundCovered: ground, airCovered: air,
      leakedBy: Object.fromEntries(leaks), leaked: leakTotal,
      topUnit: ranked.length ? nameOf(ranked[0].u) : null,
      topShare: ranked.length ? pct(ranked[0].dmg, totalDmg) : 0,
      banked: Math.round(purse),
    },
  };
}
