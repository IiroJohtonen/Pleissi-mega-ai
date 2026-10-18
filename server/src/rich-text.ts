// ---------------------------------------------------------------------------------------------
// Dokumentin muotoiltu teksti. Muotoilu tallennetaan yksinkertaisena merkintäkielenä:
//   # Otsikko 1, ## Otsikko 2, ### Otsikko 3
//   **lihavointi**, *kursiivi*, __alleviivaus__
//   1. numeroitu kohta, - luettelomerkki (sisennys kaksi välilyöntiä tasoa kohden)
//   tyhjä rivi = kappaleenvaihto, rivinvaihto kappaleen sisällä = rivinvaihto
// Kenoviiva (\) ennen merkkiä tarkoittaa merkkiä itseään. Selain näyttää ja muokkaa samaa muotoa.
// AI ja haku käyttävät tekstiä ilman muotoilumerkkejä (markdownToPlain).
// ---------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

// Merkit, jotka tarkoittaisivat muotoilua, kirjoitetaan kenoviivan kanssa.
export function escapeInline(text: string) {
  return text.replace(/([\\*_])/g, "\\$1");
}

// Rivin alku, joka tulkittaisiin otsikoksi tai luetteloksi.
function escapeLineStart(line: string) {
  return line.replace(/^(\s*)(#|-\s|\d+)(\.\s)?/, (whole, space: string, mark: string, dot: string | undefined) => {
    if (mark === "#" || mark.startsWith("-")) return `${space}\\${mark}${dot ?? ""}`;
    return dot ? `${space}${mark}\\${dot}` : whole;
  });
}

const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "div", "blockquote"]);

// Word-dokumentin (mammoth) HTML muotoilluksi tekstiksi: otsikot, kappaleet, lihavoinnit ja luettelot säilyvät.
export function htmlToMarkdown(html: string) {
  const blocks: { text: string; item: boolean }[] = [];
  const lists: { ordered: boolean; count: number }[] = [];
  let current: { prefix: string; text: string } | null = null;
  let cellOpen = false;
  // Avatut muotoilut, joille ei vielä ole tekstiä: välilyönnit jäävät muotoilun ulkopuolelle ja tyhjä muotoilu pois.
  let pendingMarks = "";

  const flush = () => {
    pendingMarks = "";
    if (!current) return;
    const { prefix } = current;
    const text = current.text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
    if (text) {
      const lines = text.split("\n").map((line, index) => (index === 0 && !prefix ? escapeLineStart(line) : line));
      blocks.push({ text: `${prefix}${lines.join("\n")}`, item: /^\s*(\d+\.|-) $/.test(prefix) });
    }
    current = null;
  };
  const open = (prefix: string) => {
    flush();
    current = { prefix, text: "" };
  };
  const append = (text: string) => {
    if (!current) current = { prefix: "", text: "" };
    if (pendingMarks) {
      const [, space, rest] = text.match(/^(\s*)([\s\S]*)$/)!;
      if (!rest) {
        current.text += space;
        return;
      }
      current.text += `${space}${pendingMarks}`;
      pendingMarks = "";
      text = rest;
    }
    current.text += text;
  };
  const openMark = (mark: string) => {
    pendingMarks += mark;
  };
  const closeMark = (mark: string) => {
    if (pendingMarks.endsWith(mark)) {
      pendingMarks = pendingMarks.slice(0, -mark.length);
      return;
    }
    if (!current) return;
    const [, body, space] = current.text.match(/^([\s\S]*?)(\s*)$/)!;
    current.text = `${body}${mark}${space}`;
  };

  for (const match of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>|([^<]+)/gi)) {
    const [, closing, rawTag, , text] = match;
    if (text !== undefined) {
      append(escapeInline(decodeEntities(text).replace(/\s+/g, " ")));
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (!closing) {
      if (/^h[1-6]$/.test(tag)) open(`${"#".repeat(Math.min(Number(tag[1]), 3))} `);
      else if (tag === "ol" || tag === "ul") {
        flush();
        lists.push({ ordered: tag === "ol", count: 0 });
      } else if (tag === "li") {
        const list = lists[lists.length - 1];
        const depth = Math.max(lists.length - 1, 0);
        if (list) list.count += 1;
        open(`${"  ".repeat(depth)}${list?.ordered ? `${list.count}. ` : "- "}`);
      } else if (tag === "tr") open("");
      else if (tag === "td" || tag === "th") {
        if (cellOpen) append(" | ");
        cellOpen = true;
      } else if (BLOCK_TAGS.has(tag)) {
        // Luettelokohdan sisällä oleva kappale jatkaa samaa kohtaa.
        const insideItem = current && /^\s*(\d+\.|-) $/.test((current as { prefix: string }).prefix) && !(current as { text: string }).text.trim();
        if (!insideItem && !cellOpen) open("");
      } else if (tag === "br") append("\n");
      else if (tag === "strong" || tag === "b") openMark("**");
      else if (tag === "em" || tag === "i") openMark("*");
      else if (tag === "u") openMark("__");
    } else {
      if (tag === "strong" || tag === "b") closeMark("**");
      else if (tag === "em" || tag === "i") closeMark("*");
      else if (tag === "u") closeMark("__");
      else if (tag === "ol" || tag === "ul") {
        flush();
        lists.pop();
      } else if (tag === "tr") {
        flush();
        cellOpen = false;
      } else if (tag === "td" || tag === "th") continue;
      else if (BLOCK_TAGS.has(tag) && !cellOpen) flush();
    }
  }
  flush();
  // Saman luettelon kohdat ovat peräkkäisillä riveillä.
  return blocks.map((block, index) => (index === 0 ? "" : block.item && blocks[index - 1].item ? "\n" : "\n\n") + block.text).join("");
}

