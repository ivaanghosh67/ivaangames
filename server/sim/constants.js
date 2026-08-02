// Iron Line — shared game constants.
// These values are copied verbatim from iron-line.html so the authoritative
// server simulates exactly the game people already know. The server ships this
// table to clients on join (see `welcome` in server.js) so the shop can never
// drift out of sync with what the server actually charges.

export const TS = 40, COLS = 22, ROWS = 15, W = COLS * TS, H = ROWS * TS;
export const TAU = Math.PI * 2;
export const MAXLVL = 10;
// Solo is a 50-wave run. With a partner (or three) you have several economies
// and several sets of guns, so the campaign runs to 100.
export const MAXWAVE = 50;
export const maxWaveFor = players => (players > 1 ? 100 : 50);
export const MAXLIVES = 45;
export const BASE_SQUADS = 6;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const dist = (a, b, c, d) => Math.hypot(a - c, b - d);

export const MAPS = [
  { name: 'Iron Line',  way: [[-1,2],[4,2],[4,6],[1,6],[1,11],[9,11],[9,4],[14,4],[14,12],[18,12],[18,7],[22,7]] },
  { name: 'Switchback', way: [[-1,7],[3,7],[3,2],[7,2],[7,12],[11,12],[11,2],[15,2],[15,12],[19,12],[19,7],[22,7]] },
  { name: 'The Coil',   way: [[-1,12],[18,12],[18,2],[3,2],[3,9],[13,9],[13,5],[8,5],[8,7],[22,7]] },
  { name: 'Long March', way: [[-1,1],[20,1],[20,4],[2,4],[2,7],[20,7],[20,10],[2,10],[2,13],[22,13]] },
  { name: 'Crossroads', way: [[-1,4],[6,4],[6,1],[16,1],[16,8],[6,8],[6,13],[13,13],[13,10],[22,10]] },
  { name: 'Hairpin',    way: [[-1,13],[5,13],[5,3],[10,3],[10,11],[15,11],[15,3],[19,3],[19,9],[22,9]] },
];

export const TOWERS = {
  pistol:{ name:'Pistol Turret', cat:'gun', cost:40, color:'#7fd67f', glyph:'🔫',
    desc:'Fast single shots · hits air', dmg:11, range:114, rate:1.8, bullet:5.4,
    air:true, splash:0, slow:0, pierce:false, melee:false },
  gatling:{ name:'Gatling Gun', cat:'gun', cost:95, color:'#ff9f5a', glyph:'⚙',
    desc:'Spins up to a shredding rate', dmg:5.5, range:106, rate:6.5, bullet:8,
    air:true, splash:0, slow:0, pierce:false, melee:false, spinup:true },
  minigun:{ name:'Minigun Nest', cat:'gun', cost:500, color:'#ff5fa2', glyph:'🪖',
    desc:'Heavy calibre · sprays 2 targets · 15 hits drops the first boss', dmg:264, range:120, rate:1.0, bullet:7,
    air:true, splash:0, slow:0, pierce:false, melee:false, multi:2 },
  launcher:{ name:'Grenade Launcher', cat:'gun', cost:80, color:'#f0c14a', glyph:'💣',
    desc:'Splash damage · ground only', dmg:27, range:130, rate:.62, bullet:3.4,
    air:false, splash:48, slow:0, pierce:false, melee:false },
  sniper:{ name:'Sniper Rifle', cat:'gun', cost:130, color:'#63d6f0', glyph:'🎯',
    desc:'Huge range · ignores armour', dmg:84, range:266, rate:.42, bullet:0,
    air:true, splash:0, slow:0, pierce:true, melee:false, hitscan:true },
  flak:{ name:'Flak Cannon', cat:'gun', cost:175, color:'#9be7ff', glyph:'🎇', lock:1,
    desc:'Airburst splash · air targets only', dmg:34, range:152, rate:1.1, bullet:6,
    air:true, noGround:true, splash:56, slow:0, pierce:false, melee:false },
  laser:{ name:'Laser Lance', cat:'gun', cost:260, color:'#ff4d6d', glyph:'🔦', lock:2,
    desc:'Held beam that ramps up on one target · pierces armour', dmg:13, range:150, rate:6, bullet:0,
    air:true, splash:0, slow:0, pierce:true, melee:false, beam:true },
  railgun:{ name:'Railgun Battery', cat:'gun', cost:340, color:'#ffd166', glyph:'⚡', lock:3,
    desc:'Pierces every enemy in a line · ignores armour', dmg:190, range:250, rate:.5, bullet:0,
    air:true, splash:0, slow:0, pierce:true, melee:false, line:true },
  plasma:{ name:'Plasma Mortar', cat:'gun', cost:400, color:'#b388ff', glyph:'☄', lock:4,
    desc:'Massive splash · hits air and ground', dmg:120, range:170, rate:.5, bullet:3.2,
    air:true, splash:80, slow:.25, pierce:false, melee:false },
  blade:{ name:'Blade Sentry', cat:'sword', cost:70, color:'#c9d6e4', glyph:'🗡',
    desc:'Sweeps every ground enemy near it', dmg:20, range:64, rate:2.1, bullet:0,
    air:false, splash:0, slow:0, pierce:false, melee:true },
  greatsword:{ name:'Greatsword Guard', cat:'sword', cost:170, color:'#ff7a7a', glyph:'⚔',
    desc:'Heavy cleave · staggers (slows)', dmg:78, range:80, rate:.75, bullet:0,
    air:false, splash:0, slow:.5, pierce:false, melee:true },
};
export const TKEYS = Object.keys(TOWERS);

