# Pleissin muutosloki

Jokaisesta päivityksestä kirjataan päivämäärä, mitä muutettiin ja miten. Testitapaukset ja niiden
tulokset ovat testaussivulla: https://claude.ai/artifact/9ioRJQ7LnYLHtmq6WHi3ri

## 26.10.2026 · AI-luonnosten muokkausmittari ja toistuvien aiheiden raportin korjaus

**Mitä muutettiin**
- Kun käsittelijä lähettää vastauksen, jonka pohjana oli AI:n vastausehdotus, Pleissi vertaa lähetettyä
  tekstiä luonnokseen ja kirjaa, lähtikö luonnos sellaisenaan, pienellä tai isolla muokkauksella vai kokonaan
  uudelleen kirjoitettuna. Allekirjoitus ei vaikuta vertailuun.
- Raportit › Trendit näyttää uuden osion AI-luonnosten muokkaus: aiheittain lähetetyt vastaukset ja kuinka
  suuri osa luonnoksista lähti sellaisenaan. Tästä näkee, mitkä aiheet ovat valmiita AI-agentin hoidettavaksi.
- Toistuvien aiheiden raportti käyttää nyt kaikkia toimiston vastauksia asukkaalle, ei vain ensimmäistä.
  Huoltoyhtiölle lähetettyjä työtilauksia ei enää lueta vastaukseksi asukkaalle.
- Toimiston vastauksista peitetään yhteystiedot ja tunnisteet ennen kuin ne lähtevät AI:lle raporttia varten,
  samoin kuin asukkaan viesteistä.

**Miten**
- Tehtävä › AI-ehdotus › lähetä vastaus (muokattuna tai sellaisenaan) › Raportit › Trendit › AI-luonnosten muokkaus.
- Raportit › Toistuvat aiheet › Luo raportti.

**Pull request:** #3 · testit lisättävä testaussivulle

## 25.10.2026 · Vikahistoria, trendit ja taloyhtiön muisti

**Mitä muutettiin**
- Tehtävää suljettaessa voi kirjata lyhyesti, mikä ratkaisi asian. Ratkaisun voi kirjata ja muokata myös myöhemmin
  tehtävällä. Yhteisen vian korjauksen yhteydessä ratkaisu kirjataan kaikille sen ilmoituksille.
- Tehtävällä on Aiemmin-osio: saman asunnon tehtävät kahden vuoden ajalta, saman portaan samanaiheiset tehtävät
  vuoden ajalta ja taloyhtiön aiemmat samanaiheiset yhteiset viat ratkaisuineen.
- Raportit › Trendit: aiheet kuukausittain (tavallista vilkkaampi kuukausi korostettuna), toistuvat viat, hoitoajat
  aiheittain, huoltoyhtiöiden työtilaukset ja yhteiset viat. Trendit ovat laskentaa eivätkä maksa AI-kuluja.
- Raportit › Taloyhtiön muisti: AI käy läpi ratkaistut tehtävät ja ehdottaa niistä pysyviä tietoja rakennuksesta,
  esimerkiksi toistuvan vian syyn tai tehdyn korjauksen. Isännöitsijä hyväksyy, muokkaa tai hylkää ehdotukset ja voi
  lisätä tietoja itse. Asukkaista ei tallenneta mitään.
- Vain hyväksytyt tiedot annetaan AI:lle: AI-ehdotus, AI-agentti ja yhteisen vian AI-tulkinta käyttävät niitä.
  Yhteisen vian tulkinta saa lisäksi aiemmat samanaiheiset viat ja niiden ratkaisut.
- Ehdotukset haetaan painikkeesta. Asetuksista voi kytkeä viikoittaisen haun; AI:ta kutsutaan vain, jos uusia
  ratkaisuja on.

**Miten**
- Sulje tehtävä -ikkuna › Mikä ratkaisi asian?
- Tehtävä › Mikä ratkaisi asian ja Aiemmin.
- Raportit › Trendit ja Raportit › Taloyhtiön muisti.
- Asetukset › Isännöitsijätoimiston tiedot › AI › Ehdota taloyhtiön muistiin tietoja kerran viikossa.

**Testit:** T-187–T-192 · Pleissi Mega AI

## 24.10.2026 · Yhtenäiset painikkeet ja yhteisten vikojen rajat asetuksiin

**Mitä muutettiin**
- Kaikki toimintopainikkeet ovat saman kokoisia ja näköisiä: tavallinen painike on valkoinen harmaalla reunalla,
  päätoiminto sininen ja poisto punaisella tekstillä. Teksti on tavallista eikä lihavoitua.
- Hiiren alla painike tummuu hieman, näppäimistöllä valittu painike saa sinisen kehyksen, ja painike, jota ei voi
  juuri nyt käyttää, on harmaa eikä läpikuultava.
- Näkymän päätoiminto on sininen: Lisää asukas, Luo dokumentti, Uusi tiedote ja Lisää taloyhtiö.
- Yhteisten vikojen rajat ovat säädettävissä: jokaiselle aiheelle voi valita, seurataanko sitä, montako eri
  asuntoa tarvitaan ja minkä ajan sisällä. Palauta oletusrajat palauttaa alkuperäiset arvot.

**Miten**
- Painikkeet näkyvät koko sovelluksessa, esim. tehtävän yläpalkissa ja päätösjonon korteissa.
- Asetukset › Isännöitsijätoimiston tiedot › AI › Tunnista yhteiset viat › rajataulukko.

**Testit:** T-184–T-186 · Pleissi Mega AI

## 24.10.2026 · Mahdolliset yhteiset viat

**Mitä muutettiin**
- Jokainen tehtävä saa aiheen (esim. lämmitys, lämmin vesi, vesivuoto, hissi, sähkö). Aihe näkyy tehtävällä, sen
  voi vaihtaa, ja Kaikki tehtävät -listan voi suodattaa aiheen mukaan.
- Kun useampi eri asunto ilmoittaa samasta aiheesta lyhyessä ajassa ja selvästi tavallista enemmän (esim. kolme
  saman portaan asuntoa kylmästä vuorokauden sisällä), Päätösjonon yläosaan tulee Mahdolliset yhteiset viat -rivi
  ja vastuuisännöitsijä saa sähköpostin. Saman asunnon useampi viesti lasketaan yhdeksi.
