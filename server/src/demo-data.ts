import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "./auth.js";
import { attachmentsDir, db, knowledgeFilesDir } from "./db.js";
import { migrateKnowledgeChunks } from "./knowledge-chunks.js";
import { migrateRenovationNotices } from "./routes/renovations.js";

// ---------------------------------------------------------------------------------------------
// Esittelyaineisto: tyhjentää alustan tiedot ja luo tilalle kuvitteellisen isännöintitoimiston
// taloyhtiöineen, asukkaineen, tehtävineen ja tauluineen. Kaikki nimet, osoitteet ja yhteystiedot
// ovat keksittyjä (sähköpostit example.com-, puhelinnumerot 010 123 -muotoa).
// Toimiston asetukset, perustiedot (hätäsanat ym.), AI-kulujen seuranta ja tietokannan rakenne säilyvät.
// ---------------------------------------------------------------------------------------------

// Taulut, joiden tiedot säilyvät: toimiston asetukset, perustiedot ja AI-kulut.
const KEEP_TABLES = new Set(["office_settings", "master_data", "ai_usage", "ai_budget_notices", "roles"]);

export type DemoOptions = { password: string; adminEmail?: string; now?: Date };

// Toistettava satunnaisuus, jotta aineisto on joka kerta sama.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (value: number) => String(value).padStart(2, "0");
const isoDay = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

// Suomen aikaa oleva kellonaika ISO-muodossa (UTC).
function helsinki(day: string, hour: number, minute = 0) {
  const guess = new Date(`${day}T${pad(hour)}:${pad(minute)}:00Z`);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Helsinki", timeZoneName: "shortOffset" })
    .formatToParts(guess).find(part => part.type === "timeZoneName")?.value ?? "GMT+2";
  const offset = Number(/GMT([+-]\d+)/.exec(zone)?.[1] ?? 2);
  return new Date(guess.getTime() - offset * 3600_000).toISOString();
}

const ascii = (text: string) => text.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/å/g, "a").replace(/[^a-z]/g, "");

// ---------------------------------------------------------------------------------------------
// Aineisto
// ---------------------------------------------------------------------------------------------

const USERS = [
  { key: "admin", name: "Sanna Aaltonen", email: "demo@pohjantahti-isannointi.fi", role: "Pääkäyttäjä" },
  { key: "hanna", name: "Hanna Lehtonen", email: "hanna.lehtonen@pohjantahti-isannointi.fi", role: "Isännöitsijä" },
  { key: "mikko", name: "Mikko Rantanen", email: "mikko.rantanen@pohjantahti-isannointi.fi", role: "Isännöitsijä" },
  { key: "jari", name: "Jari Salminen", email: "jari.salminen@pohjantahti-isannointi.fi", role: "Isännöitsijä" },
  { key: "elina", name: "Elina Koskinen", email: "elina.koskinen@pohjantahti-isannointi.fi", role: "Asiakaspalvelu" }
] as const;
type UserKey = typeof USERS[number]["key"];

const MAINTENANCE = {
  name: "Kiinteistöhuolto Kunto Oy", phone: "010 123 4567", email: "huolto@kunto.example", emergency: "010 123 4500"
};

const COMPANIES = [
  { id: "demo-company", name: "As Oy Koivikko", street: "Koivikkotie 10", city: "20100 Turku", manager: "hanna", others: ["admin"],
    stairs: [["A", 6], ["B", 6]] },
  { id: "company-honkaranta", name: "As Oy Honkaranta", street: "Honkarannantie 4", city: "20540 Turku", manager: "mikko", others: [],
    stairs: [["A", 8]] },
  { id: "company-satamakulma", name: "As Oy Satamakulma", street: "Satamakatu 18", city: "20100 Turku", manager: "hanna", others: ["jari"],
    stairs: [["A", 5], ["B", 5]] },
  { id: "company-pihlajapuisto", name: "As Oy Pihlajapuisto", street: "Pihlajakuja 2", city: "32700 Huittinen", manager: "jari", others: [],
    stairs: [["A", 6]] }
] as const satisfies readonly { id: string; name: string; street: string; city: string; manager: UserKey; others: readonly UserKey[]; stairs: readonly (readonly [string, number])[] }[];

const FIRST_NAMES = ["Aino", "Eetu", "Helmi", "Juho", "Kaisa", "Lauri", "Minna", "Niko", "Oona", "Petri", "Riikka", "Sami", "Tiina",
  "Ville", "Anu", "Erkki", "Heidi", "Ismo", "Jenni", "Kalle", "Leena", "Markus", "Noora", "Olli", "Pirjo", "Rasmus", "Satu", "Timo",
  "Ulla", "Veera", "Antti", "Emilia", "Hannu", "Iida", "Joonas", "Katja", "Lotta", "Mervi", "Otto", "Paula"];
const LAST_NAMES = ["Aho", "Heikkinen", "Hiltunen", "Jokinen", "Karjalainen", "Laaksonen", "Lindqvist", "Mäkelä", "Nieminen",
  "Ojala", "Peltonen", "Rautio", "Saarinen", "Tuominen", "Vainio", "Väisänen", "Kallio", "Leinonen", "Mattila", "Suominen"];

// Tehtävät: taloyhtiö (indeksi), asunto (rappu ja numero) tai null, ilmoittajan viesti ja käsittelyn tila.
type TicketPlan = {
  company: number; apartment?: string; subject: string; summary: string; body: string; type: string;
  priority?: "emergency" | "urgent" | "normal" | "low"; status: string; assignee?: UserKey; daysAgo: number; hour?: number;
  channel?: "email" | "portal" | "phone"; draft?: string; reason?: string; source?: string; reply?: string; replyDaysAgo?: number;
  workOrder?: string; workOrderDone?: boolean; note?: string; sensitive?: boolean; unidentified?: boolean; sender?: string;
};

