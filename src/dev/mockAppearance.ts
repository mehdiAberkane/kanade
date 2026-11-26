// The Appearance page's commands, faked for the browser preview and the
// tests (KAN-44): kept in memory and made safe as the Rust side does
// (library/appearance.rs, background.rs). Also the window's theme and zoom,
// which the preview shows by zooming the page itself.
import type { InvokeArgs } from "@tauri-apps/api/core";
import {
  DEFAULT_APPEARANCE,
  FONTS,
  NEON_SPEEDS,
  THEMES,
  type Appearance,
  type Neon,
} from "../lib/appearance";
import { isHex } from "../lib/color";
import { NOT_MINE } from "./mockLibraries";

export interface MockAppearance {
  handle: (cmd: string, args?: InvokeArgs) => unknown;
  /** The calls that changed the window: its theme and its zoom. */
  window: { theme: string | null; zoom: number };
}

/** `?background=light`: a light image to start with, to check the text on it. */
export type BackgroundScenario = "none" | "light";

export function backgroundScenario(search: string): BackgroundScenario {
  return new URLSearchParams(search).get("background") === "light" ? "light" : "none";
}

function oneOf<T extends string>(value: unknown, known: readonly { id: T }[], fallback: T): T {
  return known.find((k) => k.id === value)?.id ?? fallback;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/** As the Rust side keeps it: an unknown value gives way to the default. */
export function sanitize(sent: Partial<Appearance> | undefined): Appearance {
  const d = DEFAULT_APPEARANCE;
  const s = sent ?? {};
  const neon: Partial<Neon> = s.neon ?? {};
  const hex = (value: unknown) =>
    typeof value === "string" && isHex(value) ? value.toLowerCase() : null;
  return {
    theme: oneOf(s.theme, THEMES, d.theme),
    accent: hex(s.accent) ?? d.accent,
    font: oneOf(s.font, FONTS, d.font),
    compact: s.compact === true,
    highContrast: s.highContrast === true,
    reduceMotion: s.reduceMotion === true,
    backgroundDim: clamp(s.backgroundDim, 0, 90, d.backgroundDim),
    neon: {
      enabled: neon.enabled === true,
      color: hex(neon.color) ?? "",
      speed: oneOf(neon.speed, NEON_SPEEDS, d.neon.speed),
    },
    zoom: clamp(s.zoom, 50, 300, d.zoom),
  };
}

function refuse(code: string): Promise<never> {
  // The Rust side rejects with its error, an object, as the libraries' mock.
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return Promise.reject({ code });
}

export function createMockAppearance(
  options: { background?: Uint8Array; zoomsPage?: boolean } = {},
): MockAppearance {
  let appearance = DEFAULT_APPEARANCE;
  let background = options.background ?? new Uint8Array();
  const window = { theme: null as string | null, zoom: 1 };

  function handle(cmd: string, args?: InvokeArgs): unknown {
    const named = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "appearance_get":
        return appearance;
      case "appearance_set":
        appearance = sanitize(named.appearance as Partial<Appearance> | undefined);
        return appearance;
      case "background_get":
        return background;
      case "background_set": {
        // The raw body: a JPEG, never a path.
        const jpeg = args instanceof Uint8Array ? args : null;
        if (!jpeg || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return refuse("not_an_image");
        background = jpeg.slice();
        return null;
      }
      case "background_clear":
        background = new Uint8Array();
        return null;
      case "plugin:window|set_theme":
        window.theme = (named.value as string | null | undefined) ?? null;
        return null;
      case "plugin:webview|set_webview_zoom":
        window.zoom = named.value as number;
        // The preview cannot zoom like WebView2: the page zooms itself.
        if (options.zoomsPage)
          document.documentElement.style.setProperty("zoom", String(window.zoom));
        return null;
      default:
        return NOT_MINE;
    }
  }

  return { handle, window };
}

/** A light picture (sky, sun, hills), as JPEG bytes, made in the browser. */
export function lightPicture(): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 900;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  const sky = context.createLinearGradient(0, 0, 0, 900);
  sky.addColorStop(0, "#dbeafe");
  sky.addColorStop(1, "#fef9c3");
  context.fillStyle = sky;
  context.fillRect(0, 0, 1600, 900);
  context.fillStyle = "#fde68a";
  context.beginPath();
  context.arc(1250, 220, 120, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#bbf7d0";
  context.beginPath();
  context.ellipse(500, 900, 900, 260, 0, 0, Math.PI * 2);
  context.fill();
  const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
