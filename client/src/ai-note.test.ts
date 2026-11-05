import { describe, expect, it } from "vitest";
import { splitAiNote } from "./tickets/ticket-utils";

// AI-vastauksen huomautus erotetaan viestistä, jotta se näytetään pienellä allekirjoituksen alla.
describe("AI-huomautus", () => {
  it("erottaa huomautuksen viestin lopusta", () => {
    const body = "Vuoro on varattu.\n\nYstävällisin terveisin\nAino-AI, tekoälyavustaja\n\nTämän vastauksen kirjoitti tekoäly. Jos asiasi ei ratkennut, vastaa tähän viestiin.";
    expect(splitAiNote(body)).toEqual({
      text: "Vuoro on varattu.\n\nYstävällisin terveisin\nAino-AI, tekoälyavustaja",
      note: "Tämän vastauksen kirjoitti tekoäly. Jos asiasi ei ratkennut, vastaa tähän viestiin."
    });
    expect(splitAiNote("Tavallinen vastaus.")).toEqual({ text: "Tavallinen vastaus.", note: "" });
  });
});