const TICKETS: TicketPlan[] = [
  { company: 0, apartment: "A 2", subject: "Keittiön altaan alla vuotaa", type: "Vikailmoitus", priority: "urgent", status: "open", assignee: "admin",
    daysAgo: 0, hour: 7, summary: "Asukas huomasi aamulla vettä keittiön altaan alla. Kaapin pohja on märkä.",
    body: "Huomasin aamulla, että keittiön altaan alla on vettä ja kaapin pohja on märkä. Laitoin ämpärin alle. Voisiko joku tulla katsomaan?",
    reason: "Vesivuoto on kiireellinen: ohjataan huoltoyhtiölle heti.", source: "Huoltoyhtiö ja päivystys",
    draft: "Hei,\n\nkiitos ilmoituksesta. Vesivuoto on kiireellinen asia, joten välitimme sen heti huoltoyhtiölle. Sulje tarvittaessa keittiön hanan alla oleva sulkuventtiili. Huoltomies on yhteydessä sinuun tänään.\n\nYstävällisin terveisin" },
  { company: 0, apartment: "B 9", subject: "Häiriötä rappukäytävässä yöllä", type: "Häiriöilmoitus", status: "open", assignee: "admin", daysAgo: 0, hour: 8,
    summary: "Asukas kertoo kovasta metelistä B-rapussa yöllä klo 2–3 ja pyytää toimenpiteitä.",
    body: "Hei, B-rapussa oli viime yönä kovaa meteliä ja ovien paukuttelua kello kahden ja kolmen välillä. Tämä on toistunut useana viikonloppuna.",
    reason: "Järjestyssääntöjen mukaan hiljaisuus on klo 22–7.", source: "Järjestyssäännöt",
    draft: "Hei,\n\nkiitos ilmoituksesta. Järjestyssääntöjen mukaan taloyhtiössä on hiljaisuus klo 22–7. Muistutamme B-rapun asukkaita järjestyssäännöistä. Jos häiriö toistuu, voit tehdä kirjallisen häiriöilmoituksen asukasportaalissa.\n\nYstävällisin terveisin" },
  { company: 0, apartment: "A 4", subject: "Saunavuoron varaaminen", type: "Kysymys", status: "open", assignee: "admin", daysAgo: 1, hour: 15, channel: "portal",
    summary: "Uusi asukas kysyy, miten saunavuoron voi varata.",
    body: "Muutin juuri taloon. Miten saan varattua oman saunavuoron?",
    reason: "Saunavuorojen varaus on kerrottu ohjeessa.", source: "Sauna- ja pyykkitupavuorot",
    draft: "Hei ja tervetuloa taloon!\n\nSaunavuoron voi varata asukasportaalista kohdasta Saunavuorot. Vapaat vuorot näkyvät kalenterissa, ja varaus vahvistuu heti. Kiinteä viikkovuoro maksaa 15 € kuukaudessa.\n\nYstävällisin terveisin" },
  { company: 0, apartment: "B 11", subject: "Patterit kylmänä", type: "Vikailmoitus", priority: "urgent", status: "waiting_third_party", assignee: "hanna", daysAgo: 2,
    summary: "Makuuhuoneen ja olohuoneen patterit ovat kylmiä, vaikka termostaatti on täysillä.",
    body: "Olohuoneen ja makuuhuoneen patterit ovat olleet kylmiä eilisestä asti, vaikka termostaatti on täysillä.",
    workOrder: "Patterit kylmänä asunnossa B 11. Tarkistetaan termostaatit ja ilmataan patterit.",
    reply: "Hei, kiitos ilmoituksesta. Tilasimme huoltoyhtiöltä käynnin, ja huoltomies tulee tarkistamaan patterit huomenna aamupäivällä.", replyDaysAgo: 2 },
  { company: 0, apartment: "A 1", subject: "Isännöitsijäntodistus asuntokauppaan", type: "Asiakirjatilaus", status: "waiting_manager", assignee: "hanna", daysAgo: 3,
    summary: "Osakas tarvitsee isännöitsijäntodistuksen liitteineen asunnon myyntiä varten.",
    body: "Hei, olemme myymässä asuntoamme ja tarvitsisimme isännöitsijäntodistuksen liitteineen. Normaali toimitus riittää." },
  { company: 0, apartment: "B 8", subject: "Pyykkituvan kuivausrumpu ei lämpene", type: "Vikailmoitus", status: "active", assignee: "elina", daysAgo: 4,
    summary: "Pyykkituvan kuivausrumpu pyörii mutta ei lämpene.", body: "Pyykkituvan kuivausrumpu pyörii, mutta ei lämpene ollenkaan.",
    note: "Huoltoyhtiö tilannut varaosan, arvio ensi viikolla." },
  { company: 0, apartment: "A 6", subject: "Parvekelasien huolto", type: "Pyyntö", status: "closed", assignee: "hanna", daysAgo: 12,
    summary: "Asukas kysyi parvekelasien säätöä.", body: "Parvekelasit eivät sulkeudu kunnolla. Kuuluuko säätö taloyhtiölle?",
    reply: "Hei, parvekelasien huolto kuuluu osakkaalle. Lähetimme ohjeen ja huoltoliikkeen yhteystiedot sähköpostiin.", replyDaysAgo: 11 },
  { company: 0, subject: "Lämmintä vettä ei tule koko talossa", type: "Vikailmoitus", priority: "emergency", status: "active", assignee: "hanna", daysAgo: 0, hour: 6,
    summary: "Useampi asukas ilmoittaa, ettei lämmintä vettä tule.", body: "Koko A-rapussa ei tule lämmintä vettä tänä aamuna.",
    workOrder: "Lämmin vesi poikki A-rapussa. Kiireellinen tarkistus lämmönjakohuoneessa." },
  { company: 1, apartment: "A 3", subject: "Kosteusläikkä kylpyhuoneen katossa", type: "Vikailmoitus", priority: "urgent", status: "open", assignee: "mikko", daysAgo: 1,
    summary: "Asukas havaitsi kasvavan kosteusläikän kylpyhuoneen katossa.",
    body: "Kylpyhuoneen kattoon on ilmestynyt kostea läikkä, joka on kasvanut päivän aikana. Epäilen yläkerran vuotoa.",
    reason: "Mahdollinen vesivahinko: kosteusmittaus heti.", source: "Huoltoyhtiö ja päivystys",
    draft: "Hei,\n\nkiitos ilmoituksesta. Pyysimme huoltoyhtiötä tekemään kosteusmittauksen sinun ja yläkerran asuntoon vielä tänään. Huoltomies sopii käynnistä kanssasi.\n\nYstävällisin terveisin" },
  { company: 1, apartment: "A 5", subject: "Autopaikan vuokraus", type: "Kysymys", status: "open", assignee: "admin", daysAgo: 2,
    summary: "Uusi asukas kysyy vapaita autopaikkoja.", body: "Hei, onko taloyhtiössä vapaita autopaikkoja? Tarvitsisin lämmityspaikan.",
    reason: "Autopaikkojen jonosta on ohje dokumentaatiossa.", source: "Autopaikat ja lämmityspaikat",
    draft: "Hei,\n\nvapaita lämmityspaikkoja ei juuri nyt ole, mutta lisäsimme sinut autopaikkajonoon. Saat tiedon heti, kun paikka vapautuu.\n\nYstävällisin terveisin" },
  { company: 1, apartment: "A 7", subject: "Jäteastiat täynnä", type: "Ilmoitus", status: "answered", assignee: "elina", daysAgo: 5,
    summary: "Sekajäteastiat ovat olleet täynnä jo viikon.", body: "Sekajäteastiat ovat täynnä ja roskia on maassa. Voisiko tyhjennyksiä lisätä?",
    reply: "Hei, kiitos ilmoituksesta. Pyysimme jätehuoltoyhtiöltä ylimääräisen tyhjennyksen huomiselle ja tarkistamme tyhjennysvälin.", replyDaysAgo: 5 },
  { company: 1, subject: "Ulko-oven lukko jumittaa", type: "Vikailmoitus", status: "waiting_third_party", assignee: "mikko", daysAgo: 6,
    summary: "A-rapun ulko-oven lukko jumittaa ja ovi jää auki.", body: "A-rapun ulko-ovi jää välillä auki, koska lukko jumittaa.",
    workOrder: "A-rapun ulko-oven lukon huolto ja säätö.", workOrderDone: false },
  { company: 1, apartment: "A 2", subject: "Kylpyhuoneremontin aikataulu", type: "Kysymys", status: "closed", assignee: "mikko", daysAgo: 15,
    summary: "Osakas kysyi, mitä kylpyhuoneremontista pitää ilmoittaa.", body: "Aion remontoida kylpyhuoneen ensi kuussa. Mitä minun pitää ilmoittaa?",
    reply: "Hei, kylpyhuoneremontista tehdään muutostyöilmoitus asukasportaalissa vähintään kaksi viikkoa ennen töiden alkua. Ilmoitukseen liitetään suunnitelma ja urakoitsijan tiedot.", replyDaysAgo: 14 },
  { company: 2, apartment: "B 7", subject: "Hissi pysähtyy kerrosten väliin", type: "Vikailmoitus", priority: "urgent", status: "open", assignee: "admin", daysAgo: 0, hour: 9,
    summary: "B-rapun hissi pysähtyi kerrosten väliin, asukas pääsi ulos hälytyksen jälkeen.",
    body: "B-rapun hissi pysähtyi eilen illalla kerrosten väliin. Pääsin ulos vasta, kun hissihuolto tuli. Hissi on edelleen käytössä, mutta pelottaa.",
    reason: "Hissivika on turvallisuusasia: hissi pois käytöstä ja hissihuolto paikalle.", source: "Huoltoyhtiö ja päivystys",
    draft: "Hei,\n\nolemme pahoillamme tapahtuneesta. Hissi on otettu pois käytöstä, ja hissihuolto tarkistaa sen tänään. Ilmoitamme rapun ilmoitustaululla, kun hissi on taas käytössä.\n\nYstävällisin terveisin" },
  { company: 2, apartment: "A 3", subject: "Naapurin tupakansavu parvekkeella", type: "Häiriöilmoitus", status: "active", assignee: "jari", daysAgo: 3,
    summary: "Asukas valittaa alakerran parvekkeelta nousevasta tupakansavusta.", body: "Alakerran parvekkeelta nousee tupakansavua makuuhuoneeseeni joka ilta.",
    note: "Tarkistetaan järjestyssäännöt ja lähetetään tiedote koko taloon." },
  { company: 2, apartment: "B 9", subject: "Lääkärintodistus vuokranmaksun lykkäykseen", type: "Pyyntö", status: "waiting_manager", assignee: "hanna", daysAgo: 2,
    summary: "Asukas pyytää maksuaikaa terveydellisistä syistä.", body: "Olen ollut sairaalassa ja tarvitsisin lisää maksuaikaa vastikkeelle. Liitän lääkärintodistuksen.",
    sensitive: true },
  { company: 2, subject: "Piha-alueen valaistus ei toimi", type: "Vikailmoitus", status: "answered", assignee: "elina", daysAgo: 7,
    summary: "Pihan valot eivät syty iltaisin.", body: "Pihan pylväsvalot eivät ole syttyneet moneen iltaan. Pihalla on pimeää.",
    reply: "Hei, kiitos ilmoituksesta. Huoltoyhtiö vaihtaa hämäräkytkimen tällä viikolla.", replyDaysAgo: 6 },
  { company: 2, apartment: "A 1", subject: "Varastokoppi ilman lukkoa", type: "Kysymys", status: "closed", assignee: "jari", daysAgo: 20,
    summary: "Asukas kysyi, saako varastokoppiin oman lukon.", body: "Saako kellarin varastokoppiin laittaa oman lukon?",
    reply: "Hei, varastokoppiin saa laittaa oman lukon. Ilmoitathan huoltoyhtiölle avainkopion hätätilanteita varten.", replyDaysAgo: 19 },
  { company: 3, apartment: "A 2", subject: "Ilmanvaihto heikko keittiössä", type: "Vikailmoitus", status: "open", assignee: "jari", daysAgo: 1,
    summary: "Keittiön liesituuletin ei vedä kunnolla.", body: "Liesituuletin ei vedä kunnolla ja keittiö käryää ruoanlaiton jälkeen.",
    reason: "Ilmanvaihdon säätö kuuluu huoltoyhtiölle.", source: "Huoltoyhtiö ja päivystys",
    draft: "Hei,\n\nkiitos ilmoituksesta. Pyysimme huoltoyhtiötä tarkistamaan ilmanvaihdon ja puhdistamaan poistoilmaventtiilin. Huoltomies sopii käynnistä kanssasi.\n\nYstävällisin terveisin" },
  { company: 3, apartment: "A 5", subject: "Pihakeinu rikki", type: "Ilmoitus", priority: "low", status: "open", assignee: "jari", daysAgo: 4,
    summary: "Leikkipaikan keinun ketju on katkennut.", body: "Leikkipaikan keinun toinen ketju on poikki. Keinu kannattaisi poistaa käytöstä." },
  { company: 3, subject: "Yhtiökokouksen pöytäkirja", type: "Asiakirjatilaus", status: "closed", assignee: "elina", daysAgo: 9,
    summary: "Osakas pyysi viimeisimmän yhtiökokouksen pöytäkirjaa.", body: "Saisinko kevään yhtiökokouksen pöytäkirjan sähköpostiin?",
    reply: "Hei, liitteenä kevään yhtiökokouksen pöytäkirja.", replyDaysAgo: 8 },
  { company: 0, subject: "Tarjous julkisivumaalauksesta", type: "Muu", priority: "low", status: "open", daysAgo: 1, unidentified: true,
    sender: "Maalaus Virtanen <tarjoukset@maalaus.example>", summary: "Urakoitsija tarjoaa julkisivumaalausta. Taloyhtiötä ei tunnistettu.",
    body: "Hei, tarjoamme julkisivujen maalausta ensi kesälle. Kertoisitteko, mitä taloyhtiöitä tämä voisi koskea?" },
  { company: 0, subject: "Avainta ei palautettu", type: "Kysymys", status: "open", daysAgo: 0, hour: 10, unidentified: true,
    sender: "Kalle Mattila <kalle.mattila@example.com>", summary: "Lähettäjä kysyy avaimen palautuksesta, osoitetta ei mainita.",
    body: "Hei, lainasin yleisavaimen viime viikolla. Minne sen voi palauttaa?" }
];