// ── quests ────────────────────────────────────────────────────────────────
// The four heavy weapons are earned, not given. Each has a quest whose
// progress is measured from things the simulation already counts, so nothing
// here needs special-case plumbing in the game loop.
//
//   cumulative: totals that carry across every run you play
//   best:       a high-water mark from a single run
export const QUESTS = [
  { gun:'flak', name:'Ground the Flight', kind:'cumulative', stat:'flyerKills', target:120,
    desc:'Shoot down 120 flyers', hint:'Flyers ignore the road and cut straight for the keep.' },
  { gun:'laser', name:'Hold the Line', kind:'best', stat:'bestWave', target:15,
    desc:'Reach wave 15 in a single run', hint:'Survive deep enough to prove the line holds.' },
  { gun:'railgun', name:'Armour Piercing', kind:'cumulative', stat:'bossKills', target:10,
    desc:'Destroy 10 bosses', hint:'Bosses arrive every wave from five onward.' },
  { gun:'plasma', name:'Scorched Earth', kind:'best', stat:'bestWave', target:30,
    desc:'Reach wave 30 in a single run', hint:'The long game. Bring everything you have.' },
];
export const QUEST_STATS = ['flyerKills', 'bossKills', 'bestWave'];

/** Which guns a given progress record has earned. */
export function unlockedFrom(progress) {
  const p = progress || {};
  const out = new Set();
  for (const q of QUESTS) {
    const have = +p[q.stat] || 0;
    if (have >= q.target) out.add(q.gun);
  }
  return out;
}

export const BOTS = {
  rifleBot:{ name:'Rifle Bot', cost:95, color:'#8fe38f', glyph:'🤖',
    desc:'Marches where you send it, shoots air + ground', hp:130, dmg:10, rate:2.1, range:138,
    speed:0, move:64, block:false, air:true, heal:0 },
  bladeBot:{ name:'Blade Bot', cost:125, color:'#dfe7ef', glyph:'🤺',
    desc:'Charges out and body-blocks ground foes', hp:290, dmg:18, rate:1.7, range:30,
    speed:78, move:78, block:true, air:false, heal:0, leash:105 },
  medicBot:{ name:'Medic Bot', cost:145, color:'#6ee7a8', glyph:'🚑',
    desc:'Walking medic — repairs damaged units nearby', hp:170, dmg:0, rate:1.0, range:125,
    speed:0, move:70, block:false, air:false, heal:22 },
  gunCrew:{ name:'Gun Crew', cost:165, color:'#ffcf6b', glyph:'👥',
    desc:'Two people on foot — turrets they stand by fire faster', hp:200, dmg:7, rate:1.5, range:114,
    speed:0, move:58, block:false, air:true, heal:0, crew:true, buff:.35 },
};
export const BKEYS = Object.keys(BOTS);

