// A room is one co-op game: up to four seats, one authoritative Sim, one
// broadcast loop. Rooms are ticked by the shared scheduler in server.js rather
// than each holding its own interval, so a hundred idle rooms cost one timer.

import { Sim } from './sim/sim.js';
import { applyIntent, makeRateLimiter, rateOk } from './sim/intents.js';
import { encodeSnapshot, staticInfo } from './sim/snapshot.js';
import { kitName, MODES, PCOL, TOWERS, diffOf, DIFFICULTY } from './sim/constants.js';
import { track } from './analytics.js';
import { recordRun } from './db.js';

export const TICK_HZ = 30;
export const SNAP_EVERY = 2;              // broadcast every 2nd tick → 15 Hz
const DT = 1 / TICK_HZ;

// How long a seat is held for someone who drops, and how long an empty room
// lingers before it is collected.
const RECONNECT_GRACE_MS = 90_000;
const EMPTY_ROOM_TTL_MS = 120_000;

let ROOM_SEQ = 0;

export class Room {
  constructor({ code, name, isPublic, hostToken, map, partySize, allUnlocked, difficulty, rnd }) {
    this.id = ++ROOM_SEQ;
    this.code = code;
    this.name = (name || 'Iron Line').slice(0, 40);
    this.isPublic = !!isPublic;
    this.hostToken = hostToken;
    this.map = map || 'random';
    this.partySize = Math.max(1, Math.min(4, partySize | 0 || 2));
    // Quests apply by default; the host can waive them for a casual game.
    this.allUnlocked = allUnlocked === true;
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : 'regular';
    this.rnd = rnd;

    this.state = 'lobby';                 // 'lobby' | 'playing' | 'ended'
    this.sim = null;
    this.tick = 0;
    this.acc = 0;
    this.seats = new Map();               // seat -> { token, name, ws, lastSeen, rl }
    this.spectators = new Set();
    this.emptySince = Date.now();
    this.lastActivity = Date.now();
    this.chat = [];
  }

  // ── membership ──────────────────────────────────────────────────────────
  get occupied() {
    let n = 0;
    for (const s of this.seats.values()) if (s.ws) n++;
    return n;
  }
  get isEmpty() { return this.occupied === 0; }
  get openSeats() {
    const open = [];
    for (let s = 1; s <= this.partySize; s++) {
      const held = this.seats.get(s);
      if (!held || (!held.ws && Date.now() - held.lastSeen > RECONNECT_GRACE_MS)) open.push(s);
    }
    return open;
  }

  seatOf(token) {
    for (const [seat, s] of this.seats) if (s.token === token) return seat;
    return 0;
  }

  /** Seats a player, resuming their old seat if they are reconnecting. */
  join(ws, { token, name, unlocked }) {
    const existing = this.seatOf(token);
    if (existing) {
      const s = this.seats.get(existing);
      if (s.ws && s.ws !== ws) { try { s.ws.close(4001, 'joined elsewhere'); } catch {} }
      s.ws = ws; s.lastSeen = Date.now(); s.name = name || s.name;
      if (unlocked) { s.unlocked = unlocked; if (this.sim) this.sim.setSeatUnlocks(existing, unlocked); }
      if (ws.ctx && ws.ctx.playerId) s.playerId = ws.ctx.playerId;
      // Clearing this is what stops the GC sweep from collecting a room that
      // emptied once and then filled up again — without it, the *next* drop
      // looks like it has been empty since the first one and kills a live run.
      this.emptySince = null;
      this.lastActivity = Date.now();
      this.ensureHost();
      return { seat: existing, resumed: true };
    }
    const open = this.openSeats;
    if (!open.length) return { seat: 0, resumed: false, why: 'room full' };
    const seat = open[0];
    this.seats.set(seat, {
      token, name: (name || 'Player ' + seat).slice(0, 24),
      ws, lastSeen: Date.now(), rl: makeRateLimiter(),
      unlocked: unlocked || [],
      playerId: (ws.ctx && ws.ctx.playerId) || null,
    });
    if (this.sim) this.sim.setSeatUnlocks(seat, unlocked);
    this.emptySince = null;
    this.lastActivity = Date.now();
    this.ensureHost();
    return { seat, resumed: false };
  }

