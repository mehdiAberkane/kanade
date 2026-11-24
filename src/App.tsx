import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DatabaseBanner } from "./components/DatabaseBanner";
import { SettingsPage } from "./components/SettingsPage";
import { statusLine } from "./lib/updater";
import { useBackgroundUpdateCheck, useUpdater } from "./lib/useUpdater";
import "./App.css";

type Page = "library" | "settings";

function App() {
  const [version, setVersion] = useState("");
  const [page, setPage] = useState<Page>("library");
  useBackgroundUpdateCheck();

  useEffect(() => {
    invoke<string>("app_version")
      .then(setVersion)
      .catch(() => {
        setVersion("");
      });
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Kanade</span>
        <nav className="nav">
          <NavButton current={page} page="library" onSelect={setPage}>
            Bibliothèque
          </NavButton>
          <NavButton current={page} page="settings" onSelect={setPage}>
            Réglages
          </NavButton>
        </nav>
        <UpdateButton />
      </header>
      <DatabaseBanner />

      <main>
        {page === "library" ? (
          <section className="page library">
            <h1>Kanade</h1>
            <p>Gestionnaire de bibliothèque musicale{version && ` — v${version}`}</p>
          </section>
        ) : (
          <SettingsPage version={version} />
        )}
      </main>
    </div>
  );
}

function NavButton(props: {
  current: Page;
  page: Page;
  onSelect: (page: Page) => void;
  children: string;
}) {
  const active = props.current === props.page;
  return (
    <button
      className={`nav-btn${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        props.onSelect(props.page);
      }}
    >
      {props.children}
    </button>
  );
}

/** Shown in the top bar once a newer version is found, like in Todoom. */
function UpdateButton() {
  const { available, status, install } = useUpdater();
  if (!available) return null;
  if (status.kind === "installing") {
    return <span className="update-btn busy">{statusLine(status)?.text}</span>;
  }
  return (
    <button className="update-btn" onClick={() => void install()}>
      ⬆ Mettre à jour vers {available}
    </button>
  );
}

export default App;