- Yhteisen vian näkymässä on tilanne (montako asuntoa, mistä portaasta, milloin) ja selitys, miksi vika on
  todennäköisemmin yhteinen kuin yksittäisen asunnon asia. Tunnistus on laskentaa eikä maksa AI-kuluja.
- AI-tulkinnan voi pyytää painikkeesta: AI arvioi todennäköisen syyn, ehdottaa toimenpiteet ja kirjoittaa
  luonnokset työtilaukseksi, tiedotteeksi ja vastaukseksi. Arkaluonteisten ilmoitusten tekstiä ei lähetetä AI:lle.
- Samasta näkymästä voi lähettää yhden työtilauksen huoltoyhtiölle, julkaista tiedotteen portaan tai koko
  taloyhtiön asukkaille, vastata kaikille ilmoittajille ja merkitä vian korjatuksi, jolloin kaikki ilmoitukset
  suljetaan viestin kera.
- Halutessa uusiin samanaiheisiin ilmoituksiin vastataan automaattisesti, myös toimiston ollessa kiinni. AI-agentti
  vastaa yhteiseen vikaan kuuluvaan tehtävään samalla viestillä ilman AI-kutsua.
- Toisen portaan ilmoitus liitetään samaan vikaan, joka laajenee koskemaan koko taloyhtiötä. Väärin liitetyn
  ilmoituksen voi irrottaa, ja Ei yhteinen vika -painike sulkee vian.

**Miten**
- Päätösjono › Mahdolliset yhteiset viat (näkyy, kun vika on tunnistettu).
- Tehtävä › Aihe-kenttä ja ilmoitus Kuuluu mahdolliseen yhteiseen vikaan.
- Asetukset › Isännöitsijätoimiston tiedot › AI › Tunnista yhteiset viat (oletuksena päällä).

**Testit:** T-176–T-183 · Pleissi Mega AI

## 24.10.2026 · Rauhallisempi ulkoasu

**Mitä muutettiin**
- Koko sovellus käyttää nyt yhtä yhtenäistä väri-, kirjasin- ja välistyskokoelmaa (kuvattu tiedostossa
  DESIGN.md). Väreillä on merkitys: punainen ja keltainen kertovat kiireestä, sininen on painike tai valittu kohta.
- Mustat päätoimintopainikkeet ovat nyt sinisiä. Valitut välilehdet ja suodattimet näkyvät vaaleansinisinä.
- Nimilaput ja otsikot ovat tavallisella kirjoitusasulla eivätkä ISOILLA KIRJAIMILLA.
- Tehtäväkortissa otsikko on ensin, ja taloyhtiö, asunto, asukas ja numero ovat tavallista tekstiä.
  Tehtäväkorteilla ja -riveillä ei ole värillisiä reunoja; prioriteettimerkki näkyy vain kiireellisillä ja
  hätätehtävillä.
- Päätösjonon laskurit ovat yhdellä rauhallisella rivillä. Tehtävä- ja asukaslistan rivit ovat yhtenäisenä listana.
- Sauna- ja pyykkituvan kalenterit käyttävät samaa sinistä väriä oranssin ja turkoosin sijaan.
- AI-painikkeista on poistettu kipinä- ja robottikuvakkeet, ja AI-ehdotus näkyy lainauksena.
- Sivun yläosan PLEISSI / toimisto -teksti on poistettu. Kenttien kohdistuskehys on sininen.
- Tumma tila käyttää samoja värejä tummina versioina.

**Miten**
- Näkyy koko sovelluksessa, erityisesti päätösjonossa, tehtävälistassa, asukaslistassa ja saunakalenterissa.

**Testit:** T-172–T-175 · Pleissi Mega AI

## 22.10.2026 · AI-agentti käynnistetään tehtävän painikkeesta

**Mitä muutettiin**
- AI-agentti ei enää lue jokaista uutta tehtävää itsestään. Tehtävällä on uusi painike **Anna AI-agentin
  hoitaa** AI-ehdotuksen vieressä, ja agentti käsittelee tehtävän vasta, kun painiketta painetaan. Näin
  AI-kutsuja ei tehdä turhaan.
- Painike toimii kaikilla tehtävillä. Sauna-, pyykkitupa- ja autopaikka-asiat agentti hoitaa kuten ennenkin:
  se vastaa asukkaalle ja tarvittaessa varaa vuoron. Muut asiat se jättää käsittelijälle ja kirjoittaa
  perustelun tehtävän sisäiseksi muistiinpanoksi.
- Painalluksen jälkeen ruudun yläreunaan tulee ilmoitus tuloksesta: agentti hoiti ja sulki tehtävän, agentti
  vastasi ja odottaa asukkaan vastausta, tai agentti jätti tehtävän käsittelijälle (syy näkyy ilmoituksessa).
- Jos agentti ei voi käsitellä tehtävää (esim. ilmoittajaa ei ole tunnistettu asukkaaksi tai tehtävä on
  arkaluonteinen), syy näytetään heti eikä AI:ta kutsuta.
- Kun asukas vastaa agentin hoitamaan tehtävään (esim. valitsee tarjotun vuoron), agentti jatkaa itse kuten
  ennenkin, myös toimiston ollessa kiinni.
- Asetus on nyt nimeltään **AI-agentti käytössä**: se näyttää painikkeen tehtävillä.

**Miten**
- Avaa tehtävä › Vastaus asukkaalle › Anna AI-agentin hoitaa.
- Asetukset › Isännöitsijätoimiston tiedot › AI › AI-agentti käytössä.

**Testit:** T-169–T-171 (lisäksi T-164–T-168 päivitetty painikkeen mukaisiksi) · Pleissi Mega AI

## 22.10.2026 · AI-agentti hoitaa sauna-, pyykkitupa- ja autopaikka-asiat

**Mitä muutettiin**
- Uusi asetus **AI-agentti hoitaa sauna-, pyykkitupa- ja autopaikka-asiat** (oletuksena pois päältä).
- Kun asetus on päällä, AI-agentti lukee tunnistetun asukkaan uuden tehtävän (sähköposti tai asukasportaali).
- Jos asukas haluaa saunan tai pyykkituvan vuoron ja pyydetty aika on vapaa, agentti varaa sen ja vahvistaa
  varauksen asukkaalle.
