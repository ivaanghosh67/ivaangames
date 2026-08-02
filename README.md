# Iron Line

A tower-defence game. Hold the road against fifty waves alone, or a hundred with
friends. Guns, steel, bots, and two nervous guards on the rampart.

**Play now → <https://buildwithsumit.com/ivaangames/>**

Also runs with no server at all: download [iron-line.html](iron-line.html) and
open it. The whole single-player game is in that one file.

![Iron Line gameplay](docs/media/gameplay.gif)

*Wave 24. Five bosses on the board, towers at level 3–6, and the line holding.*

---

## Contents

- [Features](#features) · [How to play](#how-to-play) · [Controls](#controls)
- [The board](#the-board) · [Lives](#lives) · [Gold](#gold)
- [Waves](#waves) · [Enemies](#enemies)
- [Towers](#towers) · [Bots](#bots) · [Medical](#medical)
- [Upgrading and selling](#upgrading-and-selling)
- [How to get better](#how-to-get-better) · [What unlocks when](#what-unlocks-when)
- [Quests](#quests-unlocking-the-heavy-weapons)
- [Multiplayer rules](#multiplayer-rules)
- [Maps](#maps) · [Settings](#settings) · [Full stat tables](#full-stat-tables)

---

## Features

- **11 turrets and 4 bots**, each with its own role — spinning miniguns, piercing
  railguns, splash mortars, sword sentries that sweep whole crowds, and walking
  robots you can order around the field
- **10 upgrade levels** per unit, compounding to roughly **33× the damage**
- **50-wave solo campaign**, or **100 waves** when you play with someone
- **A boss every wave from wave 5**, building to **10 bosses at once** — and three
  **Ultra Bosses** on the penultimate wave
- **Online co-op for 2–4 players** on separate computers, with a **shareable
  invite link**, in-game chat, and a public game browser
- **Per-player gold** — your guns earn your money — with **shared lives**, so you
  compete on the scoreboard and cooperate on survival
- **A quest system** that unlocks the four heavy weapons through play, with
  progress saved between runs
- **Six hand-built maps plus an infinite random map generator**
- **Reconnect protection** — drop out and your seat and everything you built are
  held for 90 seconds
- **Runs offline from a single HTML file.** No install, no build step, no account

---

## Screenshots

### A wave in progress
![A wave under way](docs/media/gameplay-wave.png)
Towers show their level. The bar across the top tracks the bosses still alive.
Green flashes are damage landing; the flag at the right is the keep you are
defending.

### A boss wave
![Five bosses at once](docs/media/gameplay-boss.png)
From wave 5 every wave carries a boss, and more of them as you go. Flyers (the
purple arrowheads) cut straight across the map instead of following the road.

### The online lobby
![Online lobby](docs/media/online-lobby.png)
Host a game, get a 5-letter code and a shareable link, or browse public games.

### The settings menu
![Settings menu](docs/media/settings.png)
Display options, quest progress, and — offline only — the cheat panel.

---

## How to play

Enemies walk a fixed road from the left edge to the right. You build turrets on
the ground beside it. Anything that reaches the far end costs you lives. Lose all
your lives and the run is over; clear every wave and you win.

Between waves there is a **15-second countdown**. You can build during it, or
call the wave in early for bonus gold.

### Three ways to play

| Mode | How | Waves |
|---|---|---|
| **Solo** | Just open the page | 50 |
| **Couch co-op** | 2–4 players, one keyboard, one screen | 50 |
| **Online co-op** | 2–4 players, separate computers | **100** |

**To play online:** click **🌐 Online** in the top bar → *Host a game* → pick a
party size and map → **Create game**. You get a 5-letter code and a shareable
link. Anyone who opens the link joins automatically. When everyone is seated, the
host clicks **Start the run**.

---

## Controls

| Action | Key / mouse |
|---|---|
| Pick a turret | `1`–`0`, or click it in the right panel |
| Pick a bot | `Q` `W` `E` `T`, or click it |
| Place what you picked | Click the board |
| Select a unit | Click it |
| Upgrade / sell | `U` / `X` |
| Send a bot somewhere | Select it, then click open ground |
| Buy bandage / medkit | `B` / `M` |
| Call the next wave early | `Enter` |
| Cancel a selection | `Esc` or right-click |
| Chat (online) | `T` |
| Pause / speed *(offline only)* | `Space` or `P` / the `1×` button |

Couch co-op gives players 2–4 their own keyboard cluster and their own on-screen
cursor — the layouts are listed in the party lobby.

---

## The board

22 × 15 tiles. The road is drawn in dirt; you **cannot build on it**, and you
cannot stack two turrets on one tile. Everything else is fair game.

Ground enemies follow the road exactly. **Flyers ignore it** and fly straight
across from entry to exit, so anti-air coverage has to be spread differently
from your ground defence.

At the right-hand end sits **the keep**, with two guards who fire for free all
game: 9 damage, 1.2 shots/second, 104 range. They will not save you, but they
chip in.

---

## Lives

You start with **20 lives**, and can hold at most **45**.

| What leaks through | Lives lost |
|---|---|
| Any normal enemy | 1 |
| A boss | 10 |
| An Ultra Boss | 25 |

At zero, the run ends. Lives are **shared by the whole team** in co-op — you hold
the line together or you lose together.

---

## Gold

You start with **250 gold**. In online co-op **every player has their own purse**,
and every purse starts at 250.

**Kill bounties go to the owner of the gun that lands the killing shot.** Your
turret finishes something, you get paid. Kills by the free keep guards belong to
nobody, so everyone is paid for those.

Bounties are not fixed. Each kill pays the enemy's base value **±35%**, and
**8% of kills pay a ×3 jackpot**. Enemy values also rise about **4% per wave**.

Two bonuses pay **every player in full** rather than being split:

- **Clearing a wave** — `(25 + 20 × wave) × 0.8–1.2` gold
- **Calling a wave early** — 3 gold for every second left on the countdown

That last one is the most reliable income in the game. If your line is holding
comfortably, calling waves in early compounds fast.

---

## Waves

Wave composition grows on a fixed curve. Enemy health scales hard:

| Wave | Health multiplier | Bosses | Boss HP each | Armour bonus |
|---:|---:|---:|---:|---:|
| 1 | ×1.0 | — | — | +0 |
| 5 | ×3.2 | 1 | 3,850 | +0 |
| 10 | ×8.1 | 1 | 9,754 | +1 |
| 20 | ×25.2 | 2 | 30,202 | +3 |
| 30 | ×51.8 | 3 | 62,170 | +5 |
| 50 | ×133.9 | 5 | 160,666 | +8 |
| 75 | ×290.5 | 8 | 348,586 | +12 |
| 100 | ×507.1 | 10 | 608,506 | +16 |

- **Waves 1–4** are boss-free: grunts, then runners (2+), flyers (3+), tanks (4+).
- **From wave 5, every single wave carries a boss**, and one more boss is added
  every ten waves.
- **Enemy armour rises by 1 every 6 waves.** Armour subtracts flat damage from
  every hit, which is why armour-piercing weapons matter more the longer you go.
- **The penultimate wave** (49 solo, 99 in a party) brings **three Ultra Bosses**
  at 4.5× normal boss health. Survive it and the last wave is all that stands
  between you and the win.

---

## Enemies

| Enemy | Health | Speed | Armour | Bounty | Damage to bots | Notes |
|---|---:|---:|---:|---:|---:|---|
| **Grunt** | 58 | 52 | 0 | 6 | 9 | The bulk of every wave |
| **Runner** | 38 | 112 | 0 | 5 | 7 | Fast and fragile — leaks past slow defences |
| **Tank** | 300 | 34 | 4 | 17 | 28 | Armour makes weak rapid-fire useless |
| **Flyer** | 74 | 88 | 1 | 11 | — | **Ignores the road.** Needs anti-air |
| **BOSS** | 800 × curve | 29 | 7 | 220 | 75 | Costs 10 lives if it gets through |
| **ULTRA BOSS** | ×4.5 a boss | 21 | 18 | 3,000 | 220 | Three of them, once per run |

All values above are the base; multiply health by the wave curve and add the
wave's armour bonus.

---

## Towers

Eleven turrets. Four are locked behind [quests](#quests-unlocking-the-heavy-weapons).

### Guns

| Turret | Cost | Damage | Range | Rate | Hits air? | Notes |
|---|---:|---:|---:|---:|:---:|---|
| 🔫 **Pistol Turret** | 40 | 11 | 114 | 1.8/s | yes | Cheap, reliable opener |
| ⚙ **Gatling Gun** | 95 | 5.5 | 106 | 6.5/s | yes | **Spins up** — weak on first contact, shreds while held |
| 💣 **Grenade Launcher** | 80 | 27 | 130 | 0.62/s | **no** | 48 splash. Ground only |
| 🎯 **Sniper Rifle** | 130 | 84 | 266 | 0.42/s | yes | Enormous range, **ignores armour** |
| 🪖 **Minigun Nest** | 500 | 264 | 120 | 1.0/s | yes | Hits **2 targets at once** |
| 🎇 **Flak Cannon** 🔒 | 175 | 34 | 152 | 1.1/s | **air only** | 56 splash. Cannot touch ground units |
| 🔦 **Laser Lance** 🔒 | 260 | 13 | 150 | 6.0/s | yes | **Ramps up** while held on one target; ignores armour |
| ⚡ **Railgun Battery** 🔒 | 340 | 190 | 250 | 0.5/s | yes | **Pierces every enemy in a line**; ignores armour |
| ☄ **Plasma Mortar** 🔒 | 400 | 120 | 170 | 0.5/s | yes | 80 splash **and** slows by 25% |

### Swords

| Turret | Cost | Damage | Range | Rate | Notes |
|---|---:|---:|---:|---:|---|
| 🗡 **Blade Sentry** | 70 | 20 | 64 | 2.1/s | Sweeps **every** ground enemy in reach at once |
| ⚔ **Greatsword Guard** | 170 | 78 | 80 | 0.75/s | Heavy cleave, **slows survivors by 50%** |

Swords cannot hit air. They hit everything on the ground within range on every
swing, which makes them extraordinary against packed waves and poor against a
lone boss.

**Targeting:** turrets always shoot whichever valid enemy is **furthest along the
road**, not the nearest.

---

## Bots

Bots walk the field, take damage, die, and come back. You can order them anywhere
by selecting one and clicking open ground.

| Bot | Cost | Health | Damage | Range | Notes |
|---|---:|---:|---:|---:|---|
| 🤖 **Rifle Bot** | 95 | 130 | 10 @ 2.1/s | 138 | Shoots air and ground. Holds position |
| 🤺 **Blade Bot** | 125 | 290 | 18 @ 1.7/s | 30 | **Body-blocks** ground enemies — they stop and fight it |
| 🚑 **Medic Bot** | 145 | 170 | — | 125 | Repairs 22 hp/s to damaged bots nearby, including itself |
| 👥 **Gun Crew** | 165 | 200 | 7 @ 1.5/s | 114 | **Turrets within 114 fire 35% faster** |

**Rules that apply to all bots:**

- **Squad limit.** 6 bots at once, **+2 per extra player**, **+1 every 15 waves**.
- **Body-blocking.** A Blade Bot stops ground enemies in their tracks and trades
  blows. This is the single best way to buy time on a leaking lane.
- **Self-repair.** Out of combat (no enemy within 165), a bot heals 5% of its max
  health per second.
- **Respawn.** A destroyed bot returns after **9 seconds** at the spot you last
  ordered it to, at full health. You do not pay again.
- **Gun Crew buffs do not stack** — only the best crew in range counts.

---

## Medical

| Item | Cost | Effect |
|---|---:|---|
| 🩹 **Bandage** | 35 | +3 lives |
| 🧰 **Medkit** | 90 | +9 lives |

**Every purchase raises the price by 8%**, permanently for that run. Buying
lives is an emergency measure, not a strategy. Cap is 45 lives.

---

## Upgrading and selling

Everything can be upgraded to **level 10**.

**Per level, a turret gains:**

- **+46% damage** (compounding — level 10 is roughly **33× the damage** of level 1)
- +7% range (+5% for swords)
- +10% fire rate
- +6% splash radius, +4% slow

**Per level, a bot gains:** +38% health, +44% damage, +40% healing, +5% range,
+7% fire rate. Upgrading a live bot also heals it to full.

**Upgrade cost** rises steeply: `base cost × 0.78 × level^1.25`.

| | Lv 1→2 | Lv 2→3 | Lv 3→4 | Lv 5→6 | Lv 9→10 |
|---|---:|---:|---:|---:|---:|
| Pistol Turret | 31 | 74 | 123 | 233 | 486 |
| Railgun Battery | 265 | 631 | 1,047 | 1,983 | 4,134 |

> **The most important number in the game.** A level-10 pistol out-damages a
> level-1 railgun many times over for a fraction of the price. Concentrating gold
> into a few upgraded turrets beats spreading it across many cheap ones — right
> up until you need coverage somewhere new.

**Selling** returns **60% of everything you have put into a unit**, purchase
price plus every upgrade. Recalling a bot works the same way.

---

## How to get better

The game does not gate you behind menus — everything opens up through play. This
is roughly the order things click.

### Your first runs (waves 1–10)

Open with **Pistol Turrets** on the inside of the first few corners, where the
road doubles back. A turret on a bend covers the enemy twice.

**Wave 3 brings flyers**, and they ignore the road entirely — they fly straight
from the entry row to the exit row. If you have built everything in one corner,
they will sail past it. Keep something with `hits air` near the middle.

**Wave 5 is the first real test:** the first boss, arriving alongside ~40 other
enemies. Most first runs end here. Two things get you through it:

1. **Upgrade, don't sprawl.** Three level-4 turrets beat nine level-1 turrets for
   the same gold, and it isn't close.
2. **Buy a Blade Bot.** It body-blocks the boss and buys your turrets several
   free seconds of fire. 125 gold is cheap for that.

### Finding your economy (waves 10–25)

Once your line holds without babysitting, **call waves in early**. Three gold per
second left on the clock compounds into everything else you want to buy. Players
who clear the game are almost always the ones who stopped waiting out countdowns.

This is where **armour** starts to bite: it climbs by 1 every six waves and
subtracts flat damage from every hit. A Gatling Gun doing 5.5 per shot loses most
of its damage to a Tank's armour, while a Sniper — which ignores armour entirely
— does not care at all.

### The long game (wave 25+)

Late waves are about **splash and piercing**, not single-target damage. Twenty
enemies arrive at once and bosses stack up. Blade Sentries and Greatsword Guards
hit *everything* in range on every swing, which is why cheap swords stay relevant
next to a 400-gold mortar.

Add a **Gun Crew** next to your best cluster: a flat +35% fire rate on every
turret in range is usually better value than another turret.

### Playing together

Split the map, not the job. Two players each covering half the road with their
own upgraded turrets beats both of you crowding the same corner — you each have
your own purse to spend, and coverage is what kills you when it's missing.

---

## What unlocks when

Nothing is bought with real money and nothing is time-gated. Everything arrives
by playing.

| When | What you get |
|---|---|
| **Immediately** | Pistol, Gatling, Grenade Launcher, Sniper, Minigun, Blade Sentry, Greatsword Guard, and all four bots |
| **Wave 2** | Runners join the waves |
| **Wave 3** | Flyers — you now need anti-air |
| **Wave 4** | Tanks — armour starts mattering |
| **Wave 5** | The first boss. From here **every wave has one** |
| **Every 6 waves** | All enemies gain +1 armour |
| **Every 10 waves** | One more boss per wave |
| **Every 15 waves** | +1 to your squad limit |
| **120 flyers killed** | 🎇 **Flak Cannon** |
| **Reach wave 15** | 🔦 **Laser Lance** |
| **10 bosses killed** | ⚡ **Railgun Battery** |
| **Reach wave 30** | ☄ **Plasma Mortar** |
| **Wave 49 / 99** | Three Ultra Bosses |
| **Wave 50 / 100** | You win |

Quest progress is **cumulative across runs** — the flyers and bosses you killed
in a losing run still count. You are always making progress, even when you lose.

---

## Quests — unlocking the heavy weapons

Four turrets are locked. Each is earned by finishing a quest. **Progress is saved
on your own computer and carries across every run**, and there's a live progress
panel in the right-hand sidebar.

| Weapon | Quest | Goal |
|---|---|---|
| 🎇 **Flak Cannon** | *Ground the Flight* | Shoot down **120 flyers** (cumulative) |
| 🔦 **Laser Lance** | *Hold the Line* | Reach **wave 15** in a single run |
| ⚡ **Railgun Battery** | *Armour Piercing* | Destroy **10 bosses** (cumulative) |
| ☄ **Plasma Mortar** | *Scorched Earth* | Reach **wave 30** in a single run |

In online co-op **each player brings their own unlocks** — your grind arms you,
not the whole room. A host who would rather skip this can tick **"Skip the
quests"** when creating a game, which gives everyone everything.

---

## Multiplayer rules

Everyone shares one battlefield. What is shared and what is yours:

| | |
|---|---|
| **Shared** | The map, the wave, **lives**, the squad limit, the auto-wave setting |
| **Yours alone** | **Your gold**, your turrets and bots, your quest unlocks |

**Ownership.** Anyone can build anywhere, but **only the owner can upgrade or
sell their own units**. Your gold pays for your line; nobody can cash out your
investment or spend your money.

**Kills are tracked per player** and shown on the scoreboard, so there are
bragging rights even though you win or lose together.

**Seats.** Party size is fixed when the run starts, so a player going quiet never
reshuffles anyone else's game. Seat 1 is the host.

**If you disconnect,** your seat and everything you built are held for **90
seconds**. Reload the page and you drop straight back into the same run. If the
host leaves for good, the next connected player inherits the room so it can still
be started and restarted.

**Calling waves.** Anyone can call the next wave in early, and anyone can toggle
**⏭ Auto**, which skips every countdown from then on. Both apply to the whole
room — there is one clock and one wave.

**Not available online:** pause, fast-forward, the first-person view, and the
admin/cheat panel. Time belongs to the server when it is shared. All four still
work in offline solo play.

---

## Settings

The gear button opens settings, in every mode.

| Option | What it does |
|---|---|
| **Show every turret's range** | Draws all range circles at once — useful for spotting gaps |
| **Enemy health bars** | Turn off for a cleaner board |
| **Floating gold & damage text** | The `+13` numbers that pop off kills |
| **Screen shake** | Turn off if it bothers you |
| **Particle effects** | Turn off on a slow machine |
| **Show FPS** | Frame rate, and your ping when online |
| **Teammates' build cursors** | See what the others are lining up (online) |
| **Chat box on screen** | Hide the chat panel (online) |
| **Reset quest progress** | Clears counts and re-locks the four heavy weapons |

Choices are saved on your computer. **Offline only:** the same menu opens the
cheat panel, with free building, god mode, gold, wave jumping and map controls.
It is unavailable online, where a shared game has to be the same for everyone.

---

## Maps

Six hand-built maps — **Iron Line, Switchback, The Coil, Long March, Crossroads,
Hairpin** — plus a **freshly generated serpentine road** that is different every
time. Hosts pick one or leave it on *Surprise us*.

---

## Full stat tables

<details>
<summary><b>Formulas</b> (click to expand)</summary>

```
enemy health      base × (1 + 0.36(n−1) + 0.048(n−1)²)
boss health       800 × health multiplier × 1.5
ultra health      boss health × 4.5
enemy armour      base + floor(wave / 6)
enemy bounty      base × (1 + 0.04(n−1)) × (0.65–1.35) × (3 if jackpot, 8% chance)

damage dealt      max(1, damage − armour)        armour-piercing ignores armour

turret at level L dmg × 1.46^(L−1) · range × 1.07^(L−1) · rate × 1.10^(L−1)
bot    at level L hp × 1.38^(L−1) · dmg × 1.44^(L−1) · rate × 1.07^(L−1)

upgrade cost      base cost × 0.78 × L^1.25
sell refund       60% of total invested
medical cost      base × 1.08^(times bought this run)

squad limit       6 + 2×(players − 1) + floor(wave / 15)
wave clear bonus  (25 + 20 × wave) × 0.8–1.2
early call bonus  3 × seconds remaining
```

</details>

---

## For developers

The architecture, netcode and deployment are documented separately in
[MULTIPLAYER.md](MULTIPLAYER.md). In short: the client is one self-contained HTML
file, and online play is server-authoritative — a Node process runs the real
simulation at 30 Hz and broadcasts snapshots at 15 Hz, so no client ever decides
anything.

```bash
cd server && npm install
npm start                        # :8092

node test/smoke.js               # protocol, economy, quests, auto, reconnect
node test/abuse.js               # exploits, floods, malformed input
node test/deep-sim.js 4          # full campaigns, 1–4 players, invariant checks
node test/simulate.js 2          # multi-client network simulation
node test/soak.js 60             # bandwidth and tick health
node --expose-gc test/leak.js    # memory under churn and sustained load
```

## Licence

See [LICENSE](LICENSE).
