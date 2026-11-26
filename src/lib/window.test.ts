// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { setPageZoom, setWindowTheme } from "./window";

afterEach(() => {
  clearMocks();
});

describe("the window's theme and zoom", () => {
  it("asks Tauri for them", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, (args as { value?: unknown }).value]);
      return null;
    });
    mockWindows("main");
    setWindowTheme("dark");
    setWindowTheme(null);
    setPageZoom(1.25);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      ["plugin:window|set_theme", "dark"],
      ["plugin:window|set_theme", null],
      ["plugin:webview|set_webview_zoom", 1.25],
    ]);
  });

  it("leaves them be when Tauri refuses, or outside a Tauri window", async () => {
    mockIPC(() => Promise.reject(new Error("not allowed")));
    mockWindows("main");
    setWindowTheme("light");
    setPageZoom(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearMocks();
    expect(() => {
      setWindowTheme("light");
      setPageZoom(1);
    }).not.toThrow();
  });
});
