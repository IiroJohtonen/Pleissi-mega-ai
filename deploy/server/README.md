# Kotilo palvelimella (UpCloud)

Palvelin tarjoaa alustan osoitteessa `app.kotilo.io`. Esittelysivu (`site/`) on valmiina repossa, mutta sitä ei vielä tarjota tältä palvelimelta, koska `kotilo.io` ja `www.kotilo.io` osoittavat toistaiseksi muualle. Kun niiden DNS-tietueet osoittavat palvelimeen, esittelysivu otetaan käyttöön poistamalla kommenttimerkit tiedostosta `Caddyfile`.

| Osoite | Sisältö | Lähde repossa |
| --- | --- | --- |
| `kotilo.io` | Esittelysivu | `site/` |
| `app.kotilo.io` | Alusta | `client/` ja `server/` |

Palvelimella on kaksi konttia: Kotilo ja Caddy. Caddy ottaa vastaan liikenteen, hakee HTTPS-varmenteet itse ja ohjaa `app.kotilo.io`:n Kotilolle.

## 1. SSH-avain omalle koneelle

Palvelimelle kirjaudutaan avaimella, ei salasanalla. Luo avain PowerShellissä ja paina Enter jokaiseen kysymykseen:

```powershell
ssh-keygen -t ed25519
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

Kopioi tulostunut rivi (alkaa `ssh-ed25519`). Se on julkinen avain, jonka saa antaa UpCloudille. Tiedostoa ilman `.pub`-päätettä ei anneta kenellekään.

## 2. Palvelin UpCloudissa

UpCloudin hallintapaneelissa **Servers → Deploy server**:

- **Location:** Helsinki (FI-HEL1 tai FI-HEL2)
- **Plan:** vähintään 2 Gt muistia. Sovellus käännetään palvelimella, ja 1 Gt ei riitä siihen.
- **Operating system:** Ubuntu Server 24.04 LTS
- **Login method:** SSH keys, ja liitä kohdan 1 julkinen avain
- **Backups:** ota päälle (päivittäinen riittää)

Kun palvelin on käynnissä, kopioi sen julkinen IPv4-osoite.

## 3. Domain osoittamaan palvelimeen

Lisää domainin DNS-hallinnassa A-tietue, joka osoittaa palvelimen IP-osoitteeseen:

| Nimi | Tyyppi | Arvo |
| --- | --- | --- |
| `app` | A | palvelimen IP |

Esittelysivua varten tarvitaan myöhemmin samanlaiset tietueet nimille `@` (eli kotilo.io) ja `www`.

Muutos tulee voimaan yleensä muutamassa minuutissa, joskus vasta tunnin kuluessa. Voit tarkistaa sen komennolla `nslookup app.kotilo.io`.

## 4. Asennus

Kehitysrepon juuressa:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\server\deploy.ps1 -Server root@PALVELIMEN-IP
```

Ensimmäisellä kerralla SSH kysyy, luotetaanko palvelimeen: vastaa `yes`. Komento vie viimeisimmän commitin palvelimelle, asentaa Dockerin ja palomuurin, luo asetustiedoston ja käynnistää Kotilon. Ensimmäinen kerta kestää muutaman minuutin.

Lopuksi komento tulostaa aloitussalasanan. Kirjaudu osoitteessa `https://app.kotilo.io` tunnuksella `demo@pohjantahti-isannointi.fi` ja vaihda käyttäjien osoitteet ja salasanat heti asetuksista. Tietokanta on uusi ja tyhjä: kehitysversion tehtävät ja asukkaat eivät siirry.

Jos varmenne ei heti toimi, DNS ei ole vielä ehtinyt päivittyä. Caddy yrittää uudelleen itse.

## 5. Asetukset palvelimella

Asetukset ovat tiedostossa `/opt/kotilo/.env`. AI-avain lisätään sinne:

```powershell
ssh root@PALVELIMEN-IP
nano /opt/kotilo/.env        # lisää ANTHROPIC_API_KEY=..., tallenna Ctrl+O, poistu Ctrl+X
exit
```

Aja sen jälkeen kohdan 4 komento uudelleen, jotta muutos tulee voimaan.

## 6. Gmail

1. Google Cloud -konsolissa OAuth-clientin **Authorized redirect URIs** -listaan lisätään `https://app.kotilo.io/api/gmail/callback`.
2. Vie OAuth-clientin tiedosto palvelimelle:

   ```powershell
   scp server\credentials.json root@PALVELIMEN-IP:/opt/kotilo/config/credentials.json
   ```

3. Yhdistä tili alustassa: Asetukset → Isännöitsijätoimiston tiedot → Toimiston Gmail-tili.
4. Lisää kehitysversion tiedostoon `server\.env` rivi `GMAIL_DISABLED=1`. Muuten kehitysversio ja palvelin lukevat samaa postilaatikkoa, ja sama viesti päätyy kumpaankin.

## Päivittäminen

Kun uusi versio on commitoitu kehitysrepoon, aja sama komento kuin asennuksessa:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\server\deploy.ps1 -Server root@PALVELIMEN-IP
```

Tietokanta, liitteet ja asetukset säilyvät.

## Varmuuskopiot

- Kotilo ottaa tietokannasta ja liitteistä varmuuskopion kerran päivässä kansioon `/opt/kotilo/varmuuskopiot` ja säilyttää 14 uusinta.
- UpCloudin oma varmuuskopiointi (kohta 2) kopioi koko palvelimen levyn, eli myös nämä kopiot. Se suojaa tilanteelta, jossa palvelin tai sen levy menetetään.

Palautus: pysäytä kontit, kopioi varmuuskopion `kotilo.sqlite`, `attachments` ja `knowledge-files` data-levylle ja käynnistä uudelleen.

## Hyödyllisiä komentoja palvelimella

```bash
cd /opt/kotilo/app/deploy/server
docker compose -p kotilo ps                  # ovatko kontit käynnissä
docker compose -p kotilo logs -f kotilo      # Kotilon loki
docker compose -p kotilo logs -f caddy       # varmenteet ja liikenne
docker compose -p kotilo restart kotilo      # uudelleenkäynnistys
```
