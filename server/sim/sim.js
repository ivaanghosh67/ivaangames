// Iron Line — authoritative simulation.
//
// This is a faithful port of update()/spawn()/fire()/hurt()/kill()/updateBots()/
// updateKeep() from iron-line.html. Three deliberate differences:
//
//   1. All state hangs off an explicit `G` owned by a Sim instance instead of a
//      module global, so one Node process can run many rooms.
//   2. Cosmetics (floating text, particle bursts, beam zaps, melee swings,
//      screen shake) are emitted as EVENTS rather than stored in G. They are
//      short-lived and purely visual, so clients spawn and expire them locally.
//      That keeps them out of every snapshot — a large bandwidth win.
//   3. Entities carry a numeric `id` so snapshots can reference them, and
//      bullets/blocks hold internal object references that never get serialised.
//
// The first-person mode and its chest pickups are intentionally absent: online
// co-op is the top-down game, and chests only ever did anything in first person.

import {
  TS, COLS, ROWS, W, H, TAU, MAXLVL, MAXWAVE, maxWaveFor, MAXLIVES, BASE_SQUADS,
  clamp, dist, TOWERS, BOTS, HEALS, ENEMIES, TKEYS, BKEYS,
  hpScale, bossHp, goldScale, armorOf, waveDef, statsOf, botStats,
  kitOf, canUse, upCostOf, healCostOf, PCOL,
  diffOf, partyScale, bossRamp,
} from './constants.js';
import { makeRng } from './rng.js';
import { loadMap, pickMap } from './map.js';

const isBotUnit = u => !!(u && u.kind);
const defOf = u => (isBotUnit(u) ? BOTS[u.kind] : TOWERS[u.type]);

export class Sim {
  constructor({ seed, players, map = 'random', unlocked = null, difficulty = 'regular' }) {
    this.rnd = makeRng(seed);
    this.seed = seed >>> 0;
    this.players = clamp(players | 0, 1, 4);
    this.diffKey = diffOf(difficulty) === diffOf('regular') && difficulty !== 'regular'
      ? 'regular' : difficulty;
    this.diff = diffOf(this.diffKey);
    // 50 waves solo, 100 with company.
    this.maxWave = maxWaveFor(this.players);
    // null waives the quest locks for the whole room (a host option). Otherwise
    // each seat brings its own earned set, filled in from the client on join.
    this.unlockedSet = unlocked;
    this.seatUnlocks = { 1:new Set(), 2:new Set(), 3:new Set(), 4:new Set() };
    this.events = [];
    this.nextId = 1;
    this.map = loadMap(pickMap(this.rnd, map));
    this.newGame();
  }

