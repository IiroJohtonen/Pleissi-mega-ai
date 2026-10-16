# Pleissi (kotilo)

## Muutosloki ja testaussivu jokaiseen pull requestiin

Käyttäjä testaa muutokset selaimessa toimivalla testaussivulla:
https://claude.ai/artifact/9ioRJQ7LnYLHtmq6WHi3ri

Kun teet pull requestin, joka muuttaa sovelluksen toimintaa:

1. Lisää testaussivun tietokantaan (ArtifactData-työkalu, sivun osoite yllä):
   - `changes/pr-<numero>`: `{date: "VVVV-KK-PP", pr: <numero>, title, what: [selkokieliset muutokset], how: "missä ja miten muutos näkyy"}`
   - `tests/T-<juokseva numero>` jokaiselle uudelle testille: `{order, changeId: "pr-<numero>", status: "todo",
     area (näkymä), field (kenttä), role, priority ("1"–"3"), title, steps: [vaiheet], input (prompti/syöte), expected}`.
     Jatka numerointia suurimmasta olemassa olevasta T-numerosta (lue `tests`-kokoelma ensin).
   - Älä koskaan muuta olemassa olevien testien kenttiä `status`, `result`, `comment` tai `testedAt`: ne ovat käyttäjän merkintöjä.
2. Lisää sama muutos tiedoston `docs/MUUTOSLOKI.md` alkuun (uusin ylimpänä).

Kirjoita muutokset ja testit suomeksi ja selkokielellä, käyttäjän näkökulmasta (ei koodin nimiä).
