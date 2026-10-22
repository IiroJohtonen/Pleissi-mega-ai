# Kotilo

Kotilo on isännöitsijätoimiston työkalu, joka kokoaa asukkaiden yhteydenotot tehtäviksi, auttaa vastaamaan niihin ja hoitaa taloyhtiön arjen varaukset ja ilmoitukset. Projektin aiempi nimi oli Kiito; kansion nimi `kiito-mvp` on peruja siitä.

Tilanne ja puuttuvat osat on kuvattu tiedostossa [shared/PRODUCT_SCOPE.md](shared/PRODUCT_SCOPE.md).

## Mitä Kotilo tekee

- **Tehtävät:** sähköposti, asukasportaali ja käsin kirjatut asiat päätyvät samaan päätösjonoon. Tehtävällä on käsittelijä, prioriteetti, määräaika, viestiketju, liitteet, muistiinpanot ja loki.
- **AI-apu:** käsittelijä voi pyytää vastausehdotuksen, joka perustuu vain kyseisen taloyhtiön AI-dokumentaatioon. Sisäinen dokumentaatio on henkilökunnan omia ohjeita, joita AI ei näe. Raportti toistuvista aiheista ehdottaa uusia vakiotietoja.
- **Asukasportaali:** asukas näkee tiedotteet, tekee ilmoituksia, varaa sauna- ja pyykkitupavuoroja, jonottaa autopaikkaa, tekee muutto- ja remontti-ilmoituksen ja ilmoittaa kulutuslukemat.
- **Taloyhtiön hallinta:** asukkaat, autopaikat, vuorot, jonot, tiedotteet, muutto- ja remontti-ilmoitukset, avainrekisteri, kulutuslukemat, työtilaukset huoltoyhtiölle ja laskutusraportit.
- **Kielet:** käyttöliittymä on suomeksi ja englanniksi. Kieli vaihdetaan asetuksista, kirjautumissivulta tai asukasportaalin yläpalkista.
- **Roolit:** pääkäyttäjä, isännöitsijä ja asiakaspalvelu. Isännöitsijä näkee vain omat taloyhtiönsä.

## Rakenne

```
server/   Express-rajapinta, SQLite-tietokanta, Gmail-yhteys
  src/index.ts        käynnistys, tietoturva-asetukset ja reitittimien kytkentä
  src/routes/         rajapinnan reitit aihealueittain
  src/access.ts       kirjautuneen käyttäjän yhtiönäkyvyys
  src/auth.ts         kirjautuminen, istunnot, käyttäjät ja roolit
  src/db.ts           tietokannan rakenne ja päivitykset
  src/jobs.ts         muistutukset, säilytysajan poistot ja varmuuskopiot
  test/               rajapinnan testit
client/   React-käyttöliittymä (Vite)
  src/views/          näkymät (työtila, asetukset, portaali, …)
  src/tickets/        tehtäväkortti, tehtävän tiedot ja työtilaukset
  src/session.ts      istunto ja rajapintakutsut
```

## Käyttöönotto kehityskoneella

Tarvitset Node.js-version 22 tai uudemman.

```bash
cd server
cp .env.example .env      # Windowsissa: copy .env.example .env
npm install
npm run dev
```

```bash
cd client
npm install
npm run dev
```

Käyttöliittymä aukeaa osoitteessa http://localhost:5173 ja rajapinta osoitteessa http://localhost:4000.

Ensimmäisellä käynnistyksellä palvelin luo esimerkkitaloyhtiön ja neljä käyttäjää. Aloitussalasana tulostuu palvelimen lokiin, ellei sitä ole annettu muuttujassa `INITIAL_PASSWORD`. Kirjaudu osoitteella `demo@pohjantahti-isannointi.fi` ja vaihda käyttäjien osoitteet ja salasanat asetuksista.

### AI

Aseta `ANTHROPIC_API_KEY` tiedostoon `server/.env`. Ilman avainta vastausehdotukset tehdään avainsanahaulla tietopankista, joten sovellus toimii myös ilman AI-tiliä.

Saapuvan tehtävän prioriteetin voi antaa AI:n arvioitavaksi: Asetukset → Isännöitsijätoimiston tiedot → AI. Asetus on oletuksena pois päältä, jolloin prioriteetti päätellään avainsanoista. Jokainen saapuva viesti on silloin yksi AI-kutsu. Samasta paikasta voi kytkeä päälle tarkistuksen, jossa AI pitää taloyhtiöön liittymättömät sähköpostit (mainokset, uutiskirjeet, automaattivastaukset) poissa päätösjonosta; ne tallentuvat suljettuina tehtävinä. Molemmat arviot tehdään samalla kutsulla.

