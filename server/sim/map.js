// Map generation and the derived collision/pathing data.
//
// Ported from loadMap()/randomMap()/rollMap() in iron-line.html, with
// Math.random swapped for the room's seeded generator. Everything a client
// needs to draw the map is derivable from `way`, so a snapshot only ever
// carries the waypoint list once, at join time.

import { TS, COLS, ROWS, W, MAPS } from './constants.js';

export function randomMap(rnd) {
  const way = [];
  let r = 1 + rnd.int(ROWS - 2), c = -1;
  way.push([c, r]);
  let dir = 1;
  while (c < COLS - 3) {
    c = Math.min(COLS - 2, c + 2 + rnd.int(4));
    way.push([c, r]);
    const room = dir > 0 ? (ROWS - 2 - r) : (r - 1);
    if (room > 2) {
      const step = 2 + rnd.int(Math.max(1, Math.min(room - 1, 7)));
      r += dir * step; way.push([c, r]);
    }
    dir = -dir;
  }
  way.push([COLS, r]);
  return { name: 'Random', way };
}

export function rollMap(rnd, currentName) {
  const pool = MAPS.filter(m => m.name !== currentName);
  // half the time a hand-built map, half the time a freshly generated one
  return rnd() < 0.5 ? rnd.pick(pool) : randomMap(rnd);
}

export function pickMap(rnd, requested) {
  if (requested === 'random') return randomMap(rnd);
  const found = MAPS.find(m => m.name === requested);
  return found ? { name: found.name, way: found.way.map(p => p.slice()) } : rollMap(rnd, null);
}

// Builds the immutable per-map data the simulation reads every tick.
export function loadMap(def) {
  const way = def.way.map(p => p.slice());
  const name = def.name;
  const path = way.map(([c, r]) => ({ x: c * TS + TS / 2, y: r * TS + TS / 2 }));
  const inR = way[0][1], outR = way[way.length - 1][1];
  const airpath = [{ x: -40, y: inR * TS + TS / 2 }, { x: W + 40, y: outR * TS + TS / 2 }];

  const blocked = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
  for (let i = 0; i < way.length - 1; i++) {
    const [c1, r1] = way[i], [c2, r2] = way[i + 1];
    const sc = Math.sign(c2 - c1), sr = Math.sign(r2 - r1);
    let c = c1, r = r1;
    for (;;) {
      if (c >= 0 && c < COLS && r >= 0 && r < ROWS) blocked[r][c] = true;
      if (c === c2 && r === r2) break;
      c += sc; r += sr;
    }
  }

  // the keep sits just off the exit, on whichever side has room
  const kr = outR > 0 ? outR - 1 : outR + 1;
  const keep = { cx: 840, cy: kr * TS + TS / 2, range: 104, dmg: 9, rate: 1.2 };
  for (const cc of [20, 21]) if (kr >= 0 && kr < ROWS) blocked[kr][cc] = true;

  return { name, way, path, airpath, blocked, keep };
}
