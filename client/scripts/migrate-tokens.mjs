/* global console, process */
// Kertaluonteinen siirto: styles.css:n harmaat sävyt, fonttikoot ja pyöristykset muuttujiksi (DESIGN.md).
// Värilliset sävyt (tilat, prioriteetit) ja tumma kehys (sivupalkki, yläpalkki, kirjautuminen) jätetään ennalleen.
// Käyttö: node scripts/migrate-tokens.mjs [--write]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, "../src/styles.css");
const write = process.argv.includes("--write");

const CHROME = /(^|[\s,>+~])(\.sidebar|nav\b|\.nav-|\.settings-button|\.login-page|\.login-card|\.portal-header|\.portal-nav|\.topbar(?!-dropdown)|\.portal-footer|\.mobile-bar|\.mobile-menu|\.report-tooltip|\.board-header|\.user-avatar)/;
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;

function parse(token) {
  if (/^white$/i.test(token)) token = "#ffffff";
  if (/^black$/i.test(token)) token = "#000000";
  if (token.startsWith("#")) {
    let h = token.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split("").map(c => c + c).join("");
    return { rgb: [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)), alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  const parts = token.match(/[\d.]+%?/g).map(Number.parseFloat);
  return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
}
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, l];
  const d = max - min;
  return [l > 0.5 ? d / (2 - max - min) : d / (max + min), l];
}

// Harmaa sävy muuttujaksi käyttötarkoituksen mukaan; null = jätetään ennalleen.
function tokenFor(token, role) {
  const { rgb, alpha } = parse(token);
  if (alpha < 1) return null;
  const [s, l] = hsl(rgb);
  if (s > 0.16 && l > 0.08 && l < 0.97) return null;
  if (role === "bg") {
    if (l >= 0.985) return "var(--surface)";
    if (l >= 0.955) return "var(--surface-2)";
    return null;
  }
  if (role === "border") {
    if (l >= 0.86 && l < 0.95) return "var(--line)";
    if (l >= 0.76 && l < 0.86) return "var(--line-strong)";
    return null;
  }
  if (role === "text") {
    if (l < 0.22) return "var(--ink)";
    if (l < 0.42) return "var(--ink-2)";
    if (l < 0.62) return "var(--ink-3)";
    return null;
  }
  return null;
}
function roleOf(prop) {
  if (/^(color|fill|caret-color)$/.test(prop)) return "text";
  if (/^(background|background-color)$/.test(prop)) return "bg";
  if (/^(border|border-(top|right|bottom|left)(-color)?|border-color|outline-color)$/.test(prop)) return "border";
  return null;
}
function sizeToken(px) {
  if (px <= 12.5) return "var(--text-xs)";
  if (px <= 13.5) return "var(--text-sm)";
  if (px <= 14.5) return "var(--text-md)";
  if (px <= 17) return "var(--text-lg)";
  if (px <= 21) return "var(--text-xl)";
  if (px <= 30) return "var(--text-2xl)";
  return null;
}
const ROUND = /avatar|switch|toggle|dot|spinner|radio|knob|slider|count|progress|-pin|pager-dot|\bb\b|> b|badge-count/;
function radiusToken(value, selector) {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)px$/);
  if (!m) return null;
  const px = Number(m[1]);
  if (px >= 50) return ROUND.test(selector) ? null : "var(--radius-sm)";
  if (px <= 5) return "var(--radius-sm)";
  if (px <= 9) return "var(--radius-md)";
  return "var(--radius-lg)";
}

const source = fs.readFileSync(FILE, "utf8");
const root = postcss.parse(source);
const stats = { color: 0, size: 0, radius: 0, upper: 0 };
root.walkRules(rule => {
  if (rule.parent.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
  if (rule.selector.startsWith(":root")) return;
  const chrome = CHROME.test(rule.selector);
  rule.walkDecls(decl => {
    const role = roleOf(decl.prop);
    if (role && !chrome) {
      const next = decl.value.replace(COLOR, token => tokenFor(token, role) ?? token);
      if (next !== decl.value) { decl.value = next; stats.color++; }
    }
    if (decl.prop === "font-size") {
      const m = decl.value.match(/^(\d+(?:\.\d+)?)px$/);
      const token = m && sizeToken(Number(m[1]));
      if (token) { decl.value = token; stats.size++; }
    }
    if (decl.prop === "border-radius") {
      const token = radiusToken(decl.value, rule.selector);
      if (token) { decl.value = token; stats.radius++; }
    }
    // Isot kirjaimet ja harvennus pois: tavallinen kirjoitusasu (DESIGN.md).
    if (decl.prop === "text-transform" && decl.value === "uppercase") { decl.value = "none"; stats.upper++; }
    const spacing = decl.prop === "letter-spacing" && decl.value.match(/^(\.\d+|\d+(?:\.\d+)?)em$/);
    if (spacing && Number(spacing[1]) >= 0.03) { decl.value = "normal"; stats.upper++; }
  });
});
const out = root.toString();
const count = re => new Set(out.match(re) ?? []).size;
console.log(stats, "hex jäljellä:", count(/#[0-9a-fA-F]{3,8}\b/g), "fonttikokoja:", count(/font-size:\s*[^;]+/g), "pyöristyksiä:", count(/border-radius:\s*[^;]+/g));
if (write) fs.writeFileSync(FILE, out);
