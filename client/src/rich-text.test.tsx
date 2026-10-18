import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { htmlToRichText, parseRichText, RichText, richTextToHtml } from "./components/RichText";

const DOCUMENT = [
  "# Järjestyssäännöt",
  "Nämä **säännöt** koskevat *kaikkia* asukkaita ja __vieraita__.\nToinen rivi.",
  "## 1. Yleistä",
  "1. Piha pidetään siistinä\n  1. Roskat viedään astioihin\n  2. Pyörät telineisiin\n2. Hiljaisuus klo 22–7",
  "- Pallo\n- Maila",
  "Hinta 5 \\* 2 ja 1. ei ole luettelo\n1\\. tämäkään ei ole"
].join("\n\n");

const toDom = (html: string) => {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};

afterEach(cleanup);

describe("dokumentin muotoiltu teksti", () => {
  it("säilyy ennallaan muokkaimen kautta", () => {
    expect(htmlToRichText(toDom(richTextToHtml(DOCUMENT)))).toBe(DOCUMENT);
  });

  it("näyttää otsikot, lihavoinnit ja sisäkkäiset numeroidut kohdat", () => {
    const { container } = render(<RichText text={DOCUMENT} />);
    expect(container.querySelector(".rt-h1")?.textContent).toBe("Järjestyssäännöt");
    expect(container.querySelector("strong")?.textContent).toBe("säännöt");
    expect(container.querySelector("em")?.textContent).toBe("kaikkia");
    expect(container.querySelector("u")?.textContent).toBe("vieraita");
    expect(container.querySelectorAll("ol > li > ol > li")).toHaveLength(2);
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.textContent).toContain("Hinta 5 * 2 ja 1. ei ole luettelo");
  });

  it("aloittaa numeroinnin dokumentin numerosta", () => {
    const [list] = parseRichText("3. Kolmas\n4. Neljäs");
    expect(list).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  it("ottaa liitetystä Word-tekstistä vain otsikot, muotoilut ja luettelot", () => {
    const pasted = toDom(
      `<style>p { color: red }</style><h2 style="color:blue">Otsikko</h2><p class="MsoNormal"><span style="font-weight:700">Tärkeä</span> teksti<o:p></o:p></p>` +
      `<ol><li>Eka</li><ol><li>Sisennetty</li></ol><li>Toka</li></ol><div><p>- ei luettelo</p></div>`
    );
    expect(htmlToRichText(pasted)).toBe("## Otsikko\n\n**Tärkeä** teksti\n\n1. Eka\n  1. Sisennetty\n2. Toka\n\n\\- ei luettelo");
  });

  it("muokkaimen HTML ei suorita tekstin sisältöä", () => {
    expect(richTextToHtml("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  });
});