// Raporttien historiaa varten: aiemmin hoidetut tavalliset asiat viimeisen kolmen kuukauden ajalta.
const HISTORY: { subject: string; type: string; body: string; reply: string }[] = [
  { subject: "Hana tippuu", type: "Vikailmoitus", body: "Keittiön hana tippuu, vaikka se on kiinni.", reply: "Huoltomies vaihtoi hanan tiivisteen." },
  { subject: "Lisäavaimen tilaus", type: "Pyyntö", body: "Tarvitsisin yhden lisäavaimen asuntooni.", reply: "Lisäavain on tilattu, ja voit noutaa sen toimistolta ensi viikolla." },
  { subject: "Rappuvalo ei pala", type: "Vikailmoitus", body: "Rapun kolmannen kerroksen valo ei pala.", reply: "Huoltoyhtiö vaihtoi lampun." },
  { subject: "Saunavuoron peruutus", type: "Pyyntö", body: "Haluaisin luopua kiinteästä saunavuorostani kuun lopussa.", reply: "Saunavuorosi päättyy kuun lopussa." },
  { subject: "Vastikkeen eräpäivä", type: "Kysymys", body: "Mikä on vastikkeen eräpäivä ja tilinumero?", reply: "Vastike maksetaan kuun 5. päivään mennessä. Tilinumero löytyy vastikelaskusta." },
  { subject: "Ilmoitustaulun tiedote", type: "Kysymys", body: "Milloin seuraavat siivoustalkoot ovat?", reply: "Seuraavat talkoot ovat toukokuussa, ja niistä tulee tiedote." },
  { subject: "Ovikello rikki", type: "Vikailmoitus", body: "Ovikello ei soi.", reply: "Ovikello kuuluu osakkaan vastuulle. Lähetimme huoltoliikkeen yhteystiedot." },
  { subject: "Pyörävaraston siivous", type: "Ilmoitus", body: "Pyörävarastossa on paljon hylättyjä pyöriä.", reply: "Merkitsemme pyörät ja poistamme merkityt kuukauden kuluttua." },
  { subject: "Jääkaappi ei kylmää", type: "Vikailmoitus", body: "Jääkaappi on lakannut kylmäämästä.", reply: "Taloyhtiön kodinkoneet korjataan huoltoyhtiön kautta. Asentaja kävi ja vaihtoi termostaatin." },
  { subject: "Isännöitsijäntodistus", type: "Asiakirjatilaus", body: "Tarvitsen isännöitsijäntodistuksen pankkia varten.", reply: "Isännöitsijäntodistus on lähetetty sähköpostiisi." },
  { subject: "Lumityöt", type: "Ilmoitus", body: "Pihaa ei ole aurattu aamulla.", reply: "Huoltoyhtiö kävi auraamassa pihan aamupäivällä." },
  { subject: "Ilmanvaihdon suodattimet", type: "Kysymys", body: "Milloin ilmanvaihdon suodattimet vaihdetaan?", reply: "Suodattimet vaihdetaan kahdesti vuodessa, seuraavan kerran marraskuussa." }
];

