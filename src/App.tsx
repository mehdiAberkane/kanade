import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppearancePage } from "./components/AppearancePage";
import { AppearanceProvider } from "./components/AppearanceProvider";
import { DatabaseBanner } from "./components/DatabaseBanner";
import { NowPlaying } from "./components/NowPlaying";
import { DropZone } from "./components/DropZone";
import { UpdateNotice } from "./components/UpdateNotice";
import { HealthPage } from "./components/HealthPage";
import { LibrariesPage } from "./components/LibrariesPage";
import { SettingsPage } from "./components/SettingsPage";
import { StatsPage, type TracksStart } from "./components/StatsPage";
import { TracksPage } from "./components/TracksPage";
import { UpdateDialog } from "./components/UpdateDialog";
import { statusLine } from "./lib/updater";
import { useBackgroundUpdateCheck, useUpdater } from "./lib/useUpdater";
import "./App.css";

type Page = "tracks" | "libraries" | "health" | "stats" | "appearance" | "settings";

function App() {
  const [version, setVersion] = useState("");
  const [page, setPage] = useState<Page>("tracks");
  /** The list opened from a figure of the statistics, with its filters. */
  const [start, setStart] = useState<TracksStart | undefined>(undefined);
  const select = (next: Page) => {
    setStart(undefined);
    setPage(next);
  };
  /** The update window: notes, then the go to install. */
  const [confirming, setConfirming] = useState(false);
  const confirm = () => {
    setConfirming(true);
  };
  useBackgroundUpdateCheck();

  useEffect(() => {
    invoke<string>("app_version")
      .then(setVersion)
      .catch(() => {
        setVersion("");
      });
  }, []);

  return (
    <AppearanceProvider>
      <div className="app">
        <header className="topbar">
          <span className="brand">Kanade</span>
          <nav className="nav">
            <NavButton current={page} page="tracks" onSelect={select}>
              Musique
            </NavButton>
            <NavButton current={page} page="libraries" onSelect={select}>
              Bibliothèques
            </NavButton>
            <NavButton current={page} page="health" onSelect={select}>
              Santé
            </NavButton>
            <NavButton current={page} page="stats" onSelect={select}>
              Statistiques
            </NavButton>
            <NavButton current={page} page="appearance" onSelect={select}>
              Apparence
            </NavButton>
            <NavButton current={page} page="settings" onSelect={select}>
              Réglages
            </NavButton>
          </nav>
          <UpdateButton onOpen={confirm} />
        </header>
        <DatabaseBanner />

        <main>
          {page === "tracks" && (
            <TracksPage
              start={start}
              onManage={() => {
                select("libraries");
              }}
            />
          )}
          {page === "libraries" && <LibrariesPage />}
          {page === "health" && <HealthPage />}
          {page === "stats" && (
            <StatsPage
              onShow={(next) => {
                setStart(next);
                setPage("tracks");
              }}
            />
          )}
          {page === "appearance" && <AppearancePage />}
          {page === "settings" && <SettingsPage version={version} onInstall={confirm} />}
        </main>
        <NowPlaying />
        <DropZone />
        <UpdateNotice onOpen={confirm} />
        {confirming && (
          <UpdateDialog
            version={version}
            onClose={() => {
              setConfirming(false);
            }}
          />
        )}
      </div>
    </AppearanceProvider>
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

/**
 * Shown in the top bar once a newer version is found, like in Todoom. It
 * opens the update window, then shows the progress of the install.
 */
function UpdateButton({ onOpen }: { onOpen: () => void }) {
  const { available, status } = useUpdater();
  if (!available) return null;
  if (status.kind === "backingUp" || status.kind === "installing") {
    return <span className="update-btn busy">{statusLine(status)?.text}</span>;
  }
  // Small, on every page, until it is installed (KAN-51).
  return (
    <button className="update-btn" title="Voir les nouveautés et installer" onClick={onOpen}>
      ⬆ {available} disponible
    </button>
  );
}

export default App;
