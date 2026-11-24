import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { databaseMessage, type DatabaseStatus } from "../lib/database";

/** Under the top bar: says when the database was repaired or cannot open. */
export function DatabaseBanner() {
  const [status, setStatus] = useState<DatabaseStatus | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    invoke<DatabaseStatus>("database_status").then(setStatus, () => {
      // No answer: nothing reliable to say.
    });
  }, []);

  const message = status ? databaseMessage(status) : null;
  if (!message || closed) return null;
  return (
    <div className={`banner banner-${message.tone}`} role="alert">
      <span>{message.text}</span>
      {message.tone === "warning" && (
        <button
          className="btn"
          onClick={() => {
            setClosed(true);
          }}
        >
          J'ai compris
        </button>
      )}
    </div>
  );
}
