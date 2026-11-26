// How Kanade looks (KAN-44), without the page: the settings the Appearance
// page changes, the choices it offers, and how they apply to <html> (data-*
// attributes and CSS variables that App.css reads). Kept by the Rust side
// (`library/appearance.rs`), which knows the same lists.
import { mix, readableOn } from "./color";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";
export type FontChoice = "segoe" | "georgia" | "atkinson" | "nunito";
export type NeonSpeed = "slow" | "medium" | "fast";

export interface Neon {
  enabled: boolean;
  /** `#rrggbb`, or empty for the main colour. */
  color: string;
  speed: NeonSpeed;
}

export interface Appearance {
  theme: ThemeChoice;
  /** `#rrggbb`: one of ACCENTS' `light`, or a colour of the user's. */
  accent: string;
  font: FontChoice;
  compact: boolean;
  highContrast: boolean;
  reduceMotion: boolean;
  /** The veil over the background image, 0 to 90 %. */
  backgroundDim: number;
  neon: Neon;
  /** In percent, one of ZOOM_LEVELS. */
  zoom: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "system",
  accent: "#7c3aed",
  font: "segoe",
  compact: false,
  highContrast: false,
  reduceMotion: false,
  backgroundDim: 40,
  neon: { enabled: false, color: "", speed: "medium" },
  zoom: 100,
};

export const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "Comme Windows" },
  { id: "light", label: "Clair" },
  { id: "dark", label: "Sombre" },
];

/**
 * The main colours offered, each with its variant for the dark theme. Each
 * keeps text readable (WCAG AA): white on the light one, dark on the dark
 * one, and the light one on a white page, the dark one on a dark page.
 */
export const ACCENTS: { name: string; light: string; dark: string }[] = [
  { name: "Violet", light: "#7c3aed", dark: "#a78bfa" },
  { name: "Bleu", light: "#2563eb", dark: "#60a5fa" },
  { name: "Sarcelle", light: "#0f766e", dark: "#2dd4bf" },
  { name: "Vert", light: "#15803d", dark: "#4ade80" },
  { name: "Orange", light: "#c2410c", dark: "#fb923c" },
  { name: "Rose", light: "#be185d", dark: "#f472b6" },
  { name: "Rouge", light: "#b91c1c", dark: "#f87171" },
];

/**
 * Fonts already on Windows (Segoe UI, Georgia), or shipped with Kanade
 * under the SIL Open Font License (Atkinson Hyperlegible, Nunito): nothing
 * is loaded from the Internet.
 */
export const FONTS: { id: FontChoice; label: string; detail: string; family: string }[] = [
  {
    id: "segoe",
    label: "Segoe UI",
    detail: "Celle de Windows",
    family: '"Segoe UI", Inter, Avenir, Helvetica, Arial, sans-serif',
  },
  {
    id: "atkinson",
    label: "Atkinson Hyperlegible",
    detail: "Faite pour être lue facilement",
    family: '"Atkinson Hyperlegible", "Segoe UI", Arial, sans-serif',
  },
  {
    id: "nunito",
    label: "Nunito",
    detail: "Arrondie",
    family: 'Nunito, "Segoe UI", Arial, sans-serif',
  },
  {
    id: "georgia",
    label: "Georgia",
    detail: "À empattements",
    family: 'Georgia, Cambria, "Times New Roman", serif',
  },
];

export const NEON_SPEEDS: { id: NeonSpeed; label: string; seconds: number }[] = [
  { id: "slow", label: "Lente", seconds: 26 },
  { id: "medium", label: "Moyenne", seconds: 14 },
  { id: "fast", label: "Rapide", seconds: 7 },
];

/** Light colours for the neon, beside the main colour. */
export const NEON_COLORS: { name: string; color: string }[] = [
  { name: "Cyan", color: "#22d3ee" },
  { name: "Magenta", color: "#e879f9" },
  { name: "Vert", color: "#4ade80" },
  { name: "Ambre", color: "#fbbf24" },
];

/** Themes made in advance: one click sets the theme, colours and font. */
export const PRESETS: {
  id: string;
  name: string;
  detail: string;
  set: Pick<Appearance, "theme" | "accent" | "font" | "highContrast" | "neon">;
}[] = [
  {
    id: "kanade",
    name: "Kanade",
    detail: "L'apparence d'origine",
    set: {
      theme: "system",
      accent: "#7c3aed",
      font: "segoe",
      highContrast: false,
      neon: { enabled: false, color: "", speed: "medium" },
    },
  },
  {
    id: "nuit",
    name: "Nuit",
    detail: "Sombre et bleu",
    set: {
      theme: "dark",
      accent: "#2563eb",
      font: "segoe",
      highContrast: false,
      neon: { enabled: false, color: "", speed: "slow" },
    },
  },
  {
    id: "neon",
    name: "Néon",
    detail: "Sombre, une lumière cyan qui passe",
    set: {
      theme: "dark",
      accent: "#be185d",
      font: "nunito",
      highContrast: false,
      neon: { enabled: true, color: "#22d3ee", speed: "medium" },
    },
  },
  {
    id: "papier",
    name: "Papier",
    detail: "Clair, à empattements",
    set: {
      theme: "light",
      accent: "#c2410c",
      font: "georgia",
      highContrast: false,
      neon: { enabled: false, color: "", speed: "medium" },
    },
  },
  {
    id: "foret",
    name: "Forêt",
    detail: "Sombre et vert, arrondi",
    set: {
      theme: "dark",
      accent: "#15803d",
      font: "nunito",
      highContrast: false,
      neon: { enabled: false, color: "", speed: "medium" },
    },
  },
  {
    id: "lisible",
    name: "Très lisible",
    detail: "Contraste élevé, police lisible",
    set: {
      theme: "light",
      accent: "#2563eb",
      font: "atkinson",
      highContrast: true,
      neon: { enabled: false, color: "", speed: "medium" },
    },
  },
];

