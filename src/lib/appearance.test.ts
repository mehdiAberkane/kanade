// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCENTS,
  accentColors,
  applyAppearance,
  cacheAppearance,
  cachedAppearance,
  DEFAULT_APPEARANCE,
  fontFamily,
  FONTS,
  NEON_COLORS,
  neonSeconds,
  presetOf,
  PRESETS,
  resolveTheme,
  selectedRow,
  stepZoom,
  textRatio,
  veilColor,
  ZOOM_LEVELS,
  type Appearance,
  type FontChoice,
  type NeonSpeed,
  type Theme,
} from "./appearance";
import { contrast, mix } from "./color";

/** The text colours of App.css, per theme and contrast. */
const TEXT = {
  light: {
    normal: { text: "#1f1f1f", muted: "#5f5f5f", panel: "#ffffff", bg: "#f6f6f6" },
    high: { text: "#000000", muted: "#262626", panel: "#ffffff", bg: "#ffffff" },
  },
  dark: {
    normal: { text: "#f0f0f0", muted: "#a8a8a8", panel: "#282828", bg: "#1e1e1e" },
    high: { text: "#ffffff", muted: "#e0e0e0", panel: "#000000", bg: "#000000" },
  },
};
const THEMES: Theme[] = ["light", "dark"];
/** Colours a user might pick, the hard ones included. */
const FREE = [
  "#ffff00",
  "#ffffff",
  "#000000",
  "#00ff00",
  "#00ffff",
  "#ff0000",
  "#808080",
  "#1e3a8a",
];

describe("main colour", () => {
  for (const theme of THEMES) {
    for (const high of [false, true]) {
      const level = high ? "high" : "normal";
      const ratio = textRatio(high);
      const colours = TEXT[theme][level];
      it(`keeps buttons, links and selected rows readable (${theme}, ${level} contrast)`, () => {
        for (const accent of [...ACCENTS.map((a) => a.light), ...FREE]) {
          const shown = accentColors({ accent, highContrast: high }, theme);
          expect(contrast(shown.accent, shown.accentText), accent).toBeGreaterThanOrEqual(ratio);
          expect(contrast(shown.accent, colours.panel), accent).toBeGreaterThanOrEqual(ratio);
          const row = selectedRow(shown.accent, theme, high);
          expect(contrast(colours.text, row), accent).toBeGreaterThanOrEqual(ratio);
        }
      });
    }
  }

  it("shows the offered colours as they are, each theme its variant", () => {
    for (const a of ACCENTS) {
      expect(accentColors({ accent: a.light, highContrast: false }, "light").accent).toBe(a.light);
      expect(accentColors({ accent: a.light, highContrast: false }, "dark").accent).toBe(a.dark);
    }
    expect(accentColors(DEFAULT_APPEARANCE, "dark")).toEqual({
      accent: "#a78bfa",
      accentText: "#141414",
    });
  });
});