**AI-agentti** (Asetukset → Isännöitsijätoimiston tiedot → AI, oletuksena pois) hoitaa asukkaan sauna-, pyykkitupa- ja autopaikka-asiat. Agentti (`server/src/ai-agent.ts`) käsittelee tehtävän vasta, kun käsittelijä painaa tehtävällä **Anna AI-agentin hoitaa**, joten AI-kutsuja ei tehdä tehtäviin, joita kukaan ei ole antanut agentille. Asukkaan vastaus agentin hoitamaan tehtävään (esim. valittu vuoro) käsitellään heti, myös toimiston ollessa kiinni. Agentti käyttää palvelimen työkaluja: vapaiden vuorojen haku, vuoron tarkistus ja varaus, autopaikkatiedot ja autopaikkajonoon lisäys. Varatun vuoron tilalle se tarjoaa vapaita vuoroja (oletuksena pyydetystä päivästä kolmen päivän päähän) ja varaa asukkaan valitseman, kun asukas vastaa. Vastaus lähtee samaan sähköpostiketjuun tai portaaliin. Muut asiat se jättää käsittelijälle perustelun kanssa. Turvarajat ovat koodissa: työkalut koskevat vain tehtävän taloyhtiötä ja asukasta, tarjottu vuoro varataan vasta asukkaan vastattua, ja autopaikan luovutus jää henkilökunnalle. Malli on oletuksena `claude-opus-5-5` (muuttuja `ANTHROPIC_AGENT_MODEL`).

### Sähköposti

Saapuva ja lähtevä posti kulkee toimiston tai taloyhtiön sähköpostitilin kautta. Tili yhdistetään asetuksista (Asetukset → Isännöitsijätoimiston tiedot → Toimiston sähköpostitili); taloyhtiölle voi yhdistää oman tilin, muuten käytetään toimiston tiliä. Palveluja on kolme:

- **Gmail:** tallenna Google Cloudin OAuth-clientin tiedot tiedostoon `server/credentials.json`.
- **Microsoft 365 / Outlook:** rekisteröi sovellus Azure-portaaliin ja aseta `MS_CLIENT_ID` ja `MS_CLIENT_SECRET`.
- **Muu sähköposti (IMAP/SMTP):** ei vaadi palvelimen asetuksia; palvelimet ja salasana annetaan asetuksissa.

Lisäksi jokainen toimiston käyttäjä voi yhdistää oman postilaatikkonsa kohdassa Asetukset → Käyttäjän asetukset → Oma sähköpostitili. Siihen tulevista viesteistä tehdään tehtäviä, jotka annetaan postilaatikon omistajalle, ja vastaukset lähtevät samasta osoitteesta. Taloyhtiö päätellään lähettäjästä (asukkaan taloyhtiö); tuntemattoman lähettäjän viesti kirjataan isännöitsijän omalle yhtiölle, jos hän on yhden yhtiön vastuuisännöitsijä, ja muuten oletusyhtiölle.

Ohjeet ovat tiedostossa [deploy/server/README.md](deploy/server/README.md), kohta "Sähköposti". Tiedostot `credentials.json` ja `token.json` sekä data-kansion `mail-secret.key` ovat salaisuuksia eivätkä kuulu repoon.

## Käännökset

Suomenkielinen teksti kirjoitetaan koodiin funktion `t()` sisään, ja sama teksti on käännöksen avain: `t("Tallenna")` tai muuttujien kanssa `t("Avain {0}", key.code)`. Englanninkieliset käännökset ovat tiedostossa `client/src/locales/en.ts`. Testi kaatuu, jos jollekin tekstille ei ole käännöstä tai paikkamerkit eivät täsmää.

Tietokantaan tallentuvat arvot (tehtävätyypit, roolit, autopaikka- ja avaintyypit) pysyvät suomenkielisinä; ne käännetään vasta näytettäessä. Palvelimen virheilmoitukset käännetään selaimessa samasta sanastosta.

## Tarkistukset