- Jos pyydetty aika on varattu, agentti ehdottaa 2–4 vapaata vuoroa pyydetystä päivästä kolmen päivän päähän.
  Kun asukas vastaa ja valitsee vuoron, agentti varaa sen ja sulkee tehtävän.
- Autopaikoista agentti kertoo paikkatyypit, hinnat, vapaat paikat ja asukkaan jonosijan, ja lisää asukkaan
  autopaikkajonoon. Paikan luovutus jää henkilökunnalle.
- Vastaus lähtee heti, myös toimiston ollessa kiinni: sähköpostiin samaan viestiketjuun ja portaalin tehtävään
  portaaliviestinä. Viestin lopussa kerrotaan, että vastaus on automaattinen.
- Muut asiat (vikailmoitukset, muutot ym.) ja asiat, joita agentti ei saa ratkaistua, jäävät päätösjonoon.
  Jos agentti oli jo ottanut tehtävän hoitaakseen, tehtävä palaa jonoon sisäisen muistiinpanon kanssa.
- Agentti ei voi varata aikaa, jota asukas ei ole valinnut, eikä toisen asukkaan nimiin.
- Sivupalkissa Kaikki tehtävät -kohdan alla on taas **AI tehtävät**: agentin hoitamat tehtävät. Laskuri
  näyttää tehtävät, joissa agentti odottaa asukkaan vastausta.
- Tehtävän lokiin kirjataan agentin varaukset, vastaukset ja siirrot henkilökunnalle.

**Miten**
- Asetukset › Isännöitsijätoimiston tiedot › AI › AI-agentti hoitaa sauna-, pyykkitupa- ja autopaikka-asiat.
- Sivupalkki › Kaikki tehtävät › AI tehtävät.
- Vaatii palvelimelle AI-avaimen. Jokainen uusi asukkaan tehtävä on silloin AI-kutsu.

**Testit:** T-163–T-168 · Pleissi Mega AI

## 22.10.2026 · Pleissi Mega AI: kopio Kotilosta ja Data-osio

**Mitä muutettiin**
- Pleissi Mega AI on kopio Kotilosta. Siihen lisätään myöhemmin paljon AI-ominaisuuksia.
- Sivupalkissa on taloyhtiöosion yläpuolella uusi otsikko **Data**. Sen alla ovat samat ryhmät ja sivut kuin
  taloyhtiön alla: Dokumentaatio, Perustiedot, Tilat ja Ilmoitukset.
- Data-osion taulut näyttävät jokaisen taloyhtiön jokaisen tietueen ilman suodatusta. Mukana ovat myös
  esimerkiksi poismuuttaneet asukkaat, käsitellyt muutto- ja remontti-ilmoitukset, päättyneet jonot,
  menneet sauna- ja pyykkituvan vuorot sekä dokumenttien vanhat versiot. Jokaisella rivillä on taloyhtiön nimi.
- Taulua voi hakea hakukentällä ja järjestää napsauttamalla sarakkeen otsikkoa. Taloyhtiön nimi avaa saman
  sivun kyseisen taloyhtiön omana näkymänä.
- **Kaikki taloyhtiöt** -lista on siirretty taloyhtiövalikon lopusta Data-otsikon alle. Taloyhtiövalikossa
  ovat nyt vain taloyhtiöt.
- Data-taulun näkee käyttäjä, jonka rooli näkee saman sivun taloyhtiön alla (Asetukset › Roolit).

**Miten**
- Sivupalkki › Data › esim. Perustiedot › Asukkaat.
- Sivupalkki › Data › Kaikki taloyhtiöt.

**Testit:** T-159–T-162 · Pleissi Mega AI

## 21.10.2026 · Uuden tehtävän asukasvalinta ja Muu-vaihtoehto

**Mitä muutettiin**
- Kun luot uuden tehtävän käsin, Asukas-kenttä ehdottaa valitun taloyhtiön asukkaita. Voit hakea nimellä,
  asunnolla, osoitteella tai sähköpostilla.
- Valitusta asukkaasta tulee tehtävän ilmoittaja, ja tehtävän asunto, osoite ja sähköposti täyttyvät hänen
  tiedoistaan samalla tavalla kuin kun ilmoittaja valitaan tehtäväsivulla.
- Listan viimeinen vaihtoehto on **Muu**. Se avaa kentät asukkaan nimelle, osoitteelle ja asunnolle. Henkilö
  lisätään taloyhtiön asukkaaksi (ja asunto tarvittaessa) ja tehtävän ilmoittajaksi.
- Asukkaan valinta on edelleen vapaaehtoinen.

**Miten**
- Kaikki tehtävät › + Luo tehtävä › Asukas.

**Testit:** T-156–T-158 · PR #44

## 21.10.2026 · Päätösjonon alla omat käsittelyssä olevat tehtävät

**Mitä muutettiin**
- Päätösjonossa on avointen tehtävien alla uusi osio **Käsittelyssä olevat tehtäväsi**. Siinä näkyvät sinulle
  osoitetut tehtävät, joiden tila on Käsittelyssä, ja niiden määrä.
- Osio noudattaa samaa järjestystä kuin avoimet tehtävät (Järjestys-valinta). Tehtävän saa auki kortista.
- Remonttitehtävät ovat edelleen Remontit-osiossa, eivätkä ne näy päätösjonossa.

**Miten**
- Päätösjono › avointen tehtävien alla.

**Testit:** T-154–T-155 · PR #43

## 20.10.2026 · AI-ehdotuksen voi pyytää uudelleen, ja se lukee sähköpostiketjun

**Mitä muutettiin**
- AI-ehdotuksen voi nyt pyytää tehtävälle useamman kerran. Ensimmäisen ehdotuksen jälkeen painikkeessa lukee
  **Pyydä uusi AI-ehdotus**.
- Kun asukkaalle on jo lähetetty vastaus, AI lukee uutta ehdotusta tehdessään tehtävän sähköpostiketjun (oikealla
  näkyvät viestit) vanhimmasta uusimpaan, myös jo lähetetyt vastaukset. Se kirjoittaa seuraavan vastauksen samaan
  ketjuun: vastaa asukkaan uusimpaan viestiin eikä toista jo kerrottua.
