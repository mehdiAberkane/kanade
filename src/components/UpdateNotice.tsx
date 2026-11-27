import { useEffect, useState } from "react";
import { useUpdater } from "../lib/useUpdater";

/** How long the notice stays. */
export const NOTICE_MS = 12_000;

/** Where the last version announced is kept: once per version. */
const KEY = "kanade.updateNotice";

function announcedAlready(version: string): boolean {
  try {
    return localStorage.getItem(KEY) === version;
  } catch {
    // Storage refused: announced, at worst, at each launch.
    return false;
  }
}

function remember(version: string) {
  try {
    localStorage.setItem(KEY, version);
  } catch {
    // Not kept: see above.
  }
}

/**
 * A newer version, said once (KAN-51): a small notice at the bottom right,
 * which takes no focus and goes by itself. The top bar's button stays.
 */
export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const { available } = useUpdater();
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (!available || announcedAlready(available)) return;
    remember(available);
    setShown(available);
    // It goes by itself: the top bar's button keeps saying it.
    const timer = window.setTimeout(() => {
      setShown(null);
    }, NOTICE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [available]);

  return (
    <div className="update-notice-zone" aria-live="polite">
      {shown && (
        <div className="update-notice">
          <span>Kanade {shown} est disponible.</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setShown(null);
              onOpen();
            }}
          >
            Voir les nouveautés
          </button>
          <button
            type="button"
            className="update-notice-close"
            aria-label="Fermer"
            onClick={() => {
              setShown(null);
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
