# Pleissin AI:n evaluointi

Mittaa, toimiiko Pleissin AI oikein, ennen kuin ohje-, malli- tai agenttimuutos menee tuotantoon.
Määrittely: [Evaluation suite spec](https://claude.ai/artifact/N5XrnmZ4hewvZCrhFaSXuh).
Ensimmäinen versio kattaa saapuvan viestin arvioinnin (`assessIncoming`).

Evaluointi kutsuu oikeaa Claudea, joten se maksaa ja kestää minuutteja. Se ei kuulu `npm test` -ajoon.

```sh
npm run eval                                   # koko joukko
npm run eval -- --case assess-001              # yksi tapaus (toistettavissa tai pilkuilla)
npm run eval -- --model claude-sonnet-5-5      # toinen malli
npm run eval -- --baseline eval/results/2026-10-27-abc1234.json   # uudet hylätyt ja läpäisyt
```

API-avain luetaan muuttujasta `EVAL_ANTHROPIC_API_KEY` (oma avain ja kuukausiraja Anthropicin
konsolissa), tai sen puuttuessa `ANTHROPIC_API_KEY`. Ajo käyttää omaa väliaikaista tietokantaa, joten
mitään ei tallennu sovelluksen dataan eikä kulut näy Pleissin AI-kulurajassa.

## Tapaukset

Yksi JSON-tiedosto per tapaus kansiossa `cases/<toiminto>/`, tiedoston nimi = tapauksen `id`. Repoon
menee vain keksittyä tai anonymisoitua dataa.

```json
{
  "id": "assess-001",
  "feature": "assess",
  "source": "synthetic",
  "tags": ["rajatapaus", "vesivahinko"],
  "input": { "subject": "…", "body": "…", "sender": "asukas@example.fi" },
  "expected": { "relevant": true, "priorityAcceptable": ["emergency"] },
  "critical": true,
  "note": "Miksi tapaus on olemassa."
}
```

## Tarkistukset

- `relevant` = odotettu ja `priority` kuuluu `priorityAcceptable`-listaan → läpäisty.
- Kriittinen virhe: odotettu emergency/urgent (kaikki hyväksyttävät) mutta tulos normal/low, odotettu
  relevantti mutta tulos false, tai `critical`-tapauksen (esim. injektio) mikä tahansa virhe.

## Tulokset

Raportti tulostuu komentoriville ja tallentuu tiedostoihin `results/<päivä>-<commit>.json` ja `.md`
(osajoukon ajo: `-osajoukko`). JSON-tiedostoa voi käyttää myöhemmin `--baseline`-vertailuun.

Exit code: 0 = kunnossa, 1 = kriittisiä virheitä, 2 = tapauksia jäi arvioimatta (esim. API-virhe).

## ERP-integraation suorituskyky

`npm run bench:integration` mittaa ERP-integraation ajat tilapäisessä tietokannassa keksityllä aineistolla
(oletuksena 3 000 tehtävää × 10 viestiä ja ensilataus 100 taloyhtiöstä, 10 000 asukasta). Oikeaa tietokantaa
tai verkkoa ei käytetä. Kokoa voi muuttaa: `npm run bench:integration -- --tickets 10000 --companies 300`
(myös `--messages`, `--apartments`, `--residents`, `--pending`).

Ohjearvot kehityskoneella: tehtävän muutos jono päällä alle 2 ms, luonnoksen tallennus alle 0,1 ms,
ensilatauksen päivitys alle 1 s ja kutsu 1 000 odottavan sanoman aikana alle 1 ms. Selvästi suuremmat ajat
kertovat yleensä puuttuvasta indeksistä tai kyselystä, joka käy läpi koko taulun.