- Ilmoitus kertoo, kun uusi ehdotus on tehty sähköpostiketjun perusteella. Urakoitsijalle lähetettyjä työtilauksia
  ei tulkita asukkaalle lähetetyiksi vastauksiksi.

**Miten**
- Tehtävä › Vastaus asukkaalle › Pyydä AI-ehdotus / Pyydä uusi AI-ehdotus.

**Testit:** T-151–T-153 · PR #42

## 20.10.2026 · Vastaukseen tehtävän liitteitä ja dokumentaation tiedostoja

**Mitä muutettiin**
- Asukkaalle lähtevään vastaukseen voi nyt liittää tiedoston omalta koneelta, tehtävällä jo olevan liitteen (esim.
  asukkaan lähettämä kuva tai huoltoyhtiön raportti) tai taloyhtiön dokumentaatiosta tiedoston (esim. järjestyssäännöt).
- Valinnat **Tehtävän liitteet** ja **Dokumentaatiosta** ovat Liitä tiedosto -painikkeen vieressä. Valitut näkyvät listana,
  ja ne voi poistaa ×-merkistä.
- Dokumentaatiosta tarjotaan vain taloyhtiön käytössä olevat tiedostot, ei henkilökunnan sisäisiä dokumentteja.
  Liitteitä voi olla yhteensä enintään 10 ja enintään 15 Mt.

**Miten**
- Tehtävä › Vastaus asukkaalle › viestikentän alla ennen Lähetä-painiketta.

**Testit:** T-148–T-150 · PR #41

## 20.10.2026 · Esittelyaineisto: alustan tyhjennys ja uudet esimerkkitiedot

**Mitä muutettiin**
- Uudella komennolla alustan saa tyhjennettyä ja täytettyä esittelyä varten kuvitteellisella aineistolla. Ennen
  tyhjennystä otetaan automaattisesti varmuuskopio.
- Aineistossa on neljä taloyhtiötä (Koivikko, Honkaranta, Satamakulma ja Pihlajapuisto), 36 asuntoa, noin 50 asukasta ja
  noin 70 tehtävää: avoimia AI-ehdotuksineen, hätä- ja kiireellisiä, huoltoyhtiölle tilattuja, tunnistamattomia ja vanhoja
  hoidettuja raporttien historiaksi.
- Lisäksi dokumentit, avaimet ja avainlainat, sauna- ja pyykkituvan vuorot, autopaikat, jonot, mittarilukemat, muutot,
  remontit, tiedotteet, lämmityspaikkatilaukset ja hallituksen tunnukset.
- Kaikki nykyiset tiedot ja käyttäjät poistuvat. Toimiston asetukset säilyvät. Kaikilla esittelytunnuksilla on sama salasana.

**Miten**
- Koneelta: `deploy\server\demo-reset.ps1` uusimman version viennin jälkeen (ohje: deploy/server/README.md).

**Testit:** T-144–T-147 · PR #40

## 19.10.2026 · Päätösjonon ehdotus on nyt "AI:n ehdotus"

**Mitä muutettiin**
- Päätösjonon tehtäväkortin vastausehdotuksen otsikko on nyt **AI:N EHDOTUS** (aiemmin KOTILON EHDOTUS).

**Miten**
- Päätösjono: tehtäväkortti, jolle tekoäly on laatinut vastausehdotuksen.

**Testit:** T-143 · PR #39

## 19.10.2026 · Tietoturvakorjaukset: tilin suojaus, arkaluonteisten näkyvyys ja häiriönkesto

**Mitä muutettiin**
- Oman sähköpostin tai salasanan vaihto Asetukset › Oma tili -sivulla vaatii nyt nykyisen salasanan vahvistukseksi.
  Näin kukaan ei voi muuttaa kirjautumistietoja pelkällä auki jääneellä istunnolla.
- Asukkaan sähköpostiosoitteen vaihtaminen onnistuu vain isännöitsijän tai pääkäyttäjän oikeuksilla. Taloyhtiön
  isännöitsijöiden vaihtaminen onnistuu vain pääkäyttäjältä.
- Arkaluonteiseksi merkityt tehtävät pysyvät piilossa niiltä, joilla ei ole niihin oikeutta, myös tehtävien
  viennissä (export) ja työmääräysten listassa. Piilotetusta tehtävästä ei paljastu aihe, viestit, liitteet eikä
  asunnon tiedot.
- Asukasportaalissa jaetun tehtävän viestit ja liitteet näkyvät asukkaalle vain omien viestiensä osalta: toisen
  asukkaan liitteitä tai viestejä ei pääse näkemään.
- Hätäsanan (esim. "vesivuoto") sisältävää viestiä ei koskaan suodateta pois päätösjonosta, vaikka AI arvioisi sen
  mainokseksi, vaan se nostetaan hätätilanteeksi. Näin aito hätä (tai AI:n harhautusyritys) ei jää huomaamatta.
- Sähköpostin palvelinosoitteeksi (IMAP/SMTP) hyväksytään vain julkinen verkkonimi, ei sisäverkon osoitteita.
- Salasanan palautuslinkki osoittaa aina luotettuun sovellusosoitteeseen.
- Suuret tai viallisesti muotoillut sähköpostit eivät enää jumita palvelinta: tekstiksi muunnos on nopea kaikilla
  syötteillä.
- Sähköpostiketjuun yhdistäminen varmistaa lähettäjän, jottei ketjuun voi liittää viestiä vieraalla osoitteella.
  Kirjautumiskoodin uudelleenlähetys ei enää nollaa yritysten laskuria.

**Miten**
- Asetukset › Oma tili (nykyinen salasana vahvistukseksi). Asetukset › Isännöitsijätoimiston tiedot › AI
  (sähköpostipalvelin, suodatus). Muutokset näkyvät myös tehtävien viennissä ja asukasportaalissa.

**Testit:** server/test/security.test.ts · PR #38

## 19.10.2026 · Roolit: omat roolit ja niiden näkemät taulut

**Mitä muutettiin**
- Asetukset › Isännöitsijätoimiston tiedot -sivulla on uusi **Roolit**-välilehti. Pääkäyttäjä voi luoda uusia rooleja
  omalla nimellä, muuttaa niiden nimeä ja poistaa roolin, jolla ei ole käyttäjiä.
