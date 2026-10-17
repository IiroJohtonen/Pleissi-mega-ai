# Pleissin muutosloki

Jokaisesta päivityksestä kirjataan päivämäärä, mitä muutettiin ja miten. Testitapaukset ja niiden
tulokset ovat testaussivulla: https://claude.ai/artifact/9ioRJQ7LnYLHtmq6WHi3ri

## 17.10.2026 · Verkkosivun lomakkeet sähköpostista Lomakkeet-tauluun

**Mitä muutettiin**
- Toimiston postiin tuleva viesti, jonka otsikossa on lomakkeen nimi (Mittarilukemailmoitus, Muuttoilmoitus,
  Huoltotyötilaus, Auton lämmityspaikka, Asuntohakemus, Häiriöilmoitus, Irtisanomisilmoitus), luetaan lomakkeeksi:
  viestin kentät tallentuvat tehtävälle otsikoineen
- Kenttien nimet ovat isännöitsijäyrityksen verkkosivun lomakkeista, joten myös taulukkomuotoinen viesti luetaan oikein
- Lomakkeen osoite ja huoneistonumero ohjaavat tehtävän oikeaan taloyhtiöön ja asuntoon; ilmoittaja liitetään
  asukkaaseen lomakkeen sähköpostin tai nimen perusteella
- Uusi Lomakkeet-taulu (sivupalkki → Ilmoitukset → Lomakkeet), jossa oma välilehti jokaiselle lomaketyypille;
  myös asukasportaalin lomakkeet näkyvät siellä
- Lomakkeita ei lähetetä AI:lle, koska niissä voi olla henkilötunnuksia ja tilinumeroita

**Miten**
- Sivupalkki → valitse taloyhtiö → Ilmoitukset → Lomakkeet. Rivi avaa tehtävän, jolla kaikki kentät ovat
  Lomakkeen tiedot -kortissa.

**Testit:** T-074–T-079

## 17.10.2026 · Asukasportaalin lomakkeet: huoltotyötilaus, häiriöilmoitus, irtisanomisilmoitus, asuntohakemus ja lämmityspaikka

**Mitä muutettiin**
- Asukasportaaliin uusi Lomakkeet-osio, jossa ovat isännöitsijäyrityksen sivujen lomakkeet: huoltotyötilaus,
  häiriöilmoitus, mittarilukemat, muuttoilmoitus, remontti-ilmoitus, auton lämmityspaikka, irtisanomisilmoitus
  ja yleinen asuntohakemus
- Lähetetystä lomakkeesta tulee isännöitsijälle tehtävä, jolla lomakkeen tiedot näkyvät selkeänä taulukkona;
  asukas näkee lomakkeen ja vastaukset Tehtävät-sivulla
- Irtisanomisilmoitus kertoo aikaisimman päättymispäivän; liian aikaisesta päivästä näkyy huomio myös isännöitsijälle
- Autopaikoille uusi paikkatyyppi Lämmityspaikka (hinta asetuksissa, jono portaalissa)
- Kulutuslukemat-sivu on nyt nimeltään Mittarilukemat

**Miten**
- Asukasportaali → sivupalkin Lomakkeet (puhelimella Lisää-valikko).
- Isännöitsijä: päätösjono ja Kaikki tehtävät → avaa tehtävä, jonka tyyppi on Huoltotyötilaus, Häiriöilmoitus,
  Irtisanomisilmoitus tai Asuntohakemus.

**Testit:** T-067–T-073

## 16.10.2026 · Kirjautumiskoodi sähköpostiin ja tilapäivitykset asukkaalle

**Mitä muutettiin**
- Henkilökunnan kirjautumiseen kuusinumeroinen koodi sähköpostiin (kytketään asetuksista)
- Luotettu laite: koodia ei kysytä samalla laitteella 30 päivään
- Asukas saa sähköpostin, kun hänen ilmoituksensa etenee
- Tietoturvakatselmus: kirjautumisyritykset rajattu viiteen vartissa käyttäjää kohden

**Miten**
- Asetukset → Isännöitsijätoimiston tiedot → Tietoturva: Kirjautumiskoodi sähköpostiin. Vaatii yhdistetyn
  toimiston sähköpostitilin. Hätäkatkaisin palvelimelle: TWO_FACTOR_DISABLED=1.
- Asetukset → Asukasviestintä: Tilapäivitykset asukkaalle (oletuksena päällä). Viesti lähtee työtilauksesta,
  tehdystä työstä, käsittelyyn otosta, siirrosta kolmannelle osapuolelle ja sulkemisesta.

**Testit:** T-033–T-041

## 16.10.2026 · Ilmoittaja näkyviin tietueille, siirtymä asukkaan tietueelle, uudet sauna- ja pyykkitupasivut, tiiviimpi dokumentaatio

**Mitä muutettiin**
- Ilmoittajan nimi, asunto, osoite ja sähköposti näkyvät jonoissa, muutoissa, lukemissa ja avaimen haltijana
- Ilmoittajan voi vaihtaa hakemalla asukastaulusta
- Painike ilmoittajan vieressä vie asukkaan tietueelle (kysyy ensin vahvistuksen)
- Sauna ja pyykkitupa: suodattimet ja viikkonavigaatio aina näkyvissä, tilakohtaiset värit ja viikon yhteenveto
- Dokumentaatio: tiivis otsikko, AI:n poiminnat ja luettu teksti vierekkäin, Merkitse tarkistetuksi -painike

**Miten**
- Jonot, Muutot ja Lukemat: avaa tietue → Ilmoittaja-kortti ylhäällä; hakukentästä uusi ilmoittaja,
  henkilökuvake avaa vahvistusikkunan ja Kyllä, siirry avaa asukkaan tiedot.
- Tehtäväsivulla henkilökuvake on Ilmoittaja-otsikon vieressä. Remontin ilmoittaja vaihdetaan remonttitehtävältä.
- Sauna ja Pyykkitupa: yläpalkissa viikon vaihto, taloyhtiö, kellonaika ja Kaikki / Vapaat / Varatut.
- Dokumentaatio → dokumentti: Mitä AI poimi tästä näkyy vain pääkäyttäjälle.

**Testit:** T-021–T-032

## 16.10.2026 · PR #17 · AI-kulujen raja, järjestelmähälytykset, raportit, hallituksen näkymä ja portaalin kuvaliitteet

**Mitä muutettiin**
- AI-kulujen kuukausiraja ja varoitusraja asetuksiin
- Järjestelmähälytykset sähköpostilla ja Järjestelmän tila -kortti
- Raportit: Mittarit kaikista taloyhtiöistä ja tallennettavat omat raportit (CSV)
- Hallituksen näkymä: hallituksen jäsenen omat lukutunnukset
- Asukasportaali: Ota kuva -painike, liitteiden esikatselu ja kuvien pienennys

**Miten**
- Asetukset → Isännöitsijätoimiston tiedot → AI: kulumittari, kuukausiraja ($) ja varoitusraja (%).
  Rajan täyttyessä AI kytkeytyy pois kuun loppuun.
- Asetuksissa uusi Järjestelmän tila -kortti; avoimista hälytyksistä ilmoitus sovelluksen yläosassa pääkäyttäjälle.
- Raportit-sivulla välilehdet Mittarit, Omat raportit ja Taloyhtiön raportit.
- Taloyhtiöt → yhtiö → Hallituksen näkymä -kortti: tunnusten luonti. Jäsen kirjautuu samalta kirjautumissivulta.
- Asukasportaali → Tehtävät → Luo tehtävä: uudet liitepainikkeet.

**Testit:** T-001–T-020
