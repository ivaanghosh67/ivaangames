// Read the analytics trail and answer the questions that change the game.
//
//   node tools/analyze.js [days]        # default: everything on disk
//   node tools/analyze.js 7             # last 7 days
//
// Deliberately opinionated: it reports the handful of things that actually
// drive design decisions, rather than dumping every counter and leaving the
// reading to you.

import fs from 'node:fs';
import path from 'node:path';
import { TOWERS, BOTS } from '../sim/constants.js';

const DIR = process.env.IRONLINE_DATA_DIR || '/var/lib/ironline/analytics';
const DAYS = +(process.argv[2] || 0);

if (!fs.existsSync(DIR)) {
  console.error(`no analytics directory at ${DIR}`);
  process.exit(1);
}
let files = fs.readdirSync(DIR).filter(f => /^runs-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
if (DAYS > 0) files = files.slice(-DAYS);
if (!files.length) { console.error('no analytics files yet — play a game first'); process.exit(1); }

const events = [];
for (const f of files) {
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a torn last line is fine */ }
  }
}

const by = t => events.filter(e => e.e === t);
const starts = by('run_start'), ends = by('run_end');
const waveStarts = by('wave_start'), waveClears = by('wave_clear'), actions = by('action');

const pct = (n, d) => d ? (n / d * 100).toFixed(0) + '%' : '—';
const bar = (n, max, w = 28) => '█'.repeat(Math.round(n / (max || 1) * w));
const h = s => console.log('\n\x1b[1m' + s + '\x1b[0m\n' + '─'.repeat(s.length));

console.log(`Iron Line — ${events.length.toLocaleString()} events across ${files.length} day(s)`);
console.log(`${starts.length} runs started, ${ends.length} finished`);

// ── who plays, and how ──────────────────────────────────────────────────────
h('Party sizes');
const parties = {};
for (const s of starts) parties[s.party] = (parties[s.party] || 0) + 1;
const pmax = Math.max(...Object.values(parties), 1);
for (const p of [1, 2, 3, 4]) {
  if (!parties[p]) continue;
  console.log(`  ${p}p  ${String(parties[p]).padStart(4)}  ${bar(parties[p], pmax)}`);
}

// ── how runs end: the difficulty curve, in one table ───────────────────────
h('Where runs end');
const deaths = {};
let wins = 0;
for (const e of ends) {
  if (e.reason === 'restarted') continue;
  if (e.won) { wins++; continue; }
  deaths[e.wave] = (deaths[e.wave] || 0) + 1;
}
const dmax = Math.max(...Object.values(deaths), 1);
const waveKeys = Object.keys(deaths).map(Number).sort((a, b) => a - b);
for (const w of waveKeys) {
  const boss = w % 5 === 0 ? ' ← boss wave' : '';
  console.log(`  wave ${String(w).padStart(2)}  ${String(deaths[w]).padStart(4)}  ${bar(deaths[w], dmax)}${boss}`);
}
const finished = ends.filter(e => e.reason !== 'restarted').length;
console.log(`\n  won ${wins}/${finished} (${pct(wins, finished)})`);
const abandoned = ends.filter(e => e.reason === 'abandoned').length;
console.log(`  abandoned mid-run: ${abandoned} (${pct(abandoned, finished)})`);

// ── which wave is the wall ─────────────────────────────────────────────────
h('Per-wave difficulty');
console.log('  wave  reached  cleared  survival  avg secs  avg leaks');
const reached = {}, cleared = {}, secs = {}, leaks = {};
for (const w of waveStarts) reached[w.wave] = (reached[w.wave] || 0) + 1;
for (const w of waveClears) {
  cleared[w.wave] = (cleared[w.wave] || 0) + 1;
  (secs[w.wave] ||= []).push(w.secs);
  (leaks[w.wave] ||= []).push(w.leaked);
}
const avg = a => a && a.length ? (a.reduce((x, y) => x + y, 0) / a.length) : 0;
for (const w of Object.keys(reached).map(Number).sort((a, b) => a - b)) {
  const r = reached[w], c = cleared[w] || 0;
  const flag = r >= 5 && c / r < 0.5 ? '  ← wall' : '';
  console.log(`  ${String(w).padStart(4)}  ${String(r).padStart(7)}  ${String(c).padStart(7)}  ` +
    `${pct(c, r).padStart(8)}  ${avg(secs[w]).toFixed(1).padStart(8)}  ${avg(leaks[w]).toFixed(1).padStart(9)}${flag}`);
}

