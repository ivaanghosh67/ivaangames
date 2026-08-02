// Companion for a real-browser test. Creates a room, prints the invite code,
// then reports every roster change and (once a browser has joined) starts the
// run and watches what that browser actually does to the shared game.
//
//   node test/await-join.js [wss://host/ivaangames/ws] [seconds]

import { WebSocket } from 'ws';

const WS_URL = process.argv[2] || 'wss://buildwithsumit.com/ivaangames/ws';
const SECS = +(process.argv[3] || 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ws = new WebSocket(WS_URL);
const send = o => ws.send(JSON.stringify(o));
let code = null, started = false, snaps = 0, lastSnap = null;
let sawBrowser = false, browserBuilt = false, browserCursor = false;

const ts = () => new Date().toISOString().slice(11, 23);
ws.on('open', () => { console.log(ts() + ' socket open'); send({ type: 'hello', name: 'TestHost' }); });
ws.on('close', (c, r) => console.log(`${ts()} socket CLOSED code=${c} reason=${r}`));
ws.on('error', e => console.log(`${ts()} socket ERROR ${e.message}`));
ws.on('ping', () => console.log(ts() + ' <- server ping'));
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'welcome') {
    send({ type: 'create', name: 'browser check', isPublic: false, partySize: 2, map: 'Iron Line' });
  }
  if (m.type === 'joined') {
    code = m.room.code;
    console.log('CODE=' + code);
  }
  if (m.type === 'lobby') {
    const names = m.roster.map(r => `${r.seat}:${r.name}${r.online ? '' : '(off)'}`).join(' ');
    console.log('roster → ' + names);
    if (m.roster.some(r => r.seat === 2 && r.online)) {
      if (!sawBrowser) {
        sawBrowser = true;
        console.log('BROWSER_JOINED');
        setTimeout(() => { if (!started) { started = true; send({ type: 'start' }); console.log('starting run'); } }, 700);
      }
    }
  }
  if (m.type === 'chat') console.log('chat ← ' + m.line.name + ': ' + m.line.text);
  if (m.type === 's') {
    snaps++;
    lastSnap = m.s;
    // did the browser's seat do anything?
    for (let i = 0; i < m.s.T.length; i += 11) if (m.s.T[i + 6] === 2) browserBuilt = true;
    for (let i = 0; i < m.s.B.length; i += 13) if (m.s.B[i + 9] === 2) browserBuilt = true;
    for (let i = 0; i < m.s.C.length; i += 4) if (m.s.C[i] === 2 && m.s.C[i + 3] >= 0) browserCursor = true;
  }
});

setTimeout(() => {
  console.log('--- result ---');
  console.log('browser joined     ' + sawBrowser);
  console.log('run started        ' + started);
  console.log('snapshots seen     ' + snaps);
  console.log('browser cursor     ' + browserCursor);
  console.log('browser built      ' + browserBuilt);
  if (lastSnap) console.log(`wave ${lastSnap.w}  gold ${lastSnap.g}  towers ${lastSnap.T.length / 11}  enemies ${lastSnap.E.length / 7}`);
  ws.close();
  process.exit(sawBrowser ? 0 : 1);
}, SECS * 1000);
