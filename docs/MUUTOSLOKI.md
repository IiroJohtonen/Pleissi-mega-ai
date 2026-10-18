# Pleissin muutosloki

Jokaisesta päivityksestä kirjataan päivämäärä, mitä muutettiin ja miten. Testitapaukset ja niiden
tulokset ovat testaussivulla: https://claude.ai/artifact/9ioRJQ7LnYLHtmq6WHi3ri

## 18.10.2026 · Sähköpostitilin yhdistäminen: selkeä ilmoitus, missä osoite jo on

**Mitä muutettiin**
- Kun saman sähköpostiosoitteen yrittää yhdistää toiseen paikkaan, ilmoitus kertoo tarkalleen, missä osoite jo on:
  toimiston tilinä, tietyn käyttäjän omana postilaatikkona vai tietyssä taloyhtiössä, ja mistä sen voi poistaa.
  Aiemmin ilmoitus väitti aina "yhdistetty toiseen taloyhtiöön", vaikka osoite olisi ollut esimerkiksi oma postilaatikko.
- Isot ja pienet kirjaimet sekä välilyönnit osoitteen ympärillä eivät enää vaikuta vertailuun.
- Jos osoite on jäänyt tilille, jonka taloyhtiötä tai käyttäjää ei enää ole, vanha tili poistetaan eikä se estä yhdistämistä.

**Miten**
- Asetukset tai taloyhtiön tiedot → Taloyhtiön sähköpostitili → Yhdistä. Jos osoite on jo käytössä, ilmoitus kertoo missä.

**Testit:** T-100–T-101

## 17.10.2026 · Tila-monivalinta, Umpeutumassa-suodatin ja dokumenttihaun korjaus

**Mitä muutettiin**
- Tehtävälistan Tila-suodatin on nyt monivalinta. Oletuksena kaikki tilat ovat valittuina, ja niistä voi
  poistaa tai lisätä haluamansa. Vanha Keskeneräiset-valinta poistui, koska se oli päällekkäinen muiden
  tilojen kanssa. Kaikki kuusi tilaa säilyvät ennallaan.
- Määräaika-suodattimessa on uusi valinta Umpeutumassa: avoimet tehtävät, joiden määräaika on lähipäivinä.
  Myöhässä-valinta näyttää edelleen tehtävät, joiden määräaika on jo mennyt.
- Taloyhtiösuodatin poistettiin näkymistä, jotka avataan taloyhtiön alta: Jonot, Asukkaat, Muutot,
  Tiedotteet, Remontit ja Lukemat. Ne näyttävät aina sivupalkissa valitun taloyhtiön tiedot.
  Taloyhtiö-sarake näkyy vain, jos näkymässä on useamman yhtiön tietoja.
- Dokumentin Kokeile kysymyksellä löytää nyt myös taivutetut sanat: esimerkiksi kysymys remontista osuu
  dokumentin kohtaan, jossa puhutaan remontista tai remontin tekemisestä.
  Haku on edelleen Pleissin oma sanahaku. AI ei valitse tietoja, vaan kirjoittaa vastausehdotuksen
  haun löytämien tietojen pohjalta.

**Miten**
- Kaikki tehtävät → suodatinkuvake → Tila: avaa valikko ja valitse tai poista tiloja. Kaikki-ruutu valitsee
  tai poistaa kaikki kerralla.
- Kaikki tehtävät → suodatinkuvake → Määräaika → Umpeutumassa.
- Valitse sivupalkista taloyhtiö ja avaa esimerkiksi Asukkaat: taloyhtiövalintaa ei enää ole sivulla.
- Dokumentaatio → avaa dokumentti → Kokeile kysymyksellä → kirjoita asukkaan kysymys, jossa sana on
  eri muodossa kuin dokumentissa.

## 17.10.2026 · Taloyhtiö tunnistamatta -jono ja tehtävän siirto toiseen taloyhtiöön