export const HEALS = {
  bandage:{ name:'Bandage', glyph:'🩹', cost:35, lives:3, color:'#f2c14e', desc:'Patch the line · +3 lives' },
  medkit:{  name:'Medkit',   glyph:'🧰', cost:90, lives:9, color:'#6ee7a8', desc:'Field surgery · +9 lives' },
};

export const ENEMIES = {
  grunt: {name:'Grunt', hp:58,  speed:52, gold:6,  armor:0, r:11, dps:9,  color:'#7ec96b', fly:false},
  runner:{name:'Runner',hp:38,  speed:112,gold:5,  armor:0, r:9,  dps:7,  color:'#ffe066', fly:false},
  tank:  {name:'Tank',  hp:300, speed:34, gold:17, armor:4, r:15, dps:28, color:'#8fa7c4', fly:false},
  flyer: {name:'Flyer', hp:74,  speed:88, gold:11, armor:1, r:11, dps:0,  color:'#d18bff', fly:true },
  boss:  {name:'BOSS',  hp:800, speed:29, gold:220,armor:7, r:22, dps:75, color:'#ff6b6b', fly:false},
  ultra: {name:'ULTRA BOSS', hp:800, speed:21, gold:3000, armor:18, r:36, dps:220,
          color:'#ff2d6f', fly:false, ultra:true},
};
// Enemy types get a stable numeric index so snapshots can send a byte, not a string.
export const EKEYS = Object.keys(ENEMIES);

export const hpScale = n => 1 + .36 * (n - 1) + .048 * (n - 1) * (n - 1);
export const bossHp = n => 800 * hpScale(n) * 1.5;
export const goldScale = n => 1 + .04 * (n - 1);
export const armorOf = (base, n) => base + Math.floor(n / 6);

// ── difficulty ────────────────────────────────────────────────────────────
// Four explicit tiers the host picks, plus the party-size scaling that keeps
// co-op honest. Measured headroom (firepower ÷ incoming health) on Regular sits
// near 1.5-2× for a competent player; Iron pulls that under 1.
// Tuned by measurement, not feel. A reference bot reaches roughly wave 20 / 11 /
// 7 / 5 across these four; a competent human gets considerably further. The
// first attempt spaced them far too wide — Veteran and Iron both ended runs by
// wave 3, which is not a difficulty setting, it is a wall.
export const DIFFICULTY = {
  recruit: { name:'Recruit', hp:0.85, count:0.92, income:1.15, lives:25,
             desc:'Forgiving. Learn the maps.' },
  regular: { name:'Regular', hp:1.00, count:1.00, income:1.00, lives:20,
             desc:'The intended fight.' },
  veteran: { name:'Veteran', hp:1.15, count:1.08, income:0.92, lives:16,
             desc:'Tighter economy, real pressure.' },
  iron:    { name:'Iron',    hp:1.32, count:1.16, income:0.84, lives:12,
             desc:'Every mistake costs the run.' },
};
export const DKEYS = Object.keys(DIFFICULTY);
export const diffOf = k => DIFFICULTY[k] || DIFFICULTY.regular;

/**
 * How much bigger a wave gets per extra player.
 *
 * Co-op used to be free: four players brought four separate economies to one
 * unchanged wave, so a party had ~4× the income against ~1× the threat
 * (measured headroom at wave 1 was 3.8× solo versus 18.5× for four).
 *
 * The scaling goes on enemy COUNT rather than health, deliberately. Bounties
 * are paid per kill, so more enemies means proportionally more gold — each
 * player ends up earning and facing roughly one solo game's worth. Scaling
 * health instead would multiply the threat while leaving total income flat,
 * which starves the party rather than challenging it.
 */
// Tunable so the balance sweep can search it without editing source. In the
// browser, and in production, it is simply the constant below.
export const PARTY_COEFF =
  (typeof process !== 'undefined' && process.env && +process.env.IRONLINE_PARTY_COEFF) || 0.8;
export const partyScale = players => 1 + PARTY_COEFF * (Math.max(1, players) - 1);

/**
 * Bosses arrive from wave 5, but a wave-5 boss at full strength is the wall
 * every measured solo run died on. This ramps the first few from 45% up to
 * full by wave 12 — the boss still shows up on schedule, it just is not an
 * instant loss before you have an economy.
 */
