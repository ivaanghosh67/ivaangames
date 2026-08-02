// Iron Line — online co-op server.
//
// One process, one shared 30 Hz scheduler, many rooms. Everything the client
// needs travels over a single WebSocket: room browsing, creating and joining,
// lobby chat, and the authoritative game stream. Keeping it to one connection
// means one reconnect path to get right instead of three.
//
// Env:
//   PORT        listen port                    (default 8092)
//   HOST        bind address                   (default 127.0.0.1 — nginx fronts us)
//   MAX_ROOMS   safety cap on concurrent rooms (default 200)

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, TICK_HZ, send } from './room.js';
import { makeRng, makeRoomCode } from './sim/rng.js';
import { MAPS, DIFFICULTY, DKEYS } from './sim/constants.js';
import { staticInfo, encodeSnapshot } from './sim/snapshot.js';
import analytics, { track } from './analytics.js';
import { initDb, dbReady, loadPlayer, mergeProgress, recordRun,
         leaderboard, fastestBoard, profileOf } from './db.js';

const PORT = +(process.env.PORT || 8092);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_ROOMS = +(process.env.MAX_ROOMS || 200);

const rooms = new Map();                 // code -> Room
const rnd = makeRng((Date.now() ^ (process.pid * 2654435761)) >>> 0);

// Room lifecycle logging — journalctl -u ironline is the only window into what
// a live room is doing, so keep it terse but present.
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ── http: health + a plain-JSON room list for anything that is not the game ──
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health' || url.pathname === '/ivaangames/health') {
    return json(res, 200, {
      ok: true, rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.occupied, 0),
      uptime: Math.round(process.uptime()),
    });
  }
  if (url.pathname === '/rooms' || url.pathname === '/ivaangames/rooms') {
    return json(res, 200, { rooms: publicListing() });
  }
  json(res, 404, { error: 'not found' });
});

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── websocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  path: '/ivaangames/ws',
  maxPayload: 64 * 1024,
  // Snapshots are repetitive JSON; deflate cuts them to roughly a fifth.
  perMessageDeflate: {
    threshold: 512,
    zlibDeflateOptions: { level: 3, memLevel: 7 },
  },
});

// Per-socket budget covering EVERY message, not just gameplay intents. Without
// it one socket looping `join` or `create` starves the shared 30 Hz scheduler
// that every other room in the process depends on.
const SOCKET_RATE = { window: 1000, max: 220 };
const CREATE_LIMIT = { window: 60_000, max: 8 };
function budgetOk(bucket, limit, now) {
  while (bucket.length && now - bucket[0] > limit.window) bucket.shift();
  if (bucket.length >= limit.max) return false;
  bucket.push(now);
  return true;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.ctx = { token: null, name: null, room: null, seat: 0, hits: [], creates: [], warned: 0 };
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    // Count the frame BEFORE parsing. Charging only well-formed messages let a
    // flood of junk (or non-JSON) bypass the limiter entirely.
    if (!budgetOk(ws.ctx.hits, SOCKET_RATE, Date.now())) {
      // Sustained flooding is not a human; warn a few times, then hang up.
      if (++ws.ctx.warned > 3) { try { ws.close(4008, 'flooding'); } catch {} }
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { onMessage(ws, msg); }
    catch (err) {
      console.error('[msg]', msg.type, err);
      send(ws, { type: 'error', why: 'server error' });
    }
  });

  ws.on('close', (code, reason) => {
    const r = ws.ctx.room;
    if (r) {
      log(`close ${r.code} seat=${ws.ctx.seat} code=${code} ${reason ? 'reason=' + reason : ''}`);
      r.leave(ws);
      r.broadcast(r.lobbyState());
    }
  });

  ws.on('error', () => { /* close handler does the cleanup */ });
});

