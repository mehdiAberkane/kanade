import { describe, expect, it } from "vitest";
import { contrast, isHex, luminance, mix, parseHex, readableOn, toHex } from "./color";

describe("colours", () => {
  it("reads and writes #rrggbb", () => {
    expect(parseHex("#7c3aed")).toEqual([124, 58, 237]);
    expect(toHex([124, 58, 237])).toBe("#7c3aed");
    expect(toHex([0.4, 254.6, 15])).toBe("#00ff0f");
    expect(isHex("#A78BFA")).toBe(true);
    for (const odd of ["a78bfa", "#a78bf", "#a78bfa0", "#g78bfa", ""])
      expect(isHex(odd)).toBe(false);
  });

  it("measures luminance and contrast as WCAG does", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21);
    expect(contrast("#777777", "#777777")).toBe(1);
    // The reference pair: #767676 on white is the lightest grey at 4.5:1.
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("mixes as CSS color-mix in srgb", () => {
    expect(mix("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(mix("#7c3aed", "#ffffff", 1)).toBe("#7c3aed");
    expect(mix("#7c3aed", "#ffffff", 0)).toBe("#ffffff");
  });

  it("keeps a readable colour, and darkens or lightens one that is not", () => {
    expect(readableOn("#7c3aed", "#ffffff", 4.5)).toBe("#7c3aed");
    const yellow = readableOn("#ffff00", "#ffffff", 4.5);
    expect(contrast(yellow, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(luminance(yellow)).toBeLessThan(luminance("#ffff00"));
    const navy = readableOn("#1e3a8a", "#282828", 4.5);
    expect(contrast(navy, "#282828")).toBeGreaterThanOrEqual(4.5);
    expect(luminance(navy)).toBeGreaterThan(luminance("#1e3a8a"));
    // Out of reach on a mid grey: the furthest it can go.
    expect(readableOn("#808080", "#808080", 21)).toBe("#ffffff");
  });
});
