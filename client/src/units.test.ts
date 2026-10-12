import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDay, formatTicketNumber } from "./format";
import { downloadFile } from "./session";
import { isOverdue, splitQuotedReply } from "./tickets/ticket-utils";
import type { Ticket } from "./types";
import { parseCsv, tableToResidents } from "./views/Residents";

const ticket = (fields: Partial<Ticket>): Ticket => ({
  id: "t", company_id: "c", type: "Muu", priority: "normal", status: "open", subject: "", summary: "",
  source_channel: "email", ai_action: "", ai_reason: "", created_at: "2026-01-01T00:00:00.000Z", ...fields
});

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("sv-SE");

describe("määräaika", () => {
  it("on myöhässä vain, kun tehtävä on kesken ja määräaika on mennyt", () => {
    expect(isOverdue(ticket({ due_date: day(-1) }))).toBe(true);
    expect(isOverdue(ticket({ due_date: day(0) }))).toBe(false);
    expect(isOverdue(ticket({ due_date: day(3) }))).toBe(false);
    expect(isOverdue(ticket({ due_date: day(-1), status: "closed" }))).toBe(false);
    expect(isOverdue(ticket({ due_date: null }))).toBe(false);
  });
});

describe("muotoilu", () => {
  it("näyttää päivän ja tehtävän numeron suomalaisittain", () => {
    expect(formatDay("2026-01-05")).toBe("5.1.2026");
    expect(formatDay(null)).toBe("");
    expect(formatTicketNumber(7)).toBe("0007");
    expect(formatTicketNumber(null)).toBe("----");
  });
});

describe("sähköpostivastauksen lainaus", () => {
  it("erottaa uuden tekstin lainatusta viestistä", () => {
    const result = splitQuotedReply("Kiitos, sopii!\n\nma 12.10.2026 klo 9.00 Isännöinti <a@example.com> kirjoitti:\n> Käykö torstai?\n> Terveisin");
    expect(result.text).toBe("Kiitos, sopii!");
    expect(result.quoted).toContain("> Käykö torstai?");
  });

  it("jättää lainaamattoman viestin ennalleen", () => {
    expect(splitQuotedReply("Hei, hana vuotaa.")).toEqual({ text: "Hei, hana vuotaa.", quoted: "" });
  });
});

describe("asukkaiden tuonti", () => {
  it("tunnistaa erottimen, lainausmerkit ja sarakkeet", () => {
    const table = parseCsv('﻿Nimi;Sähköposti;Osoite;Asunto\n"Meikäläinen; Matti";matti@example.com;Koivikkotie 10;A 12\n\nLiisa Mallikas;;Koivikkotie 10;B 34\n');
    const { rows, missing } = tableToResidents(table);
    expect(missing).toEqual([]);
    expect(rows).toEqual([
      { line: 2, name: "Meikäläinen; Matti", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12" },
      { line: 3, name: "Liisa Mallikas", email: "", address: "Koivikkotie 10", apartmentNumber: "B 34" }
    ]);
  });

  it("kertoo puuttuvat pakolliset sarakkeet", () => {
    expect(tableToResidents(parseCsv("Nimi,Sähköposti\nMatti,m@example.com")).missing).toEqual(["osoite", "asunto"]);
  });
});

describe("tiedoston lataus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hakee tiedoston ilman tunnistetta osoitteessa ja hylkää virhevastauksen", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response("ei oikeutta", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadFile("/attachments/a1", "ohje.pdf")).rejects.toThrow("ei oikeutta");
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/attachments\/a1$/);
  });
});
