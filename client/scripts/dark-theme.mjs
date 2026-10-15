/* global console, process */
// Tuottaa tumman tilan tyylit (src/styles-dark.css) tiedostosta src/styles.css.
//
// Jokainen väriarvo muunnetaan sen käytön mukaan: vaalea tausta muuttuu tummaksi siniharmaaksi, tumma
// teksti vaaleaksi ja vaalea reuna tummaksi. Värikkäät sävyt (prioriteetit, tilat) säilyttävät
// sävynsä mutta tummuvat tai vaalenevat. Sovelluksen kehys (sivupalkki, kirjautumissivu ja
// asukasportaalin yläpalkki) on jo valmiiksi tumma, joten sen säännöt jätetään ennalleen. Muut tummat
// elementit, kuten päätoimintopainikkeet, käännetään vaaleiksi, jotta ne erottuvat tummalta pohjalta.
//
// Aja komennolla `npm run theme:dark`, kun styles.css muuttuu. Testi tarkistaa, että tiedosto on ajan tasalla.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, "../src/styles.css");
const TARGET = path.join(here, "../src/styles-dark.css");
const PREFIX = ':root[data-theme="dark"]';

// Valmiiksi tumma kehys: näiden sääntöjen värit pysyvät samoina.
const CHROME = /(^|[\s,>+~])(\.sidebar|nav\b|\.nav-company|\.settings-button|\.login-page|\.login-card|\.portal-header|\.portal-nav-|\.nav-pin|\.nav-company-name|\.topbar(?!-dropdown)|\.portal-footer|\.mobile-bar|\.mobile-menu|\.report-tooltip)/;

// Tumman tilan perussävy: sininen, kevyesti kylläinen.
const HUE = 214;
const NEUTRAL_SAT = 0.24;

const NAMED = { white: "#ffffff", black: "#000000" };
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;

function parse(token) {
  const named = NAMED[token.toLowerCase()];
  if (named) token = named;
  if (token.startsWith("#")) {
    let h = token.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split("").map(c => c + c).join("");
    const rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { rgb, alpha };
  }
  const parts = token.match(/[\d.]+%?/g).map(Number.parseFloat);
  return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
}

function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
}

