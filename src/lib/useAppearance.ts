// The appearance as the components read it (KAN-44): given by
// AppearanceProvider, which loads, applies and saves it. Without the
// provider (a component tested alone), the default appearance.
import { createContext, useContext } from "react";
import { DEFAULT_APPEARANCE, ROW_HEIGHTS, type Appearance, type Theme } from "./appearance";

interface BackgroundState {
  /** An object URL of the image, or null without one. */
  url: string | null;
  busy: boolean;
  error: string | null;
  choose: (file: File) => Promise<void>;
  clear: () => Promise<void>;
}

export interface AppearanceState {
  appearance: Appearance;
  /** The theme shown: the one chosen, or Windows'. */
  theme: Theme;
  /** Read from the database; the page's controls wait for it. */
  loaded: boolean;
  /** Why the appearance could not be read or kept. */
  failure: string | null;
  /** Shown at once, kept a moment later (a slider sends many changes). */
  update: (change: Partial<Appearance>) => void;
  /** One zoom level up (1) or down (-1), shown briefly on screen. */
  zoomBy: (steps: number) => void;
  /** A zoom level, in percent, shown briefly on screen. */
  zoomTo: (zoom: number) => void;
  /** Everything back to the default, the background image removed. */
  reset: () => Promise<void>;
  background: BackgroundState;
}

const nothing = () => Promise.resolve();

export const AppearanceContext = createContext<AppearanceState>({
  appearance: DEFAULT_APPEARANCE,
  theme: "light",
  loaded: true,
  failure: null,
  update: () => undefined,
  zoomBy: () => undefined,
  zoomTo: () => undefined,
  reset: nothing,
  background: { url: null, busy: false, error: null, choose: nothing, clear: nothing },
});

export function useAppearance(): AppearanceState {
  return useContext(AppearanceContext);
}

/** The height of a virtualised list's rows, compact or not (App.css reads the same). */
export function useRowHeight(list: keyof typeof ROW_HEIGHTS): number {
  return ROW_HEIGHTS[list][useAppearance().appearance.compact ? "compact" : "normal"];
}
