# Pleissi Mega AI palvelimella (UpCloud)

Pleissi Mega AI on Kotilon kopio, johon lisätään AI-ominaisuuksia. Se asennetaan **samalle palvelimelle kuin
Kotilon tuotantoversio** osoitteeseen `test2.kotilo.io`, mutta omaan kansioonsa ja omalla tietokannallaan:

| | Pleissi Mega AI | Kotilo (tuotanto) |
| --- | --- | --- |
| Osoite | `test2.kotilo.io` | `app.kotilo.io` |
| Repo | Pleissi-mega-ai | kotilo |
| Kansio palvelimella | `/opt/pleissi-ai` | `/opt/kotilo` |
| Docker-projekti ja kontti | `pleissi-ai` | `kotilo` |
| Tietokanta ja liitteet | oma (`pleissi-ai-data`) | oma |

Mega AI:lla ei ole omaa Caddya, koska portit 80 ja 443 ovat Kotilon Caddyn. Mega AI:n kontti liittyy Kotilon
Docker-verkkoon, ja Kotilon Caddy ohjaa osoitteen `test2.kotilo.io` sille ja hakee sen HTTPS-varmenteen. Kotilon
tiedostoihin, tietokantaan ja asetuksiin Mega AI ei koske.

## 1. Edellytykset

- Kotilo on asennettu palvelimelle Kotilon ohjeen mukaan (kotilo-repon `deploy/server/README.md`).
- Kotilo on päivitetty versioon, jonka Caddyfilessä on osoite `test2.kotilo.io`. Mega AI:n julkaisu keskeytyy
  ilmoitukseen, jos näin ei ole.
- Palvelimella on muistia vähintään 4 Gt, koska palvelimella pyörii kaksi sovellusta. Muistin voi kasvattaa
  UpCloudin hallintapaneelista (palvelin pitää sammuttaa hetkeksi).

## 2. Domain osoittamaan palvelimeen

Lisää domainin DNS-hallinnassa A-tietue samaan IP-osoitteeseen kuin `app`:

| Nimi | Tyyppi | Arvo |
| --- | --- | --- |
| `test2` | A | palvelimen IP (sama kuin `app`) |

Muutos tulee voimaan yleensä muutamassa minuutissa, joskus vasta tunnin kuluessa. Voit tarkistaa sen komennolla `nslookup test2.kotilo.io`.

## 3. Kotilon päivitys

Kotilo-repon juuressa (päähaarassa, jossa test2-osoite on mukana):

```powershell
powershell -ExecutionPolicy Bypass -File deploy\server\deploy.ps1 -Server root@PALVELIMEN-IP
```

Kotilon Caddy käynnistyy uudelleen ja tuntee osoitteen `test2.kotilo.io`. Ennen Mega AI:n asennusta osoite antaa
virheen; Kotilon omat osoitteet toimivat koko ajan normaalisti.

## 4. Asennus

Pleissi-mega-ai-repon juuressa:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\server\deploy.ps1 -Server root@PALVELIMEN-IP
```

Komento vie viimeisimmän commitin kansioon `/opt/pleissi-ai`, luo asetustiedoston ja käynnistää Mega AI:n. Ensimmäinen kerta kestää muutaman minuutin.

Lopuksi komento tulostaa aloitussalasanan. Kirjaudu osoitteessa `https://test2.kotilo.io` tunnuksella `demo@pohjantahti-isannointi.fi` ja vaihda käyttäjien osoitteet ja salasanat heti asetuksista. Tietokanta on uusi ja tyhjä: Kotilon tehtävät ja asukkaat eivät siirry.

Jos varmenne ei heti toimi, DNS ei ole vielä ehtinyt päivittyä. Kotilon Caddy yrittää uudelleen itse.

## 5. Asetukset palvelimella

Asetukset ovat tiedostossa `/opt/pleissi-ai/.env`. AI-avain lisätään sinne:

```powershell
ssh root@PALVELIMEN-IP
nano /opt/pleissi-ai/.env        # lisää ANTHROPIC_API_KEY=..., tallenna Ctrl+O, poistu Ctrl+X
exit
```

