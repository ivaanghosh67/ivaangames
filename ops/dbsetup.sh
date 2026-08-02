#!/usr/bin/env bash
# Create the game's own database and a least-privilege user for it.
# Additive only: it never touches the existing business databases.
set -euo pipefail

DBNAME=ironline
DBUSER=ironline
ENVFILE=/opt/ironline/.env

if sudo mysql -N -B -e "SHOW DATABASES LIKE '$DBNAME';" | grep -q "$DBNAME"; then
  echo "database '$DBNAME' already exists — leaving it alone"
else
  echo "creating database '$DBNAME'"
fi

sudo mysql < /tmp/schema.sql
echo "schema applied"

# Reuse the existing password if we already provisioned one, so re-running this
# script never locks the service out of its own database.
if sudo test -f "$ENVFILE" && sudo grep -q '^IRONLINE_DB_PASS=' "$ENVFILE"; then
  PASS=$(sudo grep '^IRONLINE_DB_PASS=' "$ENVFILE" | cut -d= -f2-)
  echo "reusing the existing database password"
else
  PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28)
  echo "generated a new database password"
fi

sudo mysql <<SQL
CREATE USER IF NOT EXISTS '$DBUSER'@'localhost' IDENTIFIED BY '$PASS';
ALTER USER '$DBUSER'@'localhost' IDENTIFIED BY '$PASS';
GRANT SELECT, INSERT, UPDATE, DELETE ON $DBNAME.* TO '$DBUSER'@'localhost';
REVOKE ALL PRIVILEGES ON *.* FROM '$DBUSER'@'localhost';
GRANT USAGE ON *.* TO '$DBUSER'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON $DBNAME.* TO '$DBUSER'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "user '$DBUSER' granted rights on '$DBNAME' only"

sudo mkdir -p /opt/ironline
sudo touch "$ENVFILE"
sudo chmod 600 "$ENVFILE"
sudo chown www-data:www-data "$ENVFILE"
# rewrite the file rather than appending, so re-runs do not duplicate keys
sudo tee "$ENVFILE" >/dev/null <<ENV
IRONLINE_DB_HOST=127.0.0.1
IRONLINE_DB_USER=$DBUSER
IRONLINE_DB_NAME=$DBNAME
IRONLINE_DB_PASS=$PASS
ENV
echo "credentials written to $ENVFILE (mode 600, www-data)"

echo "--- verifying the game user can reach ONLY its own database ---"
mysql -h 127.0.0.1 -u "$DBUSER" -p"$PASS" -N -B -e "SHOW DATABASES;" 2>/dev/null | sed 's/^/  sees: /'
mysql -h 127.0.0.1 -u "$DBUSER" -p"$PASS" "$DBNAME" -N -B -e "SHOW TABLES;" 2>/dev/null | sed 's/^/  table: /'
