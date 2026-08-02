# Iron Line — online co-op

Iron Line started as a single-file couch game: 1–4 players sharing one keyboard,
each seat owning a slice of the arsenal. Online co-op moves the seats onto
separate computers and changes three things about how the game plays.

**Live at <https://buildwithsumit.com/ivaangames/>.**

---

## How it fits together

```
browser (iron-line.html)                  buildwithsumit.com
┌──────────────────────────┐              ┌────────────────────────────────┐
│ draw()      ← G          │              │ nginx :443                     │
│ input  → intent ─────────┼──WebSocket──▶│  /ivaangames/     → static     │
│ snapshot → G   ◀─────────┼──────────────┼─ /ivaangames/ws   → :8092      │
└──────────────────────────┘              │                                │
                                          │ ironline.service (node 18)     │
                                          │  ├─ Room  ×N                   │
                                          │  │   └─ Sim  (authoritative)   │
                                          │  ├─ 30 Hz scheduler, 15 Hz out │
                                          │  └─ analytics → JSONL          │
                                          └────────────────────────────────┘
```

**The server owns the simulation.** Clients render and ask; they never decide.
A client with edited JavaScript can request anything it likes and the worst it
gets back is a `deny`.

### Why server-authoritative

The alternative — one player's browser hosts and the rest relay through it —
ships faster but gives the host zero latency while everyone else eats theirs,
and the run dies when the host closes their tab. Since `update(dt)` already
operated purely on a single `G` object with rendering cleanly separated, lifting
it into Node was mostly mechanical, so the better architecture was also the
affordable one.

## What changed from the couch game

**Everyone gets the full arsenal.** The original sliced it up by seat (P1 guns,
P2 swords…). Online that mostly meant watching a teammate hold the piece you
wanted, so every seat can now build, upgrade and sell anything.

**Gold is per player, lives are shared.** Your kills fund your purse. Each purse
starts at 250 — the solo figure — so one player's economy feels the same whether
they are alone or in a squad of four. Wave-clear and early-call bonuses pay
everyone in full rather than being split. Selling refunds the unit's **owner**,
not whoever clicked sell, so a teammate can clear space for you without
pocketing your investment. Lives stay shared, because the line is shared.

**Everyone walks the map.** Each seat has an avatar that moves with
arrows/WASD, aims at the cursor, and fires while the mouse is held. Ten carried
guns, per-seat ammo and reloads. All of it is server-simulated, so what you see
is what the server scored — no local shots that "should have hit".

## Layout

| Path | What it is |
|---|---|
| [iron-line.html](iron-line.html) | The whole client. Still plays offline solo/couch with no server. |
| [server/sim/constants.js](server/sim/constants.js) | Tower/bot/enemy/carry-gun tables and the wave curve. |
| [server/sim/sim.js](server/sim/sim.js) | The authoritative simulation, including avatars. |
| [server/sim/intents.js](server/sim/intents.js) | Every legal player action, each re-validated server-side. |
| [server/sim/snapshot.js](server/sim/snapshot.js) | Wire encoding. Flat arrays with a fixed stride. |
| [server/room.js](server/room.js) | One co-op game: seats, host migration, reconnect, broadcast. |
| [server/server.js](server/server.js) | WebSocket, room browser, rate limits, the 30 Hz scheduler. |
| [server/analytics.js](server/analytics.js) | Append-only gameplay trail. |
| [server/tools/analyze.js](server/tools/analyze.js) | Turns that trail into design decisions. |
| [ops/](ops/) | systemd unit, nginx snippet, deploy script. |

## The netcode, briefly

**Tick and send.** The sim steps at a fixed 30 Hz; snapshots go out every second
tick (15 Hz). One `setInterval` drives every room, so idle rooms cost nothing.

**Snapshots are flat.** Each entity list is one array with a fixed stride
(enemies 7, towers 11, bots 14, bullets 5, avatars 8) rather than an array of
objects — no repeated JSON keys. Positions round to whole pixels, angles
quantise to a byte. `ws` deflates the rest. Measured: **~8 KB/s per client**.

**Cosmetics are events, not state.** Particle bursts, floating damage numbers,
laser beams and sword arcs never appear in a snapshot. The server emits them
once and each client spawns and expires its own copies.

**Interpolation.** Clients render between the two most recent snapshots, so
motion stays smooth at 60 fps off a 15 Hz feed. The blend window tracks the
*measured* arrival gap, so a jittery connection degrades instead of stuttering.

**Avatar input is state, not events.** Clients send `{a:'input', ang, d, f, s,
sp, fire}` about 20×/s, and only when it changes (with a 4 Hz heartbeat). The
server integrates from the last packet it heard, so a dropped packet costs
nothing and there is no teleporting.

**Reconnects.** Identity is a token in `localStorage`. Drop out and your seat —
and your towers — are held for 90 seconds. If the host vanishes, the
lowest-seated connected player inherits the room. Empty rooms are collected
after two minutes.

## Rooms

Host picks party size, map, and whether to list the game publicly. Joining is by
5-character code (no vowels, no `0/O/1/I/L`, so it survives being read aloud),
by shareable link (`/ivaangames/?room=ABCDE`), or from the public browser.

Party size is fixed at start — a seat going quiet must not reshuffle the game.
Unlocks are per-room and default to everything, since per-computer progression
would give four players four different arsenals.

## What is deliberately not online

- **First person.** The WebGL first-person mode stays solo-only; it needs
  prediction and lag compensation, and this is the top-down co-op.
- **The admin/cheat panel.** A gift in a solo run, a grief vector in a shared one.
- **Pause and fast-forward.** Time belongs to the server when it is shared.

All three still work exactly as before in offline play.

## Analytics

Every run writes JSONL to `/var/lib/ironline/analytics/runs-YYYY-MM-DD.jsonl`.
Player identity is a SHA-256 prefix of the reconnect token, never the token.

Events: `run_start`, `wave_start`, `wave_clear`, `action` (every decision,
including refusals — repeatedly failing to afford something is a pacing signal),
`run_end` (with per-unit gold spent and kills), `seat`.

```bash
node tools/analyze.js          # everything on disk
node tools/analyze.js 7        # last 7 days
```

Reports where runs end (against the boss waves), per-wave survival rate and the
wave that is a wall, what people build, **gold spent per kill for each unit**,
what gets sold (regret), how often actions fail on price, and whether one seat
is carrying the team.

## Running it

```bash
cd server && npm install
npm start                 # :8092, ws path /ivaangames/ws

node test/smoke.js        # 40 end-to-end checks: join, avatars, economy, reconnect
node test/abuse.js        # 16 checks: exploits, floods, malformed input
node test/deep-sim.js 4   # full 50-wave runs, 1-4 players, invariant checks
node test/simulate.js 2   # network-level multi-client sim with invariant checks
node test/soak.js 75      # bandwidth and tick health
node --expose-gc test/leak.js   # heap under churn and sustained load
```

Point a local client at a local server with
`iron-line.html?server=ws://localhost:8092/ivaangames/ws`.

## Deploying

```bash
bash ops/deploy.sh /path/to/buildwithsumit.pem
```

Copies `server/` to `/opt/ironline`, restarts `ironline.service`, and publishes
the client to `/var/www/html/ivaangames/index.html` (keeping a timestamped
backup). **A deploy restarts the service and ends any run in progress.**

Nginx is a one-time manual step — see
[ops/nginx-ivaangames.conf](ops/nginx-ivaangames.conf). Health check:
`https://buildwithsumit.com/ivaangames/health`.