export const bossRamp = n => (n >= 12 ? 1 : 0.45 + 0.55 * Math.max(0, n - 5) / 7);

/**
 * Late-game escalation.
 *
 * Measured on a real run: a full board of 110 level-10 turrets took ZERO leaks
 * from wave 40 all the way to wave 100. The cause was structural — the per-type
 * headcounts are clamped (34 grunts, 26 runners, 22 flyers, 16 tanks) and those
 * clamps bind by about wave 20. After that a wave only ever got tankier, never
 * bigger, and a maxed board's damage is a fixed ceiling that out-paced the
 * quadratic health curve indefinitely.
 *
 * Two levers, deliberately weighted towards health rather than headcount:
 * health is free on the wire, whereas every extra body costs snapshot bandwidth
 * at 15 Hz. The count growth is the smaller number for that reason.
 */
export const lateHp = n => 1 + Math.max(0, n - 25) * 0.12;
export const lateCount = n => 1 + Math.max(0, n - 25) * 0.02;

/**
 * How hard an enemy hits the thing standing in front of it.
 *
 * This was the real reason the late game had no teeth. Enemy *health* grows
 * quadratically with the wave, but their melee damage was a flat constant for
 * the whole game — a wave-60 boss shoved a Blade Bot for exactly the same 75
 * damage a second as a wave-5 boss did. Meanwhile the bot is level 10 with a
 * Medic Bot topping it up. The arithmetic never closes: a blocking bot becomes
 * permanently unkillable, enemies queue up behind it forever, and nothing
 * reaches the flag no matter how far you play.
 *
 * Measured: a maxed board took zero leaks all the way to wave 120. Delete the
 * bots from that same board and it starts leaking at wave 60 — the bots were
 * the whole story.
 *
 * Damage now grows as the square root of health, so a bot is a speed bump you
 * rotate rather than a wall you install once.
 *
 * Offset so it is exactly 1× through wave 10 and only climbs after. The plain
 * root was already 1.79× at wave 5, which is the very wave bosses first appear
 * and the one bossRamp exists to soften — it halved how long a fresh Blade Bot
 * could hold the first boss, and the reference 4-player runs fell from wave 26
 * to wave 5 on that alone. The complaint was that the LATE game had no teeth;
 * making the opening harder was never part of it.
 *
 * Costs almost nothing at the far end: wave 60 lands at 11.9× instead of 13.8×,
 * still far past what a Medic Bot can sustain.
 */
const MELEE_FLAT_TO = 10;
export const meleeScale = n =>
  Math.max(1, Math.sqrt(hpScale(n)) - Math.sqrt(hpScale(MELEE_FLAT_TO)) + 1);

/**
 * Endless mode: keep going past the final wave instead of winning.
 *
 * The existing curve is quadratic in the wave number, so it escalates on its
 * own without any extra multiplier — wave 150 is already brutally harder than
 * wave 100. Endless simply removes the finish line and scores how far past it
 * you get. The wave cap becomes a milestone rather than an ending.
 */
export const ENDLESS_CAP = 400;   // a ceiling purely so numbers stay finite

/**
 * The composition of wave `n` in a run that ends at `maxWave`.
 *
 * The `m = n * 2` compression is inherited from the original 50-wave design:
 * it makes each wave's headcount grow as if the campaign were twice as long.
 * A 100-wave run keeps it, so the back half is genuinely punishing rather than
 * a stretched-out version of the front half.
 */