const KNOWLEDGE = [
  { title: "Järjestyssäännöt", tags: "järjestys, hiljaisuus, tupakointi, lemmikit", content: (c: string) =>
    `# ${c}: järjestyssäännöt\n\nHiljaisuus on arkisin ja viikonloppuisin klo 22–7. Tällöin asunnoissa ja yhteisissä tiloissa vältetään häiritsevää ääntä.\n\nTupakointi on kielletty porraskäytävissä, kellareissa ja muissa yhteisissä tiloissa. Parveketupakointi on kielletty, jos savu leviää naapureihin.\n\nLemmikit pidetään yhteisissä tiloissa ja pihalla kytkettyinä. Omistaja siivoaa jätökset.\n\nHäiriöistä ilmoitetaan isännöitsijälle kirjallisesti asukasportaalissa.` },
  { title: "Sauna- ja pyykkitupavuorot", tags: "sauna, pyykkitupa, varaus", content: (c: string) =>
    `# ${c}: sauna ja pyykkitupa\n\nSaunavuoron voi varata asukasportaalista. Kiinteä viikkovuoro maksaa 15 € kuukaudessa, ja yksittäinen vuoro 5 €. Vuoro kestää tunnin.\n\nPyykkituvan vuorot ovat maksuttomia. Vuoro kestää kolme tuntia klo 7–22 välillä. Kone ja nukkasihti puhdistetaan käytön jälkeen.\n\nPeruuta vuoro portaalissa, jos et käytä sitä.` },
  { title: "Huoltoyhtiö ja päivystys", tags: "huolto, päivystys, vesivuoto, hätä", content: (c: string) =>
    `# ${c}: huolto ja päivystys\n\nHuoltoyhtiö on ${MAINTENANCE.name}. Tavalliset huoltoasiat ilmoitetaan Pleissin asukasportaalissa huoltotyötilauksena.\n\nKiireellisissä asioissa, kuten vesivuodoissa, lämmön tai sähkön katkeamisessa tai hissiin juuttumisessa, soita päivystykseen ${MAINTENANCE.emergency}. Vesivuodossa sulje ensin hanan sulkuventtiili.\n\nHuolto saa mennä asuntoon yleisavaimella, jos asukas antaa siihen luvan ilmoituksessa.` },
  { title: "Jätehuolto ja kierrätys", tags: "jätteet, kierrätys, jäteastiat", content: (c: string) =>
    `# ${c}: jätehuolto\n\nJätekatoksessa on astiat sekajätteelle, biojätteelle, kartongille, lasille, metallille ja muoville. Sekajäte tyhjennetään kerran viikossa.\n\nIsot esineet ja huonekalut viedään itse jäteasemalle. Taloyhtiö järjestää keväisin siivoustalkoot, joihin tilataan lavat.` },
  { title: "Autopaikat ja lämmityspaikat", tags: "autopaikka, lämmityspaikka, jono", content: (c: string) =>
    `# ${c}: autopaikat\n\nAutopaikat vuokrataan taloyhtiön asukkaille jonotusjärjestyksessä. Jonoon pääsee asukasportaalista tai ottamalla yhteyttä isännöitsijään.\n\nLämmityspaikan hinta on 15 € kuukaudessa ja autotallin 45 € kuukaudessa. Irtisanomisaika on yksi kuukausi.` },
  { title: "Muutto ja avaimet", tags: "muutto, avaimet, muuttoilmoitus", content: (c: string) =>
    `# ${c}: muutto\n\nTee muuttoilmoitus asukasportaalissa viimeistään viikkoa ennen muuttoa. Ilmoita samalla mukana muuttavat henkilöt.\n\nAsunnon avaimet luovutetaan myyjältä tai vuokranantajalta. Lisäavaimia voi tilata isännöitsijältä; avaintilaus vaatii osakkaan luvan.` },
  { title: "Remontti-ilmoitus ja muutostyöt", tags: "remontti, muutostyö, märkätila", content: (c: string) =>
    `# ${c}: remontit\n\nOsakkaan muutostöistä tehdään remontti-ilmoitus asukasportaalissa vähintään kaksi viikkoa ennen töiden alkua. Märkätila-, sähkö- ja LVI-töihin tarvitaan suunnitelma ja pätevä urakoitsija.\n\nTaloyhtiö valvoo vedeneristyksen ja muut rakenteisiin vaikuttavat työt. Meluavat työt tehdään arkisin klo 8–18.` }
];

const INTERNAL_KNOWLEDGE = [
  { title: "Muistilista: vesivahinko", content: "# Vesivahingon muistilista\n\n1. Varmista, että vuoto on pysäytetty ja huoltoyhtiö on paikalla.\n2. Tilaa kosteusmittaus vahinkoasuntoon ja naapuriasuntoihin.\n3. Ilmoita vakuutusyhtiölle ja kirjaa vahinkonumero tehtävään.\n4. Tiedota asukkaille kuivatuksen aikataulusta." },
  { title: "Asiakaspalvelun vastausohje", content: "# Vastausohje\n\nVastaa asukkaalle saman päivän aikana, vaikka asia ei vielä ratkeaisi. Kerro, mitä seuraavaksi tapahtuu ja milloin asukas kuulee asiasta.\n\nKiireelliset viat ohjataan huoltoyhtiön päivystykseen heti." }
];

const ANNOUNCEMENTS = [
  { title: "Vesikatko torstaina", body: "Torstaina klo 9–12 taloon ei tule vettä putkiston huoltotöiden vuoksi. Varaathan vettä etukäteen." },
  { title: "Syystalkoot lauantaina", body: "Syystalkoot pidetään lauantaina klo 10 alkaen. Haravoidaan piha ja siivotaan varastot. Tarjolla kahvia ja pullaa!" },
  { title: "Ilmanvaihdon nuohous", body: "Ilmanvaihtokanavat nuohotaan ensi viikolla. Nuohooja tarvitsee pääsyn asuntoon yleisavaimella. Tarkemmat ajat rappukohtaisesti ilmoitustaululla." }
];