  leave(ws) {
    for (const [seat, s] of this.seats) {
      if (s.ws === ws) {
        s.ws = null; s.lastSeen = Date.now();
        // A seat held by someone who never started playing is freed at once;
        // mid-game we hold it so a dropped player can pick their towers back up.
        if (this.state === 'lobby') this.seats.delete(seat);
        break;
      }
    }
    this.spectators.delete(ws);
    if (this.isEmpty && !this.emptySince) this.emptySince = Date.now();
    this.ensureHost();
  }

  /**
   * Host migration. Without this, a host who closes their tab leaves a room
   * nobody can ever start or restart — the token lives on with no socket
   * behind it. Whoever is connected and lowest-seated inherits the room.
   */
  ensureHost() {
    const hostSeat = this.seatOf(this.hostToken);
    const hostLive = hostSeat && this.seats.get(hostSeat) && this.seats.get(hostSeat).ws;
    if (hostLive) return false;
    for (const seat of [...this.seats.keys()].sort((a, b) => a - b)) {
      const s = this.seats.get(seat);
      if (s && s.ws) {
        this.hostToken = s.token;
        this.hostSeat = seat;
        return true;
      }
    }
    return false;
  }

  expired(now) {
    const dead = this.isEmpty && this.emptySince && now - this.emptySince > EMPTY_ROOM_TTL_MS;
    // A run everyone walked away from is still a data point — often the most
    // interesting one, because it says where people lose interest.
    if (dead && this.sim && this.state === 'playing') {
      safely(() => track.runEnd(this.run, this.sim, 'abandoned'));
      this.state = 'ended';
    }
    return dead;
  }

  // ── run control ─────────────────────────────────────────────────────────
  start() {
    if (this.state === 'playing') return false;
    const seed = (this.rnd() * 0xffffffff) >>> 0;
    this.sim = new Sim({
      seed,
      players: this.partySize,
      map: this.map,
      unlocked: this.allUnlocked ? null : new Set(),
      difficulty: this.difficulty,
    });
    // Seed each seat's earned weapons from what its client reported on join.
    for (const [seat, s] of this.seats) this.sim.setSeatUnlocks(seat, s.unlocked);
    this.tick = 0; this.acc = 0;
    this.state = 'playing';
    this.lastActivity = Date.now();
    // Analytics run id: room code plus a monotonic counter, so a room that
    // plays five games produces five distinguishable runs.
    this.runNo = (this.runNo || 0) + 1;
    this.run = `${this.code}-${this.runNo}`;
    this.waveStartedAt = this.sim.G.t;
    this.waveStartLeaks = 0;
    this.lastWave = 0;
    safely(() => track.runStart(this.run, this, this.sim));
    this.broadcast({ type: 'start', info: staticInfo(this.sim, this) });
    return true;
  }

  restart() {
    if (this.sim && this.state === 'playing') safely(() => track.runEnd(this.run, this.sim, 'restarted'));
    this.state = 'lobby'; this.sim = null;
    return this.start();
  }