**Mitä muutettiin**
- Jos saapuvasta sähköpostista ei selviä, mitä taloyhtiötä se koskee, tehtävä menee uuteen jonoon
  Taloyhtiö tunnistamatta. Aiemmin se meni aina oletusyhtiölle ja sen isännöitsijälle.
- Lähettäjä, joka löytyy asukasrekisteristä, tunnistetaan edelleen automaattisesti.
- Jonon näkevät pääkäyttäjät ja asetuksissa valitut roolit ja käyttäjät (oletuksena asiakaspalvelu).
- Jonon käsittelijä valitsee tehtävälle taloyhtiön ja halutessaan käsittelijän. Pleissi ehdottaa yhtiötä,
  jos lähettäjä tai viestissä mainittu yhtiön nimi tai osoite sen kertoo.
- Väärään taloyhtiöön mennyt tehtävä voidaan siirtää oikeaan. Se menee uuden yhtiön vastuuisännöitsijälle
  ja saa uuden tehtävänumeron. Siirron voi tehdä tehtävän käsittelijä, yhtiön vastuuisännöitsijä tai pääkäyttäjä.
- Tunnistamattoman hätätapauksen hälytys menee jonon käsittelijöille.

**Miten**
- Sivupalkki → Kaikki tehtävät → Tunnistamattomat. Avaa tehtävä → keltainen laatikko: valitse taloyhtiö
  (ehdotus on valmiina) ja käsittelijä → Siirrä taloyhtiöön.
- Tehtäväsivu → Yhtiö-kentän alla Väärä yhtiö? Siirrä → valitse yhtiö → Siirrä.
- Asetukset → Toimisto → Taloyhtiö tunnistamatta -jono: roolit ja lisäkäyttäjät.

**Testit** (lisättävä testaussivulle)
- Tunnistamaton viesti menee jonoon: lähetä toimiston sähköpostiin viesti osoitteesta, jota ei ole
  asukasrekisterissä, ja jossa ei mainita taloyhtiötä. Odotus: tehtävä näkyy kohdassa Tunnistamattomat
  eikä kenenkään Päätösjonossa.
- Asukkaan viesti tunnistetaan: lähetä viesti asukasrekisterissä olevasta osoitteesta. Odotus: tehtävä
  menee asukkaan taloyhtiöön, ei jonoon.
- Yhtiöehdotus: viestissä mainitaan taloyhtiön nimi (esim. "Männikön pihavalo"). Odotus: tehtävällä näkyy
  ehdotus kyseisestä yhtiöstä.
- Yhtiön valinta: valitse jonon tehtävälle yhtiö → Siirrä taloyhtiöön. Odotus: tehtävä katoaa jonosta,
  menee yhtiön vastuuisännöitsijälle ja saa yhtiön seuraavan tehtävänumeron.
- Näkyvyys asetuksista: poista Asiakaspalvelu jonon rooleista. Odotus: asiakaspalvelun käyttäjä ei näe
  Tunnistamattomat-kohtaa eikä jonon tehtäviä. Lisää yksittäinen isännöitsijä: hän näkee jonon.
- Siirto väärästä yhtiöstä: avaa oma tehtävä → Väärä yhtiö? Siirrä → valitse toinen yhtiö. Odotus:
  tehtävä siirtyy, aikajanalla näkyy "Siirretty toiseen taloyhtiöön" ja vanha → uusi yhtiö.
- Siirto-oikeus: asiakaspalvelun käyttäjä, joka ei ole tehtävän käsittelijä. Odotus: siirtoa ei voi tehdä.

## 17.10.2026 · Tehtävät kaikista taloyhtiöistä ja taloyhtiön valinta sivupalkissa

**Mitä muutettiin**
- Kaikki tehtävät, Omat tehtävät ja AI tehtävät näyttävät kaikkien taloyhtiöiden tehtävät; yhtiön voi
  rajata Taloyhtiö-suodattimella.
