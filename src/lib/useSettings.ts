// Kanade's settings, for the Réglages page: read once, saved at each change.
// A change the Rust side refuses is undone, and the reason is kept to show.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorText, type Settings } from "./libraries";

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    invoke<Settings>("settings_get").then(setSettings, (e: unknown) => {
      setFailure(errorText(e));
    });
  }, []);

  async function save(change: Partial<Settings>) {
    // The boxes stay disabled until the settings are read.
    const before = settings as Settings;
    const next = { ...before, ...change };
    setSettings(next);
    setFailure(null);
    try {
      await invoke("settings_set", { settings: next });
    } catch (e) {
      setSettings(before);
      setFailure(errorText(e));
    }
  }

  return { settings, failure, save };
}