  // ── plumbing ────────────────────────────────────────────────────────────
  id() { return this.nextId++; }
  ev(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  pop(x, y, txt, col) { this.ev({ k:'pop', x:Math.round(x), y:Math.round(y), txt, col }); }
  burst(x, y, col, n, sp) { this.ev({ k:'burst', x:Math.round(x), y:Math.round(y), col, n, sp }); }
  zap(x1, y1, x2, y2, col, w, life) {
    this.ev({ k:'zap', x1:Math.round(x1), y1:Math.round(y1), x2:Math.round(x2), y2:Math.round(y2), col, w, life });
  }
  swing(x, y, a, r, col, dir, w, life) {
    this.ev({ k:'swing', x:Math.round(x), y:Math.round(y), a:+a.toFixed(2), r:Math.round(r), col, dir, w, life });
  }
  shake(v) { const G = this.G; G.shake = Math.max(G.shake, v); }

  /**
   * Can this seat build this weapon?
   *
   * The four heavy guns are quest-locked. Progress lives on each player's own
   * machine, so they tell us what they have earned when they join and we keep
   * it per seat — one player's grind does not arm the whole room, and the host
   * can waive it entirely for a casual game.
   */
  isUnlocked(k, seat) {
    if (!TOWERS[k] || !TOWERS[k].lock) return true;
    if (this.unlockedSet === null) return true;             // room waived the locks
    const own = seat && this.seatUnlocks[seat];
    return own ? own.has(k) : false;
  }
  setSeatUnlocks(seat, list) {
    this.seatUnlocks[seat] = new Set(
      (Array.isArray(list) ? list : []).filter(k => TOWERS[k] && TOWERS[k].lock));
  }
  maxSquads() { return BASE_SQUADS + (this.players - 1) * 2 + Math.floor(this.G.wave / 15); }
  upCost(u) { return upCostOf(defOf(u), u.lvl); }
  healCost(k) { return healCostOf(k, this.G.healBuys[k]); }

  towerAt(c, r) { return this.G.towers.find(t => t.c === c && t.r === r); }
  canBuild(c, r) {
    return c >= 0 && c < COLS && r >= 0 && r < ROWS &&
      !this.map.blocked[r][c] && !this.towerAt(c, r);
  }
  unitById(id) {
    return this.G.towers.find(t => t.id === id) || this.G.bots.find(b => b.id === id) || null;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  newGame() {
    const K = this.map.keep;
    this.G = {
      lives:this.diff.lives,
      // Gold is PER PLAYER: you spend what your own kills earned. Lives stay
      // shared, because the line is shared — you hold it together or you don't.
      // Each purse starts at the solo game's 250 so one player's economy feels
      // the same whether they are alone or in a squad of four.
      purse:{ 1:250, 2:250, 3:250, 4:250 },
      wave:0, autoWave:false, towers:[], bots:[], enemies:[], bullets:[],
      spawnQ:[], spawnT:0, spawning:false, prep:15, waveActive:false,
      over:false, won:false, t:0, shake:0,
      healBuys:{ bandage:0, medkit:0 }, leaked:0, killed:0,
      players:this.players, score:{ 1:0, 2:0, 3:0, 4:0 },
      // Cheats are not reachable over the wire; the object exists only so the
      // ported formulas below read identically to the original.
      admin:{ god:false, hpMul:1 },
      keep:{ kills:0, hit:0, guards:[
        { x:K.cx - 19, y:K.cy - 3, a:Math.PI, cd:0, bob:0, flash:0 },
        { x:K.cx + 19, y:K.cy - 3, a:Math.PI, cd:.4, bob:1.7, flash:0 }] },
      // Where each seat's build cursor sits. Purely cosmetic for other players,
      // but it is what makes co-op feel co-operative.
      cursors:{ 1:{ c:5, r:8 }, 2:{ c:8, r:8 }, 3:{ c:11, r:8 }, 4:{ c:16, r:8 } },
      // Per-seat quest counters for THIS run. Clients fold them into their
      // saved totals, which is what actually unlocks the heavy weapons.
      quest:{ 1:{ flyerKills:0, bossKills:0 }, 2:{ flyerKills:0, bossKills:0 },
              3:{ flyerKills:0, bossKills:0 }, 4:{ flyerKills:0, bossKills:0 } },
    };
  }

  /** Debit one seat's purse. Returns false (and changes nothing) if short. */
  spend(seat, n) {
    const G = this.G;
    const s = G.purse[seat] === undefined ? 1 : seat;
    if (G.purse[s] < n) return false;
    G.purse[s] -= n;
    return true;
  }
  /** Credit one seat, or every seat when nobody in particular earned it. */
  credit(seat, n) {
    const G = this.G;
    if (seat && G.purse[seat] !== undefined) G.purse[seat] += n;
    else for (let s = 1; s <= this.players; s++) G.purse[s] += n;
  }

  /**
   * A shared bonus (clearing a wave, calling one in early), per player.
   *
   * Paying every player the full amount was the second half of the co-op
   * income problem: four players collected four times the bonus against one
   * wave. Now each player's share tracks the share of the threat they actually
   * carry — a 4-player party faces partyScale(4) = 3.4× the enemies between
   * four of them, so each takes 3.4/4 = 0.85 of a solo bonus.
   */
  sharedBonus(base) {
    return Math.round(base * partyScale(this.players) / this.players * this.diff.income);
  }
  goldOf(seat) { return Math.floor(this.G.purse[seat] || 0); }

  // ── waves ───────────────────────────────────────────────────────────────
  startWave(early) {
    const G = this.G;
    if (G.waveActive || G.over) return false;
    if (early && G.prep > 0) {
      // Calling it in early is a shared decision, so everyone gets a share.
      const b = this.sharedBonus(G.prep * 3);
      this.credit(0, b);
      this.pop(W / 2, 60, '+' + b + ' early bonus', '#f2c14e');
    }
    G.wave++; G.waveActive = true; G.spawning = true; G.prep = 0;
    const q = [];
    for (const grp of waveDef(G.wave, this.maxWave, this.players, this.diffKey)) {
      let t = 0;
      for (let i = 0; i < grp.c; i++) { q.push({ type:grp.t, at:t }); t += grp.g; }
    }
    q.sort((a, b) => a.at - b.at);
    G.spawnQ = q; G.spawnT = 0;
    this.ev({ k:'wave', n:G.wave });
    return true;
  }

  spawn(type) {
    const G = this.G, rnd = this.rnd;
    if (type === 'ultra') {
      G.shake = 22;
      if (!G.ultraWarned) {
        G.ultraWarned = true;
        this.pop(W / 2, 150, '⚠  THREE ULTRA BOSSES INCOMING  ⚠', '#ff2d6f');
      } else this.pop(W / 2, 178, 'another one', '#ff8ab0');
    }
    const b = ENEMIES[type];
    // bossRamp softens only the first few bosses (waves 5-11), which is where
    // every measured solo run was dying
    const hp = (type === 'ultra' ? bossHp(G.wave) * 4.5
      : type === 'boss' ? bossHp(G.wave) * bossRamp(G.wave)
      : b.hp * hpScale(G.wave)) * (G.admin.hpMul || 1) * this.diff.hp;
    const p = b.fly ? this.map.airpath : this.map.path;
    G.enemies.push({
      id:this.id(), type, x:p[0].x, y:p[0].y, wp:1, hp, maxhp:hp,
      speed:b.speed * (type === 'boss' ? 1 : (.94 + rnd() * .12)),
      armor:armorOf(b.armor, G.wave), r:b.r, fly:b.fly, dps:b.dps,
      gold:Math.round(b.gold * goldScale(G.wave)),
      slowT:0, slowF:1, prog:0, angle:0, hit:0, block:null,
    });
  }

  // ── combat ──────────────────────────────────────────────────────────────
  hurt(e, dmg, pierce, src) {
    e.hp -= pierce ? dmg : Math.max(1, dmg - e.armor);
    e.hit = .12;
    if (e.hp <= 0) this.kill(e, src);
  }

  kill(e, src) {
    const G = this.G, rnd = this.rnd;
    const i = G.enemies.indexOf(e);
    if (i < 0) return;
    G.enemies.splice(i, 1); G.killed++;
    // randomised bounty: ±35% swing, with an occasional jackpot drop
    const jack = rnd() < .08;
    const drop = Math.max(1, Math.round(e.gold * (.65 + rnd() * .7) * (jack ? 3 : 1) * this.diff.income));
    // The bounty goes to whoever's gun did it. Kills by the free rampart guards
    // belong to nobody, so everyone gets paid for those.
    const earner = src && src.owner ? src.owner : 0;
    this.credit(earner, drop);
    this.ev({ k:'gold', seat:earner, n:drop });
    this.pop(e.x, e.y - e.r - 4, (jack ? 'JACKPOT +' : '+') + drop, jack ? '#ffe066' : '#f2c14e');
    if (jack) this.burst(e.x, e.y, '#ffe066', 18, 150);
    this.burst(e.x, e.y, ENEMIES[e.type].color, e.type === 'boss' ? 46 : 14, e.type === 'boss' ? 220 : 120);
    if (src) { src.kills++; if (src.owner) G.score[src.owner]++; }
    // Quest progress goes to whoever's weapon did it.
    const q = earner && G.quest[earner];
    if (q) {
      if (e.fly) q.flyerKills++;
      if (e.type === 'boss' || e.type === 'ultra') q.bossKills++;
    }
    if (e.type === 'boss') G.shake = 14;
    if (e.type === 'ultra') {
      G.shake = 30;
      this.burst(e.x, e.y, '#ff2d6f', 90, 340);
      this.pop(W / 2, 120, 'ULTRA BOSS DOWN', '#ff2d6f');
    }
    // a dying enemy releases whatever bot was body-blocking it
    for (const b of G.bullets) if (b.tgt === e) b.tgt = null;
  }

  leak(e) {
    const G = this.G;
    const i = G.enemies.indexOf(e);
    if (i < 0) return;
    G.enemies.splice(i, 1); G.leaked++;
    const d = e.type === 'ultra' ? 25 : e.type === 'boss' ? 10 : 1;
    if (!G.admin.god) G.lives -= d;
    G.shake = Math.max(G.shake, 8); G.keep.hit = .7;
    this.pop(W - 48, e.y, '-' + d + ' ♥', '#e5534b');
    for (const b of G.bullets) if (b.tgt === e) b.tgt = null;
    if (G.lives <= 0) {
      G.lives = 0; G.over = true;
      this.ev({ k:'over', won:false, title:'Overrun',
        body:'The line broke on wave ' + G.wave + ' of ' + this.maxWave + '.  ' + G.killed +
             ' kills · ' + G.towers.length + ' emplacements · ' + G.bots.length + ' bots.' });
    }
  }

  fire(t, s, tgt) {
    const G = this.G, rnd = this.rnd;
    const B = TOWERS[t.type];
    const mx = t.x + Math.cos(t.a) * 15, my = t.y + Math.sin(t.a) * 15;

    if (B.melee) {
      t.swingDir = -(t.swingDir || 1);
      this.swing(t.x, t.y, t.a, s.range, B.color, t.swingDir, t.type === 'greatsword' ? 1.5 : 1.0, .22);
      for (const e of G.enemies.slice()) {
        if (e.fly) continue;
        if (dist(t.x, t.y, e.x, e.y) > s.range + e.r) continue;
        this.hurt(e, s.dmg, false, t);
        if (s.slow > 0 && e.hp > 0) { e.slowF = Math.min(e.slowF, 1 - s.slow); e.slowT = 1.6; }
        this.burst(e.x, e.y, B.color, 4, 80);
      }
      t.flash = .18; return;
    }
    if (B.beam) {
      const mult = 1 + (t.ramp || 0);
      this.zap(mx, my, tgt.x, tgt.y, B.color, 1.5 + mult * 1.6, .14);
      this.hurt(tgt, s.dmg * mult, true, t);
      if (rnd() < .4) this.burst(tgt.x, tgt.y, B.color, 2, 70);
      t.flash = .14; return;
    }
    if (B.line) {
      const dx = Math.cos(t.a), dy = Math.sin(t.a), L = s.range;
      this.zap(mx, my, t.x + dx * L, t.y + dy * L, B.color, 4, .22);
      for (const e of G.enemies.slice()) {
        if (e.fly && !B.air) continue;
        const px = e.x - t.x, py = e.y - t.y;
        const pr = px * dx + py * dy;                    // distance along the ray
        if (pr < 0 || pr > L) continue;
        if (Math.abs(px * dy - py * dx) > 16 + e.r * .5) continue;  // perpendicular offset
        this.hurt(e, s.dmg, true, t);
        this.burst(e.x, e.y, B.color, 5, 90);
      }
      this.shake(3);
      t.flash = .22; return;
    }
    if (B.hitscan) {
      this.zap(mx, my, tgt.x, tgt.y, '#bdf0ff', 2.5, .16);
      this.hurt(tgt, s.dmg, true, t);
      this.burst(tgt.x, tgt.y, B.color, 7, 90);
      t.flash = .16; return;
    }

    const spread = t.type === 'gatling' ? (1 - t.spin) * .09 : 0;
    const shoot = e => G.bullets.push({
      id:this.id(), x:mx, y:my, lx:e.x, ly:e.y, tgt:e, sp:B.bullet * 60, dmg:s.dmg,
      splash:s.splash, slow:s.slow, col:B.color, src:t, life:3, rot:t.a + spread,
      type:t.type, air:B.air, noGround:B.noGround,
    });
    shoot(tgt);
    if (B.multi > 1) {
      let extra = B.multi - 1;
      const cands = G.enemies
        .filter(e => e !== tgt && !(e.fly && !B.air) && dist(t.x, t.y, e.x, e.y) <= s.range + e.r)
        .sort((a, b) => b.prog - a.prog);
      for (const e of cands) { if (extra-- <= 0) break; shoot(e); }
    }
    this.burst(mx, my, B.color, t.type === 'gatling' ? 1 : 2, 40);
    t.flash = .06;
  }

  impact(b, x, y) {
    const G = this.G;
    if (b.splash > 0) {
      this.ev({ k:'ring', x:Math.round(x), y:Math.round(y), col:b.col, sz:Math.round(b.splash) });
      for (const e of G.enemies.slice()) {
        if (e.fly && !b.air) continue;
        if (!e.fly && b.noGround) continue;
        if (dist(x, y, e.x, e.y) <= b.splash + e.r) {
          this.hurt(e, b.dmg, false, b.src);
          if (b.slow > 0 && e.hp > 0) { e.slowF = Math.min(e.slowF, 1 - b.slow); e.slowT = 1.8; }
        }
      }
      this.burst(x, y, b.col, 10, 150);
    } else {
      if (b.tgt && b.tgt.hp > 0 && dist(x, y, b.tgt.x, b.tgt.y) < b.tgt.r + 8)
        this.hurt(b.tgt, b.dmg, false, b.src);
      this.burst(x, y, b.col, 3, 80);
    }
  }

  // ── per-tick ────────────────────────────────────────────────────────────
  update(dt) {
    const G = this.G;
    G.t += dt;
    if (G.over) return;
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 30);

    if (!G.waveActive && G.wave < this.maxWave) {
      // Auto: don't sit through the countdown, roll straight into the next
      // wave (and bank the early-call bonus). It is a room-wide setting because
      // the wave is shared — one player cannot skip a countdown for themselves.
      if (G.autoWave && G.prep > 0 && G.prep < 14.2) this.startWave(true);
      else { G.prep -= dt; if (G.prep <= 0) { G.prep = 0; this.startWave(false); } }
    }

    if (G.spawning) {
      G.spawnT += dt;
      while (G.spawnQ.length && G.spawnQ[0].at <= G.spawnT) this.spawn(G.spawnQ.shift().type);
      if (!G.spawnQ.length) G.spawning = false;
    }

    for (const e of G.enemies) e.block = null;
    this.updateBots(dt);
    this.updateKeep(dt);

    // enemies
    for (let i = G.enemies.length - 1; i >= 0; i--) {
      const e = G.enemies[i];
      if (e.hit > 0) e.hit -= dt;
      if (e.slowT > 0) { e.slowT -= dt; if (e.slowT <= 0) e.slowF = 1; }
      if (e.block) {                                    // locked in melee with a bot
        e.block.hp -= e.dps * dt;
        e.angle = Math.atan2(e.block.y - e.y, e.block.x - e.x);
        if (this.rnd() < dt * 6) this.burst(e.block.x, e.block.y, '#ff9a6b', 1, 50);
        continue;
      }
      let d = e.speed * e.slowF * dt;
      const p = e.fly ? this.map.airpath : this.map.path;
      while (d > 0 && e.wp < p.length) {
        const t = p[e.wp], dx = t.x - e.x, dy = t.y - e.y, dd = Math.hypot(dx, dy);
        if (dd <= d) { e.x = t.x; e.y = t.y; e.prog += dd; d -= dd; e.wp++; }
        else { e.x += dx / dd * d; e.y += dy / dd * d; e.angle = Math.atan2(dy, dx); e.prog += d; d = 0; }
      }
      if (e.wp >= p.length) this.leak(e);
    }

    // towers
    for (const t of G.towers) {
      const B = TOWERS[t.type], s = statsOf(t.type, t.lvl);
      t.cd -= dt; if (t.flash > 0) t.flash -= dt;
      // Targeting priority. 0 first (furthest along the road) is the default
      // and the right answer most of the time; the others matter for specific
      // jobs — `strongest` to focus a boss, `closest` to stop a leak at the
      // last moment, `last` to soften what the front line has not reached yet.
      let best = null, bs = -Infinity;
      for (const e of G.enemies) {
        if (e.fly && !B.air) continue;
        if (!e.fly && B.noGround) continue;
        const d = dist(t.x, t.y, e.x, e.y);
        if (d > s.range + e.r) continue;
        let score;
        switch (t.tmode) {
          case 1: score = -e.prog; break;      // last: least far along
          case 2: score = e.hp; break;         // strongest: most health left
          case 3: score = -d; break;           // closest to this turret
          default: score = e.prog;             // first: furthest along
        }
        if (score > bs) { bs = score; best = e; }
      }
      // gun crews standing nearby load faster for this turret (best crew applies)
      let crewBuff = 1;
      for (const b of G.bots) {
        const D = BOTS[b.kind];
        if (b.dead || !D.buff) continue;
        if (dist(b.x, b.y, t.x, t.y) <= botStats(b.kind, b.lvl).range)
          crewBuff = Math.max(crewBuff, 1 + D.buff * (1 + (b.lvl - 1) * .12));
      }
      t.buff = crewBuff;
      if (B.spinup) t.spin = clamp(t.spin + (best ? dt / 1.4 : -dt / .9), 0, 1);
      if (B.beam) {                                     // laser charges while held on one target
        if (best && best === t.lastTgt) t.ramp = Math.min(2.2, (t.ramp || 0) + dt * .8);
        else t.ramp = 0;
        t.lastTgt = best;
      }
      if (best) {
        const a = Math.atan2(best.y - t.y, best.x - t.x);
        const da = ((a - t.a + Math.PI * 3) % TAU) - Math.PI;
        t.a += clamp(da, -(B.melee ? 7 : 10) * dt, (B.melee ? 7 : 10) * dt);
        let rate = s.rate * crewBuff;
        if (B.spinup) rate *= .35 + .65 * t.spin;
        if (t.cd <= 0) { t.cd = 1 / rate; this.fire(t, s, best); }
      } else if (t.cd < 0) t.cd = 0;
    }

    // bullets
    for (let i = G.bullets.length - 1; i >= 0; i--) {
      const b = G.bullets[i];
      const alive = b.tgt && b.tgt.hp > 0;
      const tx = alive ? b.tgt.x : b.lx, ty = alive ? b.tgt.y : b.ly;
      if (alive) { b.lx = b.tgt.x; b.ly = b.tgt.y; }
      const dx = tx - b.x, dy = ty - b.y, dd = Math.hypot(dx, dy), step = b.sp * dt;
      b.rot = Math.atan2(dy, dx);
      if (dd <= step || dd < 1) { this.impact(b, tx, ty); G.bullets.splice(i, 1); continue; }
      b.x += dx / dd * step; b.y += dy / dd * step;
      b.life -= dt;
      if (b.life <= 0) { this.impact(b, b.x, b.y); G.bullets.splice(i, 1); }
    }

    if (G.waveActive && !G.spawning && !G.enemies.length) {
      G.waveActive = false;
      const bonus = this.sharedBonus((25 + 20 * G.wave) * (.8 + this.rnd() * .4));
      this.credit(0, bonus);
      this.pop(W / 2, 92, 'Wave ' + G.wave + ' cleared  +' + bonus, '#6ee7a8');
      if (G.wave >= this.maxWave) {
        G.over = true; G.won = true;
        this.ev({ k:'over', won:true, title:'Line Held',
          body:'All ' + this.maxWave + ' waves repelled with ' + G.lives + ' lives left — ' +
               G.killed + ' total kills.' });
      } else G.prep = 15;
    }
  }

  updateBots(dt) {
    const G = this.G;
    for (const b of G.bots) {
      const D = BOTS[b.kind], s = botStats(b.kind, b.lvl);
      if (b.dead) {
        b.respawn -= dt;
        if (b.respawn <= 0) {
          b.dead = false; b.hp = s.hp; b.x = b.rx; b.y = b.ry;
          this.burst(b.x, b.y, D.color, 14, 120);
          this.pop(b.x, b.y - 18, 'online', '#6ee7a8');
        }
        continue;
      }
      b.cd -= dt; if (b.flash > 0) b.flash -= dt;

      // every unit walks to wherever it has been ordered
      if (!D.speed) {
        const dx = b.rx - b.x, dy = b.ry - b.y, dd = Math.hypot(dx, dy);
        if (dd > 1.5) {
          const st = Math.min((D.move || 60) * dt, dd);
          b.x += dx / dd * st; b.y += dy / dd * st;
          b.walk = (b.walk || 0) + st;
          if (!G.enemies.length) b.a = Math.atan2(dy, dx);
        }
      }

      // out-of-combat self repair
      let nearFoe = false;
      for (const e of G.enemies) { if (dist(b.x, b.y, e.x, e.y) < 165) { nearFoe = true; break; } }
      if (!nearFoe && b.hp < s.hp) b.hp = Math.min(s.hp, b.hp + s.hp * 0.05 * dt);

      if (D.heal > 0) {                                 // medic bot (can patch itself too)
        let tgt = null, worst = 1;
        for (const o of G.bots) {
          if (o.dead) continue;
          const f = o.hp / botStats(o.kind, o.lvl).hp;
          if (f < .999 && f < worst && dist(b.x, b.y, o.x, o.y) <= s.range) { worst = f; tgt = o; }
        }
        if (tgt) {
          if (tgt !== b) b.a = Math.atan2(tgt.y - b.y, tgt.x - b.x);
          if (b.cd <= 0) {
            b.cd = 1 / s.rate;
            const amt = tgt === b ? s.heal * .5 : s.heal;
            tgt.hp = Math.min(botStats(tgt.kind, tgt.lvl).hp, tgt.hp + amt);
            if (tgt !== b) this.zap(b.x, b.y, tgt.x, tgt.y, '#6ee7a8', 2, .2);
            this.pop(tgt.x, tgt.y - 22, '+' + Math.round(amt), '#6ee7a8');
            b.flash = .2;
          }
        }
        continue;
      }

      // combat bots
      let tgt = null, nd = 1e9;
      const seek = D.block ? (D.leash || 100) : s.range;
      for (const e of G.enemies) {
        if (e.fly && !D.air) continue;
        if (dist(b.rx, b.ry, e.x, e.y) > seek + e.r) continue;
        const dd = dist(b.x, b.y, e.x, e.y);
        if (dd < nd) { nd = dd; tgt = e; }
      }
      if (D.speed > 0) {                                // melee bot repositions
        const gx = tgt ? tgt.x : b.rx, gy = tgt ? tgt.y : b.ry;
        const dx = gx - b.x, dy = gy - b.y, dd = Math.hypot(dx, dy);
        const stop = tgt ? Math.max(6, s.range * .55) : 2;
        if (dd > stop) {
          const st = Math.min(D.speed * dt, dd - stop);
          b.x += dx / dd * st; b.y += dy / dd * st; b.a = Math.atan2(dy, dx);
        } else if (tgt) b.a = Math.atan2(tgt.y - b.y, tgt.x - b.x);
      } else if (tgt) b.a = Math.atan2(tgt.y - b.y, tgt.x - b.x);

      if (tgt && dist(b.x, b.y, tgt.x, tgt.y) <= s.range + tgt.r) {
        if (D.block && !tgt.block) tgt.block = b;
        if (b.cd <= 0) {
          b.cd = 1 / s.rate; b.flash = .16;
          if (D.range <= 40) {
            b.swingDir = -(b.swingDir || 1);
            this.swing(b.x, b.y, b.a, s.range + 12, D.color, b.swingDir, 1, .2);
            this.hurt(tgt, s.dmg, false, b);
          } else {
            G.bullets.push({
              id:this.id(), x:b.x + Math.cos(b.a) * 10, y:b.y + Math.sin(b.a) * 10, lx:tgt.x, ly:tgt.y,
              tgt, sp:430, dmg:s.dmg, splash:0, slow:0, col:D.color, src:b,
              life:3, rot:b.a, type:'botshot', air:true,
            });
          }
        }
      }

      if (b.hp <= 0) {                                  // destroyed
        b.dead = true; b.respawn = 9; b.hp = 0;
        this.burst(b.x, b.y, '#ff8f6b', 22, 170);
        this.pop(b.x, b.y - 18, 'bot down', '#e5534b');
        this.shake(5);
        for (const e of G.enemies) if (e.block === b) e.block = null;
      }
    }
  }

  // the two defenders on the rampart — free, weak, always there
  updateKeep(dt) {
    const G = this.G, KEEP = this.map.keep;
    const K = G.keep;
    if (K.hit > 0) K.hit -= dt;
    for (const g of K.guards) {
      g.cd -= dt; g.bob += dt * 2.4;
      if (g.flash > 0) g.flash -= dt;
      let tgt = null, nd = 1e9;
      for (const e of G.enemies) {
        const d = dist(g.x, g.y, e.x, e.y);
        if (d <= KEEP.range + e.r && d < nd) { nd = d; tgt = e; }
      }
      if (!tgt) { g.a += ((Math.PI - g.a + Math.PI * 3) % TAU - Math.PI) * Math.min(1, dt * 3); continue; }
      const a = Math.atan2(tgt.y - g.y, tgt.x - g.x);
      g.a += clamp(((a - g.a + Math.PI * 3) % TAU) - Math.PI, -8 * dt, 8 * dt);
      if (g.cd <= 0) {
        g.cd = 1 / KEEP.rate;
        g.flash = .08;
        G.bullets.push({
          id:this.id(), x:g.x + Math.cos(g.a) * 8, y:g.y + Math.sin(g.a) * 8, lx:tgt.x, ly:tgt.y, tgt,
          sp:340, dmg:KEEP.dmg, splash:0, slow:0, col:'#ffd9a0', src:K,
          life:3, rot:g.a, type:'botshot', air:true,
        });
      }
    }
  }
}