  // ── simulation ──────────────────────────────────────────────────────────
  step(dtReal) {
    if (this.state !== 'playing' || !this.sim) return;
    this.acc += dtReal;
    // Cap catch-up so a stalled process cannot spiral into a death loop.
    if (this.acc > DT * 8) this.acc = DT * 8;
    let ran = false;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.sim.update(DT);
      this.tick++;
      ran = true;
      if (this.tick % SNAP_EVERY === 0) this.pushSnapshot();
    }
    // A wave that has stopped being active but has not yet rolled over is a
    // wave that was just cleared — stamp the moment so its duration excludes
    // the prep countdown that follows.
    if (ran && !this.sim.G.waveActive && this.lastWave === this.sim.G.wave) this.noteWaveCleared();
    if (ran) this.trackWaves();
    if (ran && this.sim.G.over && this.state === 'playing') {
      this.state = 'ended';
      safely(() => track.runEnd(this.run, this.sim, this.sim.G.won ? 'won' : 'lost'));
      this.persistResults();
      this.pushSnapshot();
    }
  }

  // Wave boundaries are the most useful analytics unit: they tell us where a
  // run's difficulty actually bites. Derived from state transitions so the
  // simulation stays free of reporting concerns.
  trackWaves() {
    const G = this.sim.G;
    if (G.wave === this.lastWave) return;
    if (this.lastWave > 0) {
      // Report the wave that just ENDED, and only the time it was actually
      // running. G.wave has already advanced by the time we notice, and the
      // gap includes the prep countdown — filing both under the new number
      // made every wave look slower and harder than it was.
      const ended = this.lastWave;
      const secs = Math.max(0, (this.waveEndedAt || G.t) - this.waveStartedAt);
      const leaked = (this.waveEndLeaks === undefined ? G.leaked : this.waveEndLeaks) - this.waveStartLeaks;
      safely(() => track.waveClear(this.run, this.sim, leaked, secs, ended));
    }
    this.lastWave = G.wave;
    this.waveStartedAt = G.t;
    this.waveStartLeaks = G.leaked;
    this.waveEndedAt = undefined;
    this.waveEndLeaks = undefined;
    safely(() => track.waveStart(this.run, this.sim));
  }

  /** Called the moment a wave is beaten, before the countdown to the next. */
  noteWaveCleared() {
    const G = this.sim.G;
    if (this.waveEndedAt === undefined) { this.waveEndedAt = G.t; this.waveEndLeaks = G.leaked; }
  }

  pushSnapshot() {
    const snap = encodeSnapshot(this.sim, this.tick);
    const events = this.sim.drainEvents();
    const msg = { type: 's', s: snap };
    if (events.length) msg.e = events;
    // Hold on to the win/loss event so someone joining after the fact still
    // gets the real result screen instead of a blank one.
    const over = events.find(e => e.k === 'over');
    if (over) this.finalEvents = [over];
    this.broadcast(msg);
  }

  // ── messages ────────────────────────────────────────────────────────────
  handleIntent(ws, seat, msg) {
    if (this.state !== 'playing' || !this.sim) return;
    const s = this.seats.get(seat);
    if (!s) return;
    if (!rateOk(s.rl, Date.now())) return;             // silently drop floods
    // Resolve the unit kind BEFORE the intent runs — a sell deletes it.
    let kindBefore;
    if ((msg.a === 'sell' || msg.a === 'upgrade') && msg.id !== undefined) {
      const u = this.sim.unitById(msg.id | 0);
      if (u) kindBefore = u.kind || u.type;
    }
    const res = applyIntent(this.sim, seat, msg);
    this.lastActivity = Date.now();
    // Log the decisions, not the noise — cursor moves fire constantly and would
    // drown the interesting events.
    if (msg.a !== 'cursor' && msg.a !== 'input') {
      // sell/upgrade carry only an id, so resolve the unit KIND before the
      // sell removes it — otherwise "what do people regret buying?" is
      // unanswerable, which was the whole point of logging sells.
      let k = msg.k;
      if (!k && msg.id !== undefined) k = kindBefore;
      safely(() => track.action(this.run, seat, msg.a,
        { k, id: msg.id, wave: this.sim.G.wave }, res.ok, res.why));
    }
    if (!res.ok) send(ws, { type: 'deny', why: res.why, a: msg.a });
  }

  addChat(seat, text) {
    const s = this.seats.get(seat);
    if (!s) return;
    const line = { seat, name: s.name, text: String(text || '').slice(0, 200), at: Date.now() };
    if (!line.text.trim()) return;
    this.chat.push(line);
    if (this.chat.length > 50) this.chat.shift();
    this.broadcast({ type: 'chat', line });
  }

  roster() {
    const out = [];
    for (const [seat, s] of this.seats) {
      out.push({
        seat, name: s.name, online: !!s.ws,
        color: PCOL[seat], kit: kitName(seat, this.partySize),
      });
    }
    return out.sort((a, b) => a.seat - b.seat);
  }

  lobbyState() {
    return {
      type: 'lobby',
      room: {
        code: this.code, name: this.name, isPublic: this.isPublic,
        partySize: this.partySize, map: this.map, allUnlocked: this.allUnlocked,
        difficulty: this.difficulty, difficultyName: diffOf(this.difficulty).name,
        mode: MODES[this.partySize], state: this.state,
      },
      roster: this.roster(),
      chat: this.chat.slice(-20),
    };
  }

  /**
   * Save each seat's result. The wave reached is shared, but kills, gold and
   * unit performance are personal. Failures are logged and swallowed — a stats
   * write must never affect a game.
   */
  persistResults() {
    if (!this.sim) return;
    const G = this.sim.G;
    for (const [seat, s] of this.seats) {
      if (!s.playerId) continue;
      const units = [
        ...G.towers.filter(t => t.owner === seat)
          .map(t => ({ kind: t.type, spent: t.spent, kills: t.kills })),
        ...G.bots.filter(b => b.owner === seat)
          .map(b => ({ kind: b.kind, spent: b.spent, kills: b.kills })),
      ];
      recordRun(s.playerId, {
        room: this.code, difficulty: this.difficulty, partySize: this.partySize,
        map: this.sim.map.name, wave: G.wave, won: !!G.won,
        kills: G.score[seat] || 0, gold: Math.round(G.purse[seat] || 0),
        seconds: Math.round(G.t),
        flyerKills: G.quest[seat] ? G.quest[seat].flyerKills : 0,
        bossKills: G.quest[seat] ? G.quest[seat].bossKills : 0,
        units,
      }).catch(err => console.error('[db] recordRun:', err.message));
    }
  }

  /** What the public room browser shows. */
  listing() {
    return {
      code: this.code, name: this.name, mode: MODES[this.partySize],
      difficulty: diffOf(this.difficulty).name,
      partySize: this.partySize, players: this.occupied,
      open: this.openSeats.length, state: this.state,
      wave: this.sim ? this.sim.G.wave : 0,
      map: this.sim ? this.sim.map.name : this.map,
    };
  }

  broadcast(obj, except) {
    // `isHost` is per-recipient, so lobby state cannot be one shared string —
    // otherwise a player promoted by host migration never learns they are the
    // host and nobody in the room can ever start or restart it.
    const perSeat = obj && obj.type === 'lobby';
    const data = perSeat ? null : JSON.stringify(obj);
    for (const s of this.seats.values()) {
      if (!s.ws || s.ws === except) continue;
      if (perSeat) rawSend(s.ws, JSON.stringify({ ...obj, isHost: s.token === this.hostToken }));
      else rawSend(s.ws, data);
    }
    for (const ws of this.spectators) if (ws !== except) rawSend(ws, data || JSON.stringify(obj));
  }
}

// Analytics must never be able to break a game. Anything that throws in here
// is a reporting bug, not a gameplay one, and gets logged rather than raised.
function safely(fn) {
  try { fn(); } catch (err) { console.error('[analytics]', err.message); }
}

export function send(ws, obj) { rawSend(ws, JSON.stringify(obj)); }
function rawSend(ws, data) {
  // 1 === OPEN. Guarding here keeps every call site free of readyState checks.
  if (ws && ws.readyState === 1) {
    try { ws.send(data); } catch { /* socket died between check and send */ }
  }
}
