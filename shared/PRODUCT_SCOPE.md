# Kotilo: toteutettu ja puuttuva

Lähde: Kiito – tuotespeksi V1 (projektin aiempi nimi). Päivitetty 12.10.2026.

## Toteutettu

**Tehtävät**
- Saapuva sähköposti (Gmail), asukasportaali ja käsin luotu tehtävä
- Asukkaan ja asunnon tunnistus lähettäjästä, saman ketjun vastaukset samalle tehtävälle
- Päätösjono: osoita minulle, anna toiselle tai sulje
- Käsittelijä, prioriteetti, tyyppi ja määräaika; myöhässä olevat merkitään
- Viestiketju, vastaus sähköpostilla liitteineen, sisäiset muistiinpanot ja loki
- Työtilaukset huoltoyhtiölle ja niiden kuittaus
- Muistutuskooste käsittelijälle sähköpostilla (kytketään asetuksista)
- Hätätapauksesta lähtee heti sähköposti taloyhtiön vastuuisännöitsijälle; tulos näkyy tehtävän lokissa

**AI**
- Vastausehdotus taloyhtiön tietopankin pohjalta, pyydettäessä
- Raportti toistuvista aiheista ja ehdotukset uusiksi vakiotiedoiksi
- Avainsanahaku varalla, kun AI-avainta ei ole

**Taloyhtiöt ja asukkaat**
- Taloyhtiöt, vastuuisännöitsijä ja muut isännöitsijät, huoltoyhtiön tiedot
- Asukkaat ja asunnot, tuonti CSV- tai Excel-tiedostosta
- Tietopankki: dokumentit ja vakiotiedot, versiot ja voimassaoloajat
- Sauna- ja pyykkitupavuorot, autopaikat, jonot, tiedotteet ja muuttoilmoitukset
- Laskutusraportit sauna- ja autopaikkamaksuista

**Asukasportaali**
- Kirjautuminen ja salasanan palautus
- Tiedotteet, omat tehtävät ja viestit, vuorojen varaus, jonot ja muuttoilmoitus

**Käyttäjät ja tietosuoja**
- Roolit pääkäyttäjä, isännöitsijä ja asiakaspalvelu; yhtiökohtainen näkyvyys palvelimella
- Käyttäjän poisto, asukkaan tietojen vienti ja poisto
- Säilytysaika suljetuille tehtäville ja lokille
- Liitteiden tarkistus, pyyntöjen rajoitus ja varmuuskopiot

## Ei vielä toteutettu

**Tehtävien käsittely**
- Hätätapauksesta ei hälytetä huoltoyhtiön päivystystä, eikä hälytys kulje tekstiviestillä tai puhelulla
- Saapuvan viestin luokittelu on avainsanahaku, ei AI
- "AI hoitaa" -päätös ei lähetä vastausta automaattisesti

**Kanavat ja integraatiot**
- Muu sähköposti kuin Gmail (SMTP/IMAP, Microsoft 365)
- Gmailin push-ilmoitukset; uudet viestit haetaan 20 sekunnin välein
- Tekstiviestit ja puhelut
- Integraatiot isännöintijärjestelmiin ja asukasrekisterin synkronointi

**Isännöinnin toiminnot**
- Osakkaat ja osakeluettelo, hallitus ja yhtiökokoukset
- Vastikkeet ja isännöitsijäntodistukset
- Remontti-ilmoitukset, avainhallinta ja kulutuslukemat

**Käyttöliittymä**
- Käännökset; kielivalikko on olemassa, mutta käyttöliittymä on vain suomeksi
- Mobiilisovellus

**Tuotanto**
- Sovellusta ei ole otettu käyttöön millään palvelimella: HTTPS, valvonta ja hälytykset puuttuvat
- Tietokanta on SQLite yhdellä levyllä; usean palvelimen ajo vaatisi tietokannan vaihdon
- Tietosuojan vaikutustenarviointi (DPIA) ja käsittelysopimukset (DPA)