function onMessage(ws, msg) {
  const ctx = ws.ctx;

  switch (msg.type) {
    case 'hello': {
      // The client persists this token in localStorage; it is what lets a
      // dropped player reclaim their seat (and their towers) on reconnect.
      //
      // Identity is pinned to the socket on the FIRST hello. Re-helloing with
      // a fresh token was a way to walk into every open seat of a room from
      // one connection and hold them all for the 90 s reconnect grace.
      if (!ctx.token) ctx.token = sanitiseToken(msg.token) || randomToken();
      ctx.name = String(msg.name || '').slice(0, 24) || 'Player';
      // What this player has earned through quests. Kept per seat, so one
      // player's progress never arms anybody else.
      if (Array.isArray(msg.unlocked)) ctx.unlocked = msg.unlocked.slice(0, 16).map(String);
      if (ctx.room && ctx.seat && ctx.room.sim) ctx.room.sim.setSeatUnlocks(ctx.seat, ctx.unlocked);
      // A name change should show up for everyone already in the room.
      if (ctx.room && ctx.seat) {
        const s = ctx.room.seats.get(ctx.seat);
        if (s) { s.name = ctx.name; ctx.room.broadcast(ctx.room.lobbyState()); }
      }
      send(ws, { type: 'welcome', token: ctx.token, maps: MAPS.map(m => m.name),
        difficulties: DKEYS.map(k => ({ key: k, ...DIFFICULTY[k] })), persistence: dbReady() });
      // Pull saved progress, merging in whatever this browser holds locally.
      // Deliberately AFTER the welcome, so a slow database never delays getting
      // into a game — persistence is a bonus, not a gate.
      if (dbReady()) {
        loadPlayer(ctx.token, ctx.name).then(async p => {
          if (!p) return;
          ctx.playerId = p.id;
          const merged = msg.progress ? await mergeProgress(p.id, msg.progress) : p.progress;
          send(ws, { type: 'progress', progress: merged || p.progress, linked: p.linked });
        }).catch(() => {});
      }
      return;
    }

    case 'board': {
      if (!dbReady()) return send(ws, { type: 'board', rows: null, why: 'leaderboards are offline' });
      const diff = String(msg.difficulty || 'regular').slice(0, 16);
      const party = Math.max(1, Math.min(4, msg.partySize | 0 || 1));
      const kind = msg.kind === 'fastest' ? 'fastest' : 'deepest';
      const fn = kind === 'fastest' ? fastestBoard : leaderboard;
      fn(diff, party, 20)
        .then(rows => send(ws, { type:'board', kind, difficulty:diff, partySize:party, rows: rows || [] }))
        .catch(() => send(ws, { type:'board', kind, rows: [] }));
      return;
    }

    case 'profile': {
      if (!ctx.playerId) return send(ws, { type: 'profile', profile: null });
      profileOf(ctx.playerId)
        .then(pf => send(ws, { type: 'profile', profile: pf }))
        .catch(() => send(ws, { type: 'profile', profile: null }));
      return;
    }

    case 'list':
      return send(ws, { type: 'rooms', rooms: publicListing() });

    case 'create': {
      if (!ctx.token) return send(ws, { type: 'error', why: 'say hello first' });
      // One socket must not be able to consume the whole room table.
      if (!budgetOk(ctx.creates, CREATE_LIMIT, Date.now()))
        return send(ws, { type: 'error', why: 'too many games created — wait a minute' });
      if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', why: 'server is full, try again shortly' });
      partRoom(ws);
      let code;
      do { code = makeRoomCode(rnd); } while (rooms.has(code));
      const room = new Room({
        code,
        name: msg.name,
        isPublic: !!msg.isPublic,
        hostToken: ctx.token,
        map: validMap(msg.map),
        partySize: msg.partySize,
        allUnlocked: msg.allUnlocked,
        difficulty: msg.difficulty,
        endless: msg.endless,
        rnd,
      });
      rooms.set(code, room);
      log(`create ${code} "${room.name}" party=${room.partySize} public=${room.isPublic} map=${room.map}`);
      return doJoin(ws, room);
    }

    case 'join': {
      if (!ctx.token) return send(ws, { type: 'error', why: 'say hello first' });
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return send(ws, { type: 'error', why: 'no room with that code' });
      // Check the target will actually take us BEFORE giving up the seat we
      // already hold — otherwise a click on a room that just filled up drops
      // you out of your current game for nothing.
      if (room !== ctx.room && !room.seatOf(ctx.token) && !room.openSeats.length)
        return send(ws, { type: 'error', why: 'that game is full' });
      partRoom(ws);
      return doJoin(ws, room);
    }

    case 'leave':
      partRoom(ws);
      return send(ws, { type: 'left' });

    case 'setopts': {
      const room = ctx.room;
      if (!room || !isHost(ws, room)) return;
      if (room.state === 'playing') return send(ws, { type: 'deny', why: 'game already running' });
      if (msg.partySize !== undefined) {
        const want = Math.max(1, Math.min(4, msg.partySize | 0));
        // Never shrink below the people already sitting down.
        const highest = Math.max(0, ...[...room.seats.keys()]);
        room.partySize = Math.max(want, highest);
      }
      if (msg.map !== undefined) room.map = validMap(msg.map);
      if (msg.isPublic !== undefined) room.isPublic = !!msg.isPublic;
      if (msg.allUnlocked !== undefined) room.allUnlocked = !!msg.allUnlocked;
      if (msg.difficulty !== undefined && DIFFICULTY[msg.difficulty]) room.difficulty = msg.difficulty;
      if (msg.endless !== undefined) room.endless = !!msg.endless;
      if (msg.name !== undefined) room.name = String(msg.name).slice(0, 40);
      return room.broadcast(room.lobbyState());
    }

    case 'start': {
      const room = ctx.room;
      if (!room || !isHost(ws, room)) return send(ws, { type: 'deny', why: 'only the host can start' });
      if (room.state === 'playing') return;
      room.start();
      return room.broadcast(room.lobbyState());
    }

    case 'restart': {
      const room = ctx.room;
      if (!room || !isHost(ws, room)) return send(ws, { type: 'deny', why: 'only the host can restart' });
      room.restart();
      return room.broadcast(room.lobbyState());
    }

    case 'i':                                   // gameplay intent
      if (ctx.room && ctx.seat) ctx.room.handleIntent(ws, ctx.seat, msg);
      return;

    case 'chat':
      if (ctx.room && ctx.seat) ctx.room.addChat(ctx.seat, msg.text);
      return;

    case 'ping':
      return send(ws, { type: 'pong', t: msg.t });
  }
}

