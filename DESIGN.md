# Pleissin ulkoasu

Pleissi on isännöitsijän työväline, jolla hoidetaan päivittäin kymmeniä asukkaiden asioita. Ilme on rauhallinen
ja asiallinen: tieto ensin, koristeet pois. Sovellus on erillinen kotisivusta (`site/`), jolla on oma ilmeensä.

Periaatteet:

1. **Väri tarkoittaa jotain.** Punainen ja keltainen kertovat kiireestä (hätä, kiireellinen, myöhässä,
   muistutus). Sininen tarkoittaa toimintoa: painike, linkki, valittu kohta. Kaikki muu on neutraalia.
2. **Yksi asia korostetaan.** Päätösjonossa se on kiireellisyys ja määräaika. Muut tiedot ovat tavallista tekstiä.
3. **Listat ovat rekistereitä, eivät kortteja.** Rivit ovat yhden paneelin sisällä viivoin erotettuina. Korttia
   ei laiteta kortin sisään.
4. **Tavallinen kirjoitusasu.** Otsikot ja nimilaput isolla alkukirjaimella, ei ISOILLA KIRJAIMILLA eikä
   harvennettuna. Painikkeessa lukee, mitä se tekee.

Arvot ovat muuttujina tiedostossa `client/src/tokens.css`, ja tyylit käyttävät niitä nimellä, eivät suoraan
värikoodeina. Tumma tila saa arvonsa samoista muuttujista.

## Värit

| Muuttuja | Vaalea | Tumma | Käyttö |
| --- | --- | --- | --- |
| `--canvas` | `#f4f6f9` | `#121a24` | sivun tausta |
| `--surface` | `#ffffff` | `#1a2431` | paneelit, lomakkeet, listat |
| `--surface-2` | `#f8f9fb` | `#1f2a38` | listan otsikkorivi, kentän tausta, valinnan hover |
| `--ink` | `#1c2733` | `#e6ebf1` | teksti ja otsikot |
| `--ink-2` | `#4b5866` | `#b3bfcc` | toissijainen teksti |
| `--ink-3` | `#65717f` | `#8d9aa8` | aikaleimat, selitteet, vihjeet (kontrasti valkoisella 4,9:1) |
| `--line` | `#dfe4ea` | `#2a3646` | rivien ja paneelien viivat |
| `--line-strong` | `#c8d0da` | `#3a4859` | toissijaisten painikkeiden reunat |
| `--field-border` | `#84909d` | `#6a7b8e` | kenttien reunat (kontrasti vähintään 3:1, jotta kentän rajat erottuvat) |
| `--primary` | `#2b5c8a` | `#7fb0de` | ensisijainen painike, linkit, valittu kohta |
| `--primary-hover` | `#224a70` | `#a3c7ea` | ensisijaisen painikkeen hover |
| `--primary-tint` | `#e9f0f7` | `#1f3247` | valittu rivi, aktiivinen suodatin |
| `--on-primary` | `#ffffff` | `#10202f` | teksti ensisijaisella painikkeella |
| `--chrome` | `#172230` | `#0e151e` | sivupalkki ja yläpalkki |
| `--danger` / `--danger-tint` | `#b23b2b` / `#fbecea` | `#f0a093` / `#3a2220` | hätä, myöhässä, poisto, virhe |
| `--warning` / `--warning-tint` | `#8a5a00` / `#fdf2d8` | `#e8c170` / `#352a14` | kiireellinen, muistutus, määräaika lähellä |
| `--success` / `--success-tint` | `#2f6b45` / `#e6f1ea` | `#8fcfa3` / `#1d3326` | valmis, hyväksytty, tallennettu |

Ei liukuvärejä, ei läpikuultavia lasipintoja. Musta on `--ink`, ei `#000` tai `#111`.

## Typografia

Yksi fontti: Inter (sovelluksen mukana). Luvut tasalevyisinä (`font-variant-numeric: tabular-nums`) tauluissa ja
laskureissa.

