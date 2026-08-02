// Soak test: runs a real room for a while with four connected clients and
// reports what it costs — bandwidth per client, tick health, waves survived.
// Answers the questions the smoke test does not: does it leak, does it keep up,
// and is it cheap enough to leave running.
//
//   node test/soak.js [seconds]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const SECONDS = +(process.argv[2] || 60);
const PORT = 8098;
const WS_URL = `ws://127.0.0.1:${PORT}/ivaangames/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  cwd: fileURLToPath(new globalThis.URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErrors = 0;
child.stdout.on('data', d => process.stdout.write('[srv] ' + d));
child.stderr.on('data', d => { serverErrors++; process.stderr.write('[srv!] ' + d); });

function mkClient(name) {
  const ws = new WebSocket(WS_URL);
  const c = { name, ws, bytes: 0, snaps: 0, last: {}, open: new Promise(r => ws.once('open', r)) };
  ws.on('message', raw => {
    c.bytes += raw.length;
    const m = JSON.parse(raw);
    c.last[m.type] = m;
    if (m.type === 's') c.snaps++;
  });
  c.send = o => ws.send(JSON.stringify(o));
  return c;
}

async function main() {
  for (let i = 0; i < 60; i++) {
    try {
      const p = new WebSocket(WS_URL);
      await new Promise((res, rej) => { p.once('open', res); p.once('error', rej); });
      p.close(); break;
    } catch { await sleep(100); }
  }

  const cs = [mkClient('p1'), mkClient('p2'), mkClient('p3'), mkClient('p4')];
  await Promise.all(cs.map(c => c.open));
  cs.forEach((c, i) => c.send({ type: 'hello', name: 'P' + (i + 1) }));
  await sleep(300);

  cs[0].send({ type: 'create', name: 'Soak', isPublic: false, partySize: 4, map: 'random' });
  await sleep(400);
  const code = cs[0].last.joined.room.code;
  for (let i = 1; i < 4; i++) { cs[i].send({ type: 'join', code }); await sleep(150); }
  cs[0].send({ type: 'start' });
  await sleep(600);
  console.log(`room ${code} started — 4 seats, map ${cs[0].last.start.info.map.name}`);

  // Seed a real defence so the sim has plenty to chew on, then keep buying.
  const KITS = { 1:['pistol','gatling','minigun','launcher'], 2:['blade','greatsword'],
                 3:['rifleBot','bladeBot','medicBot','gunCrew'], 4:['sniper','flak','laser','railgun','plasma'] };
  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  let builds = 0;

  const buyer = setInterval(() => {
    for (let seat = 1; seat <= 4; seat++) {
      const c = cs[seat - 1];
      const kit = KITS[seat];
      const k = kit[Math.floor(Math.random() * kit.length)];
      const cc = Math.floor(Math.random() * 22), rr = Math.floor(Math.random() * 15);
      if (seat === 3) c.send({ type:'i', a:'deploy', k, x: cc * 40 + 20, y: rr * 40 + 20 });
      else c.send({ type:'i', a:'build', k, c: cc, r: rr });
      c.send({ type:'i', a:'cursor', c: cc, r: rr, k });
      builds++;
    }
  }, 700);

  // Push waves along rather than waiting out every countdown.
  const waver = setInterval(() => cs[0].send({ type:'i', a:'wave' }), 2500);

  let peakEnemies = 0, peakSnapBytes = 0;
  const sampler = setInterval(() => {
    const s = cs[0].last.s && cs[0].last.s.s;
    if (!s) return;
    peakEnemies = Math.max(peakEnemies, s.E.length / 7);
    peakSnapBytes = Math.max(peakSnapBytes, JSON.stringify(cs[0].last.s).length);
  }, 250);

  await sleep(SECONDS * 1000);
  clearInterval(buyer); clearInterval(waver); clearInterval(sampler);

  const secs = (Date.now() - t0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  const s = cs[0].last.s.s;
  const totalBytes = cs.reduce((n, c) => n + c.bytes, 0);

  console.log('\n─── soak result ───────────────────────────────');
  console.log(`duration            ${secs.toFixed(1)}s`);
  console.log(`wave reached        ${s.w}`);
  console.log(`enemies killed      ${s.k}`);
  console.log(`towers standing     ${s.T.length / 12}`);
  console.log(`bots deployed       ${s.B.length / 14}`);
  console.log(`peak enemies        ${peakEnemies}`);
  console.log(`build attempts      ${builds}`);
  console.log(`snapshots / client  ${cs[0].snaps}  (${(cs[0].snaps / secs).toFixed(1)} Hz)`);
  console.log(`peak snapshot       ${(peakSnapBytes / 1024).toFixed(1)} KB uncompressed`);
  console.log(`bandwidth / client  ${(cs[0].bytes / secs / 1024).toFixed(1)} KB/s on the wire (deflated)`);
  console.log(`bandwidth  4 seats  ${(totalBytes / secs / 1024).toFixed(1)} KB/s`);
  console.log(`server stderr lines ${serverErrors}`);
  console.log('───────────────────────────────────────────────');

  const bad = [];
  if (s.w < 2) bad.push('waves did not advance');
  if (cs[0].snaps / secs < 8) bad.push('snapshot rate below 8 Hz');
  if (serverErrors > 0) bad.push('server wrote to stderr');
  if (bad.length) { console.log('PROBLEMS: ' + bad.join('; ')); process.exitCode = 1; }
  else console.log('healthy');

  cs.forEach(c => c.ws.close());
  await sleep(200);
}

main().then(() => { child.kill('SIGTERM'); setTimeout(() => process.exit(process.exitCode || 0), 300); })
      .catch(e => { console.error('soak crashed:', e); child.kill('SIGTERM'); process.exit(1); });
