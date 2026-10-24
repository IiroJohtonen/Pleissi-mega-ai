#!/usr/bin/env bash
# Ajetaan palvelimella skriptistä deploy.ps1. Luo asetustiedoston ensimmäisellä kerralla ja käynnistää tai
# päivittää Pleissi Mega AI:n. Sovelluksen tiedostot ovat kansiossa /opt/pleissi-ai/app.
#
# Mega AI asennetaan Kotilon tuotantoversion rinnalle: Kotilo on asentanut palvelimelle Dockerin, palomuurin ja
# sivutusmuistin, ja Kotilon Caddy ohjaa osoitteen test2.kotilo.io Mega AI:lle. Siksi Kotilon pitää olla
# asennettuna ja käynnissä ensin.
set -euo pipefail

BASE=/opt/pleissi-ai
APP="$BASE/app"
COMPOSE="$APP/deploy/server/docker-compose.yml"

if ! command -v docker >/dev/null 2>&1 || ! docker network inspect kotilo_default >/dev/null 2>&1; then
  echo "Kotilon tuotantoversiota ei löydy tältä palvelimelta (Docker-verkko kotilo_default puuttuu)." >&2
  echo "Asenna tai päivitä ensin Kotilo (kotilo-repon deploy\\server\\deploy.ps1), sitten aja tämä uudelleen." >&2
  exit 1
fi
if ! grep -q "test2.kotilo.io" /opt/kotilo/app/deploy/server/Caddyfile 2>/dev/null; then
  echo "Kotilon Caddy ei vielä tunne osoitetta test2.kotilo.io. Päivitä ensin Kotilo uusimpaan versioon." >&2
  exit 1
fi

# Sovellus ajetaan kontissa käyttäjänä node (uid 1000), joka kirjoittaa varmuuskopiot tähän kansioon.
mkdir -p "$BASE/varmuuskopiot" "$BASE/config"
chown 1000:1000 "$BASE/varmuuskopiot"

if [ ! -f "$BASE/.env" ]; then
  cp "$APP/deploy/server/production.env.example" "$BASE/.env"
  chmod 600 "$BASE/.env"
  echo "Luotiin asetustiedosto $BASE/.env oletusarvoilla."
fi

echo "Käännetään ja käynnistetään Pleissi Mega AI. Ensimmäinen kerta kestää muutaman minuutin."
docker compose -p pleissi-ai -f "$COMPOSE" up -d --build --remove-orphans
docker image prune -f >/dev/null

echo
docker compose -p pleissi-ai -f "$COMPOSE" ps
echo
# Aloitussalasana tulostuu lokiin vain, kun tietokanta luodaan ensimmäisen kerran.
docker compose -p pleissi-ai -f "$COMPOSE" logs --no-log-prefix pleissi-ai 2>/dev/null | grep -i "salasana" || true