Aja sen jälkeen kohdan 4 komento uudelleen, jotta muutos tulee voimaan.

## 6. Sähköposti

Saapuva ja lähtevä posti kulkee toimiston tai taloyhtiön sähköpostitilin kautta. Tili yhdistetään alustassa: **Asetukset → Isännöitsijätoimiston tiedot → Toimiston sähköpostitili**, ja taloyhtiön oma tili taloyhtiön sivulta. Vaihtoehtoja on kolme.

### Gmail

1. Google Cloud -konsolissa OAuth-clientin **Authorized redirect URIs** -listaan lisätään `https://test2.kotilo.io/api/gmail/callback`.
2. Vie OAuth-clientin tiedosto palvelimelle:

   ```powershell
   scp server\credentials.json root@PALVELIMEN-IP:/opt/pleissi-ai/config/credentials.json
   ```

3. Yhdistä tili alustassa painikkeella **Gmail**.

### Microsoft 365 / Outlook

Sovellus rekisteröidään kerran Microsoftin Azure-portaaliin. Kirjaudu toimiston Microsoft 365 -työtilillä; henkilökohtaisella tilillä (esim. @outlook.com) portaali ei avaudu ilman omaa hakemistoa.

1. Avaa https://portal.azure.com → **Microsoft Entra ID → App registrations → New registration**.
2. **Name:** Kotilo. **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*.
3. **Redirect URI:** tyyppi **Web**, osoite `https://test2.kotilo.io/api/mail/microsoft/callback`.
4. Kopioi **Application (client) ID**.
5. **Certificates & secrets → New client secret** ja kopioi salaisuuden **Value** (näytetään vain kerran). Salaisuus vanhenee valitun ajan kuluttua; tee silloin uusi ja vaihda se palvelimelle.
6. Lisää palvelimen tiedostoon `/opt/pleissi-ai/.env`:

   ```
   MS_CLIENT_ID=kopioitu-client-id
   MS_CLIENT_SECRET=kopioitu-salaisuus
   MS_REDIRECT_URI=https://test2.kotilo.io/api/mail/microsoft/callback
   ```

7. Aja kohdan 4 julkaisukomento uudelleen, jotta asetukset tulevat voimaan.
8. Yhdistä tili alustassa painikkeella **Microsoft 365 / Outlook**. Jos organisaatio vaatii ylläpitäjän hyväksynnän, Microsoft pyytää sen kirjautumisen yhteydessä.

Kotilo tarvitsee oikeudet lukea ja lähettää postia (Mail.ReadWrite, Mail.Send) sekä lukea tilin osoitteen (User.Read).

### Muu sähköposti (IMAP/SMTP)

Toimii useimpien palvelujen kanssa (oman domainin posti, Telia, Elisa, iCloud ym.) eikä vaadi palvelimen asetuksia. Valitse alustassa **Muu sähköposti (IMAP/SMTP)** ja täytä sähköpostipalvelun antamat tiedot: saapuvan postin palvelin (IMAP, portti yleensä 993) ja lähtevän postin palvelin (SMTP, portti yleensä 465 tai 587). Kotilo kokeilee yhteyden ennen tallennusta. Jos tilillä on kaksivaiheinen tunnistautuminen, käytä palvelun sovellussalasanaa.

Yritysten Microsoft 365 -tileissä IMAP-kirjautuminen salasanalla on yleensä estetty; käytä niille Microsoft 365 -yhteyttä.

Salasanat ja Microsoftin tunnisteet tallennetaan salattuina. Salausavain on data-levyn tiedostossa `mail-secret.key` tai muuttujassa `MAIL_SECRET_KEY`. Jos tietokanta palautetaan varmuuskopiosta uudelle levylle ilman avainta, sähköpostitilit pitää yhdistää uudelleen.

### Käyttäjien omat postilaatikot

