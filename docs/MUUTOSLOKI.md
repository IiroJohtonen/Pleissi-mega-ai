# Pleissin muutosloki

Jokaisesta päivityksestä kirjataan päivämäärä, mitä muutettiin ja miten. Testitapaukset ja niiden
tulokset ovat testaussivulla: https://claude.ai/artifact/9ioRJQ7LnYLHtmq6WHi3ri

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
