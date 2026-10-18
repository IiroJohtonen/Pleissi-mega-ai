import { type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { t } from "../i18n";

// ---------------------------------------------------------------------------------------------
// Dokumentin muotoiltu teksti (sama merkintätapa kuin palvelimen rich-text.ts):
//   # / ## / ### otsikot, **lihavointi**, *kursiivi*, __alleviivaus__,
//   1. numeroitu kohta, - luettelomerkki (kaksi välilyöntiä sisentää tason), tyhjä rivi = uusi kappale.
// RichText näyttää tekstin, RichTextEditor muokkaa sitä Wordin tapaan.
// ---------------------------------------------------------------------------------------------

type Marks = { bold?: boolean; italic?: boolean; underline?: boolean };
type Segment = Marks & { text: string };
type ListItem = { segments: Segment[]; children: ListBlock[] };
type ListBlock = { type: "list"; ordered: boolean; start: number; items: ListItem[] };
type Block =
  | { type: "heading"; level: 1 | 2 | 3; segments: Segment[] }
  | { type: "paragraph"; segments: Segment[] }
  | ListBlock;

const MARKS: [string, keyof Marks][] = [["**", "bold"], ["__", "underline"], ["*", "italic"]];

export function parseInline(text: string): Segment[] {
  const segments: Segment[] = [];
  const marks: Marks = {};
  let buffer = "";
  const push = () => {
    if (buffer) segments.push({ text: buffer, ...marks });
    buffer = "";
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      buffer += text[++index];
      continue;
    }
    const mark = MARKS.find(([token]) => text.startsWith(token, index));
    if (mark) {
      push();
      marks[mark[1]] = !marks[mark[1]];
      index += mark[0].length - 1;
      continue;
    }
    buffer += char;
  }
  push();
  return segments;
}

const LIST_ITEM = /^( *)(?:(\d+)\.|-)\s+(.*)$/;

export function parseRichText(text: string): Block[] {
  const blocks: Block[] = [];
  // Avoimet luettelot sisennystasoittain.
  let lists: ListBlock[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", segments: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) {
      endParagraph();
      lists = [];
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      endParagraph();
      lists = [];
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, segments: parseInline(heading[2]) });
      continue;
    }
    const item = line.match(LIST_ITEM);
    if (item) {
      endParagraph();
      const ordered = item[2] !== undefined;
      const depth = Math.min(Math.floor(item[1].length / 2), lists.length);
      lists = lists.slice(0, depth + 1);
      let list = lists[depth];
      if (!list || list.ordered !== ordered) {
        list = { type: "list", ordered, start: ordered ? Number(item[2]) : 1, items: [] };
        const parent = lists[depth - 1];
        if (depth > 0 && parent?.items.length) parent.items[parent.items.length - 1].children.push(list);
        else blocks.push(list);
        lists[depth] = list;
      }
      list.items.push({ segments: parseInline(item[3]), children: [] });
      continue;
    }
    if (lists.length) lists = [];
    paragraph.push(line);
  }
  endParagraph();
  return blocks;
}

// --- Näyttö --------------------------------------------------------------------------------------

function renderSegments(segments: Segment[]) {
  return segments.map((segment, index) => {
    let node: ReactNode = segment.text.includes("\n")
      ? segment.text.split("\n").flatMap((part, line) => (line ? [<br key={line} />, part] : [part]))
      : segment.text;
    if (segment.underline) node = <u>{node}</u>;
    if (segment.italic) node = <em>{node}</em>;
    if (segment.bold) node = <strong>{node}</strong>;
    return <span key={index}>{node}</span>;
  });
}

function renderList(list: ListBlock, key: number) {
  const items = list.items.map((item, index) => (
    <li key={index}>{renderSegments(item.segments)}{item.children.map(renderList)}</li>
  ));
  return list.ordered
    ? <ol key={key} start={list.start} style={list.start !== 1 ? { counterReset: `rt-item ${list.start - 1}` } : undefined}>{items}</ol>
    : <ul key={key}>{items}</ul>;
}

export function RichText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`rich-text${className ? ` ${className}` : ""}`}>
      {parseRichText(text).map((block, index) => {
        if (block.type === "list") return renderList(block, index);
        if (block.type === "heading") {
          const Heading = `h${block.level + 1}` as "h2" | "h3" | "h4";
          return <Heading key={index} className={`rt-h${block.level}`}>{renderSegments(block.segments)}</Heading>;
        }
        return <p key={index}>{renderSegments(block.segments)}</p>;
      })}
    </div>
  );
}

// --- Muokkain: muotoiltu teksti HTML:ksi ja takaisin -----------------------------------------

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function segmentsToHtml(segments: Segment[]) {
  return segments.map(segment => {
    let html = escapeHtml(segment.text).replace(/\n/g, "<br>");
    if (segment.underline) html = `<u>${html}</u>`;
    if (segment.italic) html = `<i>${html}</i>`;
    if (segment.bold) html = `<b>${html}</b>`;
    return html;
  }).join("");
}