const BULLET = /^[•▪●◦·\-–*]\s+/;
const NUMBERED_HEADING = /^(\d+(\.\d+)*\.?|[IVX]+\.|§\s*\d+)\s+\S/;

// Näyttääkö PDF:n rivi otsikolta: lyhyt rivi, joka on numeroitu tai kokonaan isoilla kirjaimilla eikä pääty virkkeeseen.
function looksLikeHeading(line: string) {
  if (line.length > 80 || /[.,;:]$/.test(line)) return false;
  if (NUMBERED_HEADING.test(line) && /[A-ZÅÄÖa-zåäö]/.test(line)) return /^\S+\s+[A-ZÅÄÖ§]/.test(line);
  const letters = line.replace(/[^A-Za-zÅÄÖåäö]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
}

// Luettu teksti (PDF, kuva, tekstitiedosto) muotoilluksi tekstiksi: otsikot erottuvat, luettelot
// säilyvät ja katkenneet rivit yhdistetään kappaleiksi. Rivien sisältö pysyy ennallaan.
export function plainToMarkdown(text: string) {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  const blocks: string[] = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n").map(line => line.trim()).filter(Boolean);
    let buffer: string[] = [];
    const flush = () => {
      if (buffer.length) blocks.push(buffer.join("\n"));
      buffer = [];
    };
    for (const line of lines) {
      if (looksLikeHeading(line)) {
        flush();
        blocks.push(`## ${escapeInline(line)}`);
        continue;
      }
      if (BULLET.test(line)) {
        flush();
        blocks.push(`- ${escapeInline(line.replace(BULLET, ""))}`);
        continue;
      }
      const previous = buffer[buffer.length - 1];
      // Katkennut rivi jatkuu pienellä kirjaimella alkavalla rivillä.
      if (previous !== undefined && !/[.!?:]$/.test(previous) && /^[a-zåäö(]/.test(line)) {
        buffer[buffer.length - 1] = `${previous} ${escapeInline(line)}`;
      } else {
        buffer.push(escapeLineStart(escapeInline(line)));
      }
    }
    flush();
  }
  // Peräkkäiset luettelokohdat ovat samaa luetteloa.
  return blocks.join("\n\n").replace(/^(- .*)\n\n(?=- )/gm, "$1\n");
}

// Muotoiltu teksti ilman muotoilumerkkejä. Luettelon numerot ja merkit jäävät, jotta rakenne säilyy.
export function markdownToPlain(markdown: string) {
  return markdown
    .split("\n")
    .map(line => line.replace(/^#{1,3}\s+/, "").replace(/^(\s*)\\(?=[#-])/, "$1"))
    .join("\n")
    .replace(/(?<!\\)(\*\*|__|\*)/g, "")
    .replace(/\\([\\*_.#-])/g, "$1")
    .trim();
}