- Jokaiselle roolille valitaan rastilla taulut, jotka sen käyttäjät näkevät (esim. Päätösjono, Kaikki tehtävät,
  Raportit, Asukkaat, Sauna). Ryhmän otsikon rasti valitsee koko ryhmän. Roolille valitaan myös oikeustaso:
  isännöitsijän oikeudet (saa muokata taloyhtiöiden tietoja) tai asiakaspalvelun oikeudet.
- Käyttäjälle valitaan rooli Käyttäjät-välilehdellä. Sivupalkissa näkyvät vain roolin taulut, ja piilotetun taulun
  linkki ohjaa ensimmäiseen sallittuun tauluun. Roolin muutos tulee voimaan, kun käyttäjä päivittää sivun.
- Uudet taulut tulevat roolien valintoihin automaattisesti. Rooli, jolle on valittu kaikki taulut, näkee myös
  myöhemmin lisättävät taulut. Pääkäyttäjä näkee aina kaikki taulut; asetukset ja haku näkyvät kaikille.

**Miten**
- Asetukset › Isännöitsijätoimiston tiedot › Roolit ja Käyttäjät. Sivupalkki roolin käyttäjällä.

**Testit:** T-136–T-142 · PR #37

## 19.10.2026 · Asukasportaalin yläpalkki ja muuttoilmoitus, turhat lomakkeet pois, tehtävänumerot puhelimella

**Mitä muutettiin**
- Asukasportaalissa on tietokoneella yläpalkki kuten henkilökunnan puolella: logo, taloyhtiö ja asunto sekä oikealla
  asukkaan nimi, kielen vaihto ja Kirjaudu ulos.
- Asukasportaalin muuttoilmoitus on sama lomake kuin isännöitsijätoimiston verkkosivulla: muuton laji, muuttopäivä,
  muuttaja (nimi, puhelin, sähköposti, syntymäaika), nykyinen asunto, mukana muuttavat (3), uusi asunto, "Olen"
  (vuokralainen/osakas) ja vesimaksu. Kaikki tiedot näkyvät isännöitsijälle Muutot-sivun muuttoilmoituksen tietueella.
  Mukana muuttavat lisätään asunnon asukkaiksi, kun ilmoitus hyväksytään. Ilmoittajaa itseään ei lisätä uudestaan.
- Asukasportaalista poistettiin Auton lämmityspaikka ja Irtisanomisilmoitus sekä Jonot-sivulta saunan vakiovuorojono.
- Henkilökunnan tehtävälistassa puhelimella tehtävänumero on omalla rivillään kortin yläreunassa, eikä se enää mene
  otsikon ja tägien päälle.

**Miten**
- Asukasportaali tietokoneella ja puhelimella: Muuttoilmoitus, Jonot ja valikko. Henkilökunta: Muutot ja tehtävälista puhelimella.

**Testit:** T-131–T-135 · PR #36

## 19.10.2026 · Asunnot, osakas- ja asukasroolit sekä sivupalkin Perustiedot-ryhmä

**Mitä muutettiin**
- Sivupalkin taloyhtiöosion Asukkaat-otsikko on nyt **Perustiedot**. Sen alla ovat Asukkaat, Asunnot, Jonot ja alimpana Avaimet.
  "Jonot ja tilaukset" on nyt **Jonot**. Muutot siirtyivät Ilmoitukset-otsikon alle, ja Tilat-otsikon alla ovat Sauna,
  Pyykkitupa ja Autopaikat.
- Uusi **Asunnot**-taulu: taloyhtiön asunnot listana (asunto, rappu, osoite ja henkilöiden määrä). Asunnon voi lisätä ja hakea.
- Asunnon tietueella ovat asunnon numero, rappu, osoite ja taloyhtiö. Asuntoon voi liittää useita henkilöitä (Henkilöt)
  ja avaimia. Väliotsikoista näkee asunnon henkilöiden autopaikat, tulevat sauna- ja pyykkivuorot sekä remontit.
- Asukkaan tietueen Asunto-kenttä on haettava valintalista: kirjoita numero, rappu tai osoite ja valitse asunto.
  Uuden asunnon voi edelleen kirjoittaa kohdasta "+ Uusi asunto".
- Asukkaan tietueella on monivalinta **Osakas** ja **Asukas**. Molemmat voi valita yhtä aikaa. Roolit näkyvät tägeinä
  asukaslistassa ja asunnon henkilöissä. Aiemmat asukkaat ovat rooliltaan Asukas.
- Taloyhtiön tiedoissa on alhaalla uusi ensimmäinen välilehti **Asunnot** Asukkaat-välilehden vieressä. Siinä näkyvät
  asunnon numero, rappu ja asukkaiden määrä.

**Miten**
- Sivupalkki → Perustiedot → Asunnot. Asukkaat → avaa asukas. Yhtiön tiedot → Asunnot-välilehti.

**Testit:** T-125–T-130 · PR #35

## 19.10.2026 · Suorakulmainen kirjautumissivu ja tietuekortti, valikon tehtävälista ilman suodattimia

**Mitä muutettiin**
- Kirjautumissivun kortti, kentät ja Kirjaudu-painike ovat suorakulmaisia (myös kirjautumiskoodin ja salasanan vaihdon sivut).
- Avatun tietueen kortti on suorakulmainen: tehtävä (myös aikajana ja yläpalkki), taloyhtiö, asukas, dokumentti,
  tiedote sekä sauna- ja pyykkitupavuoro.
- Kun vasemmasta valikosta painetaan Päätösjono, Kaikki tehtävät, Tunnistamattomat tai Omat tehtävät, lista avautuu
  ilman suodattimia, myös kun samaa kohtaa painetaan uudelleen. Aiemmin esim. Muistutukset-laatikon suodatin jäi päälle.
  Sarakeotsikosta valittu järjestys säilyy.

**Miten**
- Kirjautumissivu, avattu tietue ja vasen valikko.

**Testit:** T-122–T-124 · PR #34

## 18.10.2026 · Sisennyksen numerointi, päätösjonon laatikot, AI:n lisätieto muistiinpanoksi ja yhteydenottopyynnöt pois

**Mitä muutettiin**
- Dokumentin tekstin muokkaus: kun alatason kohdan (esim. 1.1.2) jälkeen sisennystä vähennetään (Shift+Sarkain tai ⇤),
  seuraava kohta saa ylemmän tason numeron (1.2) eikä enää jatka alatason numerointia (1.1.3). Syvempien tasojen numerot
  eivät enää mene tekstin päälle.
