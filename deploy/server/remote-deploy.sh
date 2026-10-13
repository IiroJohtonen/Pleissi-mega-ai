#!/usr/bin/env bash
# Ajetaan palvelimella skriptistä deploy.ps1. Asentaa Dockerin ensimmäisellä kerralla, luo asetustiedoston
# ja käynnistää tai päivittää Kotilon. Sovelluksen tiedostot ovat kansiossa /opt/kotilo/app.
set -euo pipefail

BASE=/opt/kotilo
APP="$BASE/app"
COMPOSE="$APP/deploy/server/docker-compose.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "Asennetaan Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# Palomuuri: vain SSH ja verkkoliikenne sisään. Tietoturvapäivitykset asentuvat itsestään.
if command -v ufw >/dev/null 2>&1 && ! ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443 >/dev/null
  ufw --force enable >/dev/null
  echo "Palomuuri otettu käyttöön (portit 22, 80 ja 443)."
fi
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null || true
fi

# Sivutusmuisti: sovelluksen kääntäminen vie hetkellisesti enemmän muistia kuin pienessä palvelimessa on.
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Lisättiin 2 Gt sivutusmuistia."
fi

# Sovellus ajetaan kontissa käyttäjänä node (uid 1000), joka kirjoittaa varmuuskopiot tähän kansioon.
mkdir -p "$BASE/varmuuskopiot" "$BASE/config"
chown 1000:1000 "$BASE/varmuuskopiot"

if [ ! -f "$BASE/.env" ]; then
  cp "$APP/deploy/server/production.env.example" "$BASE/.env"
  chmod 600 "$BASE/.env"
  echo "Luotiin asetustiedosto $BASE/.env oletusarvoilla."
fi

echo "Käännetään ja käynnistetään Kotilo. Ensimmäinen kerta kestää muutaman minuutin."
docker compose -p kotilo -f "$COMPOSE" up -d --build --remove-orphans
docker image prune -f >/dev/null

echo
docker compose -p kotilo -f "$COMPOSE" ps
echo
# Aloitussalasana tulostuu lokiin vain, kun tietokanta luodaan ensimmäisen kerran.
docker compose -p kotilo -f "$COMPOSE" logs --no-log-prefix kotilo 2>/dev/null | grep -i "salasana" || true