function format(rgb, alpha) {
  if (alpha < 1) return `rgba(${rgb.join(", ")}, ${Number(alpha.toFixed(3))})`;
  return "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("");
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// role: "bg" (tausta), "text" (teksti), "border" (reuna ja viiva). invert: säännön tumma tausta
// käännetään vaaleaksi, joten sen vaalea teksti tummennetaan.
function convert(token, role, invert) {
  const { rgb, alpha } = parse(token);
  // Läpikuultavat varjot ja tummennukset toimivat sellaisenaan.
  if (alpha < 0.6 && role !== "text") return token;
  const [h, s, l] = toHsl(rgb);
  const colorful = s > 0.22 && l > 0.08 && l < 0.97;
  let out;
  if (role === "bg") {
    if (colorful && l > 0.72) out = fromHsl(h, Math.min(s, 0.22), 0.215 + (1 - l) * 0.35);
    else if (colorful) out = l < 0.3 ? fromHsl(HUE, 0.18, 0.86) : rgb;
    else if (l < 0.35) out = fromHsl(HUE, 0.16, 0.86);
    else out = fromHsl(HUE, NEUTRAL_SAT, Math.max(0.11, 0.205 - (1 - l) * 0.9));
  } else if (role === "text") {
    if (colorful && l < 0.75) out = fromHsl(h, Math.min(s, 0.72), clamp(0.74 + (0.45 - l) * 0.15, 0.64, 0.82));
    else if (colorful) out = invert ? fromHsl(h, Math.min(s, 0.6), 0.3) : rgb;
    // Harmaat sävyt pidetään selvästi luettavina: himmeinkin teksti jää kontrastiltaan yli 4,5:1.
    else if (l < 0.6) out = fromHsl(HUE, 0.14, 0.95 - l * 0.42);
    else out = invert ? fromHsl(HUE, 0.3, 0.14) : rgb;
  } else {
    if (colorful && l > 0.6) out = fromHsl(h, Math.min(s, 0.3), 0.34);
    else if (colorful) out = rgb;
    else if (l > 0.55) out = fromHsl(HUE, 0.2, Math.max(0.2, 0.31 - (1 - l) * 0.35));
    else out = invert ? fromHsl(HUE, 0.16, 0.7) : fromHsl(HUE, 0.16, 0.42);
  }
  return format(out, alpha);
}

function roleOf(prop) {
  // Värimuuttujat: nimessä "soft" tai "bg" = tausta, muuten korostusväri, jota käytetään tekstinä.
  if (prop.startsWith("--")) return /soft|bg|background/.test(prop) ? "bg" : "text";
  if (/^(color|fill|caret-color|-webkit-text-fill-color|text-decoration-color)$/.test(prop)) return "text";
  if (/^(background|background-color|background-image)$/.test(prop)) return "bg";
  if (/^(border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|stroke|column-rule)$/.test(prop)) return "border";
  if (prop === "box-shadow") return "border";
  return null;
}

// Kääntyykö säännön tumma tausta vaaleaksi (silloin myös sen vaalea teksti tummennetaan).
function invertsBackground(rule) {
  let inverts = false;
  rule.walkDecls(/^background(-color)?$/, decl => {
    for (const token of decl.value.match(COLOR) ?? []) {
      const { rgb, alpha } = parse(token);
      const [, s, l] = toHsl(rgb);
      if (alpha >= 0.6 && l < 0.35 && s <= 0.22) inverts = true;
    }
  });
  return inverts;
}

// Palauttaa tumman tilan tyylit annetusta styles.css-sisällöstä.
export function buildDarkCss(source) {
const root = postcss.parse(source);
const out = postcss.root();

root.walkRules(rule => {
  if (rule.parent.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
  if (CHROME.test(rule.selector)) return;
  const invert = invertsBackground(rule);
  const decls = [];
  rule.each(node => {
    if (node.type !== "decl") return;
    const role = roleOf(node.prop);
    if (!role || !COLOR.test(node.value)) { COLOR.lastIndex = 0; return; }
    COLOR.lastIndex = 0;
    const value = node.value.replace(COLOR, token => convert(token, role, invert));
    if (value !== node.value) decls.push(postcss.decl({ prop: node.prop, value, important: node.important }));
  });
  if (decls.length === 0) return;
  const selector = rule.selectors
    .map(sel => sel.trim() === ":root" ? PREFIX : `${PREFIX} ${sel.trim()}`)
    .join(",\n");
  const copy = postcss.rule({ selector });
  decls.forEach(d => copy.append(d));
  // Mediakyselyn sisällä oleva sääntö pysyy saman kyselyn sisällä.
  let container = out;
  if (rule.parent.type === "atrule") {
    const params = rule.parent.params;
    container = out.nodes.find(n => n.type === "atrule" && n.name === rule.parent.name && n.params === params && n === out.last)
      ?? out.append(postcss.atRule({ name: rule.parent.name, params })).last;
  }
  container.append(copy);
});

const header = `/* Tumma tila. Tiedosto tuotetaan komennolla \`npm run theme:dark\` tiedostosta styles.css – älä muokkaa käsin.
   Käsin säädetyt tummat tyylit ovat tiedostossa styles-dark-overrides.css. */\n\n`;
return header + out.toString() + "\n";
}

// Testiä varten: levyllä oleva tiedosto ja se, millainen sen pitäisi olla.
export function readDarkCss() {
  return { actual: fs.readFileSync(TARGET, "utf8"), expected: buildDarkCss(fs.readFileSync(SOURCE, "utf8")) };
}

// Komentoriviltä ajettaessa tiedosto kirjoitetaan levylle.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const css = buildDarkCss(fs.readFileSync(SOURCE, "utf8"));
  fs.writeFileSync(TARGET, css);
  console.log(`Tumma tila kirjoitettu tiedostoon ${path.relative(process.cwd(), TARGET)}`);
}