- Päätösjonon laatikoissa ei ole enää liukuväriä eikä värillistä alareunaa. Laatikot ovat hillityt valkoiset kortit:
  otsikko pienellä, luku tummana ja selite himmeänä. Luvut ovat kaikissa laatikoissa samalla korkeudella. Muistutuksista kertoo
  pieni meripihkan värinen merkki.
- Kun AI:lta pyydetään vastausehdotusta lisätiedon kanssa, lisätieto tallentuu tehtävän aikajanalle sisäiseksi muistiinpanoksi
  ("Lisätieto AI:n vastausehdotukseen: …").
- Kotisivun yhteydenottopyynnöt poistettiin alustalta (Asetukset → Perustiedot). Pyyntöjä ei enää tallenneta, vaan lomakkeen
  pyyntö välitetään sähköpostina. Vastaanottaja asetetaan palvelimen asetuksissa (CONTACT_FORWARD_EMAIL). Aiemmin tallennetut
  pyynnöt poistettiin.

**Miten**
- Dokumentaatio → avaa dokumentti → Muokkaa tekstiä → numeroitu luettelo, Sarkain ja Shift+Sarkain.
- Päätösjono: laskurilaatikot.
- Tehtävä → AI-ehdotus → kirjoita lisätieto → Luo ehdotus → aikajanalla näkyy muistiinpano.
- Asetukset → Perustiedot: Yhteydenottopyynnöt-osiota ei enää ole.

**Testit:** T-118–T-121 · PR #33
- Sisennys: kirjoita 1., sisennä 1.1., sisennä 1.1.1. ja 1.1.2., paina Enter ja Shift+Sarkain. Odotus: uusi kohta on 1.2.
  Tallenna ja avaa uudelleen. Odotus: numerot ovat samat.
- AI:n lisätieto: pyydä ehdotus lisätiedon kanssa. Odotus: lisätieto näkyy aikajanalla sisäisenä muistiinpanona.
- Yhteydenotto: lähetä kotisivun lomake. Odotus: viesti tulee asetettuun sähköpostiin, eikä alustalla ole yhteydenottopyyntöjä.

## 18.10.2026 · Asetusten haku ja selkeämpi jako välilehdille

**Mitä muutettiin**
- Asetussivun yläreunassa on haku. Haku löytää asetuksen myös sanalla, joka ei ole otsikossa (esim. "henkilötunnus" →
  Maskaus ennen AI:ta), ja tuloksen valinta avaa oikean välilehden ja vierittää osioon.
- Isännöitsijätoimiston tiedot → Tietoturva: mukana nyt myös Arkaluonteiset tiedot ja Maskaus ennen AI:ta.
- Isännöitsijätoimiston tiedot → AI: mukana nyt myös AI-mallit ja AI-ehdotukset.
- AI-ehdotusten lisätietoikkuna on nyt toimiston asetus, joka koskee kaikkia käyttäjiä. Se poistui käyttäjän omista asetuksista.
- Järjestelmän tila ja Yhteydenottopyynnöt ovat nyt Perustiedot-välilehdellä. Erillinen Järjestelmä-välilehti poistui.
- Perustiedot-välilehdellä ovat Hätäsanat ja määräajat, Järjestelmän tila ja Yhteydenottopyynnöt.

**Miten**
- Asetukset → hakukenttä. Asetukset → Isännöitsijätoimiston tiedot → Tietoturva / AI / Perustiedot.

**Testit:** T-113–T-116 · PR #32

## 18.10.2026 · Asukkaan rappu ja autopaikat, vuorojen jono ja aikaikkuna, omat sivut ja isommat näkymät

**Mitä muutettiin**
- Asukkaan tiedoissa on uusi kenttä Rappu. Rappu on asunnon tieto, joten se on sama kaikilla saman asunnon asukkailla.
- Asukkaan autopaikat näkyvät asukkaan tiedoissa heti, kun asukas merkitään autopaikan haltijaksi.
- Avattu asukas on oma selainsivunsa (oma osoite). Selaimen takaisin-painike palaa asukaslistaan.
- Isännöitsijä voi lisätä asukkaan jo varatun sauna- tai pyykkitupavuoron jonoon ja poistaa jonottajan. Toimisto voi
  lisätä jonoon myös silloin, kun asukkaiden oma jonoon liittyminen ei ole käytössä. Jonon enimmäiskoko on voimassa.
- Sauna- ja pyykkitupavuoron tiedot avautuvat omana selainsivunaan. Sivu on leveä, kentät ja tekstit ovat isompia,
  ja asettelu mukautuu selaimen leveyteen.
- Varattava aikaikkuna (esim. 8–22) asetetaan taloyhtiökohtaisesti saunalle ja pyykkituvalle. Kalenteri näyttää vain nämä tunnit.
  Oletuksena sauna 15–22 ja pyykkitupa 7–21 kuten ennenkin.
- Tiedotteet voi suodattaa rapun mukaan. Rapulle kohdistettu tiedote menee asukkaille, joiden tiedoissa on se rappu
  (jos rappua ei ole kirjattu, se päätellään edelleen asunnon numeron kirjaimesta).
- Uusi tiedote ja avattu tiedote ovat omia selainsivujaan.
- Näkymät ovat leveämpiä: sivujen reunoilla on vähemmän tyhjää tilaa, ja avautuvat tietueet käyttävät enemmän ruudun leveydestä.
  Taulujen, tehtävälistan ja tietueiden tekstit ja kentät ovat isompia.

**Miten**
- Asukkaat → avaa asukas: Rappu-kenttä ja Autopaikat-kohta. Osoite on muotoa #/residents/<asukas>.
- Sauna tai Pyykkitupa → valitse varattu vuoro → Jono → valitse asukas → Lisää jonoon.
- Yhtiön tiedot → Vuorovaraukset ja autopaikat → Saunavuorot / Pyykkitupavuorot → Varattavissa (alku ja loppu).
- Tiedotteet → Rappu-suodatin. Uusi tiedote ja tiedotteen avaaminen vaihtavat osoitetta.

