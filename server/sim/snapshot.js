// Snapshot encoding.
//
// Snapshots go out ~12×/second to every client in a room, so this is the one
// place in the codebase where terseness beats readability. Each entity list is
// a FLAT array with a fixed stride — that costs far fewer JSON bytes than an
// array of objects (no repeated keys) and decodes with a simple for-loop.
//
// Positions round to whole pixels (the board is 880×600, so sub-pixel accuracy
// buys nothing the client's interpolation does not already give us) and angles
// quantise to a byte.

import {
  TKEYS, BKEYS, TAU, TOWERS, BOTS, ENEMIES, HEALS, MAXWAVE, MAXLIVES, MAXLVL,
  QUESTS, DIFFICULTY, diffOf,
} from './constants.js';

export const EKEYS = Object.keys(ENEMIES);
const TIDX = Object.fromEntries(TKEYS.map((k, i) => [k, i]));
const BIDX = Object.fromEntries(BKEYS.map((k, i) => [k, i]));
const EIDX = Object.fromEntries(EKEYS.map((k, i) => [k, i]));

const ang = a => Math.round(((a % TAU) + TAU) % TAU / TAU * 255) & 255;
const px = v => Math.round(v);

// Bullet source codes: 0..n tower types, 100+n bot kinds, 200 the keep guards.
const BOTSHOT = 100, KEEPSHOT = 200;

export function encodeSnapshot(sim, tick) {
  const G = sim.G;

  const E = [];
  for (const e of G.enemies) {
    E.push(
      e.id,
      EIDX[e.type],
      px(e.x), px(e.y),
      Math.max(0, Math.min(255, Math.round(e.hp / e.maxhp * 255))),
      (e.hit > 0 ? 1 : 0) | (e.slowF < 1 ? 4 : 0),
      // which bot has it body-blocked, so the client can draw the tether
      e.block ? e.block.id : 0,
    );
  }

  const T = [];
  for (const t of G.towers) {
    T.push(
      t.id,
      TIDX[t.type],
      t.c, t.r, t.lvl,
      ang(t.a),
      t.owner,
      t.kills,
      Math.round((t.spin || 0) * 100),
      (t.flash > 0 ? 1 : 0) | (t.buff > 1 ? 2 : 0) | ((t.ramp || 0) > 0 ? 4 : 0),
      t.spent,                                  // so the client's sell price is exact
      t.tmode || 0,                             // targeting priority
    );
  }

  const B = [];
  for (const b of G.bots) {
    B.push(
      b.id,
      BIDX[b.kind],
      px(b.x), px(b.y),
      px(b.rx), px(b.ry),
      b.lvl,
      Math.round(b.hp),
      ang(b.a),
      b.owner,
      b.kills,
      (b.dead ? 1 : 0) | (b.flash > 0 ? 2 : 0),
      b.spent,
      // tenths of a second until it walks back on — the client shows a countdown
      Math.max(0, Math.round((b.respawn || 0) * 10)),
    );
  }

  const U = [];
  for (const b of G.bullets) {
    let code;
    if (b.type === 'botshot') {
      code = b.src && b.src.kind !== undefined ? BOTSHOT + BIDX[b.src.kind] : KEEPSHOT;
    } else code = TIDX[b.type] ?? 0;
    U.push(b.id, px(b.x), px(b.y), ang(b.rot), code);
  }

  const Gd = [];
  for (const g of G.keep.guards) Gd.push(px(g.x), px(g.y), ang(g.a), g.flash > 0 ? 1 : 0);

  // Seat cursors, with what that player currently has queued up to build so
  // everyone can see a teammate lining up a turret before they commit to it.
  const C = [];
  for (let s = 1; s <= sim.players; s++) {
    const cur = G.cursors[s];
    if (!cur) continue;
    let code = -1;
    if (cur.key !== undefined && cur.key !== null) {
      code = TIDX[cur.key] !== undefined ? TIDX[cur.key]
           : BIDX[cur.key] !== undefined ? BOTSHOT + BIDX[cur.key] : -1;
    }
    C.push(s, cur.c, cur.r, code);
  }

  return {
    t: tick,
    // Every seat's purse. Clients show their own as "Gold" and the rest on the
    // teammate strip, so you can see when someone is saving for a railgun.
    gp: [1, 2, 3, 4].map(s => Math.floor(G.purse[s] || 0)),
    l: G.lives,
    w: G.wave,
    p: Math.round(G.prep * 10),
    k: G.killed,
    lk: G.leaked,
    sh: Math.round(G.shake),
    f: (G.waveActive ? 1 : 0) | (G.spawning ? 2 : 0) | (G.over ? 4 : 0) | (G.won ? 8 : 0)
       | (G.autoWave ? 16 : 0),
    sc: [G.score[1], G.score[2], G.score[3], G.score[4]],
    kh: G.keep.hit > 0 ? 1 : 0,
    q: G.spawnQ.length,
    // How many of each medical item have been bought — prices escalate per
    // purchase, and without this every client's shop shows the base price and
    // then gets its clicks refused.
    hb: [G.healBuys.bandage, G.healBuys.medkit],
    // How many turrets each seat owns — the shop needs it to show the real,
    // escalated price rather than the base one.
    tc: [1, 2, 3, 4].map(s2 => G.towers.reduce((n, t) => n + (t.owner === s2 ? 1 : 0), 0)),
    // Build permits bought per seat. The allowance and the next permit's price
    // both depend on it, so the client cannot show either without it.
    pm: [G.permits[1], G.permits[2], G.permits[3], G.permits[4]],
    // Per-seat quest progress for this run: [flyerKills, bossKills] × 4.
    // Clients add the delta to their saved totals and unlock accordingly.
    qp: [1, 2, 3, 4].flatMap(s => [G.quest[s].flyerKills, G.quest[s].bossKills]),
    E, T, B, U, Gd, C,
  };
}

// Sent once when a client joins or the room starts a new run. Everything here
// is either immutable for the run or needed to build the shop UI, so shipping
// the definition tables from the server removes any chance of a client showing
// a price the server would not actually charge.
export function staticInfo(sim, room) {
  return {
    seed: sim.seed,
    players: sim.players,
    map: { name: sim.map.name, way: sim.map.way, keep: sim.map.keep },
    unlocked: sim.unlockedSet ? [...sim.unlockedSet] : null,
    // MAXWAVE is per-run (50 solo, 100 in a party), so it travels with the run
    // rather than being a client constant.
    difficulty: { key: sim.diffKey, ...diffOf(sim.diffKey) },
    endless: !!sim.endless,
    consts: { MAXWAVE: sim.maxWave, CAMPAIGN: sim.campaignWave,
              MAXLIVES, MAXLVL, maxSquads: sim.maxSquads() },
    defs: { TOWERS, BOTS, HEALS, ENEMIES, TKEYS, BKEYS, EKEYS, QUESTS, DIFFICULTY },
    room: room ? { code: room.code, name: room.name, isPublic: room.isPublic } : null,
  };
}