function doJoin(ws, room) {
  const { seat, resumed, why } = room.join(ws,
    { token: ws.ctx.token, name: ws.ctx.name, unlocked: ws.ctx.unlocked });
  log(`join ${room.code} seat=${seat || '-'} ${resumed ? 'resumed ' : ''}name=${ws.ctx.name} ` +
      `token=${String(ws.ctx.token).slice(0, 8)} occupied=${room.occupied} ${why ? 'why=' + why : ''}`);
  if (!seat) return send(ws, { type: 'error', why: why || 'could not join' });
  ws.ctx.room = room;
  ws.ctx.seat = seat;
  // Spread first: lobbyState() carries its own `type`, and this message must
  // stay a 'joined'.
  send(ws, {
    ...room.lobbyState(),
    type: 'joined',
    seat, resumed,
    isHost: isHost(ws, room),
  });
  // A player rejoining mid-run needs the static info before snapshots mean
  // anything. An ENDED room is never stepped by the scheduler, so it would
  // never send another snapshot either — push one immediately, or the joiner
  // stares at a pristine wave-0 board that never updates.
  if (room.sim && (room.state === 'playing' || room.state === 'ended')) {
    send(ws, { type: 'start', info: staticInfo(room.sim, room) });
    if (room.state === 'ended') {
      send(ws, { type: 's', s: encodeSnapshot(room.sim, room.tick), e: room.finalEvents || [] });
    }
  }
  room.broadcast(room.lobbyState(), ws);
  return undefined;
}

function partRoom(ws) {
  const room = ws.ctx.room;
  if (!room) return;
  room.leave(ws);
  room.broadcast(room.lobbyState());
  ws.ctx.room = null;
  ws.ctx.seat = 0;
}

const isHost = (ws, room) => ws.ctx.token && ws.ctx.token === room.hostToken;

function publicListing() {
  return [...rooms.values()]
    .filter(r => r.isPublic && r.state !== 'ended' && r.openSeats.length > 0)
    .sort((a, b) => b.occupied - a.occupied || a.id - b.id)
    .slice(0, 60)
    .map(r => r.listing());
}

const validMap = m => {
  const s = String(m || 'random');
  return s === 'random' || MAPS.some(x => x.name === s) ? s : 'random';
};
const sanitiseToken = t => {
  const s = String(t || '');
  return /^[a-zA-Z0-9_-]{8,64}$/.test(s) ? s : null;
};
const randomToken = () =>
  'p' + Date.now().toString(36) + Math.floor(rnd() * 0xffffffff).toString(36);

// ── the one scheduler everything hangs off ──────────────────────────────────
let last = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  const dt = Number(now - last) / 1e9;
  last = now;
  for (const room of rooms.values()) {
    try { room.step(dt); }
    catch (err) { console.error('[tick]', room.code, err); }
  }
}, 1000 / TICK_HZ);

// Room GC and dead-socket sweep, once every 15 s.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.expired(now)) { rooms.delete(code); }
  }
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15_000);

// Bring the database up before listening, but never let it stop us: initDb
// resolves false if it is unconfigured or unreachable and the game runs without
// persistence.
await initDb();

server.listen(PORT, HOST, () => {
  console.log(`[ironline] listening on ${HOST}:${PORT} (ws path /ivaangames/ws)` +
    (dbReady() ? ' with persistence' : ' — no persistence'));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[ironline] ${sig}, shutting down`);
    const live = [];
    for (const room of rooms.values()) {
      // Record runs that were still in progress, or a deploy silently loses
      // every game that happened to be live at the time.
      if (room.sim && room.state === 'playing') {
        try { track.runEnd(room.run, room.sim, 'interrupted'); } catch {}
        // ...and SAVE them. Analytics is a log; `bests` is the player's actual
        // progress, and it was only ever written when a run reached its own
        // ending. A deploy took a real game down at wave 46 while the player's
        // saved best still read 37, so nine waves of their evening simply did
        // not happen as far as the game was concerned. A restart is not the
        // player's fault and must not cost them their record.
        try { room.persistResults(); } catch (err) {
          console.error('[ironline] persist on shutdown:', err.message);
        }
        live.push(`${room.code} wave ${room.sim.G.wave}`);
      }
      room.broadcast({ type: 'error', why: 'server restarting' });
    }
    if (live.length) console.log(`[ironline] saved ${live.length} live run(s): ${live.join(', ')}`);
    analytics.close();
    wss.close(); server.close(() => process.exit(0));
    // Long enough for the persist writes above to land before the process
    // goes. They are fire-and-forget promises, so exiting immediately would
    // throw away the very thing this block exists to save.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
