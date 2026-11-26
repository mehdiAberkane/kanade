// The real Kanade, built with the e2e feature and driven through
// tauri-driver (e2e/setup.mjs): a library added from the interface, its
// tracks listed as the Rust side read them, and all of it found again after
// a restart, from the database.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, inject, it } from "vitest";
import { Session, waitFor } from "./webdriver.mjs";

const data = inject("data");
const files = inject("files");
const libraryName = inject("library");
const screenshots = inject("screenshots");

let kanade = null;

/** Starts Kanade, once sure it is the test build, on the test's database. */
async function launch() {
  kanade = await Session.start(inject("driver"), {
    "tauri:options": { application: inject("app") },
  });
  // Another build would open the user's database: stop before any click.
  await waitFor(
    () => existsSync(join(data, "kanade.db")),
    "the database in the test's folder: is kanade.exe the e2e build (npm run build:e2e)?",
    15_000,
  );
  return kanade;
}

/** The rows of the track list, each as { column label: text shown }. */
function rows() {
  return kanade.run(`
    const grid = document.querySelector('[role="grid"]');
    if (!grid) return [];
    const labels = [...grid.querySelectorAll('[role="columnheader"] .sort-btn')].map(
      (button) => button.firstChild.textContent,
    );
    return [...grid.querySelectorAll('.track-body [role="row"]')].map((row) =>
      Object.fromEntries(
        [...row.querySelectorAll('[role="gridcell"]')].map((cell, i) => [
          labels[i],
          cell.textContent,
        ]),
      ),
    );
  `);
}

/** Waits for the list to show every test file, and returns its rows. */
async function allTracks() {
  let seen = [];
  return waitFor(
    async () => {
      seen = await rows();
      return seen.length === files.length && seen;
    },
    () => `${files.length} tracks in the list, ${seen.length} shown`,
  );
}

/** The names of the libraries in the music page's side panel. */
function sideLibraries() {
  return kanade.run(`
    return [...document.querySelectorAll('nav[aria-label="Bibliothèques suivies"] .side-name')]
      .map((name) => name.textContent);
  `);
}

// A failed test leaves what the window showed (the CI keeps it), then the
// app is closed.
afterEach(async ({ task }) => {
  if (!kanade) return;
  if (task.result?.state === "fail") {
    mkdirSync(screenshots, { recursive: true });
    writeFileSync(join(screenshots, `${task.name}.png`), await kanade.screenshot());
  }
  await kanade.quit();
  kanade = null;
});

it("lists the tracks of a library added, and keeps them after a restart", async () => {
  await launch();
  // The folder picker of the e2e build answers with the test library.
  await waitFor(
    () =>
      kanade.run(`return [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Ajouter un dossier…",
      );`),
    "the button to add a first library",
  );
  await kanade.click(`//button[normalize-space()="Ajouter un dossier…"]`);

  // Untagged files: the title is the file's name, the rest from the audio.
  const tracks = await allTracks();
  expect(tracks.map((t) => t.Format).sort()).toEqual([
    "FLAC",
    "MP3",
    "MP4",
    "Ogg Vorbis",
    "Opus",
    "WAV",
  ]);
  for (const track of tracks) {
    expect(track.Titre).toBe("tone");
    expect(track.Durée).toMatch(/^0:0[01]$/);
  }
  expect(await sideLibraries()).toEqual(["Toute la musique", libraryName]);

  // A restart: the library and its tracks come back from the database.
  await kanade.quit();
  await launch();
  expect(await allTracks()).toEqual(tracks);
  expect(await sideLibraries()).toEqual(["Toute la musique", libraryName]);
});

/** The appearance as the page shows it and the window has it. */
function looks() {
  return kanade.run(`
    return window.__TAURI_INTERNALS__.invoke("plugin:window|theme", { label: "main" }).then(
      (window) => ({
        page: document.documentElement.dataset.theme,
        window,
        pixels: devicePixelRatio,
      }),
    );
  `);
}

// What only the real window shows: the title bar's theme and the zoom are
// allowed (capabilities), and the appearance comes back from the database
// (each session starts WebView2 with empty storage).
it("keeps the theme and the zoom chosen, in the window too, after a restart", async () => {
  await launch();
  await kanade.click(`//button[normalize-space()="Apparence"]`);
  await waitFor(
    () => kanade.run(`return !document.querySelector('input[name="theme"]').disabled;`),
    "the appearance read from the database",
  );
  const before = await looks();
  await kanade.click(`//label[normalize-space()="Sombre"]`);
  await kanade.click(`//button[@aria-label="Zoom avant"]`);
  const zoomed = (now) => Math.abs(now.pixels / before.pixels - 1.1) < 0.02;
  let now = before;
  await waitFor(
    async () => {
      now = await looks();
      return now.page === "dark" && now.window === "dark" && zoomed(now);
    },
    () => `a dark window zoomed to 110 %, got ${JSON.stringify({ before, now })}`,
  );
  await waitFor(
    () =>
      kanade.run(`return window.__TAURI_INTERNALS__.invoke("appearance_get").then(
        (kept) => kept.theme === "dark" && kept.zoom === 110,
      );`),
    "the appearance kept in the database",
  );

  await kanade.quit();
  await launch();
  await waitFor(
    async () => {
      now = await looks();
      return now.page === "dark" && now.window === "dark" && zoomed(now);
    },
    () => `the same after a restart, got ${JSON.stringify({ before, now })}`,
  );
});
