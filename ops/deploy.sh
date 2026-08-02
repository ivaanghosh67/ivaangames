#!/usr/bin/env bash
# Deploy Iron Line to buildwithsumit.com.
#
# Prod is not a git checkout, so this follows the house pattern: scp into /tmp,
# then sudo cp into place. Run it from the repo root:
#
#   bash ops/deploy.sh [path/to/buildwithsumit.pem]
#
# Idempotent — safe to re-run for a code change. It never touches nginx config;
# that is a one-time manual step documented in ops/nginx-ivaangames.conf.
set -euo pipefail

KEY="${1:-buildwithsumit.pem}"
HOST="ubuntu@buildwithsumit.com"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
SCP=(scp -i "$KEY" -o BatchMode=yes)

[ -f "$KEY" ] || { echo "no ssh key at $KEY" >&2; exit 1; }
[ -f iron-line.html ] || { echo "run me from the repo root" >&2; exit 1; }

echo "── staging ────────────────────────────────────────────"
"${SSH[@]}" 'rm -rf /tmp/ironline-deploy && mkdir -p /tmp/ironline-deploy'
"${SCP[@]}" -r server "$HOST":/tmp/ironline-deploy/
"${SCP[@]}" iron-line.html "$HOST":/tmp/ironline-deploy/index.html
"${SCP[@]}" ops/ironline.service "$HOST":/tmp/ironline-deploy/

echo "── server → /opt/ironline ─────────────────────────────"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
sudo mkdir -p /opt/ironline
# Keep node_modules across deploys; only refresh it when package.json moves.
# --exclude .env: the database credentials live there and must survive deploys
sudo rsync -a --delete --exclude node_modules --exclude .env /tmp/ironline-deploy/server/ /opt/ironline/
cd /opt/ironline
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "installing dependencies…"
  sudo npm install --omit=dev --no-audit --no-fund
fi
sudo chown -R www-data:www-data /opt/ironline

sudo cp /tmp/ironline-deploy/ironline.service /etc/systemd/system/ironline.service
sudo systemctl daemon-reload
sudo systemctl enable --now ironline.service
sudo systemctl restart ironline.service
sleep 1
systemctl is-active ironline.service
REMOTE

echo "── client → /var/www/html/ivaangames ──────────────────"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
sudo mkdir -p /var/www/html/ivaangames
if [ -f /var/www/html/ivaangames/index.html ]; then
  sudo cp -a /var/www/html/ivaangames/index.html \
    "/var/www/html/ivaangames/index.html.bak-$(date +%Y%m%d-%H%M%S)"
fi
sudo cp /tmp/ironline-deploy/index.html /var/www/html/ivaangames/index.html
sudo chown -R www-data:www-data /var/www/html/ivaangames
sudo chmod 644 /var/www/html/ivaangames/index.html
REMOTE

echo "── verify ─────────────────────────────────────────────"
"${SSH[@]}" 'curl -fsS http://127.0.0.1:8092/health && echo'
curl -fsS -o /dev/null -w 'page  HTTP %{http_code}\n' https://buildwithsumit.com/ivaangames/ || true
curl -fsS -o /dev/null -w 'rooms HTTP %{http_code}\n' https://buildwithsumit.com/ivaangames/rooms || true

"${SSH[@]}" 'rm -rf /tmp/ironline-deploy'
echo "done → https://buildwithsumit.com/ivaangames/"
