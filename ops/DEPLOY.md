# Deploying Iron Line

Everything needed to ship a change to <https://buildwithsumit.com/ivaangames/>,
so nothing here ever has to be rediscovered by searching the disk again.

```bash
bash ops/deploy.sh          # key resolved automatically, see below
```

That is the whole procedure. The rest of this file is what it touches and how
to check it worked.

---

## The box

| | |
|---|---|
| Host | `buildwithsumit.com` |
| SSH user | `ubuntu` |
| Node | v18.19.1 (system) |
| Service | `ironline.service` (systemd, `User=www-data`) |
| Port | `8092`, bound to `127.0.0.1` — nginx terminates TLS and proxies |

```bash
ssh -i "$(cat ops/deploy.env | sed 's/^IRONLINE_DEPLOY_KEY=//')" ubuntu@buildwithsumit.com
```

## Where the deploy key lives

**`D:\buildwithsumit\buildwithsumit.pem`**

It is deliberately *not* stored in this folder. This repository is public, the
deploy path runs `git add -A`, and a private key that reaches a public commit
has to be rotated on the spot — so the repo records the key's **location**,
never its contents.

The path is kept in `ops/deploy.env`, which is gitignored. `ops/deploy.sh`
reads it automatically, so no argument is needed. To recreate it on a new
machine, copy `ops/deploy.env.example` and point it at your own copy of the key:

```bash
cp ops/deploy.env.example ops/deploy.env
# then edit IRONLINE_DEPLOY_KEY=
```

`deploy.sh` resolves the key in this order, first hit wins:

1. the first command-line argument — `bash ops/deploy.sh /path/to/key.pem`
2. `$IRONLINE_DEPLOY_KEY` from the environment
3. `IRONLINE_DEPLOY_KEY=` in `ops/deploy.env`
4. `./buildwithsumit.pem` in the repo root

## What lands where

| What | Path on the box |
|---|---|
| Server code | `/opt/ironline/` |
| Client (single file) | `/var/www/html/ivaangames/index.html` |
| systemd unit | `/etc/systemd/system/ironline.service` |
| Database credentials | `/opt/ironline/.env` — **survives deploys**, never in git |
| `node_modules` | `/opt/ironline/node_modules` — kept unless `package.json` moves |
| Analytics trail | `/var/lib/ironline/analytics/runs-YYYY-MM-DD.jsonl` |
| nginx snippet | see [nginx-ivaangames.conf](nginx-ivaangames.conf) — one-time manual step |

Prod is not a git checkout. `deploy.sh` scps into `/tmp` and `sudo rsync`s into
place, and it backs up the previous `index.html` alongside itself before
overwriting.

## Deploying restarts the service

`deploy.sh` runs `systemctl restart`, and game state lives in memory — a restart
**ends every run in progress**. Check first:

```bash
curl -s https://buildwithsumit.com/ivaangames/health
# {"ok":true,"rooms":0,"players":0,"uptime":...}
```

Deploy when `players` is 0, or accept that anyone mid-run loses it.

## Verifying a deploy

The script already checks health, the page and the room list. Three more that
catch what those cannot:

**The client really is the build you meant.** Cache-bust, or you may be
checksumming a CDN copy of the old file:

```bash
curl -fsS "https://buildwithsumit.com/ivaangames/?cb=$RANDOM" | sha256sum
sha256sum < iron-line.html          # must match
```

**The authoritative sim picked up the new constants.** The client can be right
while the server is stale — they are deployed by separate steps:

```bash
ssh -i <key> ubuntu@buildwithsumit.com \
  'cd /opt/ironline && node -e "import(\"./sim/constants.js\").then(c=>console.log(c.END_HP,c.END_SPEED,c.END_AIR))"'
```

**The game actually plays.** The health endpoint answers long before anything
has simulated a wave, so a crash in `spawn()` will not show up in it. The smoke
suite runs the real WebSocket stack against the deployed code on its own port
(8099), so it cannot disturb the live server on 8092:

```bash
ssh -i <key> ubuntu@buildwithsumit.com \
  'cd /opt/ironline && IRONLINE_ANALYTICS=0 IRONLINE_DATA_DIR=/tmp/ironline-smoke node test/smoke.js'
# → "all checks passed"
```

## Reading the gameplay trail

The analytics JSONL is the only record of how real runs end. It is not exposed
over HTTP — the server serves `/health` and `/rooms` and nothing else — so it
has to be read over SSH:

```bash
ssh -i <key> ubuntu@buildwithsumit.com 'ls -la /var/lib/ironline/analytics/'
ssh -i <key> ubuntu@buildwithsumit.com \
  'cd /opt/ironline && node tools/analyze.js'
```

To pull it down and analyse locally instead:

```bash
scp -i <key> 'ubuntu@buildwithsumit.com:/var/lib/ironline/analytics/runs-*.jsonl' ./trail/
IRONLINE_DATA_DIR=./trail node server/tools/analyze.js
```

## Rolling back

The client keeps timestamped backups on the box:

```bash
ssh -i <key> ubuntu@buildwithsumit.com 'ls -t /var/www/html/ivaangames/index.html.bak-* | head'
ssh -i <key> ubuntu@buildwithsumit.com \
  'sudo cp /var/www/html/ivaangames/index.html.bak-YYYYMMDD-HHMMSS /var/www/html/ivaangames/index.html'
```

The server has no such backup — roll it back by checking out the previous commit
and running `deploy.sh` again.

## Useful one-liners

```bash
# service state and recent log
ssh -i <key> ubuntu@buildwithsumit.com 'systemctl status ironline.service --no-pager -l | head -20'
ssh -i <key> ubuntu@buildwithsumit.com 'journalctl -u ironline.service -n 60 --no-pager'

# restart without deploying
ssh -i <key> ubuntu@buildwithsumit.com 'sudo systemctl restart ironline.service'
```