**Testit** (lisättävä testaussivulle)
- Rappu: kirjoita asukkaalle rappu ja tallenna. Odotus: rappu näkyy, kun asukas avataan uudelleen.
- Autopaikka: anna Autopaikat-sivulla paikka asukkaalle. Odotus: paikka näkyy asukkaan tiedoissa.
- Asukkaan sivu: avaa asukas, kopioi osoite uuteen välilehteen. Odotus: sama asukas aukeaa.
- Jonoon lisäys: avaa varattu vuoro, valitse asukas ja Lisää jonoon. Odotus: asukas näkyy jonossa sijalla 1, ja hän näkee
  jonopaikan asukasportaalissa.
- Aikaikkuna: aseta saunalle 8–22. Odotus: saunakalenterissa näkyvät tunnit 8–22.
- Tiedotteet: julkaise rapulle C tiedote ja suodata Rappu C. Odotus: tiedote näkyy suodatettuna ja rapun C asukkaan portaalissa.
- Leveys: avaa tehtävälista, asukas ja vuoro tavallisella näytöllä. Odotus: näkymä täyttää sivun, teksti on aiempaa isompaa.

## 18.10.2026 · Tunnistamattomat päätösjonoon, monivalintasuodattimet, autopaikkavaihtoehdot ja dokumenttinumerot

**Mitä muutettiin**
- Päätösjono: ensimmäinen laatikko on nyt Tunnistamattomat (aiemmin Jonossa), ja Muistutukset-laatikko on oikeanpuoleisin.
- Ilman käsittelijää -näkymä poistettiin. Tehtävät, joilla ei ole käsittelijää, näkyvät nyt Tunnistamattomat-näkymässä
  yhdessä niiden tehtävien kanssa, joiden taloyhtiötä ei ole tunnistettu. Vanhat linkit ohjautuvat Tunnistamattomiin.
- AI tehtävät -kohta piilotettiin sivupalkista.
- Raportit-otsikon alla on sivupalkissa alakohdat Mittarit, Omat raportit ja Taloyhtiön raportit.
- Arkaluonteinen-merkinnästä poistettiin lukon kuva.
- Tehtävälistassa otsikon alle ei enää tule ylimääräistä nollaa, kun tehtävällä ei ole merkintöjä.
- Tehtävälistan kaikki suodattimet (Taloyhtiö, Prioriteetti, Tyyppi, Tila, Määräaika) ovat monivalintoja. Oletuksena kaikki
  on valittu. Määräaika-suodattimessa on lisäksi valinta Muut: tehtävät, jotka eivät ole myöhässä, umpeutumassa eikä
  muistutuslistalla.
- Tehtävänumerot ovat muotoa #T000123. Haku löytää tehtävän muodoilla #T123, T123 ja #123.
- Tehtävän sivulla Yhtiö on pudotusvalikko. Taloyhtiön vaihto siirtää tehtävän, kun muutokset tallennetaan. Siirretty tehtävä
  saa uuden yhtiön tehtävänumeron.
- Uutta asukasta lisättäessä kysytään aina taloyhtiö: Asukkaat-sivulla ja kun tehtävän lähettäjästä tehdään asukas.
  Jos tehtävän lähettäjästä tehty asukas lisätään toiseen taloyhtiöön, tehtävä siirretään samalla siihen.
- Taloyhtiön tiedoissa kenttä "Sähköposti, johon tehtävät saapuvat" on nyt nimeltään Sähköposti.
- Taloyhtiön autopaikkavaihtoehdot: isännöitsijä voi lisätä uusia vaihtoehtoja omalla kuukausihinnallaan, muuttaa hintaa
  ja poistaa vaihtoehtoja. Vaihtoehdot näkyvät paikkojen tyyppinä, laskutuksessa, asukkaan autopaikkajonossa
  (hintoineen) ja autopaikkatilauksissa. Poistetun vaihtoehdon tyyppiset paikat säilyvät.
- Autopaikat-sivulta poistettiin lämmityspaikan tilaukset. Kaikki autopaikkatilaukset (verkkosivun lomakkeelta,
  asukasportaalista ja Uusi tilaus -painikkeesta) näkyvät nyt Jonot ja tilaukset -sivulla. Tilaukseen voi valita paikkatyypin.
- Jonot-sivu on nyt nimeltään Jonot ja tilaukset.
- Avattu dokumentti on oma selainsivunsa (oma osoite), joten selaimen takaisin-painike palaa listaan ja dokumenttiin voi linkittää.
- Lisää vakiotieto -painike on nyt Luo dokumentti. Luontinäkymä on leveä, ja vastauskentässä on samat tekstinkäsittelytyökalut
  kuin dokumentin tekstin muokkauksessa (kappaletyylit, lihavointi, kursiivi, alleviivaus, luettelot, sisennys, kumoa).
- Dokumenteilla on dokumenttinumero muotoa #K000123. Numero näkyy dokumenttilistassa ja dokumentin sivulla, ja saman
  dokumentin uudet versiot pitävät numeronsa. Hakupalkista #K123 avaa dokumentin suoraan.

**Miten**
- Päätösjono → Tunnistamattomat-laatikko. Sivupalkki → Kaikki tehtävät → Tunnistamattomat.
- Sivupalkki → Raportit → Mittarit / Omat raportit / Taloyhtiön raportit.
- Kaikki tehtävät → suodatinkuvake → avaa mikä tahansa suodatin ja valitse tai poista vaihtoehtoja.
- Avaa tehtävä → Yhtiö → valitse taloyhtiö → Tallenna → vahvista siirto.
- Asukkaat → Lisää asukas → Taloyhtiö. Tehtävän sivulla tuntemattoman lähettäjän kohdalla Tee käyttäjä → Taloyhtiö.
- Yhtiön tiedot → Vuorovaraukset ja autopaikat → Autopaikat: hinnat, Poista ja Lisää vaihtoehto.
- Jonot ja tilaukset → Autopaikkatilaukset → Uusi tilaus.
- Dokumentaatio → avaa dokumentti (osoite muuttuu) → selaimen takaisin-painike. Dokumentaatio → Luo dokumentti.
- Hakupalkki: kirjoita #K ja dokumentin numero tai #T ja tehtävän numero.

