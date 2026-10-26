import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyDraftEdit, draftSimilarity } from "../src/ai-draft-edits.js";

describe("AI-luonnoksen muokkausmittari", () => {
  const draft = "Hei, sauna on varattu perjantaina klo 18. Avain on huoltoyhtiöllä, ja sen saa noudettua arkisin.";

  it("sellaisenaan lähetetty luonnos on muuttamaton, vaikka välimerkit ja isot kirjaimet muuttuvat", () => {
    assert.equal(draftSimilarity(draft, draft), 1);
    assert.equal(classifyDraftEdit(draftSimilarity(draft, draft.toUpperCase().replace(/[.,]/g, ""))), "unchanged");
  });

  it("pieni lisäys on pieni muokkaus", () => {
    const sent = `${draft} Mukavaa viikonloppua!`;
    assert.equal(classifyDraftEdit(draftSimilarity(draft, sent)), "light");
  });

  it("kokonaan uusi vastaus on kirjoitettu uudelleen", () => {
    const sent = "Tähän asiaan palataan ensi viikolla, kun isännöitsijä on tarkistanut tilanteen.";
    assert.equal(classifyDraftEdit(draftSimilarity(draft, sent)), "rewritten");
  });

  it("puolet muutettu on iso muokkaus", () => {
    const sent = "Hei, sauna on varattu perjantaina klo 18. Tarkistamme vielä avaimen noutoajan ja palaamme asiaan.";
    assert.equal(classifyDraftEdit(draftSimilarity(draft, sent)), "heavy");
  });

  it("tyhjät tekstit", () => {
    assert.equal(draftSimilarity("", ""), 1);
    assert.equal(draftSimilarity(draft, ""), 0);
  });
});
