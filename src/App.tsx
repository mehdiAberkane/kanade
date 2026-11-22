import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    invoke<string>("app_version")
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  return (
    <main className="container">
      <h1>Kanade</h1>
      <p>Gestionnaire de bibliothèque musicale{version && ` — v${version}`}</p>
    </main>
  );
}

export default App;