function listToHtml(list: ListBlock): string {
  const items = list.items.map(item => `<li>${segmentsToHtml(item.segments) || "<br>"}${item.children.map(listToHtml).join("")}</li>`).join("");
  return list.ordered
    ? `<ol${list.start !== 1 ? ` start="${list.start}" style="counter-reset: rt-item ${list.start - 1}"` : ""}>${items}</ol>`
    : `<ul>${items}</ul>`;
}

export function richTextToHtml(text: string) {
  const html = parseRichText(text).map(block => {
    if (block.type === "list") return listToHtml(block);
    if (block.type === "heading") return `<h${block.level}>${segmentsToHtml(block.segments)}</h${block.level}>`;
    return `<p>${segmentsToHtml(block.segments)}</p>`;
  }).join("");
  return html || "<p><br></p>";
}

const escapeInline = (text: string) => text.replace(/([\\*_])/g, "\\$1");
// Kappaleen rivi, joka alkaisi otsikko- tai luettelomerkillä, kirjoitetaan kenoviivan kanssa.
const escapeLineStart = (line: string) =>
  line.replace(/^(\s*)(#|-(?=\s))/, "$1\\$2").replace(/^(\s*\d+)\.(?=\s)/, "$1\\.");

const BLOCK = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "OL", "UL", "LI", "BLOCKQUOTE", "TABLE", "TR", "SECTION", "ARTICLE"]);

function elementMarks(element: HTMLElement): Marks {
  const tag = element.tagName;
  const weight = element.style?.fontWeight;
  return {
    bold: tag === "B" || tag === "STRONG" || weight === "bold" || Number(weight) >= 600,
    italic: tag === "I" || tag === "EM" || element.style?.fontStyle === "italic",
    underline: tag === "U" || Boolean(element.style?.textDecoration?.includes("underline"))
  };
}

// Tekstin muotoilu: sama muotoilu ei toistu sisäkkäin, ja välilyönnit jäävät merkkien ulkopuolelle.
function inlineText(node: Node, active: Marks = {}): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeInline((node.textContent ?? "").replace(/[\s\u00a0]+/g, " "));
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as HTMLElement;
  if (element.tagName === "BR") return "\n";
  if (["OL", "UL", "STYLE", "SCRIPT"].includes(element.tagName)) return "";
  const marks = elementMarks(element);
  const added = (Object.keys(marks) as (keyof Marks)[]).filter(mark => marks[mark] && !active[mark]);
  const next = { ...active, ...Object.fromEntries(added.map(mark => [mark, true])) };
  let inner = [...element.childNodes].map(child => inlineText(child, next)).join("");
  if (BLOCK.has(element.tagName) && inner && !inner.endsWith("\n")) inner += "\n";
  if (!added.length || !inner.trim()) return inner;
  const [, before, body, after] = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  const tokens = added.map(mark => MARKS.find(([, name]) => name === mark)![0]);
  return `${before}${tokens.join("")}${body}${[...tokens].reverse().join("")}${after}`;
}

const cleanLines = (text: string) => text.split("\n").map(line => line.replace(/ +/g, " ").trim()).filter(Boolean);

function listLines(list: HTMLElement, depth: number): string[] {
  const ordered = list.tagName === "OL";
  let number = ordered ? Number(list.getAttribute("start") || 1) : 1;
  const lines: string[] = [];
  for (const child of [...list.children] as HTMLElement[]) {
    if (child.tagName === "OL" || child.tagName === "UL") {
      lines.push(...listLines(child, depth + 1));
      continue;
    }
    const text = cleanLines(inlineText(child)).join(" ");
    lines.push(`${"  ".repeat(depth)}${ordered ? `${number}.` : "-"} ${text}`);
    number += 1;
    for (const nested of [...child.children] as HTMLElement[]) {
      if (nested.tagName === "OL" || nested.tagName === "UL") lines.push(...listLines(nested, depth + 1));
    }
  }
  return lines;
}

// Muokkaimen (tai liitetyn Word-tekstin) sisältö muotoilluksi tekstiksi.
export function htmlToRichText(root: Node): string {
  const blocks: string[] = [];
  let loose = "";
  const paragraph = (text: string) => {
    const lines = cleanLines(text).map(escapeLineStart);
    if (lines.length) blocks.push(lines.join("\n"));
  };
  const flushLoose = () => {
    paragraph(loose);
    loose = "";
  };
  const visit = (parent: Node) => {
    for (const node of [...parent.childNodes]) {
      const element = node as HTMLElement;
      if (node.nodeType !== Node.ELEMENT_NODE || !BLOCK.has(element.tagName)) {
        loose += inlineText(node);
        continue;
      }
      flushLoose();
      const tag = element.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const text = cleanLines(inlineText(element)).join(" ");
        if (text) blocks.push(`${"#".repeat(Math.min(Number(tag[1]), 3))} ${text}`);
      } else if (tag === "OL" || tag === "UL") {
        const lines = listLines(element, 0);
        if (lines.length) blocks.push(lines.join("\n"));
      } else if ([...element.children].some(child => BLOCK.has(child.tagName))) {
        visit(element);
        flushLoose();
      } else {
        paragraph(inlineText(element));
      }
    }
  };
  visit(root);
  flushLoose();
  return blocks.join("\n\n");
}

