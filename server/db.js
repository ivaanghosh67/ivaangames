// Player persistence.
//
// Progress used to live only in each browser's localStorage: clear your browser
// and it was gone, and it never followed you to another machine. This moves it
// server-side.
//
// Two rules govern everything here:
//
//   1. THE DATABASE MUST NEVER BREAK THE GAME. Every call is wrapped and
//      returns null on failure. If MySQL is down, unreachable, or was never
//      configured, the game runs exactly as it did before — clients simply fall
//      back to their local copy. A game server that refuses to start because a
//      stats table is unavailable is a worse product than one without stats.
//
//   2. IDENTITY IS ANONYMOUS BY DEFAULT. Players are keyed on a hash of the
//      reconnect token they already had, so persistence works with no sign-in
//      and no personal data at all. A Google account can be linked later and
//      ADOPTS the existing row, so signing in never costs you your progress.

import crypto from 'node:crypto';

let pool = null;
let disabled = false;
let warned = false;

const hash = t => crypto.createHash('sha256').update(String(t || '')).digest('hex');

export async function initDb() {
  if (process.env.IRONLINE_DB_DISABLE === '1') { disabled = true; return false; }
  const host = process.env.IRONLINE_DB_HOST;
  const user = process.env.IRONLINE_DB_USER;
  const pass = process.env.IRONLINE_DB_PASS;
  const name = process.env.IRONLINE_DB_NAME;
  if (!host || !user || !name) {
    console.log('[db] not configured — progress stays client-side');
    disabled = true;
    return false;
  }
  try {
    const mysql = await import('mysql2/promise');
    pool = mysql.createPool({
      host, user, password: pass, database: name,
      waitForConnections: true, connectionLimit: 6, queueLimit: 0,
      // A game tick must never block on the database.
      connectTimeout: 4000,
      charset: 'utf8mb4_unicode_ci',
    });
    const c = await pool.getConnection();
    await c.ping();
    c.release();
    console.log(`[db] connected to ${name}`);
    return true;
  } catch (err) {
    console.error('[db] unavailable, continuing without persistence:', err.message);
    disabled = true; pool = null;
    return false;
  }
}

export const dbReady = () => !!pool && !disabled;

/** Run a query, returning null rather than throwing. */
async function q(sql, args = []) {
  if (!pool || disabled) return null;
  try {
    const [rows] = await pool.execute(sql, args);
    return rows;
  } catch (err) {
    if (!warned) { console.error('[db] query failed:', err.message); warned = true; }
    return null;
  }
}

/**
 * Find or create the player behind a browser token, and return their progress.
 * This is called once per connection, never on the hot path.
 */
export async function loadPlayer(token, name) {
  if (!dbReady()) return null;
  const th = hash(token);
  await q(
    `INSERT INTO players (token_hash, display_name) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP,
       display_name = IF(? = '', display_name, ?)`,
    [th, name || 'Player', name || '', name || '']);
  const rows = await q('SELECT id, display_name, google_sub FROM players WHERE token_hash = ?', [th]);
  if (!rows || !rows.length) return null;
  const p = rows[0];
  await q('INSERT IGNORE INTO progress (player_id) VALUES (?)', [p.id]);
  const pr = await q(
    `SELECT flyer_kills, boss_kills, best_wave, total_kills, runs_played, runs_won, gold_earned
     FROM progress WHERE player_id = ?`, [p.id]);
  return {
    id: p.id,
    name: p.display_name,
    linked: !!p.google_sub,
    progress: pr && pr[0] ? {
      flyerKills: +pr[0].flyer_kills, bossKills: +pr[0].boss_kills, bestWave: +pr[0].best_wave,
      totalKills: +pr[0].total_kills, runsPlayed: +pr[0].runs_played,
      runsWon: +pr[0].runs_won, goldEarned: +pr[0].gold_earned,
    } : null,
  };
}

/**
 * Merge a client's local progress up into the server's copy.
 *
 * Deliberately takes the MAXIMUM of each counter rather than overwriting or
 * summing. A player arriving with a browser that has been offline should not
 * lose what the server knows, and a client cannot inflate its totals by
 * replaying the same merge twice.
 */