/** The preset the appearance matches, if any. */
export function presetOf(appearance: Appearance): string | null {
  const same = (a: Appearance["neon"], b: Appearance["neon"]) =>
    a.enabled === b.enabled && (!a.enabled || (a.color === b.color && a.speed === b.speed));
  const found = PRESETS.find(
    ({ set }) =>
      set.theme === appearance.theme &&
      set.accent === appearance.accent &&
      set.font === appearance.font &&
      set.highContrast === appearance.highContrast &&
      same(set.neon, appearance.neon),
  );
  return found?.id ?? null;
}

/** Zoom levels, in percent, as a browser's. */
export const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];

/** The level `steps` away from `current`, snapped to a known one first. */
export function stepZoom(current: number, steps: number): number {
  let nearest = 0;
  ZOOM_LEVELS.forEach((level, i) => {
    if (Math.abs(level - current) < Math.abs(ZOOM_LEVELS[nearest] - current)) nearest = i;
  });
  const i = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, nearest + steps));
  return ZOOM_LEVELS[i];
}

/** Heights of the virtualised lists' rows, in pixels, which JS and CSS share. */
export const ROW_HEIGHTS = {
  track: { normal: 28, compact: 24 },
  artist: { normal: 56, compact: 50 },
};

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  if (choice === "system") return systemDark ? "dark" : "light";
  return choice;
}

/** The surfaces the colours are checked against, per theme (App.css). */
const SURFACES = {
  light: {
    normal: { panel: "#ffffff", onAccent: "#ffffff" },
    high: { panel: "#ffffff", onAccent: "#ffffff" },
  },
  dark: {
    normal: { panel: "#282828", onAccent: "#141414" },
    high: { panel: "#000000", onAccent: "#000000" },
  },
};

/** Contrast asked of text: AA, or AAA with high contrast. */
export function textRatio(highContrast: boolean): number {
  return highContrast ? 7 : 4.5;
}

/**
 * The main colour as the theme shows it, and the text on it. On the light
 * theme it must read against white (white text on it, it on a white page);
 * on the dark one against the dark page (dark text on it).
 */
export function accentColors(
  appearance: Pick<Appearance, "accent" | "highContrast">,
  theme: Theme,
): { accent: string; accentText: string } {
  const offered = ACCENTS.find((a) => a.light === appearance.accent);
  const base = offered ? offered[theme] : appearance.accent;
  const surface = SURFACES[theme][appearance.highContrast ? "high" : "normal"];
  const ratio = textRatio(appearance.highContrast);
  // On the dark theme, the text on the accent is darker than the page.
  return { accent: readableOn(base, surface.panel, ratio), accentText: surface.onAccent };
}

/** The colour of a selected row: a little of the accent on the panel (App.css). */
export function selectedRow(accent: string, theme: Theme, highContrast: boolean): string {
  return mix(accent, SURFACES[theme][highContrast ? "high" : "normal"].panel, 0.22);
}

/** What veils the background image: dark on the dark theme, light on the light one. */
export function veilColor(theme: Theme, dim: number): string {
  const tint = theme === "dark" ? "0 0 0" : "255 255 255";
  return `rgb(${tint} / ${String(dim)}%)`;
}

export function fontFamily(font: FontChoice): string {
  return (FONTS.find((f) => f.id === font) ?? FONTS[0]).family;
}

export function neonSeconds(speed: NeonSpeed): number {
  return (NEON_SPEEDS.find((s) => s.id === speed) ?? NEON_SPEEDS[1]).seconds;
}

/** What the page shows for an appearance: attributes and CSS variables of <html>. */
export function applyAppearance(root: HTMLElement, appearance: Appearance, theme: Theme): void {
  const { accent, accentText } = accentColors(appearance, theme);
  const density = appearance.compact ? "compact" : "normal";
  const set = (name: string, value: string) => {
    root.style.setProperty(name, value);
  };
  root.dataset.theme = theme;
  toggle(root, "contrast", appearance.highContrast ? "high" : null);
  toggle(root, "density", appearance.compact ? "compact" : null);
  toggle(root, "motion", appearance.reduceMotion ? "reduce" : null);
  set("--accent", accent);
  set("--accent-text", accentText);
  set("--font", fontFamily(appearance.font));
  set("--veil", veilColor(theme, appearance.backgroundDim));
  set("--neon", appearance.neon.color || accent);
  set("--neon-duration", `${String(neonSeconds(appearance.neon.speed))}s`);
  set("--track-row-height", `${String(ROW_HEIGHTS.track[density])}px`);
  set("--artist-row-height", `${String(ROW_HEIGHTS.artist[density])}px`);
}

function toggle(root: HTMLElement, name: string, value: string | null) {
  if (value) root.setAttribute(`data-${name}`, value);
  else root.removeAttribute(`data-${name}`);
}

/**
 * The appearance as last applied, kept in the browser's storage too, so the
 * next launch shows it at once rather than after the database answers.
 */
const CACHE = "kanade.appearance";

export function cachedAppearance(): Appearance {
  try {
    const cached = localStorage.getItem(CACHE);
    if (cached) return { ...DEFAULT_APPEARANCE, ...(JSON.parse(cached) as Partial<Appearance>) };
  } catch {
    // Unreadable or unavailable: the default, until the database answers.
  }
  return DEFAULT_APPEARANCE;
}

export function cacheAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(CACHE, JSON.stringify(appearance));
  } catch {
    // Storage full or refused: the database still has it.
  }
}