// ── the arsenal: what gets built, and does it earn its cost ────────────────
h('Arsenal — what people build');
const built = {}, sold = {}, upgraded = {};
for (const a of actions) {
  if (!a.k) continue;
  if (a.a === 'build' || a.a === 'deploy') { if (a.ok) built[a.k] = (built[a.k] || 0) + 1; }
  if (a.a === 'sell') sold[a.k] = (sold[a.k] || 0) + 1;
  if (a.a === 'upgrade') upgraded[a.k] = (upgraded[a.k] || 0) + 1;
}
const bmax = Math.max(...Object.values(built), 1);
const allKeys = Object.keys(built).sort((a, b) => built[b] - built[a]);
if (!allKeys.length) console.log('  (no builds recorded yet)');
for (const k of allKeys) {
  const def = TOWERS[k] || BOTS[k];
  console.log(`  ${(def ? def.name : k).padEnd(20)} ${String(built[k]).padStart(5)}  ${bar(built[k], bmax, 20)}`);
}

h('Arsenal — value for money (from finished runs)');
console.log('  unit                  built   gold spent   kills   gold/kill');
const spend = {}, killsBy = {};
for (const e of ends) {
  for (const u of e.standing || []) {
    spend[u.kind] = (spend[u.kind] || 0) + (u.spent || 0);
    killsBy[u.kind] = (killsBy[u.kind] || 0) + (u.kills || 0);
  }
}
const rows = Object.keys(spend).map(k => ({
  k, spent: spend[k], kills: killsBy[k],
  ratio: killsBy[k] ? spend[k] / killsBy[k] : Infinity,
})).sort((a, b) => a.ratio - b.ratio);
if (!rows.length) console.log('  (no finished runs yet)');
for (const r of rows) {
  const def = TOWERS[r.k] || BOTS[r.k];
  console.log(`  ${(def ? def.name : r.k).padEnd(20)} ${String(built[r.k] || 0).padStart(5)}  ` +
    `${String(r.spent).padStart(10)}  ${String(r.kills).padStart(6)}   ` +
    (r.ratio === Infinity ? '     never' : r.ratio.toFixed(1).padStart(9)));
}
console.log('\n  Lower gold/kill is better value. A unit near the bottom with lots of');
console.log('  builds is a trap: people keep buying it and it keeps underperforming.');

// ── regret: what gets sold soon after it is bought ────────────────────────
h('Regret — most-sold units');
const smax = Math.max(...Object.values(sold), 1);
const sortedSold = Object.keys(sold).sort((a, b) => sold[b] - sold[a]).slice(0, 8);
if (!sortedSold.length) console.log('  (nothing sold yet)');
for (const k of sortedSold) {
  const def = TOWERS[k] || BOTS[k];
  const rate = built[k] ? pct(sold[k], built[k]) : '—';
  console.log(`  ${(def ? def.name : k).padEnd(20)} sold ${String(sold[k]).padStart(4)}  ` +
    `(${rate} of builds)  ${bar(sold[k], smax, 16)}`);
}

// ── economy: are people ever able to afford anything ──────────────────────
h('Economy');
const denials = {};
for (const a of actions) if (!a.ok && a.why) denials[a.why] = (denials[a.why] || 0) + 1;
const broke = Object.entries(denials).filter(([w]) => /^need /.test(w)).reduce((n, [, v]) => n + v, 0);
const totalActs = actions.length || 1;
console.log(`  actions attempted        ${actions.length}`);
console.log(`  refused for lack of gold ${broke} (${pct(broke, totalActs)} of everything tried)`);
const topDenials = Object.entries(denials).sort((a, b) => b[1] - a[1]).slice(0, 6);
for (const [w, n] of topDenials) console.log(`    ${String(n).padStart(5)}  ${w}`);
if (broke / totalActs > 0.4) {
  console.log('\n  More than 40% of attempts fail on price — the economy is likely too tight.');
}

// ── co-op fairness: is one seat carrying? ─────────────────────────────────
h('Co-op balance (multi-player runs)');
const multi = ends.filter(e => e.party > 1 && e.score && e.reason !== 'restarted');
if (!multi.length) console.log('  (no multi-player runs finished yet)');
else {
  let lopsided = 0;
  const shares = [];
  for (const e of multi) {
    const s = Object.values(e.score).slice(0, e.party).map(Number);
    const total = s.reduce((a, b) => a + b, 0) || 1;
    const top = Math.max(...s) / total;
    shares.push(top);
    if (top > 0.6) lopsided++;
  }
  console.log(`  runs analysed            ${multi.length}`);
  console.log(`  top player's average share of kills  ${(avg(shares) * 100).toFixed(0)}%`);
  console.log(`  runs where one player took >60%      ${lopsided} (${pct(lopsided, multi.length)})`);
  if (lopsided / multi.length > 0.5)
    console.log('\n  One seat is usually carrying — worth checking whether position or\n  starting gold advantages an early seat.');
}

h('Session length');
const mins = ends.filter(e => e.minutes).map(e => e.minutes).sort((a, b) => a - b);
if (mins.length) {
  const med = mins[Math.floor(mins.length / 2)];
  console.log(`  median run   ${med.toFixed(1)} min`);
  console.log(`  shortest     ${mins[0].toFixed(1)} min`);
  console.log(`  longest      ${mins[mins.length - 1].toFixed(1)} min`);
}
console.log('');