| Muuttuja | Koko / riviväli | Käyttö |
| --- | --- | --- |
| `--text-xs` | 12 / 16 px | aikaleimat, merkit, sarakeotsikot (pienin koko) |
| `--text-sm` | 13 / 18 px | toissijainen teksti, taulun solut |
| `--text-md` | 14 / 20 px | perusteksti, painikkeet, kentät |
| `--text-lg` | 16 / 22 px | listan kohteen otsikko |
| `--text-xl` | 19 / 26 px | osion otsikko |
| `--text-2xl` | 26 / 32 px | sivun otsikko |

Painot: 400 teksti, 500 korostus ja painikkeet, 600 otsikot. Rivin pituus enintään noin 75 merkkiä.

## Välit, muodot ja syvyys

- Välit 4 px:n askelin: 4, 8, 12, 16, 24, 32, 48 (`--space-1` … `--space-7`).
- Pyöristys: `--radius-sm` 4 px (merkit), `--radius-md` 6 px (painikkeet, kentät), `--radius-lg` 8 px (paneelit,
  ikkunat). Ei täysin pyöreitä pillereitä; pyöreä vain avatar ja kytkin.
- Poikkeus: avatut tietueet (tehtävä, dokumentti, asukas, taloyhtiö) ja kirjautumiskortti ovat suorakulmaisia
  (aiempi päätös), jotta avattu tietue erottuu listan riveistä.
- Paneeleissa ei ole varjoa, vain 1 px:n `--line`-reuna. Varjo `--shadow-pop` vain avautuville valikoille ja
  ikkunoille.

## Osat

- **Painikkeet:** kaikki toimintopainikkeet ovat 36 px korkeita, `--radius-md`, `--text-sm` ja paino 500 (tyylit
  `styles.css`:n lopussa, Painikkeet-lohko).
  - Ensisijainen (`.primary`, `--primary` ja valkoinen teksti): yksi per näkymä, esim. Lisää asukas, Lähetä.
  - Toissijainen (oletus): `--surface`, `--line-strong`-reuna, hover `--surface-2`.
  - Vaarallinen (`.danger`): punainen teksti, hover `--danger-tint`; täytetty (`.danger-fill`) vain lopullisessa
    vahvistuksessa.
  - Hiljainen (`.quiet-button`): pelkkä `--primary`-teksti rivin sisäisille toiminnoille (Irrota, Tallenna vastaamatta).
  - Kaikilla näkyvä fokus (2 px `--primary`-ääriviiva) ja ei käytössä -tila `--surface-2`-taustalla ja
    `--ink-3`-tekstillä (ei läpikuultava). Ei varjoja, ei kuvakkeita koristeena, ei nuolia tekstin perässä.
- **Merkit (tila, prioriteetti):** `--radius-sm`, `--text-xs`, paino 500, taustana värin tint-sävy. Vain tila ja
  prioriteetti ovat merkkejä; taloyhtiö, asunto, asukas ja käsittelijä ovat tekstiä.
- **Listat:** yksi paneeli, rivit `--line`-viivoin, otsikkorivi `--surface-2`-taustalla. Valittu tai hover-rivi
  `--surface-2`. Riveillä ja korteilla ei ole värillistä reunaa; kiireen kertoo prioriteettimerkki.
- **Kentät:** `--surface`, reuna `--field-border`, `--radius-md`, korkeus 36 px.
- **Navigaatio:** `--chrome`-pohjainen sivupalkki; valittu kohta vaalea tausta ja paino 500.
- **AI-toiminnot:** tavallisia painikkeita, joissa lukee mitä tapahtuu. Ei kipinäkuvakkeita eikä erillistä
  AI-väriä. Ehdotus näytetään luonnoksena lähteineen.

## Kuvat ja kuvakkeet

Yksi viivakuvakesarja (1,75 px viiva, 16–18 px). Kuvake vain, kun se auttaa tunnistamaan kohteen
(navigaatio, liite); ei tekstin koristeena. Emojeja ei käytetä kuvakkeina.
