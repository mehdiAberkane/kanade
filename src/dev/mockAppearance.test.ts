// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../lib/appearance";
import { backgroundScenario, createMockAppearance, lightPicture, sanitize } from "./mockAppearance";
import { NOT_MINE } from "./mockLibraries";

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("zoom");
});

describe("the fake appearance", () => {
  it("keeps what it is sent, made safe as the Rust side does", () => {
    const mock = createMockAppearance();
    expect(mock.handle("appearance_get")).toEqual(DEFAULT_APPEARANCE);
    const kept = mock.handle("appearance_set", {
      appearance: {
        theme: "dark",
        accent: "#2563EB",
        font: "atkinson",
        compact: true,
        highContrast: true,
        reduceMotion: true,
        backgroundDim: 140,
        neon: { enabled: true, color: "#22D3EE", speed: "fast" },
        zoom: 20,
      },
    });
    expect(kept).toEqual({
      theme: "dark",
      accent: "#2563eb",
      font: "atkinson",
      compact: true,
      highContrast: true,
      reduceMotion: true,
      backgroundDim: 90,
      neon: { enabled: true, color: "#22d3ee", speed: "fast" },
      zoom: 50,
    });
    expect(mock.handle("appearance_get")).toEqual(kept);
    expect(sanitize(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(sanitize({ theme: "sepia", accent: "red", backgroundDim: "a lot" } as never)).toEqual(
      DEFAULT_APPEARANCE,
    );
  });

  it("keeps a JPEG as the background, refuses anything else", async () => {
    const mock = createMockAppearance();
    expect(mock.handle("background_get")).toEqual(new Uint8Array());
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(mock.handle("background_set", jpeg)).toBeNull();
    jpeg[3] = 0; // a copy was kept
    expect(mock.handle("background_get")).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    await expect(mock.handle("background_set", new Uint8Array([0x3c]))).rejects.toEqual({
      code: "not_an_image",
    });
    await expect(mock.handle("background_set", { path: "C:/fond.jpg" })).rejects.toEqual({
      code: "not_an_image",
    });
    expect(mock.handle("background_clear")).toBeNull();
    expect(mock.handle("background_get")).toEqual(new Uint8Array());
  });

  it("records the window's theme and zoom, and zooms the preview's page", () => {
    const mock = createMockAppearance({ zoomsPage: true });
    mock.handle("plugin:window|set_theme", { value: "dark" });
    mock.handle("plugin:webview|set_webview_zoom", { value: 1.5 });
    expect(mock.window).toEqual({ theme: "dark", zoom: 1.5 });
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.5");
    mock.handle("plugin:window|set_theme", {});
    expect(mock.window.theme).toBeNull();

    const tests = createMockAppearance();
    tests.handle("plugin:webview|set_webview_zoom", { value: 2 });
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.5");
    expect(tests.handle("tracks_list")).toBe(NOT_MINE);
  });

  it("starts with a light picture when the address asks for it", () => {
    expect(backgroundScenario("?background=light")).toBe("light");
    expect(backgroundScenario("?db=empty")).toBe("none");
    // jsdom draws nothing: a stand-in canvas that answers a tiny JPEG.
    const context = {
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      ellipse: vi.fn(),
      fill: vi.fn(),
      fillStyle: "",
    };
    vi.spyOn(document, "createElement").mockReturnValue({
      getContext: () => context,
      toDataURL: () => `data:image/jpeg;base64,${btoa("\xff\xd8\xff")}`,
    } as unknown as HTMLElement);
    expect([...lightPicture()]).toEqual([0xff, 0xd8, 0xff]);
  });
});
