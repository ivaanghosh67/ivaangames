// Verifies the deployed game through the public URL — TLS, nginx's WebSocket
// upgrade, and the live service. Unlike the smoke test this spawns nothing; it
// talks to whatever is actually running.
//
//   node test/prod-check.js [wss://host/ivaangames/ws]
//
// Creates a PRIVATE room so it never shows up in the public browser, and
// leaves it behind cleanly.

import { WebSocket } from 'ws';

const WS_URL = process.argv[2] || 'wss://buildwithsumit.com/ivaangames/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '  ok  ' : '  FAIL'}  ${label}`); if (!cond) failures++; };

function mk(name) {
  const ws = new WebSocket(WS_URL);
  const c = { name, ws, last: {}, snaps: 0, waiters: [], queue: new Map() };
  c.open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    c.last[m.type] = m;
    if (m.type === 's') c.snaps++;
    const i = c.waiters.findIndex(w => w.type === m.type);
    if (i >= 0) return void c.waiters.splice(i, 1)[0].res(m);
    if (m.type === 's') return;
    if (!c.queue.has(m.type)) c.queue.set(m.type, []);
    c.queue.get(m.type).push(m);
  });
  c.send = o => ws.send(JSON.stringify(o));
  c.wait = (type, ms = 8000) => {
    const q = c.queue.get(type);
    if (q && q.length) return Promise.resolve(q.shift());
    return new Promise((res, rej) => {
      const w = { type, res };
      c.waiters.push(w);
      setTimeout(() => {
        const i = c.waiters.indexOf(w);
        if (i >= 0) { c.waiters.splice(i, 1); rej(new Error(`${name}: timed out waiting for '${type}'`)); }
      }, ms);
    });
  };
  return c;
}

async function main() {
  console.log(`checking ${WS_URL}\n`);
  const t0 = Date.now();
  const a = mk('a'), b = mk('b');
  await Promise.all([a.open, b.open]);
  ok(true, `WebSocket upgrade succeeded through TLS (${Date.now() - t0} ms)`);

  a.send({ type: 'hello', name: 'ProbeHost' });
  const w = await a.wait('welcome');
  ok(!!w.token, 'handshake completed');
  b.send({ type: 'hello', name: 'ProbeGuest' });
  await b.wait('welcome');

  a.send({ type: 'create', name: 'prod-check (ignore)', isPublic: false, partySize: 2, map: 'Iron Line' });
  const created = await a.wait('joined');
  const code = created.room.code;
  ok(/^[A-Z0-9]{5}$/.test(code), `room created (${code})`);
  ok(created.room.isPublic === false, 'probe room is private');

  b.send({ type: 'join', code });
  const joined = await b.wait('joined');
  ok(joined.seat === 2, 'second player seated');

  a.send({ type: 'start' });
  const started = await a.wait('start');
  ok(started.info.map.name === 'Iron Line', 'run started on the requested map');

  const s = await a.wait('s');
  ok(s.s.gp[0] === 250 && s.s.gp[1] === 250, `each seat has its own 250 gold (${s.s.gp.slice(0, 2)})`);

  a.send({ type: 'i', a: 'build', k: 'pistol', c: 3, r: 3 });
  await sleep(600);
  ok(a.last.s.s.T.length >= 11, 'a build round-tripped through the live server');
  ok(a.last.s.s.gp[0] === 210, `seat 1's own purse was debited 40 (${a.last.s.s.gp[0]})`);
  ok(a.last.s.s.gp[1] === 250, "seat 2's purse was untouched");

  // latency probe
  const pings = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    a.send({ type: 'ping', t });
    await a.wait('pong');
    pings.push(Date.now() - t);
    await sleep(120);
  }
  pings.sort((x, y) => x - y);
  console.log(`  ..    round-trip median ${pings[2]} ms (min ${pings[0]}, max ${pings[4]})`);

  await sleep(1200);
  ok(a.snaps > 8, `steady snapshot stream (${a.snaps} in ~2 s)`);

  a.send({ type: 'leave' }); b.send({ type: 'leave' });
  await sleep(300);
  a.ws.close(); b.ws.close();
}

main()
  .then(() => { console.log(failures ? `\n${failures} check(s) FAILED` : '\nproduction looks healthy'); process.exit(failures ? 1 : 0); })
  .catch(e => { console.error('\nprod check failed:', e.message); process.exit(1); });
