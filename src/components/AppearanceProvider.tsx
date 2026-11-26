// Kanade's appearance (KAN-44): read from the database at launch (the last
// one shown comes at once from the browser's storage), applied to <html>,
// to the title bar and to the zoom on each change, kept a moment later.
// Also the background image, the neon light behind the page, and the zoom
// from the keyboard and the wheel.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  applyAppearance,
  cacheAppearance,
  cachedAppearance,
  DEFAULT_APPEARANCE,
  resolveTheme,
  stepZoom,
  type Appearance,
} from "../lib/appearance";
import { toBlob } from "../lib/covers";
import { ImageError, imageToBackground } from "../lib/image";
import { errorText } from "../lib/libraries";
import { AppearanceContext, type AppearanceState } from "../lib/useAppearance";
import { setPageZoom, setWindowTheme } from "../lib/window";

/** A slider or a colour being dragged is kept once it rests. */
const SAVE_DELAY_MS = 300;
/** How long the zoom level stays on screen. */
const ZOOM_SHOWN_MS = 1200;
/** Wheel distance for one zoom level: a notch of a mouse wheel. */
const WHEEL_STEP = 50;

function useMediaQuery(query: string): boolean {
  // jsdom (the component tests) has no matchMedia, despite its types.
  const list = useMemo(
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query) : null),
    [query],
  );
  const [matches, setMatches] = useState(() => list?.matches ?? false);
  useEffect(() => {
    if (!list) return;
    const change = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };
    list.addEventListener("change", change);
    return () => {
      list.removeEventListener("change", change);
    };
  }, [list]);
  return matches;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState(cachedAppearance);
  const current = useRef(appearance);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const theme = resolveTheme(appearance.theme, useMediaQuery("(prefers-color-scheme: dark)"));
  const saving = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [shownZoom, setShownZoom] = useState<number | null>(null);
  const hidingZoom = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback((next: Appearance) => {
    current.current = next;
    setAppearance(next);
  }, []);

  // Read once; an answer after the window closed changes nothing.
  useEffect(() => {
    invoke<Appearance>("appearance_get")
      .then(
        (saved) => {
          show({ ...DEFAULT_APPEARANCE, ...saved });
        },
        (e: unknown) => {
          setFailure(errorText(e));
        },
      )
      .finally(() => {
        setLoaded(true);
      });
  }, [show]);

  const update = useCallback(
    (change: Partial<Appearance>) => {
      const next = { ...current.current, ...change };
      show(next);
      clearTimeout(saving.current);
      saving.current = setTimeout(() => {
        invoke("appearance_set", { appearance: next }).then(
          () => {
            setFailure(null);
          },
          (e: unknown) => {
            setFailure(errorText(e));
          },
        );
      }, SAVE_DELAY_MS);
    },
    [show],
  );

  const zoomTo = useCallback(
    (zoom: number) => {
      if (zoom !== current.current.zoom) update({ zoom });
      setShownZoom(zoom);
      clearTimeout(hidingZoom.current);
      hidingZoom.current = setTimeout(() => {
        setShownZoom(null);
      }, ZOOM_SHOWN_MS);
    },
    [update],
  );

  const zoomBy = useCallback(
    (steps: number) => {
      zoomTo(stepZoom(current.current.zoom, steps));
    },
    [zoomTo],
  );

  // Ctrl + wheel, Ctrl + + / - / 0, as in a browser (a trackpad's pinch
  // comes as Ctrl + wheel too). WebView2's own zoom is off (Tauri's default).
  useEffect(() => {
    let wheel = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      wheel += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 40 : event.deltaY;
      // One level a notch, whatever distance the system gives a notch.
      if (Math.abs(wheel) < WHEEL_STEP) return;
      const up = wheel < 0;
      wheel = 0;
      zoomBy(up ? 1 : -1);
    };
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;
      if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") zoomBy(1);
      else if (event.key === "-" || event.code === "NumpadSubtract") zoomBy(-1);
      // On a French keyboard 0 needs Shift (à without it): the key's place counts.
      else if (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0")
        zoomTo(100);
      else return;
      event.preventDefault();
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [zoomBy, zoomTo]);

  const background = useBackground();
  // Something behind the page: its panels let it through (App.css).
  const backdrop = background.url !== null || appearance.neon.enabled;

  useLayoutEffect(() => {
    const root = document.documentElement;
    applyAppearance(root, appearance, theme);
    if (backdrop) root.dataset.backdrop = "";
    else delete root.dataset.backdrop;
    cacheAppearance(appearance);
  }, [appearance, theme, backdrop]);

  useEffect(() => {
    setWindowTheme(appearance.theme === "system" ? null : theme);
  }, [appearance.theme, theme]);

  useEffect(() => {
    setPageZoom(appearance.zoom / 100);
  }, [appearance.zoom]);

  const clearBackground = background.clear;
  const reset = useCallback(async () => {
    update(DEFAULT_APPEARANCE);
    await clearBackground();
  }, [update, clearBackground]);

  const value: AppearanceState = useMemo(
    () => ({ appearance, theme, loaded, failure, update, zoomBy, zoomTo, reset, background }),
    [appearance, theme, loaded, failure, update, zoomBy, zoomTo, reset, background],
  );

  return (
    <AppearanceContext.Provider value={value}>
      {backdrop && (
        <div className="backdrop" aria-hidden="true">
          {background.url && (
            <>
              <div
                className="backdrop-image"
                style={{ backgroundImage: `url("${background.url}")` }}
              />
              <div className="backdrop-veil" />
            </>
          )}
          {appearance.neon.enabled && (
            <div className="neon">
              <span />
              <span />
            </div>
          )}
        </div>
      )}
      {children}
      {shownZoom !== null && (
        <div className="zoom-level" role="status">
          {shownZoom} %
        </div>
      )}
    </AppearanceContext.Provider>
  );
}

/** The background image: read at launch, replaced or removed from the page. */
function useBackground(): AppearanceState["background"] {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef<string | null>(null);

  const showBytes = useCallback((bytes: ArrayBuffer | Uint8Array<ArrayBuffer> | number[]) => {
    if (shown.current) URL.revokeObjectURL(shown.current);
    const blob = toBlob(bytes);
    shown.current = blob ? URL.createObjectURL(blob) : null;
    setUrl(shown.current);
  }, []);

  useEffect(() => {
    invoke<ArrayBuffer | number[]>("background_get").then(showBytes, () => {
      // No data folder: no background, as the page already says.
    });
  }, [showBytes]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof ImageError ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const choose = useCallback(
    (file: File) =>
      run(async () => {
        const jpeg = await imageToBackground(file);
        await invoke("background_set", jpeg);
        showBytes(jpeg);
      }),
    [run, showBytes],
  );

  const clear = useCallback(
    () =>
      run(async () => {
        await invoke("background_clear");
        showBytes([]);
      }),
    [run, showBytes],
  );

  return useMemo(() => ({ url, busy, error, choose, clear }), [url, busy, error, choose, clear]);
}
