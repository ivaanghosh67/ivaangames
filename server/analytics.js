// Gameplay analytics.
//
// Every run writes an append-only JSONL trail so we can answer the questions
// that actually change the game: where do people die, which towers earn their
// cost, what gets bought and then regretted, and how long a wave really takes.
//
// Design notes:
//   - One file per day under DATA_DIR, so rotation is "delete old files".
//   - Buffered and flushed on an interval; a lost tail is acceptable for
//     analytics and never worth blocking a 30 Hz tick loop for.
//   - Player identity is a SHA-256 prefix of the reconnect token, never the
//     token itself, so runs can be linked without storing a credential.
//     Display names are recorded because players choose them for each other.
//   - Analytics must never be able to break a game: every entry point is
//     wrapped, and a failure disables the writer rather than throwing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.IRONLINE_DATA_DIR || '/var/lib/ironline/analytics';
const FLUSH_MS = 4000;
const MAX_BUFFER = 500;
const MAX_LINE = 2048;

export const anonId = token =>
  crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);

class Analytics {
  constructor() {
    this.buf = [];
    this.enabled = process.env.IRONLINE_ANALYTICS !== '0';
    this.day = null;
    this.stream = null;
    this.dropped = 0;
    if (this.enabled) {
      try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
      catch (err) {
        console.error('[analytics] disabled — cannot create ' + DATA_DIR + ':', err.message);
        this.enabled = false;
      }
    }
    if (this.enabled) {
      this.timer = setInterval(() => this.flush(), FLUSH_MS);
      this.timer.unref();
    }
  }

  file(now) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      if (this.stream) { try { this.stream.end(); } catch {} }
      this.day = day;
      this.stream = fs.createWriteStream(path.join(DATA_DIR, `runs-${day}.jsonl`), { flags: 'a' });
      this.stream.on('error', err => {
        console.error('[analytics] write error, disabling:', err.message);
        this.enabled = false;
      });
    }
    return this.stream;
  }

  emit(type, fields) {
    if (!this.enabled) return;
    if (this.buf.length >= MAX_BUFFER) { this.dropped++; return; }
    const line = JSON.stringify({ t: Date.now(), e: type, ...fields });
    // A line cap as well as a count cap. Some fields (an action's `k`) come
    // straight from a client, and a 64 KB payload repeated at the rate limit
    // would otherwise write megabytes a second into /var/lib.
    if (line.length > MAX_LINE) { this.dropped++; return; }
    this.buf.push(line);
  }

  flush() {
    if (!this.enabled || !this.buf.length) return;
    const lines = this.buf;
    this.buf = [];
    if (this.dropped) {
      lines.push(JSON.stringify({ t: Date.now(), e: 'dropped', n: this.dropped }));
      this.dropped = 0;
    }
    try { this.file(Date.now()).write(lines.join('\n') + '\n'); }
    catch (err) { console.error('[analytics] flush failed:', err.message); }
  }

  close() { this.flush(); if (this.stream) { try { this.stream.end(); } catch {} } }
}

const A = new Analytics();
export default A;

// ── the events, as the game actually produces them ─────────────────────────
// Each carries `run`, a per-run id, so a whole game reassembles with a filter.

export const track = {
  runStart(run, room, sim) {
    A.emit('run_start', {
      run, room: room.code, party: sim.players, map: sim.map.name,
      seed: sim.seed, allUnlocked: room.allUnlocked, public: room.isPublic,
      difficulty: sim.diffKey, endless: !!sim.endless,
      seats: room.roster().map(r => ({ seat: r.seat, name: r.name, id: anonId(room.seats.get(r.seat)?.token) })),
    });
  },

  runEnd(run, sim, reason) {
    const G = sim.G;
    // Tower-by-tower value: what it cost across its whole life versus what it
    // actually killed. This is the number that tells us if a turret is worth it.
    const units = [
      ...G.towers.map(t => ({ kind: t.type, lvl: t.lvl, spent: t.spent, kills: t.kills, seat: t.owner })),
      ...G.bots.map(b => ({ kind: b.kind, lvl: b.lvl, spent: b.spent, kills: b.kills, seat: b.owner })),
    ];
    A.emit('run_end', {
      run, reason,                       // 'won' | 'lost' | 'abandoned' | 'restarted'
      wave: G.wave, won: G.won, lives: G.lives,
      purse: [1, 2, 3, 4].slice(0, sim.players).map(s => Math.round(G.purse[s] || 0)),
      killed: G.killed, leaked: G.leaked,
      minutes: +(G.t / 60).toFixed(2),
      score: G.score, party: sim.players, map: sim.map.name,
      standing: units,
    });
  },

  waveStart(run, sim) {
    A.emit('wave_start', {
      run, wave: sim.G.wave, lives: sim.G.lives,
      purse: [1, 2, 3, 4].slice(0, sim.players).map(s => Math.round(sim.G.purse[s] || 0)),
      towers: sim.G.towers.length, bots: sim.G.bots.length,
      // what the defence is actually made of when the wave lands
      mix: sim.G.towers.reduce((m, t) => { m[t.type] = (m[t.type] || 0) + 1; return m; }, {}),
      at: +sim.G.t.toFixed(1),
    });
  },

  waveClear(run, sim, leakedThisWave, secs, wave) {
    A.emit('wave_clear', {
      run, wave, lives: sim.G.lives,
      purse: [1, 2, 3, 4].slice(0, sim.players).map(s => Math.round(sim.G.purse[s] || 0)),
      leaked: leakedThisWave, secs: +secs.toFixed(1),
      towers: sim.G.towers.length, bots: sim.G.bots.length,
    });
  },

  // Player actions. `ok` records refusals too — a player repeatedly failing to
  // afford something is a pacing signal, not noise.
  // `a` and `k` arrive from a client, so they are truncated before they are
  // ever written.
  action(run, seat, a, detail, ok, why) {
    const clip = v => (typeof v === 'string' ? v.slice(0, 32) : v);
    A.emit('action', {
      run, seat, a: clip(a),
      ...(detail.k !== undefined ? { k: clip(detail.k) } : {}),
      ...(detail.id !== undefined ? { id: detail.id | 0 } : {}),
      wave: detail.wave,
      ok: ok ? 1 : 0,
      ...(why ? { why: String(why).slice(0, 64) } : {}),
    });
  },

  seat(run, room, seat, what) {
    A.emit('seat', { run, room: room.code, seat, what });   // 'join' | 'rejoin' | 'drop'
  },
};

process.on('exit', () => A.close());