// --- Muokkain -------------------------------------------------------------------------------------

export type RichTextEditorHandle = { value: () => string };

type Style = "p" | "h1" | "h2" | "h3";

const STYLE_LABELS: Record<Style, string> = {
  p: "Leipäteksti",
  h1: "Otsikko 1",
  h2: "Otsikko 2",
  h3: "Otsikko 3"
};

// execCommand on vanhentunut, mutta kaikki selaimet tukevat sitä edelleen, ja se säilyttää kumoamishistorian.
const exec = (command: string, value?: string) => document.execCommand(command, false, value);

export function RichTextEditor({ initial, ref, onDirty }: {
  initial: string;
  ref?: Ref<RichTextEditorHandle>;
  onDirty?: () => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ bold: false, italic: false, underline: false, ordered: false, bullets: false, style: "p" as Style });

  useImperativeHandle(ref, () => ({ value: () => (editor.current ? htmlToRichText(editor.current) : initial) }), [initial]);

  useEffect(() => {
    if (!editor.current) return;
    editor.current.innerHTML = richTextToHtml(initial);
    exec("defaultParagraphSeparator", "p");
  }, [initial]);

  // Työkalurivi näyttää kohdistimen kohdan muotoilun.
  useEffect(() => {
    const update = () => {
      const selection = document.getSelection();
      if (!editor.current || !selection?.anchorNode || !editor.current.contains(selection.anchorNode)) return;
      const block = String(document.queryCommandValue("formatBlock")).toLowerCase().replace(/[<>]/g, "");
      setState({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        ordered: document.queryCommandState("insertOrderedList"),
        bullets: document.queryCommandState("insertUnorderedList"),
        style: (["h1", "h2", "h3"].includes(block) ? block : "p") as Style
      });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const run = (command: string, value?: string) => {
    editor.current?.focus();
    exec(command, value);
    onDirty?.();
    document.dispatchEvent(new Event("selectionchange"));
  };

  // Liitetty teksti (esim. Wordista) säilyttää otsikot, lihavoinnit ja luettelot, mutta ei muuta muotoilua.
  function paste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const html = event.clipboardData.getData("text/html");
    if (html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      exec("insertHTML", richTextToHtml(htmlToRichText(doc.body)));
    } else {
      exec("insertText", event.clipboardData.getData("text/plain"));
    }
    onDirty?.();
  }

  // Sarkain sisentää luettelon kohdan (Shift+Sarkain palauttaa), kuten Wordissa.
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab" && (state.ordered || state.bullets)) {
      event.preventDefault();
      run(event.shiftKey ? "outdent" : "indent");
    }
  }

  const button = (label: ReactNode, title: string, command: string, active?: boolean, value?: string) => (
    <button
      type="button"
      className={active ? "active" : ""}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={event => event.preventDefault()}
      onClick={() => run(command, value)}
    >
      {label}
    </button>
  );

  return (
    <div className="rich-editor">
      <div className="rich-toolbar" role="toolbar" aria-label={t("Tekstin muotoilu")}>
        <select
          value={state.style}
          aria-label={t("Kappaletyyli")}
          onChange={event => run("formatBlock", `<${event.target.value}>`)}
        >
          {(Object.keys(STYLE_LABELS) as Style[]).map(style => <option key={style} value={style}>{t(STYLE_LABELS[style])}</option>)}
        </select>
        <span className="rich-toolbar-group">
          {button(<b>B</b>, t("Lihavointi (Ctrl+B)"), "bold", state.bold)}
          {button(<i>K</i>, t("Kursiivi (Ctrl+I)"), "italic", state.italic)}
          {button(<u>A</u>, t("Alleviivaus (Ctrl+U)"), "underline", state.underline)}
        </span>
        <span className="rich-toolbar-group">
          {button("1.", t("Numeroitu luettelo"), "insertOrderedList", state.ordered)}
          {button("•", t("Luettelomerkit"), "insertUnorderedList", state.bullets)}
          {button("⇤", t("Vähennä sisennystä (Shift+Sarkain)"), "outdent")}
          {button("⇥", t("Lisää sisennystä (Sarkain)"), "indent")}
        </span>
        <span className="rich-toolbar-group">
          {button("↶", t("Kumoa (Ctrl+Z)"), "undo")}
          {button("↷", t("Tee uudelleen (Ctrl+Y)"), "redo")}
        </span>
      </div>
      <div
        ref={editor}
        className="rich-text rich-page"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={t("Dokumentin teksti")}
        spellCheck
        onInput={() => onDirty?.()}
        onPaste={paste}
        onKeyDown={keyDown}
      />
    </div>
  );
}
