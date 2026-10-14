// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error JavaScript-skripti ilman tyyppimäärittelyjä.
import { buildDarkCss, readDarkCss } from "../scripts/dark-theme.mjs";

describe("tumma tila", () => {
  it("styles-dark.css on ajan tasalla styles.css:n kanssa (aja npm run theme:dark)", () => {
    const { actual, expected } = readDarkCss();
    expect(actual).toBe(expected);
  });

  it("muuttaa vaaleat taustat tummiksi ja tummat tekstit vaaleiksi", () => {
    const css = buildDarkCss(".kortti { background: #fff; color: #1d2329; border: 1px solid #dfe3e7; }");
    const background = css.match(/background: #([0-9a-f]{6})/)![1];
    const text = css.match(/color: #([0-9a-f]{6})/)![1];
    const lightness = (hex: string) => [0, 2, 4].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0) / 765;
    expect(css).toContain(':root[data-theme="dark"] .kortti');
    expect(lightness(background)).toBeLessThan(0.3);
    expect(lightness(text)).toBeGreaterThan(0.7);
  });

  it("jättää tumman sivupalkin ennalleen", () => {
    expect(buildDarkCss(".sidebar { background: #171c22; color: white; }")).not.toContain(".sidebar");
  });
});