export function waveDef(n, maxWave = MAXWAVE, players = 1, diffKey = 'regular') {
  const D = diffOf(diffKey);
  // Party scaling and the difficulty tier both act on headcount, and both also
  // lift the per-group ceilings — otherwise a 4-player Iron wave would cap out
  // at exactly the same 34 grunts a solo Recruit wave does.
  const mul = partyScale(players) * D.count;
  const late = lateCount(n);            // waves must keep GROWING, not just tanking
  const cap = (x, m) => Math.max(1, Math.min(Math.round(m * mul * late), Math.round(x * mul * late)));
  // Spawn gaps tighten by only the SQUARE ROOT of the multiplier. Dividing them
  // by the full multiplier keeps the wave the same length while tripling its
  // size, which lands the whole thing as one unkillable blob — measured, that
  // killed every party run by wave 6. This way a bigger wave is partly more
  // enemies and partly a longer wave, and instantaneous pressure stays sane.
  const gm = Math.sqrt(mul);
  const m = n * 2;
  const w = [{ t:'grunt', c:cap(6 + m * 1.15, 34), g:Math.max(.22, .85 - m * .012) / gm }];
  if (n >= 2) w.push({ t:'runner', c:cap(3 + m * .7, 26), g:Math.max(.18, .45 - m * .004) / gm });
  if (n >= 3) w.push({ t:'flyer',  c:cap(2 + m * .5, 22), g:Math.max(.24, .6 - m * .005) / gm });
  if (n >= 4) w.push({ t:'tank',   c:cap(1 + m / 3.2, 16), g:Math.max(.38, 1.05 - m * .007) / gm });
  // From wave 5 on, every wave brings a boss, and one more every ten waves:
  // 1 from wave 5, 2 from 15, 3 from 25 … 10 at wave 100.
  //
  // Deliberately a plain step rather than a step plus a milestone bonus. Adding
  // an extra boss on round numbers made the count dip (wave 10 got two, wave 15
  // got one), so the run briefly got easier as it went. It also must not key
  // off multiples of five, which would double wave 5 — already the wave most
  // runs die on, and the game's first real test.
  // Bosses scale with the party too, but on a gentler curve — four players
  // facing four times the bosses turns every wave into a boss rush.
  if (n >= 5) {
    const base = 1 + Math.floor((n - 5) / 10);
    w.push({ t:'boss', c:Math.max(1, Math.round(base * (1 + 0.4 * (Math.max(1, players) - 1)))), g:2.2 });
  }
  // the three Ultra Bosses land on the penultimate wave, whatever the length
  if (n === maxWave - 1) w.push({ t:'ultra', c:Math.max(3, Math.round(3 * partyScale(players))), g:6 });
  return w;
}

export function statsOf(type, lvl) {
  const b = TOWERS[type], k = lvl - 1;
  return { dmg:b.dmg * Math.pow(1.46, k), range:b.range * Math.pow(b.melee ? 1.05 : 1.07, k),
    rate:b.rate * Math.pow(1.1, k), splash:b.splash ? b.splash * Math.pow(1.06, k) : 0,
    slow:b.slow ? Math.min(.78, b.slow + .04 * k) : 0 };
}
export function botStats(kind, lvl) {
  const b = BOTS[kind], k = lvl - 1;
  return { hp:b.hp * Math.pow(1.38, k), dmg:b.dmg * Math.pow(1.44, k), heal:b.heal * Math.pow(1.4, k),
    range:b.range * Math.pow(1.05, k), rate:b.rate * Math.pow(1.07, k) };
}

// ── party kits ────────────────────────────────────────────────────────────
// Every seat gets the entire arsenal. The couch game used to slice it up
// (seat 1 guns, seat 2 swords, …) but online that mostly meant watching a
// teammate hold the piece you wanted, so co-op is now fully shared: anyone can
// build anything, anyone can upgrade or sell anything, gold and lives are
// pooled. Kills are still attributed per seat, so the scoreboard still means
// something.
export const PCOL = { 1:'#4aa8ff', 2:'#ff9f5a', 3:'#6ee7a8', 4:'#c58bff' };
export const MODES = { 1:'Solo', 2:'Duo', 3:'Trio', 4:'Squad' };

export function kitOf(pl, players) { return [...TKEYS, ...BKEYS]; }
export function kitName(pl, players) { return 'Full arsenal'; }
export const canUse = (pl, k, players) => !!(TOWERS[k] || BOTS[k]);

export const upCostOf = (def, lvl) => Math.round(def.cost * .78 * Math.pow(lvl, 1.25));

/**
 * What a turret costs, given how many the buyer already owns.
 *
 * Flat build costs let a real 2-player run reach 110 turrets by wave 60 and then
 * flat-line: the map was full, gold piled up past 100,000 with nothing to spend
 * it on, and 110 maxed turrets out-damaged anything the wave curve could throw.
 * Sprawl was strictly better than depth, and the late game stopped being a game.
 *
 * Now each turret makes the next one dearer, so gold flows into LEVELS instead
 * of tile count — and levels are where the interesting decisions live, because
 * damage compounds at 46% each.
 *
 * The first `BUILD_FREE` are full price, which leaves the opening exactly as it
 * was; escalation only bites once you are established. The multiplier is capped
 * so numbers stay readable rather than becoming astronomical.
 */