// ---------------------------------------------------------------------------------------------
// Tyhjennys ja luonti
// ---------------------------------------------------------------------------------------------

function clearFolder(folder: string) {
  if (!fs.existsSync(folder)) return;
  for (const entry of fs.readdirSync(folder)) fs.rmSync(path.join(folder, entry), { recursive: true, force: true });
}

// Poistaa kaikki tiedot paitsi toimiston asetukset, perustiedot ja AI-kulut.
function clearData() {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map(row => row.name).filter(name => !KEEP_TABLES.has(name));
  for (const table of tables) db.prepare(`DELETE FROM "${table}"`).run();
  // Valmiit roolit säilyvät; toimiston omat roolit poistetaan.
  db.prepare("DELETE FROM roles WHERE id NOT IN ('role-manager', 'role-service')").run();
  db.prepare(`UPDATE office_settings SET unidentified_queue_roles = '["Pääkäyttäjä","Asiakaspalvelu"]', unidentified_queue_users = '[]' WHERE id = 1`).run();
}

// Tyhjentää alustan ja luo esittelyaineiston yhtenä kokonaisuutena: jos luonti epäonnistuu, mitään ei poisteta.
// Liitteet ja dokumenttien tiedostot poistetaan vasta onnistuneen luonnin jälkeen.
export function resetDemoData(options: DemoOptions) {
  db.pragma("foreign_keys = OFF");
  try {
    const summary = db.transaction(() => {
      clearData();
      return createDemoData(options);
    })();
    clearFolder(attachmentsDir);
    clearFolder(knowledgeFilesDir);
    return summary;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function createDemoData(options: DemoOptions) {
  const rand = random(2026);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
  const now = options.now ?? new Date();
  const dayOffset = (days: number) => isoDay(new Date(now.getTime() + days * 86_400_000));
  const at = (daysAgo: number, hour = 9, minute = 0) => helsinki(dayOffset(-daysAgo), hour, minute);
  const stamp = now.toISOString();
  const passwordHash = () => hashPassword(options.password);
  const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

  const userIds = {} as Record<UserKey, string>;
  const userNames = {} as Record<UserKey, string>;
  const insertUser = db.prepare("INSERT INTO users (id, name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const user of USERS) {
    const userId = `user-demo-${user.key}`;
    const email = user.key === "admin" && options.adminEmail ? options.adminEmail : user.email;
    insertUser.run(userId, user.name, email, user.role, passwordHash(), at(60));
    userIds[user.key] = userId;
    userNames[user.key] = user.name;
  }

  type Apartment = { id: string; number: string; companyId: string };
  type Resident = { id: string; name: string; email: string; apartmentId: string; companyId: string };
  const apartments: Apartment[][] = [];
  const residents: Resident[][] = [];
  const usedEmails = new Set<string>();

  const insertCompany = db.prepare(`
    INSERT INTO companies (id, name, email_address, business_id, address, phone, maintenance_name, maintenance_phone,
      maintenance_email, maintenance_emergency_phone, manager_id, managed)
    VALUES (?, ?, ?, '', ?, '', ?, ?, ?, ?, ?, 1)
  `);
  const insertApartment = db.prepare("INSERT INTO apartments (id, company_id, apartment_number, address, staircase) VALUES (?, ?, ?, ?, ?)");
  const insertResident = db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email, roles) VALUES (?, ?, ?, ?, ?, ?)");

  COMPANIES.forEach((company, companyIndex) => {
    insertCompany.run(company.id, company.name, `${ascii(company.name.replace("As Oy ", ""))}@kotilo.example`,
      `${company.street}, ${company.city}`, MAINTENANCE.name, MAINTENANCE.phone, MAINTENANCE.email, MAINTENANCE.emergency,
      userIds[company.manager]);
    for (const other of company.others) {
      db.prepare("INSERT INTO company_managers (company_id, user_id) VALUES (?, ?)").run(company.id, userIds[other]);
    }
    const companyApartments: Apartment[] = [];
    const companyResidents: Resident[] = [];
    let number = 0;
    for (const [stair, count] of company.stairs) {
      for (let index = 0; index < count; index++) {
        number++;
        const apartment = { id: `apt-${companyIndex}-${number}`, number: `${stair} ${number}`, companyId: company.id };
        insertApartment.run(apartment.id, company.id, apartment.number, company.street, stair);
        companyApartments.push(apartment);
        // Viimeinen asunto on tyhjillään; muissa yksi tai kaksi asukasta.
        if (index === count - 1 && stair === company.stairs[company.stairs.length - 1][0]) continue;
        const people = rand() < 0.4 ? 2 : 1;
        const lastName = pick(LAST_NAMES);
        for (let person = 0; person < people; person++) {
          let first = pick(FIRST_NAMES);
          let email = `${ascii(first)}.${ascii(lastName)}@example.com`;
          while (usedEmails.has(email)) {
            first = pick(FIRST_NAMES);
            email = `${ascii(first)}.${ascii(lastName)}@example.com`;
          }
          usedEmails.add(email);
          const roles = person === 0 ? pick(["asukas", "osakas,asukas", "osakas,asukas", "asukas"]) : "asukas";
          const resident = { id: `resident-${companyIndex}-${number}-${person + 1}`, name: `${first} ${lastName}`, email, apartmentId: apartment.id, companyId: company.id };
          insertResident.run(resident.id, company.id, apartment.id, resident.name, resident.email, roles);
          companyResidents.push(resident);
        }
      }
    }
    apartments.push(companyApartments);
    residents.push(companyResidents);
  });

  // Asukasportaalin esittelytunnukset: Koivikon A 2:n ja B 9:n asukkaat tunnetuilla nimillä.
  const portalResidents: Resident[] = [];
  for (const [number, name, email] of [["A 2", "Liisa Mallikas", "liisa@example.com"], ["B 9", "Matti Meikäläinen", "matti@example.com"]] as const) {
    const apartment = apartments[0].find(item => item.number === number)!;
    const resident = residents[0].find(item => item.apartmentId === apartment.id)!;
    db.prepare("UPDATE residents SET name = ?, email = ?, roles = 'osakas,asukas' WHERE id = ?").run(name, email, resident.id);
    resident.name = name;
    resident.email = email;
    db.prepare("INSERT INTO resident_credentials (resident_id, password_hash, updated_at) VALUES (?, ?, ?)").run(resident.id, passwordHash(), stamp);
    portalResidents.push(resident);
  }

  const apartmentBy = (companyIndex: number, number?: string) => number ? apartments[companyIndex].find(item => item.number === number) : undefined;
  const residentIn = (apartmentId?: string) => residents.flat().find(item => item.apartmentId === apartmentId);

  // Dokumentaatio: jokaiselle taloyhtiölle ohjeet AI:lle ja Koivikolle toimiston sisäiset ohjeet.
  const knowledgeIds = new Map<string, string>();
  let docNumber = 0;
  const insertKnowledge = db.prepare(`
    INSERT INTO knowledge (id, company_id, title, content, kind, version, group_id, status, extraction_ok, created_at, tags, audience, doc_number, formatted)
    VALUES (?, ?, ?, ?, 'fact', 1, ?, 'active', 1, ?, ?, ?, ?, ?)
  `);
  COMPANIES.forEach((company, companyIndex) => {
    for (const doc of KNOWLEDGE) {
      const knowledgeId = `knowledge-${companyIndex}-${++docNumber}`;
      const content = doc.content(company.name);
      insertKnowledge.run(knowledgeId, company.id, doc.title, content.replace(/^# .*\n\n/, ""), knowledgeId, at(40), doc.tags, "ai", docNumber, content);
      knowledgeIds.set(`${company.id}:${doc.title}`, knowledgeId);
    }
  });
  for (const doc of INTERNAL_KNOWLEDGE) {
    const knowledgeId = `knowledge-internal-${++docNumber}`;
    insertKnowledge.run(knowledgeId, COMPANIES[0].id, doc.title, doc.content, knowledgeId, at(30), "", "internal", docNumber, doc.content);
  }
  migrateKnowledgeChunks();

  // Tehtävät viesteineen. Lisätään vanhimmasta uusimpaan, jotta tehtävänumerot kasvavat ajassa.
  const insertTicket = db.prepare(`
    INSERT INTO tickets (id, company_id, apartment_id, resident_id, type, priority, status, subject, summary, source_channel,
      ai_action, ai_reason, draft, created_at, updated_at, assignee_id, sensitive, company_pending, knowledge_source_id,
      knowledge_source_title, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare("INSERT INTO messages (id, ticket_id, direction, sender, subject, body, created_at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertAudit = db.prepare("INSERT INTO audit_log (id, ticket_id, actor, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const history: TicketPlan[] = Array.from({ length: 44 }, (_, index) => {
    const template = HISTORY[index % HISTORY.length];
    const companyIndex = index % COMPANIES.length;
    const company = COMPANIES[companyIndex];
    const daysAgo = 9 + Math.floor(rand() * 80);
    const handlers: UserKey[] = [company.manager, "elina"];
    return {
      company: companyIndex, apartment: pick(apartments[companyIndex]).number, subject: template.subject, type: template.type,
      summary: template.body, body: template.body, status: "closed", assignee: pick(handlers), daysAgo, hour: 8 + Math.floor(rand() * 8),
      reply: template.reply, replyDaysAgo: Math.max(daysAgo - Math.floor(rand() * 2), 0), channel: rand() < 0.3 ? "portal" : "email"
    };
  });
  const ordered = [...TICKETS, ...history].sort((a, b) => b.daysAgo - a.daysAgo || (a.hour ?? 9) - (b.hour ?? 9));
  ordered.forEach((plan, index) => {
    const company = COMPANIES[plan.company];
    const ticketId = `ticket-demo-${index + 1}`;
    const apartment = apartmentBy(plan.company, plan.apartment);
    const resident = residentIn(apartment?.id);
    // Tämän päivän tehtävät saapuvat aina ennen ajohetkeä.
    const planned = at(plan.daysAgo, plan.hour ?? 9 + (index % 5), (index * 7) % 60);
    const created = planned < stamp ? planned : new Date(now.getTime() - (ordered.length - index) * 9 * 60_000).toISOString();
    const closed = plan.status === "closed" ? at(Math.max(plan.daysAgo - 1, 0), 15) : null;
    const sourceId = plan.source ? knowledgeIds.get(`${company.id}:${plan.source}`) ?? null : null;
    insertTicket.run(
      ticketId, company.id, apartment?.id ?? null, resident?.id ?? null, plan.type, plan.priority ?? "normal", plan.status,
      plan.subject, plan.summary, plan.channel ?? "email", plan.draft ? "pending_decision" : "human", plan.reason ?? "",
      plan.draft ?? null, created, closed ?? created, plan.unidentified ? null : (plan.assignee ? userIds[plan.assignee] : null),
      plan.sensitive ? 1 : 0, plan.unidentified ? 1 : 0, sourceId, sourceId ? plan.source : null, closed
    );
    if (resident) db.prepare("INSERT OR IGNORE INTO ticket_reporters (ticket_id, resident_id) VALUES (?, ?)").run(ticketId, resident.id);
    const sender = plan.sender ?? (resident ? `${resident.name} <${resident.email}>` : "Asukas <asukas@example.com>");
    insertMessage.run(`message-demo-${index + 1}`, ticketId, "inbound", sender, plan.subject, plan.body, created, plan.channel === "portal" ? "portal" : "email");
    insertAudit.run(newId("audit"), ticketId, "system", "ticket_created", "{}", created);
    if (plan.draft) insertAudit.run(newId("audit"), ticketId, "ai", "ai_suggested", JSON.stringify({ source_id: sourceId }), created);
    const handler = plan.assignee ? userNames[plan.assignee] : "Isännöitsijä";
    if (plan.reply) {
      // Vastaus on lähetetty viestin saapumisen jälkeen mutta ei tulevaisuudessa.
      const planned = [at(plan.replyDaysAgo ?? plan.daysAgo, 14), stamp].sort()[0];
      const replied = planned > created ? planned : created;
      insertMessage.run(`message-demo-${index + 1}-reply`, ticketId, "outbound", `${handler} <toimisto@kotilo.example>`, `Re: ${plan.subject}`,
        `${plan.reply}\n\nYstävällisin terveisin\n${handler}`, replied, plan.channel === "portal" ? "portal" : "email");
      insertAudit.run(newId("audit"), ticketId, handler, "reply_sent", "{}", replied);
    }
    if (plan.note) db.prepare("INSERT INTO ticket_notes (id, ticket_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(newId("note"), ticketId, handler, plan.note, at(plan.daysAgo, 16));
    if (plan.workOrder) {
      db.prepare(`
        INSERT INTO work_orders (id, ticket_id, company_id, contractor_name, contractor_email, description, status, email_sent, ordered_by, ordered_at, done_by, done_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(newId("workorder"), ticketId, company.id, MAINTENANCE.name, MAINTENANCE.email, plan.workOrder,
        plan.workOrderDone ? "done" : "ordered", handler, at(plan.daysAgo, 12), plan.workOrderDone ? MAINTENANCE.name : null,
        plan.workOrderDone ? at(Math.max(plan.daysAgo - 1, 0), 10) : null);
    }
    if (plan.status === "closed") insertAudit.run(newId("audit"), ticketId, handler, "decision_skip", "{}", closed!);
  });

  // Avaimet: asuntojen avaimet, yleisavaimet ja yhteisten tilojen avaimet sekä lainat.
  const insertKey = db.prepare("INSERT INTO building_keys (id, company_id, code, type, apartment_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertLoan = db.prepare(`
    INSERT INTO key_loans (id, key_id, resident_id, holder_name, note, due_date, handed_at, handed_by, returned_at, received_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  COMPANIES.forEach((company, companyIndex) => {
    const prefix = company.name.replace("As Oy ", "").slice(0, 3).toUpperCase();
    for (const apartment of apartments[companyIndex]) {
      for (let copy = 1; copy <= 2; copy++) {
        insertKey.run(newId("key"), company.id, `${prefix}-${apartment.number.replace(" ", "")}-${copy}`, "Asunto", apartment.id, "", "active", at(90));
      }
    }
    const shared: [string, string, string][] = [
      [`${prefix}-YA-1`, "Yleisavain", "Huoltoyhtiön käytössä"], [`${prefix}-YA-2`, "Yleisavain", "Isännöitsijän toimistolla"],
      [`${prefix}-SAUNA`, "Yleiset tilat", "Sauna ja pesutupa"], [`${prefix}-KERHO`, "Yleiset tilat", "Kerhohuone"],
      [`${prefix}-TEK`, "Tekninen tila", "Lämmönjakohuone"], [`${prefix}-AT-1`, "Autotalli", "Autotalli 1"]
    ];
    const keyIds = shared.map(([code, type, note]) => {
      const keyId = newId("key");
      insertKey.run(keyId, company.id, code, type, null, note, code.endsWith("AT-1") && companyIndex === 1 ? "lost" : "active", at(120));
      return keyId;
    });
    // Yleisavain huoltoyhtiöllä (myöhässä Koivikossa), kerhohuoneen avain asukkaalla.
    insertLoan.run(newId("loan"), keyIds[0], null, MAINTENANCE.name, "Ilmanvaihdon nuohous", dayOffset(companyIndex === 0 ? -2 : 5),
      at(6), "Hanna Lehtonen", null, null);
    const borrower = residents[companyIndex][1];
    insertLoan.run(newId("loan"), keyIds[3], borrower.id, borrower.name, "Syntymäpäiväjuhlat", dayOffset(3), at(2), "Elina Koskinen", null, null);
    insertLoan.run(newId("loan"), keyIds[2], residents[companyIndex][0].id, residents[companyIndex][0].name, "", dayOffset(-20), at(25), "Elina Koskinen",
      at(21), "Elina Koskinen");
  });

  // Autopaikat, hinnat ja haltijat.
  const parkingTypes = [["Ulkopaikka", 10], ["Lämmityspaikka", 15], ["Autotalli", 45], ["Hallipaikka", 35]] as const;
  COMPANIES.forEach((company, companyIndex) => {
    for (const [type, price] of parkingTypes) {
      db.prepare("INSERT INTO parking_prices (company_id, type, monthly_price) VALUES (?, ?, ?)").run(company.id, type, price);
    }
    for (let index = 1; index <= 8; index++) {
      const type = parkingTypes[index % 3 === 0 ? 2 : index % 2 === 0 ? 1 : 0][0];
      const holder = index <= 6 ? residents[companyIndex][(index * 2) % residents[companyIndex].length] : undefined;
      const parkingId = newId("parking");
      db.prepare("INSERT INTO parking_spaces (id, company_id, label, type, resident_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(parkingId, company.id, `P${index}`, type, holder?.id ?? null, "", at(200));
      if (holder) {
        db.prepare("INSERT INTO parking_assignments (id, parking_id, company_id, resident_id, start_date, end_date) VALUES (?, ?, ?, ?, ?, NULL)")
          .run(newId("assignment"), parkingId, company.id, holder.id, dayOffset(-180 + index * 10));
      }
    }
  });

  // Sauna- ja pyykkitupavuorot: kiinteät saunavuorot ja yksittäiset pyykkituvan vuorot kahdeksi viikoksi.
  const insertBooking = db.prepare(`
    INSERT INTO bookings (id, company_id, resource, resident_id, note, starts_at, ends_at, created_by, created_at, series_id)
    VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)
  `);
  const insertSettings = db.prepare(`
    INSERT INTO booking_settings (company_id, resource, allow_single, allow_weekly, weekly_weeks, single_price, monthly_price, queue_enabled, queue_size, first_hour, last_hour)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `);
  COMPANIES.forEach((company, companyIndex) => {
    insertSettings.run(company.id, "sauna", 1, 1, 12, 5, 15, 16, 22);
    insertSettings.run(company.id, "laundry", 1, 0, 4, 0, 0, 7, 22);
    const people = residents[companyIndex];
    // Kiinteät saunavuorot: kymmenen asukasta, vuoro samana viikonpäivänä viikoittain.
    for (let slot = 0; slot < Math.min(10, people.length); slot++) {
      const seriesId = newId("series");
      const resident = people[slot];
      const weekday = slot % 7;
      const hour = 17 + (Math.floor(slot / 7) * 2 + slot) % 5;
      for (let week = -1; week <= 3; week++) {
        const day = dayOffset(week * 7 + weekday - ((now.getUTCDay() + 6) % 7));
        insertBooking.run(newId("booking"), company.id, "sauna", resident.id, helsinki(day, hour), helsinki(day, hour + 1), resident.name, at(30), seriesId);
      }
    }
    // Pyykkituvan yksittäiset vuorot: kaksi vuoroa päivässä.
    for (let day = -3; day <= 13; day++) {
      for (const [slot, hour] of [[0, [7, 10, 13][(day + 30 + companyIndex) % 3]], [1, [16, 19][(day + 30) % 2]]] as const) {
        const resident = people[(day * 2 + slot + 40 + companyIndex) % people.length];
        insertBooking.run(newId("booking"), company.id, "laundry", resident.id, helsinki(dayOffset(day), hour), helsinki(dayOffset(day), hour + 3), resident.name, at(3), null);
      }
    }
  });

  // Jonot: autopaikkajono ja saunavuorojono.
  COMPANIES.forEach((company, companyIndex) => {
    const people = residents[companyIndex];
    [["parking", "Lämmityspaikka", 3], ["parking", "Autotalli", 4], ["parking", "Lämmityspaikka", 5], ["sauna", "", 6]].forEach(([resource, type, offset], index) => {
      const resident = people[(Number(offset) + companyIndex) % people.length];
      db.prepare("INSERT INTO waitlist (id, company_id, resource, parking_type, resident_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, '', 'waiting', ?)")
        .run(newId("waitlist"), company.id, resource, type, resident.id, at(40 - index * 8));
    });
  });

  // Mittarilukemat: vesimittarit kolmelta kuukaudelta.
  COMPANIES.forEach((company, companyIndex) => {
    if (companyIndex === 1) return;
    for (const apartment of apartments[companyIndex].slice(0, 8)) {
      const resident = residentIn(apartment.id);
      let cold = 100 + Math.round(rand() * 300);
      let hot = 40 + Math.round(rand() * 120);
      for (const monthsAgo of [2, 1, 0]) {
        cold += 6 + Math.round(rand() * 8);
        hot += 2 + Math.round(rand() * 4);
        const day = dayOffset(-monthsAgo * 30 - 2);
        for (const [type, value] of [["cold_water", cold], ["hot_water", hot]] as const) {
          db.prepare(`
            INSERT INTO meter_readings (id, company_id, apartment_id, resident_id, meter_type, reading_date, value, source, recorded_by, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
          `).run(newId("reading"), company.id, apartment.id, resident?.id ?? null, type, day, value, resident ? "portal" : "office",
            resident?.name ?? "Elina Koskinen", helsinki(day, 18));
        }
      }
    }
  });

  // Muuttoilmoitukset: odottavia ja hyväksyttyjä.
  const insertMove = db.prepare(`
    INSERT INTO move_notices (id, company_id, apartment_id, resident_id, move_date, moves_out, new_residents, door_name, note, status, created_at,
      decided_by, decided_at, result, details, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?)
  `);
  const moves = [
    { company: 0, apartment: "B 12", kind: "Sisäänmuuttoilmoitus", name: "Emma Laine", with: ["Oskari Laine"], date: 10, status: "pending", source: "email", daysAgo: 1 },
    { company: 0, apartment: "A 2", kind: "Poismuuttoilmoitus", resident: true, date: 25, status: "pending", source: "portal", daysAgo: 0 },
    { company: 2, apartment: "B 10", kind: "Sisäänmuuttoilmoitus", name: "Teemu Vuorinen", with: [], date: 5, status: "pending", source: "email", daysAgo: 2 },
    { company: 1, apartment: "A 8", kind: "Sisäänmuuttoilmoitus", name: "Sofia Ranta", with: ["Elias Ranta", "Mia Ranta"], date: -10, status: "approved", source: "email", daysAgo: 20 },
    { company: 3, apartment: "A 6", kind: "Sisäänmuuttoilmoitus", name: "Aleksi Kivinen", with: [], date: -3, status: "approved", source: "portal", daysAgo: 12 }
  ];
  for (const move of moves) {
    const company = COMPANIES[move.company];
    const apartment = apartmentBy(move.company, move.apartment)!;
    const resident = move.resident ? residentIn(apartment.id) : undefined;
    const name = resident?.name ?? move.name!;
    const movesOut = move.kind === "Poismuuttoilmoitus";
    const details: Record<string, string> = {
      kind: move.kind, name, phone: "040 123 4567", email: resident?.email ?? `${ascii(name.split(" ")[0])}.${ascii(name.split(" ")[1])}@example.com`,
      role: "Vuokralainen", waterPayment: "Taloyhtiölle erillisellä laskulla",
      ...(movesOut ? { currentAddress: company.street, currentApartment: apartment.number } : { newAddress: company.street, newApartment: apartment.number, town: company.city.split(" ")[1] })
    };
    (move.with ?? []).forEach((person, index) => { details[`with${index + 1}Name`] = person; });
    const newResidents = movesOut ? [] : [{ name, email: details.email }, ...(move.with ?? []).map(person => ({ name: person, email: "" }))];
    const decided = move.status === "approved";
    // Hyväksytyn ilmoituksen uudet asukkaat ovat jo asunnossa.
    if (decided) {
      newResidents.forEach((person, index) => {
        db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email, roles) VALUES (?, ?, ?, ?, ?, 'asukas')")
          .run(`resident-move-${move.company}-${apartment.number.replace(" ", "")}-${index + 1}`, company.id, apartment.id, person.name, person.email || null);
      });
    }
    insertMove.run(newId("move"), company.id, apartment.id, resident?.id ?? null, dayOffset(move.date), movesOut ? 1 : 0, JSON.stringify(newResidents),
      move.status, at(move.daysAgo, 11), decided ? "Hanna Lehtonen" : null, decided ? at(move.daysAgo - 1, 10) : null,
      decided ? JSON.stringify({ movedOut: 0, parkingReleased: [], bookingsRemoved: 0, added: newResidents.map(person => person.name), skipped: [] }) : null, JSON.stringify(details), move.source);
  }

  // Remontti-ilmoitukset; tehtävät luodaan niille samalla tavalla kuin uusille ilmoituksille.
  const renovations = [
    { company: 0, apartment: "A 4", workType: "Märkätila", description: "Kylpyhuoneen täysremontti: vedeneristys, laatoitus ja kalusteet.", start: 14, end: 40, status: "pending",
      contractor: "Kylpyhuonemestarit Oy", waterproofing: "Sertifioitu vedeneristäjä, vedeneristyksen tarkastus ennen laatoitusta.", daysAgo: 1 },
    { company: 0, apartment: "B 10", workType: "Keittiö", description: "Keittiökalusteiden ja tasojen uusiminen. Ei muutoksia vesi- tai viemäriputkiin.", start: -5, end: 10, status: "started",
      contractor: "Keittiöpaja Oy", daysAgo: 20 },
    { company: 2, apartment: "A 2", workType: "Sähkö", description: "Sähköpistorasioiden lisäys olohuoneeseen.", start: 7, end: 9, status: "approved",
      contractor: "Sähkö-Nieminen Oy", daysAgo: 6 },
    { company: 1, apartment: "A 6", workType: "Muu", description: "Lattioiden vaihto parketiksi koko asuntoon.", start: -40, end: -25, status: "inspected",
      contractor: "Parkettityö Lahti", daysAgo: 50 }
  ];
  for (const plan of renovations) {
    const company = COMPANIES[plan.company];
    const apartment = apartmentBy(plan.company, plan.apartment)!;
    const resident = residentIn(apartment.id);
    const decided = plan.status !== "pending";
    db.prepare(`
      INSERT INTO renovation_notices (id, company_id, apartment_id, resident_id, reporter_name, work_type, description, start_date, end_date, contractor,
        contractor_contact, supervisor, waterproofing, status, decision_note, created_at, decided_by, decided_at, started_at, completed_at, inspected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)
    `).run(newId("renovation"), company.id, apartment.id, resident?.id ?? null, resident?.name ?? "", plan.workType, plan.description,
      dayOffset(plan.start), dayOffset(plan.end), plan.contractor, "010 123 4599", "Rakennusvalvonta Tarkka Oy", plan.waterproofing ?? "",
      plan.status, at(plan.daysAgo, 13), decided ? userNames[company.manager] : null, decided ? at(plan.daysAgo - 2, 10) : null,
      ["started", "inspected"].includes(plan.status) ? at(Math.max(-plan.start, 0), 8) : null,
      plan.status === "inspected" ? at(-plan.end, 15) : null, plan.status === "inspected" ? at(-plan.end - 2, 11) : null);
  }
  migrateRenovationNotices();

  // Tiedotteet.
  COMPANIES.forEach((company, companyIndex) => {
    ANNOUNCEMENTS.forEach((announcement, index) => {
      if ((index + companyIndex) % 3 === 2) return;
      db.prepare("INSERT INTO announcements (id, company_id, stairwell, title, body, emailed_count, created_by, created_at) VALUES (?, ?, '', ?, ?, ?, ?, ?)")
        .run(newId("announcement"), company.id, announcement.title, announcement.body, residents[companyIndex].length, userNames[company.manager], at(3 + index * 9));
    });
  });

  // Lämmityspaikkatilaukset.
  [[0, "A 3", "pending", 1], [2, "A 4", "approved", 15]].forEach(([companyIndex, number, status, daysAgo]) => {
    const company = COMPANIES[companyIndex as number];
    const apartment = apartmentBy(companyIndex as number, number as string)!;
    const resident = residentIn(apartment.id)!;
    db.prepare(`
      INSERT INTO heating_orders (id, company_id, apartment_id, resident_id, start_date, end_date, status, note, details, source, created_at, updated_at, parking_type)
      VALUES (?, ?, ?, ?, ?, NULL, ?, '', ?, 'portal', ?, ?, 'Lämmityspaikka')
    `).run(newId("heating"), company.id, apartment.id, resident.id, dayOffset(7), status,
      JSON.stringify({ spot: "Lämmitystolppapaikan", orderType: "Toistaiseksi voimassa oleva", name: resident.name, email: resident.email }),
      at(daysAgo as number), at(daysAgo as number));
  });

  // Hallituksen jäsenet (kirjautuvat hallituksen näkymään samalla salasanalla).
  COMPANIES.forEach((company, companyIndex) => {
    const chair = residents[companyIndex][0];
    db.prepare("INSERT INTO board_members (id, company_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId("board"), company.id, chair.name, `hallitus.${ascii(company.name.replace("As Oy ", ""))}@example.com`, passwordHash(), at(100));
  });

  return {
    users: USERS.length, companies: COMPANIES.length, apartments: apartments.flat().length, residents: residents.flat().length,
    tickets: (db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n,
    portalLogins: portalResidents.map(resident => resident.email)
  };
}
