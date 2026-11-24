import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DatabaseBanner } from "./components/DatabaseBanner";
import { DropZone } from "./components/DropZone";
import { LibrariesPage } from "./components/LibrariesPage";
import { SettingsPage } from "./components/SettingsPage";
import { TracksPage } from "./components/TracksPage";
import { statusLine } from "./lib/updater";
import { useBackgroundUpdateCheck, useUpdater } from "./lib/useUpdater";
import "./App.css";

type Page = "tracks" | "libraries" | "settings";

function App() {
  const [version, setVersion] = useState("");
  const [page, setPage] = useState<Page>("tracks");
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
          <NavButton current={page} page="tracks" onSelect={setPage}>
            Morceaux
          </NavButton>
          <NavButton current={page} page="libraries" onSelect={setPage}>
            Bibliothèques
          </NavButton>
          <NavButton current={page} page="settings" onSelect={setPage}>
            Réglages
          </NavButton>
        </nav>
        <UpdateButton />
      </header>
      <DatabaseBanner />

      <main>
        {page === "tracks" && (
          <TracksPage
            onManage={() => {
              setPage("libraries");
            }}
          />
        )}
        {page === "libraries" && <LibrariesPage />}
        {page === "settings" && <SettingsPage version={version} />}
      </main>
      <DropZone />
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