export const BUILD_FREE = 8;
export const BUILD_STEP = 1.06;
export const BUILD_CAP = 40;
export const buildMul = owned =>
  Math.min(BUILD_CAP, Math.pow(BUILD_STEP, Math.max(0, owned - BUILD_FREE)));
export const buildCostOf = (def, owned) => Math.round(def.cost * buildMul(owned));

/**
 * How many turrets one player may have standing.
 *
 * Escalating prices were supposed to stop sprawl on their own. They did not,
 * and the telemetry says why: a real 2-player run banked 217,040 and 462,110
 * gold by wave 100. At that kind of money a 40× price multiplier on a 40-gold
 * pistol is still pocket change, so the pair ended on 112 turrets and took
 * ZERO leaks for the last 56 waves straight. Lives sat at maximum. The board
 * had not changed since wave 60 because there was nothing left to decide.
 *
 * Price pressure cannot bound a quantity when income is unbounded — only a
 * limit can. Measured on a best-case board of maxed top-tier guns: 24 turrets
 * breaks at wave 90, 32 breaks at wave 100, 40 never breaks at all. So a duo
 * allowance landing near 32 total puts the failure point right at the end of
 * the campaign, which is where it belongs — you should finish only just
 * holding on.
 *
 * The allowance opens at 10, which no opening can afford anyway (250 starting
 * gold buys six pistols), so the early game is untouched. It only binds late,
 * which is precisely where the game had stopped being one.
 */
export const TOWER_CAP_SOLO = 18;
/**
 * The allowance shrinks as the squad grows, because the road is the same length
 * however many people are defending it. Measured: a *total* board near 26 maxed
 * turrets puts the failure point right at the end of the campaign. A flat
 * per-player allowance blew straight past that — four players fielding 52
 * turrets sailed through wave 100 untouched, which is the same no-fail-state
 * problem in a new costume. Dividing by the root of the party size holds the
 * total near that mark while still giving every seat a real share to command.
 *
 *   solo 18 · duo 13 each (26) · trio 10 each (30) · squad 9 each (36)
 *
 * Flat, not growing with the wave. An allowance that starts small and opens up
 * binds hardest at the beginning, which is exactly backwards — the opening was
 * never the problem. Telemetry has a real duo on 8-9 turrets each by wave 5, so
 * a growing cap would have squeezed their first ten minutes to fix a fault that
 * only appears at wave 44. Flat means it cannot bite until you can afford more
 * than the limit, which is the late game by construction.
 */
export const towerCapOf = (wave, players = 1) =>
  Math.round(TOWER_CAP_SOLO / Math.sqrt(clamp(players | 0, 1, 4)));

/**
 * Build permits — one extra turret slot, at a price that compounds.
 *
 * A hard limit on turrets fixes the difficulty, but it leaves gold with
 * nowhere to go: the same run that ended on 462,110 gold would only bank it
 * faster once there is nothing left to buy. Dead currency from wave 40 on is
 * its own kind of broken — every kill stops meaning anything.
 *
 * So the limit is a price, not a wall. Surplus gold converts back into the one
 * thing that is actually scarce, and because each permit costs 2.1× the last,
 * the sequence bounds itself: at 3,000 to start, six permits cost 231,000
 * altogether and a seventh alone costs more than a whole run earns. A rich
 * player buys a handful of extra guns, not another fifty.
 */
export const PERMIT_BASE = 3000;
export const PERMIT_STEP = 2.1;
export const permitCostOf = bought => Math.round(PERMIT_BASE * Math.pow(PERMIT_STEP, Math.max(0, bought)));
// Medical prices climb harder than they used to. At 1.08 a purchase, a rich
// late-game player simply bought their lives back — one real run regenerated
// from 13 lives to 45 while ignoring leaks entirely, which removed the only
// consequence the game has.
export const healCostOf = (k, bought) => Math.round(HEALS[k].cost * Math.pow(1.18, bought));