Jokainen toimiston käyttäjä voi yhdistää oman postilaatikkonsa itse: **Asetukset → Käyttäjän asetukset → Oma sähköpostitili**. Palvelut ja ohjeet ovat samat kuin yllä. Laatikkoon tulevista viesteistä tehdään tehtäviä, jotka annetaan sen omistajalle, ja vastaukset lähtevät samasta osoitteesta. Pääkäyttäjä näkee käyttäjälistassa, kenellä on postilaatikko yhdistettynä. Kun käyttäjä poistetaan, myös hänen postilaatikkonsa yhteys poistuu.

### Kehitysversio

Lisää kehitysversion tiedostoon `server\.env` rivi `GMAIL_DISABLED=1`. Muuten kehitysversio ja palvelin lukevat samaa postilaatikkoa, ja sama viesti päätyy kumpaankin.

Sama koskee Kotilon tuotantoversiota: yhdistä Pleissi Mega AI:hin eri postilaatikko kuin Kotiloon, muuten sama viesti tulee tehtäväksi molempiin.

## Päivittäminen

Kun uusi versio on commitoitu kehitysrepoon, aja sama komento kuin asennuksessa:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\server\deploy.ps1 -Server root@PALVELIMEN-IP
```

Tietokanta, liitteet ja asetukset säilyvät.

## Esittelyaineisto

Esittelyä varten alustan voi tyhjentää ja täyttää kuvitteellisella aineistolla: neljä taloyhtiötä asuntoineen ja
asukkaineen, noin 70 tehtävää (myös AI-ehdotuksia ja vanhoja hoidettuja), dokumentit, avaimet lainoineen, sauna- ja
pyykkituvan vuorot, autopaikat, jonot, mittarilukemat, muutot, remontit, tiedotteet ja hallituksen tunnukset.

```
powershell -ExecutionPolicy Bypass -File deploy\server\demo-reset.ps1 -Server root@test2.kotilo.io -Salasana "Esittely-2026" -Sahkoposti oma@osoite.fi
```

- Kaikki nykyiset tiedot ja käyttäjät poistuvat. Varmuuskopio otetaan ensin kansioon `/opt/pleissi-ai/varmuuskopiot`.
- Toimiston asetukset, perustiedot ja AI-kulujen seuranta säilyvät.
- Pääkäyttäjä kirjautuu `-Sahkoposti`-osoitteella (oletus demo@pohjantahti-isannointi.fi). Anna oma osoitteesi, jos
  kirjautumiskoodi on käytössä, jotta koodi tulee perille.
- Muut tunnukset samalla salasanalla: isännöitsijät hanna.lehtonen@, mikko.rantanen@ ja jari.salminen@ sekä asiakaspalvelu
  elina.koskinen@pohjantahti-isannointi.fi, asukasportaali liisa@example.com ja matti@example.com, hallitus
  hallitus.koivikko@example.com (myös honkaranta, satamakulma ja pihlajapuisto).

## Varmuuskopiot

- Kotilo ottaa tietokannasta ja liitteistä varmuuskopion kerran päivässä kansioon `/opt/pleissi-ai/varmuuskopiot` ja säilyttää 14 uusinta.
- UpCloudin oma varmuuskopiointi (Kotilon ohjeen kohta 2) kopioi koko palvelimen levyn, eli myös nämä kopiot. Se suojaa tilanteelta, jossa palvelin tai sen levy menetetään.
- Varmuuskopiotiedostot eivät ole erikseen salattuja: ne ovat suojassa vain niin kauan kuin ne ovat salatulla levyllä. Jos kopioita siirretään palvelimen ulkopuolelle, ne pitää salata ennen siirtoa.

Palautus: pysäytä kontit, kopioi varmuuskopion `kotilo.sqlite`, `attachments` ja `knowledge-files` data-levylle ja käynnistä uudelleen.

## Hyödyllisiä komentoja palvelimella

```bash
cd /opt/pleissi-ai/app/deploy/server
docker compose -p pleissi-ai ps                  # ovatko kontit käynnissä
docker compose -p pleissi-ai logs -f pleissi-ai     # Mega AI:n loki
docker compose -p pleissi-ai restart pleissi-ai     # uudelleenkäynnistys
# Varmenteet ja liikenne näkyvät Kotilon Caddyn lokissa:
cd /opt/kotilo/app/deploy/server && docker compose -p kotilo logs -f caddy
```
