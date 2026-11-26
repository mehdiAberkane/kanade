// The window's own appearance, out of the page's reach: the theme of its
// title bar and the zoom of the whole page (KAN-44). Outside Tauri, or
// refused, they stay as they are; the page itself still changes.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Theme } from "./appearance";

/** The title bar's theme; null follows Windows. */
export function setWindowTheme(theme: Theme | null): void {
  try {
    getCurrentWindow()
      .setTheme(theme)
      .catch(() => undefined);
  } catch {
    // Not in a Tauri window.
  }
}

/** The zoom of the whole page, 1 for 100 %. */
export function setPageZoom(scale: number): void {
  try {
    getCurrentWebview()
      .setZoom(scale)
      .catch(() => undefined);
  } catch {
    // Not in a Tauri window.
  }
}
