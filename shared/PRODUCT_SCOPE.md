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
- Vastausehdotus taloyhtiön tietopankin pohjalta, pyydettäessä. AI saa vain tehtävään osuvat tietopalat (enintään viisi), ei koko tietopankkia, ja ehdotuksen lähde tallentuu tehtävälle palan ja sivun tarkkuudella
- Raportti toistuvista aiheista ja ehdotukset uusiksi vakiotiedoiksi
- Avainsanahaku varalla, kun AI-avainta ei ole
- Arkaluonteinen tehtävä (terveys ja muut erityiset tietoryhmät) tunnistetaan sanalistalla tai käsittelijä merkitsee sen; sitä ei lähetetä AI:lle arviointiin, vastausehdotukseen eikä raporttiin
- Asukkaan tekstistä maskataan puhelinnumerot, sähköpostiosoitteet, henkilötunnukset ja tilinumerot ennen AI:ta; saapuvan viestin arviointi saa lähettäjästä vain sähköpostin verkkotunnuksen
- AI arvioi saapuvan tehtävän prioriteetin, kun pääkäyttäjä kytkee sen päälle toimiston asetuksista (oletuksena pois)
- AI tarkistaa, koskeeko saapuva sähköposti taloyhtiön asioita, ja pitää muut poissa päätösjonosta (oletuksena pois)

**Taloyhtiöt ja asukkaat**
- Taloyhtiöt, vastuuisännöitsijä ja muut isännöitsijät, huoltoyhtiön tiedot
- Asukkaat ja asunnot, tuonti CSV- tai Excel-tiedostosta
- Tietopankki: dokumentit ja vakiotiedot, versiot ja voimassaoloajat
- Dokumentit pilkotaan tiedoiksi taustalla (AI tai ilman avainta kappalejako, PDF sivuittain); isännöitsijä näkee, mitä AI poimi, ja voi tarkistaa, korjata, lisätä ja poistaa tietoja. AI ei koskaan muuta isännöitsijän tarkistamaa tai kirjoittamaa tietoa
- Dokumentin uusi versio odottaa hyväksyntää: muutokset (uudet, muuttuneet, poistuneet, ristiriidat) näytetään ennen kuin uusi versio korvaa vanhan; lataus tunnistaa todennäköisen uuden version
- Merkitse vanhentuneeksi ja muistutus tiedoista, jotka vanhenevat 30 päivän sisällä
- Dokumentaatio jaettuna kahteen: AI-dokumentaatiota AI käyttää vastausehdotuksissa, sisäinen on vain henkilökunnalle
- Sauna- ja pyykkitupavuorot, autopaikat, jonot, tiedotteet ja muuttoilmoitukset
- Laskutusraportit sauna- ja autopaikkamaksuista
- Remontti-ilmoitukset: isännöitsijä hyväksyy ehdoin tai hylkää perustellen ja merkitsee työn valmistuneeksi
- Avainrekisteri: avainten luovutus asukkaalle tai muulle vastaanottajalle, palautuspäivä ja luovutushistoria
- Kulutuslukemat (kylmä ja lämmin vesi, sähkö): kulutus edellisestä lukemasta ja vienti CSV-tiedostoon

**Asukasportaali**
- Kirjautuminen ja salasanan palautus
- Tiedotteet, omat tehtävät ja viestit, vuorojen varaus, jonot ja muuttoilmoitus
- Remontti-ilmoitus ja kulutuslukemien ilmoittaminen
- Käyttöliittymä suomeksi ja englanniksi sekä henkilökunnalle että asukkaille

**Käyttäjät ja tietosuoja**
- Roolit pääkäyttäjä, isännöitsijä ja asiakaspalvelu; yhtiökohtainen näkyvyys palvelimella
- Perustiedot (vain pääkäyttäjä): hätäsanat, arkaluonteisuuden tunnistussanat, maskaus, määräajat prioriteetin mukaan ja AI-mallit toiminnoittain
- Käyttäjän poisto, asukkaan tietojen vienti ja poisto; poistopyynnössä avoimen tehtävän voi säilyttää perusteella (esim. kesken oleva vahinko), ja se anonymisoidaan suljettaessa
- Säilytysaika suljetuille tehtäville ja lokille
- Liitteiden tarkistus, pyyntöjen rajoitus ja varmuuskopiot

## Ei vielä toteutettu

**Tehtävien käsittely**
- Hätätapauksesta ei hälytetä huoltoyhtiön päivystystä, eikä hälytys kulje tekstiviestillä tai puhelulla
- Saapuvan viestin tyyppi päätellään avainsanoista, ei AI:lla
- "AI hoitaa" -päätös ei lähetä vastausta automaattisesti

**Kanavat ja integraatiot**
- Muu sähköposti kuin Gmail (SMTP/IMAP, Microsoft 365)
- Gmailin push-ilmoitukset; uudet viestit haetaan 20 sekunnin välein
- Tekstiviestit ja puhelut
- Integraatiot isännöintijärjestelmiin ja asukasrekisterin synkronointi

**Isännöinnin toiminnot**
- Osakkaat ja osakeluettelo, hallitus ja yhtiökokoukset
- Vastikkeet ja isännöitsijäntodistukset
- Remontti-ilmoituksen liitteet (suunnitelmat) ja valvojan kirjaukset
- Asukkaan näkymä hänelle luovutettuihin avaimiin
- Kulutuslukemien vienti laskutukseen

**Käyttöliittymä**
- Ruotsinkielinen käyttöliittymä
- Sähköpostit ja palvelimen tuottamat tekstit (esim. AI:n perustelut) ovat vain suomeksi
- Mobiilisovellus

**Tuotanto**
- Sovellusta ei ole otettu käyttöön millään palvelimella: HTTPS, valvonta ja hälytykset puuttuvat
- Tietokanta on SQLite yhdellä levyllä; usean palvelimen ajo vaatisi tietokannan vaihdon
- Tietosuojan vaikutustenarviointi (DPIA) ja käsittelysopimukset (DPA)
