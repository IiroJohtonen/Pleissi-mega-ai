# Kotilo palvelimella (UpCloud)

Palvelin tarjoaa alustan osoitteessa `app.kotilo.io` ja kotisivun testiosoitteessa `test.kotilo.io`. Osoitteet `kotilo.io` ja `www.kotilo.io` osoittavat toistaiseksi muualle. Kun niiden DNS-tietueet osoittavat palvelimeen, kotisivu siirretään niihin lisäämällä osoitteet tiedoston `Caddyfile` kotisivulohkoon.

| Osoite | Sisältö | Lähde repossa |
| --- | --- | --- |
| `test.kotilo.io` | Kotisivu | `site/` |
| `app.kotilo.io` | Alusta | `client/` ja `server/` |

Palvelimella on kaksi konttia: Kotilo ja Caddy. Caddy ottaa vastaan liikenteen, hakee HTTPS-varmenteet itse, ohjaa `app.kotilo.io`:n Kotilolle ja tarjoaa kotisivun tiedostot suoraan.

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
- **Plan:** vähintään 2 Gt muistia. Sovellus käännetään palvelimella; asennus lisää käännöstä varten 2 Gt sivutusmuistia.
- **Operating system:** Ubuntu Server 24.04 LTS
- **Login method:** SSH keys, ja liitä kohdan 1 julkinen avain
- **Backups:** ota päälle (päivittäinen riittää)

Kun palvelin on käynnissä, kopioi sen julkinen IPv4-osoite.

## 3. Domain osoittamaan palvelimeen

Lisää domainin DNS-hallinnassa A-tietue, joka osoittaa palvelimen IP-osoitteeseen:

| Nimi | Tyyppi | Arvo |
| --- | --- | --- |
| `app` | A | palvelimen IP |
| `test` | A | palvelimen IP |

Kun kotisivu siirretään pääosoitteeseen, tarvitaan samanlaiset tietueet nimille `@` (eli kotilo.io) ja `www`.

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

## 6. Sähköposti

Saapuva ja lähtevä posti kulkee toimiston tai taloyhtiön sähköpostitilin kautta. Tili yhdistetään alustassa: **Asetukset → Isännöitsijätoimiston tiedot → Toimiston sähköpostitili**, ja taloyhtiön oma tili taloyhtiön sivulta. Vaihtoehtoja on kolme.

### Gmail

1. Google Cloud -konsolissa OAuth-clientin **Authorized redirect URIs** -listaan lisätään `https://app.kotilo.io/api/gmail/callback`.
2. Vie OAuth-clientin tiedosto palvelimelle:

   ```powershell
   scp server\credentials.json root@PALVELIMEN-IP:/opt/kotilo/config/credentials.json
   ```

3. Yhdistä tili alustassa painikkeella **Gmail**.

### Microsoft 365 / Outlook

Sovellus rekisteröidään kerran Microsoftin Azure-portaaliin. Kirjaudu toimiston Microsoft 365 -työtilillä; henkilökohtaisella tilillä (esim. @outlook.com) portaali ei avaudu ilman omaa hakemistoa.

1. Avaa https://portal.azure.com → **Microsoft Entra ID → App registrations → New registration**.
2. **Name:** Kotilo. **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*.
3. **Redirect URI:** tyyppi **Web**, osoite `https://app.kotilo.io/api/mail/microsoft/callback`.
4. Kopioi **Application (client) ID**.
5. **Certificates & secrets → New client secret** ja kopioi salaisuuden **Value** (näytetään vain kerran). Salaisuus vanhenee valitun ajan kuluttua; tee silloin uusi ja vaihda se palvelimelle.
6. Lisää palvelimen tiedostoon `/opt/kotilo/.env`:

   ```
   MS_CLIENT_ID=kopioitu-client-id
   MS_CLIENT_SECRET=kopioitu-salaisuus
   MS_REDIRECT_URI=https://app.kotilo.io/api/mail/microsoft/callback
   ```

7. Aja kohdan 4 julkaisukomento uudelleen, jotta asetukset tulevat voimaan.
8. Yhdistä tili alustassa painikkeella **Microsoft 365 / Outlook**. Jos organisaatio vaatii ylläpitäjän hyväksynnän, Microsoft pyytää sen kirjautumisen yhteydessä.

Kotilo tarvitsee oikeudet lukea ja lähettää postia (Mail.ReadWrite, Mail.Send) sekä lukea tilin osoitteen (User.Read).

### Muu sähköposti (IMAP/SMTP)

Toimii useimpien palvelujen kanssa (oman domainin posti, Telia, Elisa, iCloud ym.) eikä vaadi palvelimen asetuksia. Valitse alustassa **Muu sähköposti (IMAP/SMTP)** ja täytä sähköpostipalvelun antamat tiedot: saapuvan postin palvelin (IMAP, portti yleensä 993) ja lähtevän postin palvelin (SMTP, portti yleensä 465 tai 587). Kotilo kokeilee yhteyden ennen tallennusta. Jos tilillä on kaksivaiheinen tunnistautuminen, käytä palvelun sovellussalasanaa.

Yritysten Microsoft 365 -tileissä IMAP-kirjautuminen salasanalla on yleensä estetty; käytä niille Microsoft 365 -yhteyttä.

Salasanat ja Microsoftin tunnisteet tallennetaan salattuina. Salausavain on data-levyn tiedostossa `mail-secret.key` tai muuttujassa `MAIL_SECRET_KEY`. Jos tietokanta palautetaan varmuuskopiosta uudelle levylle ilman avainta, sähköpostitilit pitää yhdistää uudelleen.

### Kehitysversio

Lisää kehitysversion tiedostoon `server\.env` rivi `GMAIL_DISABLED=1`. Muuten kehitysversio ja palvelin lukevat samaa postilaatikkoa, ja sama viesti päätyy kumpaankin.

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
