// Player intents.
//
// Clients never mutate game state — they ask, and the server decides. Every
// action a player can take in the couch game maps to exactly one intent here,
// and each one re-checks affordability, kit ownership and placement legality
// server-side. A client that lies (edited JS, replayed packets, a bot spamming
// build) can only ever get a `deny` back.

import {
  TS, COLS, ROWS, W, H, MAXLVL, MAXLIVES, clamp,
  TOWERS, BOTS, HEALS, TKEYS, BKEYS, canUse, PCOL, buildCostOf,
} from './constants.js';

const isBotUnit = u => !!(u && u.kind);

// Look a key up in a definition table WITHOUT touching the prototype chain.
// `TOWERS['__proto__']` and `HEALS['toString']` are both truthy, so a plain
// `if (!TOWERS[k])` guard lets them through — and then `.cost` is undefined,
// which turns a purse into NaN and makes everything free for the rest of the
// run. Membership in the key array is the only lookup we trust.
const TOWER_SET = new Set(TKEYS);
const BOT_SET = new Set(BKEYS);
const HEAL_SET = new Set(Object.keys(HEALS));
const asTower = k => (typeof k === 'string' && TOWER_SET.has(k) ? TOWERS[k] : null);
const asBot = k => (typeof k === 'string' && BOT_SET.has(k) ? BOTS[k] : null);
const asHeal = k => (typeof k === 'string' && HEAL_SET.has(k) ? HEALS[k] : null);

// Cheap per-seat rate limiting. Generous enough that a fast human never
// notices — cursor updates plus whatever they are clicking — but tight enough
// that a script cannot flood the tick loop.
const RATE = { window: 1000, max: 60 };

export function makeRateLimiter() {
  return { hits: [], };
}
export function rateOk(rl, now) {
  while (rl.hits.length && now - rl.hits[0] > RATE.window) rl.hits.shift();
  if (rl.hits.length >= RATE.max) return false;
  rl.hits.push(now);
  return true;
}

/**
 * @returns {{ok:true, changed:boolean} | {ok:false, why:string}}
 */