- Tehtävälistassa on Taloyhtiö-sarake (yhtiö ja sen alla yhteyshenkilö).
- Kaikki tehtävät näyttää oletuksena keskeneräiset; suljetut saa esiin poistamalla Tila-merkin.
- Taloyhtiön valinta siirtyi yläpalkista sivupalkin yhtiöosion otsikoksi. Valikon lopussa on Kaikki
  taloyhtiöt…, josta pääsee taloyhtiöiden listaan.
- Yhtiöosiossa ovat Yhtiön tiedot ja Dokumentaatio asukkaiden, tilojen ja ilmoitusten lisäksi.
- Dokumentin näkymän asettelu korjattu: sisältö ei enää puristu kapeaksi palstaksi.

**Miten**
- Sivupalkki → Kaikki tehtävät: suodatinkuvake → Taloyhtiö.
- Sivupalkin alaosa: taloyhtiön nimi on valikko; sen alla Yhtiön tiedot, Dokumentaatio, Asukkaat, Tilat ja Ilmoitukset.

**Testit** (lisättävä testaussivulle)
- Kaikki tehtävät näyttää usean yhtiön tehtävät ja Taloyhtiö-sarakkeen; suodatin rajaa yhteen yhtiöön.
- Tila-merkin poisto näyttää myös suljetut tehtävät.
- Sivupalkin yhtiövalikosta vaihdettu yhtiö vaihtaa Asukkaat-, Sauna- ja Dokumentaatio-näkymien yhtiön.
- Kaikki taloyhtiöt… avaa yhtiölistan; listasta avattu yhtiö vaihtaa sivupalkin valinnan.
- Dokumentin avaaminen leveällä näytöllä: poiminnat ja luettu teksti näkyvät vierekkäin täysleveänä.
## 17.10.2026 · Lomakkeet taloyhtiön tauluihin, uusi Asetukset-sivu ja dokumentin välilehdet

**Mitä muutettiin**
- Verkkosivun mittarilukemailmoitus menee Lukemat-tauluun (kylmä ja lämmin vesi omina lukeminaan), muuttoilmoitus
  Muutot-tauluun ja auton lämmityspaikka Autopaikat-sivun uuteen Lämmityspaikan tilaukset -tauluun. Niistä ei enää tule tehtäviä.
- Tietueilla on samat kentät kuin verkkosivun lomakkeella, ja niitä voi muokata (Muokkaa-painike). Jos osoitetta ei
  tunnisteta, tietue tulee ilman asuntoa ja asunnon voi valita muokkaamalla; muuttoilmoitusta ei voi hyväksyä ilman asuntoa.
- Asukasportaalin Auton lämmityspaikka on nyt tilauslomake (paikka, tilaustyyppi, alkaen, loppuu), ja tilaus näkyy Autopaikat-sivulla.
- Huoltotyötilaus, häiriöilmoitus, irtisanomisilmoitus ja asuntohakemus pysyvät tehtävinä. Erillinen Lomakkeet-taulu poistettiin.
- Asetukset-sivu on leveämpi. Isännöitsijätoimiston tiedot ovat välilehdillä (Toimisto, Tietoturva, AI, Perustiedot,
  Käyttäjät, Järjestelmä), ja vasemmalla on aliotsikot, joista pääsee suoraan oikeaan kohtaan. Samat aliotsikot ovat käyttäjän asetuksissa.
- Dokumentin näkymässä on välilehdet Dokumentista luettu teksti ja Mitä AI poimi tästä.

**Miten**
- Ilmoitukset → Lukemat, Asukkaat → Muutot ja Tilat → Autopaikat (alhaalla Auton lämmityspaikan tilaukset): avaa rivi → Muokkaa.
- Asetukset → Isännöitsijätoimiston tiedot → välilehdet; aliotsikot vasemmalla.
- Dokumentaatio → avaa dokumentti → välilehdet (Mitä AI poimi tästä vain pääkäyttäjälle).

**Testit:** T-080–T-087

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