**Testit** (lisättävä testaussivulle)
- Tunnistamattomat: tehtävä ilman käsittelijää näkyy Tunnistamattomat-näkymässä ja sen laskurissa päätösjonossa.
- Suodattimet: poista Prioriteetti-suodattimesta Normaali. Odotus: normaalin prioriteetin tehtävät katoavat listasta,
  ja listan yläpuolella näkyy merkki, josta rajauksen saa pois.
- Tehtävän siirto: vaihda tehtävän Yhtiö ja tallenna. Odotus: vahvistus kysytään, tehtävä siirtyy ja saa uuden #T-numeron.
- Asukkaan lisäys: Lisää asukas -lomakkeessa on Taloyhtiö-valinta, ja asukas tallentuu valittuun yhtiöön.
- Autopaikkavaihtoehdot: lisää vaihtoehto "Sähköautopaikka" hinnalla 35 €/kk. Odotus: se näkyy autopaikan tyyppinä,
  asukasportaalin autopaikkajonossa hintoineen ja autopaikkatilauksen paikkatyyppinä. Poista vaihtoehto: se ei palaa.
- Autopaikkatilaus: Jonot ja tilaukset → Uusi tilaus → tallenna. Odotus: tilaus näkyy Autopaikkatilaukset-listassa.
- Dokumentin sivu: avaa dokumentti, kopioi osoite uuteen välilehteen. Odotus: sama dokumentti aukeaa.
- Luo dokumentti: kirjoita vastaukseen lihavoitu teksti ja luettelo, tallenna. Odotus: muotoilu näkyy dokumentin sivulla.
- Dokumenttinumero: kirjoita hakupalkkiin dokumentin #K-numero. Odotus: dokumentti aukeaa suoraan.

## 18.10.2026 · Dokumentin tekstin muokkaus Wordin tapaan ja muotoilu säilyy tuonnissa

**Mitä muutettiin**
- Dokumentin tekstiä voi muokata suoraan alustalla. Muokkaimessa on Wordin tapaan kappaletyyli (leipäteksti,
  otsikot 1–3), lihavointi, kursiivi, alleviivaus, numeroitu luettelo, luettelomerkit, sisennys sekä kumoa ja tee uudelleen.
  Sarkain sisentää luettelon kohdan (1. → 1.1.), Shift+Sarkain palauttaa.
- Muokatun tekstin tallennus luo uuden version. Muutokset näytetään ennen kuin uusi versio korvaa nykyisen,
  ja vanha versio säilyy historiassa. Alkuperäinen tiedosto on ladattavissa myös uudesta versiosta.
- Word-dokumentin otsikot, lihavoinnit, kursiivit, alleviivaukset ja numeroidut luettelot säilyvät, kun dokumentti ladataan.
  PDF:stä ja kuvista tunnistetaan otsikkorivit ja luettelot, ja katkenneet rivit yhdistetään kappaleiksi.
  Aiemmin ladatut dokumentit näytetään samalla tavalla jäsenneltyinä.
- Dokumentin teksti näytetään siistinä sivuna: otsikot, kappaleet ja numeroidut kohdat (1., 1.1.) kuten alkuperäisessä.
- Wordista liitetty teksti säilyttää otsikot, lihavoinnit ja luettelot.
- Dokumentin "Muokkaa"-painike on nyt "Muokkaa tekstiä". Uuden tiedoston lataus on painikkeessa "Lataa uusi versio".

**Miten**
- Dokumentaatio → avaa dokumentti → Muokkaa tekstiä → muokkaa → Tallenna uutena versiona → Hyväksy muutokset.

**Testit:** T-109–T-112 · PR #29

## 18.10.2026 · AI-tieto pois aikajanalta, yhteinen osoite Tunnistamattomiin ja turhat tehtävätyypit pois

**Mitä muutettiin**
- AI:lle lähetetty tieto ei enää näy tehtävän aikajanalla. Se näkyy edelleen Lokissa.
- Vastaanottajan osoite kertoo taloyhtiön vain, jos osoite on yhden taloyhtiön oma. Jos viesti on lähetetty toimiston
  yhteiseen osoitteeseen tai osoitteeseen, jota käyttää useampi taloyhtiö, tehtävä menee Tunnistamattomat-jonoon.
  Taloyhtiö tunnistetaan silti, jos lähettäjä on tunnettu asukas.
- Tehtävän tyyppivalikosta poistettiin Muuttoilmoitus, Mittarilukemailmoitus, Muutto ja Auton lämmityspaikka
  (ne kuuluvat taloyhtiön omille tauluille). Vanhat tehtävät, joilla oli jokin näistä tyypeistä, muuttuvat tyypiksi Ilmoitus.

**Miten**
- Tehtävän sivu: aikajanalla ei ole "Lähetetty AI:lle" -merkintöjä. Asetukset → Tietoturva → Loki: merkinnät löytyvät sieltä.
- Tunnistamattomat-jono: yhteiseen osoitteeseen tulleet viestit tuntemattomalta lähettäjältä.
- Tehtävän tyyppi -valikko.

**Testit:** T-106–T-108 · PR #28

## 18.10.2026 · AI:lle lähtevä tieto lokiin, tehtävän taloyhtiö ilmoittajasta ja arkaluonteisen tehtävän tägi

**Mitä muutettiin**
- Jokainen AI:lle lähtevä pyyntö kirjataan Lokiin täsmälleen siinä muodossa kuin se lähtee (malli, ohje ja viestit,
  henkilötiedot jo peitettyinä). Merkintä "Lähetetty AI:lle" näkyy Lokissa ja tehtävän aikajanalla, ja sisällön saa auki.
- Isännöitsijän omaan postilaatikkoon tulleen viestin taloyhtiö päätellään vain ilmoittajasta. Jos ilmoittaja ei ole
  asukastaulussa, taloyhtiötä ei aseteta (tehtävä menee Tunnistamattomat-jonoon) eikä yhtiötä päätellä käsittelijästä.
- Arkaluonteinen tehtävä näkyy päätösjonossa ja tehtävälistoissa violetilla 🔒 Arkaluonteinen -tägillä.

**Miten**
- Asetukset → Isännöitsijätoimiston tiedot → Tietoturva → Loki: merkintä "Lähetetty AI:lle: …" → Näytä AI:lle lähetetty tieto.
  Sama tehtävän aikajanalla.
- Päätösjono ja Kaikki tehtävät: tägi tehtävän kortissa ja otsikon alla.

**Testit:** T-102–T-105

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