describe("over a background", () => {
  /** Grey text on a panel at 84 % (App.css, --glass) over what is behind. */
  const onGlass = (theme: Theme, behind: string) => {
    const { muted, panel } = TEXT[theme].normal;
    return contrast(muted, mix(panel, behind, 0.84));
  };

  it("keeps grey text at 4.5:1 on a white or black image under the default veil", () => {
    const dim = DEFAULT_APPEARANCE.backgroundDim / 100;
    expect(onGlass("dark", mix("#000000", "#ffffff", dim))).toBeGreaterThanOrEqual(4.5);
    expect(onGlass("light", mix("#ffffff", "#000000", dim))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps grey text at 4.5:1 where the neon is brightest", () => {
    const lights = [
      ...NEON_COLORS.map((c) => c.color),
      ...ACCENTS.flatMap((a) => [a.light, a.dark]),
    ];
    for (const theme of THEMES) {
      for (const light of lights) {
        // The neon's heart: 85 % of its colour on the page (App.css).
        const behind = mix(light, TEXT[theme].normal.bg, 0.85);
        expect(onGlass(theme, behind), `${theme} ${light}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("veils the image dark on the dark theme, light on the light one", () => {
    expect(veilColor("dark", 40)).toBe("rgb(0 0 0 / 40%)");
    expect(veilColor("light", 0)).toBe("rgb(255 255 255 / 0%)");
  });
});

describe("choices", () => {
  it("follows Windows unless a theme is chosen", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("knows each font, Segoe UI otherwise", () => {
    for (const f of FONTS) expect(fontFamily(f.id)).toBe(f.family);
    expect(fontFamily("comic" as FontChoice)).toBe(FONTS[0].family);
    expect(neonSeconds("fast")).toBeLessThan(neonSeconds("medium"));
    expect(neonSeconds("medium")).toBeLessThan(neonSeconds("slow"));
    expect(neonSeconds("warp" as NeonSpeed)).toBe(neonSeconds("medium"));
  });

  it("names the preset an appearance matches", () => {
    expect(presetOf(DEFAULT_APPEARANCE)).toBe("kanade");
    for (const p of PRESETS) {
      expect(
        ACCENTS.some((a) => a.light === p.set.accent),
        p.id,
      ).toBe(true);
      expect(presetOf({ ...DEFAULT_APPEARANCE, ...p.set })).toBe(p.id);
    }
    // A neon left off matches whatever its colour and speed.
    const off = {
      ...DEFAULT_APPEARANCE,
      neon: { enabled: false, color: "#22d3ee", speed: "fast" },
    };
    expect(presetOf(off as Appearance)).toBe("kanade");
    const lit = { ...DEFAULT_APPEARANCE, neon: { enabled: true, color: "", speed: "medium" } };
    expect(presetOf(lit as Appearance)).toBeNull();
    expect(presetOf({ ...DEFAULT_APPEARANCE, accent: "#123456" })).toBeNull();
  });

  it("zooms by a browser's steps, from 50 to 300 %", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(104, 0)).toBe(100);
    expect(stepZoom(300, 1)).toBe(300);
    expect(stepZoom(50, -1)).toBe(50);
    expect(stepZoom(1000, 0)).toBe(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
  });
});

describe("on the page", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("sets the attributes and the variables App.css reads", () => {
    const root = document.createElement("html");
    const chosen: Appearance = {
      ...DEFAULT_APPEARANCE,
      accent: "#2563eb",
      font: "nunito",
      compact: true,
      highContrast: true,
      reduceMotion: true,
      backgroundDim: 70,
      neon: { enabled: true, color: "#22d3ee", speed: "fast" },
    };
    applyAppearance(root, chosen, "dark");
    expect(root.dataset).toMatchObject({
      theme: "dark",
      contrast: "high",
      density: "compact",
      motion: "reduce",
    });
    const variable = (name: string) => root.style.getPropertyValue(name);
    expect(variable("--accent")).toBe(accentColors(chosen, "dark").accent);
    expect(variable("--accent-text")).toBe("#000000");
    expect(variable("--font")).toBe(fontFamily("nunito"));
    expect(variable("--veil")).toBe("rgb(0 0 0 / 70%)");
    expect(variable("--neon")).toBe("#22d3ee");
    expect(variable("--neon-duration")).toBe(`${String(neonSeconds("fast"))}s`);
    expect(variable("--track-row-height")).toBe("24px");
    expect(variable("--artist-row-height")).toBe("50px");

    applyAppearance(root, DEFAULT_APPEARANCE, "light");
    expect(root.dataset.contrast).toBeUndefined();
    expect(root.dataset.density).toBeUndefined();
    expect(root.dataset.motion).toBeUndefined();
    expect(variable("--neon")).toBe("#7c3aed");
    expect(variable("--track-row-height")).toBe("28px");
  });

  it("remembers the last appearance in the browser for the next launch", () => {
    expect(cachedAppearance()).toEqual(DEFAULT_APPEARANCE);
    cacheAppearance({ ...DEFAULT_APPEARANCE, theme: "dark" });
    expect(cachedAppearance().theme).toBe("dark");
    localStorage.setItem("kanade.appearance", "{not json");
    expect(cachedAppearance()).toEqual(DEFAULT_APPEARANCE);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => {
      cacheAppearance(DEFAULT_APPEARANCE);
    }).not.toThrow();
  });
});