export function applyIntent(sim, seat, msg) {
  const G = sim.G;
  if (!G) return { ok:false, why:'no game' };
  // Cursor updates stay live after the game ends so teammates' reticles do not
  // freeze on the results screen. Nothing else can change the world.
  if (G.over && msg.a !== 'cursor') return { ok:false, why:'game over' };

  switch (msg.a) {
    case 'cursor': {
      const c = clamp(msg.c | 0, 0, COLS - 1), r = clamp(msg.r | 0, 0, ROWS - 1);
      const cur = G.cursors[seat];
      // `k` is what this player has queued up to place — shown to teammates so
      // they can see a turret being lined up before it is paid for.
      const k = (asTower(msg.k) || asBot(msg.k)) ? String(msg.k) : null;
      if (cur.c === c && cur.r === r && cur.key === k) return { ok:true, changed:false };
      cur.c = c; cur.r = r; cur.key = k;
      return { ok:true, changed:true };
    }

    case 'build': {
      const k = String(msg.k || '');
      const def = asTower(k);
      if (!def) return { ok:false, why:'no such tower' };
      if (!sim.isUnlocked(k, seat)) return { ok:false, why:'🔒 finish its quest to unlock' };
      const c = msg.c | 0, r = msg.r | 0;
      if (!sim.canBuild(c, r)) return { ok:false, why:'blocked' };
      // Price rises with how many turrets this player already owns.
      const owned = G.towers.reduce((n, t) => n + (t.owner === seat ? 1 : 0), 0);
      const cost = buildCostOf(def, owned);
      if (!sim.spend(seat, cost)) return { ok:false, why:'need ' + cost + 'g' };
      const t = {
        id:sim.id(), type:k, c, r, x:c * TS + TS / 2, y:r * TS + TS / 2,
        lvl:1, cd:0, a:-Math.PI / 2, kills:0, spent:cost,
        flash:0, spin:0, swingDir:1, ramp:0, buff:1, owner:seat,
      };
      G.towers.push(t);
      sim.burst(t.x, t.y, def.color, 10, 90);
      return { ok:true, changed:true, id:t.id };
    }

    case 'deploy': {
      const k = String(msg.k || '');
      const D = asBot(k);
      if (!D) return { ok:false, why:'no such bot' };
      const cap = sim.maxSquads();
      if (G.bots.length >= cap) return { ok:false, why:'squad limit ' + cap + ' — recall one first' };
      const x = clamp(+msg.x || 0, 8, W - 8), y = clamp(+msg.y || 0, 8, H - 8);
      if (!sim.spend(seat, D.cost)) return { ok:false, why:'need ' + D.cost + 'g' };
      const b = {
        id:sim.id(), kind:k, x, y, rx:x, ry:y, lvl:1, hp:D.hp, cd:0, a:-Math.PI / 2,
        kills:0, spent:D.cost, flash:0, dead:false, respawn:0, swingDir:1, owner:seat,
      };
      G.bots.push(b);
      sim.burst(x, y, D.color, 14, 110);
      return { ok:true, changed:true, id:b.id };
    }

    case 'upgrade': {
      const u = sim.unitById(msg.id | 0);
      if (!u) return { ok:false, why:'gone' };
      // Your units are yours. Now that each player has their own purse, letting
      // anyone upgrade or sell anything meant spending your gold on someone
      // else's turret and cashing out someone else's investment.
      if (u.owner !== seat) return { ok:false, why:"that's Player " + u.owner + "'s unit" };
      if (u.lvl >= MAXLVL) return { ok:false, why:'max level' };
      const c = sim.upCost(u);
      if (!sim.spend(seat, c)) return { ok:false, why:'need ' + c + 'g' };
      u.lvl++; u.spent += c;
      // an upgrade also tops a live bot up to the new level's max hp
      if (isBotUnit(u) && !u.dead) u.hp = botMaxHp(u);
      sim.burst(u.x, u.y, '#f2c14e', 12, 110);
      sim.pop(u.x, u.y - 20, 'LVL ' + u.lvl, '#f2c14e');
      return { ok:true, changed:true };
    }

    case 'sell': {
      const u = sim.unitById(msg.id | 0);
      if (!u) return { ok:false, why:'gone' };
      if (u.owner !== seat) return { ok:false, why:"that's Player " + u.owner + "'s unit" };
      const back = Math.floor(u.spent * .6);
      sim.credit(u.owner, back);
      sim.pop(u.x, u.y, '+' + back, '#f2c14e');
      sim.burst(u.x, u.y, '#8b98a5', 10, 90);
      if (isBotUnit(u)) {
        for (const e of G.enemies) if (e.block === u) e.block = null;
        for (const b of G.bullets) if (b.src === u) b.src = null;
        G.bots.splice(G.bots.indexOf(u), 1);
      } else {
        for (const b of G.bullets) if (b.src === u) b.src = null;
        G.towers.splice(G.towers.indexOf(u), 1);
      }
      return { ok:true, changed:true };
    }

    case 'target': {
      const u = sim.unitById(msg.id | 0);
      if (!u || isBotUnit(u)) return { ok:false, why:'not a turret' };
      if (u.owner !== seat) return { ok:false, why:"that's Player " + u.owner + "'s unit" };
      u.tmode = Math.max(0, Math.min(3, msg.mode | 0));
      return { ok:true, changed:true };
    }

    case 'heal': {
      const k = String(msg.k || '');
      const Hh = asHeal(k);
      if (!Hh) return { ok:false, why:'no such item' };
      if (G.lives >= MAXLIVES) return { ok:false, why:'already at full strength' };
      const c = sim.healCost(k);
      if (!sim.spend(seat, c)) return { ok:false, why:'need ' + c + 'g' };
      G.healBuys[k]++;
      const before = G.lives;
      G.lives = Math.min(MAXLIVES, G.lives + Hh.lives);
      sim.pop(W / 2, 120, Hh.glyph + ' +' + (G.lives - before) + ' ♥', '#6ee7a8');
      sim.burst(W / 2, 120, Hh.color, 16, 140);
      return { ok:true, changed:true };
    }

    case 'order': {
      const u = sim.unitById(msg.id | 0);
      if (!u || !isBotUnit(u)) return { ok:false, why:'not a bot' };
      u.rx = clamp(+msg.x || 0, 8, W - 8);
      u.ry = clamp(+msg.y || 0, 8, H - 8);
      sim.ev({ k:'ring', x:Math.round(u.rx), y:Math.round(u.ry), col:PCOL[u.owner] || '#4aa8ff', sz:16 });
      sim.pop(u.rx, u.ry - 16, 'move out', '#cfe3f5');
      return { ok:true, changed:true };
    }

    // Auto-advance. Shared, like calling a wave in early: any seat may flip it
    // and it applies to the room.
    case 'auto': {
      const on = !!msg.on;
      if (G.autoWave === on) return { ok:true, changed:false };
      G.autoWave = on;
      sim.pop(440, 60, on ? 'AUTO WAVES ON' : 'auto waves off', on ? '#6ee7a8' : '#8b98a5');
      return { ok:true, changed:true };
    }

    case 'wave': {
      // Anyone may call the next wave in early — it is a shared decision and
      // the couch game lets whoever reaches Enter first do it.
      if (G.waveActive) return { ok:false, why:'wave already running' };
      const started = sim.startWave(true);
      return started ? { ok:true, changed:true } : { ok:false, why:'cannot start' };
    }

    default:
      return { ok:false, why:'unknown action' };
  }
}

const botMaxHp = u => BOTS[u.kind].hp * Math.pow(1.38, u.lvl - 1);