export async function mergeProgress(playerId, local) {
  if (!dbReady() || !playerId || !local) return null;
  const n = (v, cap) => Math.max(0, Math.min(cap, Math.floor(+v || 0)));
  await q(
    `UPDATE progress SET
       flyer_kills = GREATEST(flyer_kills, ?),
       boss_kills  = GREATEST(boss_kills,  ?),
       best_wave   = GREATEST(best_wave,   ?)
     WHERE player_id = ?`,
    [n(local.flyerKills, 1e7), n(local.bossKills, 1e7), n(local.bestWave, 200), playerId]);
  const pr = await q(
    `SELECT flyer_kills, boss_kills, best_wave, total_kills, runs_played, runs_won, gold_earned
     FROM progress WHERE player_id = ?`, [playerId]);
  if (!pr || !pr[0]) return null;
  return {
    flyerKills: +pr[0].flyer_kills, bossKills: +pr[0].boss_kills, bestWave: +pr[0].best_wave,
    totalKills: +pr[0].total_kills, runsPlayed: +pr[0].runs_played,
    runsWon: +pr[0].runs_won, goldEarned: +pr[0].gold_earned,
  };
}

/** Record a finished run: totals, per-difficulty bests, and unit performance. */
export async function recordRun(playerId, r) {
  if (!dbReady() || !playerId) return;
  const wave = Math.max(0, Math.min(200, r.wave | 0));
  const secs = Math.max(0, Math.min(86400, r.seconds | 0));
  await q(
    `UPDATE progress SET
       flyer_kills = GREATEST(flyer_kills, ?),
       boss_kills  = GREATEST(boss_kills,  ?),
       best_wave   = GREATEST(best_wave,   ?),
       total_kills = total_kills + ?,
       runs_played = runs_played + 1,
       runs_won    = runs_won + ?,
       gold_earned = gold_earned + ?
     WHERE player_id = ?`,
    [Math.max(0, r.flyerKills | 0), Math.max(0, r.bossKills | 0), wave,
     Math.max(0, r.kills | 0), r.won ? 1 : 0, Math.max(0, r.gold | 0), playerId]);

  await q(
    `INSERT INTO bests (player_id, difficulty, party_size, best_wave, won, fastest_secs)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       best_wave    = GREATEST(best_wave, VALUES(best_wave)),
       won          = GREATEST(won, VALUES(won)),
       -- keep the fastest WIN; a loss never sets a time
       fastest_secs = IF(VALUES(fastest_secs) IS NULL, fastest_secs,
                         IF(fastest_secs IS NULL, VALUES(fastest_secs),
                            LEAST(fastest_secs, VALUES(fastest_secs)))),
       achieved_at  = CURRENT_TIMESTAMP`,
    [playerId, String(r.difficulty || 'regular').slice(0, 16),
     Math.max(1, Math.min(4, r.partySize | 0)), wave, r.won ? 1 : 0, r.won ? secs : null]);

  await q(
    `INSERT INTO runs (player_id, room_code, difficulty, party_size, map_name, wave, won, kills, seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [playerId, (r.room || '').slice(0, 5) || null, String(r.difficulty || 'regular').slice(0, 16),
     Math.max(1, Math.min(4, r.partySize | 0)), String(r.map || '').slice(0, 32),
     wave, r.won ? 1 : 0, Math.max(0, r.kills | 0), secs]);

  for (const u of (r.units || []).slice(0, 40)) {
    await q(
      `INSERT INTO unit_stats (player_id, unit, built, gold_spent, kills)
       VALUES (?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         built = built + 1, gold_spent = gold_spent + VALUES(gold_spent),
         kills = kills + VALUES(kills)`,
      [playerId, String(u.kind || '').slice(0, 24), Math.max(0, u.spent | 0), Math.max(0, u.kills | 0)]);
  }
}

/** Top players by deepest wave, per difficulty and party size. */
export async function leaderboard(difficulty, partySize, limit = 20) {
  if (!dbReady()) return null;
  return await q(
    `SELECT p.display_name AS name, b.best_wave AS wave, b.won, b.fastest_secs, b.achieved_at
     FROM bests b JOIN players p ON p.id = b.player_id
     WHERE b.difficulty = ? AND b.party_size = ?
     ORDER BY b.best_wave DESC, b.achieved_at ASC
     LIMIT ${Math.max(1, Math.min(50, limit | 0))}`,
    [String(difficulty || 'regular').slice(0, 16), Math.max(1, Math.min(4, partySize | 0))]);
}

/** Fastest completed campaigns. */
export async function fastestBoard(difficulty, partySize, limit = 20) {
  if (!dbReady()) return null;
  return await q(
    `SELECT p.display_name AS name, b.fastest_secs AS secs, b.achieved_at
     FROM bests b JOIN players p ON p.id = b.player_id
     WHERE b.difficulty = ? AND b.party_size = ? AND b.won = 1 AND b.fastest_secs IS NOT NULL
     ORDER BY b.fastest_secs ASC
     LIMIT ${Math.max(1, Math.min(50, limit | 0))}`,
    [String(difficulty || 'regular').slice(0, 16), Math.max(1, Math.min(4, partySize | 0))]);
}

/** A player's own profile card. */
export async function profileOf(playerId) {
  if (!dbReady() || !playerId) return null;
  const pr = await q(
    `SELECT flyer_kills, boss_kills, best_wave, total_kills, runs_played, runs_won, gold_earned
     FROM progress WHERE player_id = ?`, [playerId]);
  const bests = await q(
    `SELECT difficulty, party_size, best_wave, won, fastest_secs
     FROM bests WHERE player_id = ? ORDER BY best_wave DESC`, [playerId]);
  const units = await q(
    `SELECT unit, built, gold_spent, kills FROM unit_stats
     WHERE player_id = ? ORDER BY kills DESC LIMIT 12`, [playerId]);
  if (!pr || !pr[0]) return null;
  return {
    totals: {
      flyerKills: +pr[0].flyer_kills, bossKills: +pr[0].boss_kills, bestWave: +pr[0].best_wave,
      totalKills: +pr[0].total_kills, runsPlayed: +pr[0].runs_played,
      runsWon: +pr[0].runs_won, goldEarned: +pr[0].gold_earned,
    },
    bests: (bests || []).map(b => ({
      difficulty: b.difficulty, partySize: +b.party_size, wave: +b.best_wave,
      won: !!b.won, fastest: b.fastest_secs == null ? null : +b.fastest_secs,
    })),
    units: (units || []).map(u => ({
      unit: u.unit, built: +u.built, spent: +u.gold_spent, kills: +u.kills,
    })),
  };
}

/**
 * Link a Google identity to the row the player already has.
 *
 * The anonymous row is adopted rather than replaced, so signing in keeps every
 * quest and best wave earned before the account existed.
 */
export async function linkGoogle(playerId, sub, name) {
  if (!dbReady() || !playerId || !sub) return null;
  const existing = await q('SELECT id FROM players WHERE google_sub = ?', [sub]);
  if (existing && existing.length && existing[0].id !== playerId) {
    // This Google account already has a row from another browser. Keep that one
    // as the canonical record and fold the anonymous progress into it.
    const other = existing[0].id;
    await q(
      `UPDATE progress a JOIN progress b ON b.player_id = ?
       SET a.flyer_kills = GREATEST(a.flyer_kills, b.flyer_kills),
           a.boss_kills  = GREATEST(a.boss_kills,  b.boss_kills),
           a.best_wave   = GREATEST(a.best_wave,   b.best_wave),
           a.total_kills = a.total_kills + b.total_kills,
           a.runs_played = a.runs_played + b.runs_played,
           a.runs_won    = a.runs_won + b.runs_won
       WHERE a.player_id = ?`, [playerId, other]);
    return other;
  }
  await q('UPDATE players SET google_sub = ?, display_name = IF(? = "", display_name, ?) WHERE id = ?',
    [sub, name || '', name || '', playerId]);
  return playerId;
}

export async function closeDb() {
  if (pool) { try { await pool.end(); } catch {} pool = null; }
}
