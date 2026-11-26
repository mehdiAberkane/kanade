// Colours for the Appearance page (KAN-44): contrast as WCAG measures it,
// and the variant of a colour that keeps text readable on each theme.

export type Rgb = readonly [number, number, number];

const HEX = /^#[0-9a-f]{6}$/i;

export function isHex(value: string): boolean {
  return HEX.test(value);
}

export function parseHex(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance, from 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, from 1 to 21. AA asks 4.5 for text, 3 for outlines. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** `amount` (0 to 1) of `a` in `b`, as CSS `color-mix(in srgb, a x%, b)`. */
export function mix(a: string, b: string, amount: number): string {
  const [ca, cb] = [parseHex(a), parseHex(b)];
  const at = (i: 0 | 1 | 2) => ca[i] * amount + cb[i] * (1 - amount);
  return toHex([at(0), at(1), at(2)]);
}

/**
 * `hex`, darkened (toward black) or lightened (toward white) just enough to
 * reach `ratio` against `surface`; unchanged when it already does.
 */
export function readableOn(hex: string, surface: string, ratio: number): string {
  if (contrast(hex, surface) >= ratio) return hex;
  const toward = luminance(surface) > 0.5 ? "#000000" : "#ffffff";
  for (let step = 1; step <= 50; step++) {
    const candidate = mix(toward, hex, step / 50);
    if (contrast(candidate, surface) >= ratio) return candidate;
  }
  return toward;
}
