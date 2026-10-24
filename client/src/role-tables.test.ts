import { describe, expect, it } from "vitest";
import { ALWAYS_VISIBLE, roleTableGroups, roleTableTitles } from "./role-tables";
import { ticketTabs } from "./routing";

describe("roolien taulut", () => {
  it("jokainen näkymä on roolien valinnoissa tai näkyy kaikille", () => {
    const tables = roleTableGroups.flatMap(group => group.tabs);
    // Nämä kuuluvat toisen taulun alle: Ilman käsittelijää -> Tunnistamattomat, AI tehtävät -> Kaikki tehtävät,
    // Data -> taloyhtiön alasivut.
    const aliases = ["unassigned", "ai-handled", "data"];
    expect(ticketTabs.filter(tab => !tables.includes(tab) && !ALWAYS_VISIBLE.includes(tab) && !aliases.includes(tab))).toEqual([]);
    expect(new Set(tables).size).toBe(tables.length);
    expect(tables.every(tab => roleTableTitles[tab])).toBe(true);
  });
});