Molemmissa kansioissa (`server` ja `client`):

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript
npm test            # testit
npm run build       # tuotantokäännös
```

Palvelimen testit käynnistävät oman palvelimen tyhjään väliaikaiseen tietokantaan. Gmail ja AI ovat testeissä pois päältä, joten testit eivät lähetä postia eivätkä kutsu ulkoisia palveluja. Samat tarkistukset ajetaan GitHub Actionsissa (`.github/workflows/ci.yml`).

## Asetukset

Kaikki asetukset ovat ympäristömuuttujia; selitykset ovat tiedostossa [server/.env.example](server/.env.example).

| Muuttuja | Tarkoitus |
| --- | --- |
| `APP_URL`, `CORS_ORIGINS` | Osoitteet, joista selain saa kutsua rajapintaa |
| `INITIAL_PASSWORD` | Ensimmäisten käyttäjien salasana tyhjään tietokantaan |
| `DATA_DIR` | Tietokannan ja liitteiden kansio |
| `BACKUP_DIR`, `BACKUP_KEEP` | Päivittäinen varmuuskopio ja säilytettävien kopioiden määrä |
| `CLAMAV_HOST`, `CLAMAV_PORT` | Liitteiden virustarkistus ClamAV:lla |
| `TRUST_PROXY` | Välityspalvelimien määrä palvelimen edessä |
| `GMAIL_DISABLED` | `1` kytkee postin pois (kaikki palvelut) |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REDIRECT_URI` | Microsoft 365 -yhteys |
| `MAIL_SECRET_KEY` | Sähköpostisalasanojen salausavain |
| `VITE_API_URL` (client) | Rajapinnan osoite, jos se ei ole oletus |

## Tietoturva

- Rajapinta vaatii kirjautumisen. Istuntotunniste kulkee vain `Authorization`-otsakkeessa.
- Selainkutsut sallitaan vain osoitteista `APP_URL` ja `CORS_ORIGINS`.
- Pyyntöjä rajoitetaan käyttäjä- ja osoitekohtaisesti; kirjautumista ja salasanan palautusta tiukemmin.
- Ajettavia tiedostoja ei oteta vastaan liitteinä. Asukkaan liitteen pitää olla kuva tai PDF. Kun `CLAMAV_HOST` on asetettu, jokainen liite tarkistetaan ClamAV:lla, ja tiedosto hylätään, jos tarkistus ei ole käytettävissä.
- Asukkaan tiedot voi viedä ja poistaa asukkaan lomakkeelta. Suljetuille tehtäville ja lokille voi asettaa säilytysajan asetuksista.

## Varmuuskopiot

```bash
cd server
npm run backup -- /polku/varmuuskopioille
```

Komento tallentaa eheän kopion tietokannasta sekä liitteet ja tietopankin tiedostot omaan aikaleimattuun kansioonsa. Kun `BACKUP_DIR` on asetettu, palvelin ottaa kopion itse kerran päivässä ja säilyttää `BACKUP_KEEP` uusinta (oletus 14). Kopiot kannattaa viedä toiselle levylle tai palveluun.

Palautus: pysäytä palvelin ja kopioi varmuuskopion `kotilo.sqlite`, `attachments` ja `knowledge-files` kansioon `DATA_DIR`.

## Julkaisu osoitteeseen kotilo.io

Esittelysivu on kansiossa `site/` ja julkaistaan osoitteeseen `kotilo.io`. Alusta julkaistaan osoitteeseen `app.kotilo.io` erillisestä tuotantokopiosta. Vaiheet ja skriptit ovat tiedostossa [deploy/README.md](deploy/README.md).

## Tuotantoajo

Tuotannossa palvelin tarjoaa myös käännetyn käyttöliittymän, joten tarvitaan vain yksi palvelu ja yksi osoite.

```bash
docker build -t kotilo .
docker run -p 4000:4000 -v kotilo-data:/data --env-file server/.env kotilo
```

Ilman Dockeria: käännä `client` ja `server` komennolla `npm run build` ja käynnistä palvelin kansiosta `server` komennolla `NODE_ENV=production npm start`.

Ennen oikeaa käyttöä:

- Aseta palvelimen eteen HTTPS-päätepiste (esim. Caddy tai nginx) ja `TRUST_PROXY=1`.
- Aseta `APP_URL` sovelluksen julkiseen osoitteeseen.
- Liitä `/data` pysyvään levyyn ja aseta `BACKUP_DIR` toiselle levylle.
- Valvo osoitetta `/api/health`; se vastaa vain, kun tietokanta on käytettävissä.
