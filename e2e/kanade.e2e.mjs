// The real Kanade, built with the e2e feature and driven through
// tauri-driver (e2e/setup.mjs): a library added from the interface, its
// tracks listed as the Rust side read them, and all of it found again after
// a restart, from the database.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, inject, it } from "vitest";
import { Session, waitFor } from "./webdriver.mjs";

const data = inject("data");
const files = inject("files");
const libraryName = inject("library");
const libraryPath = inject("libraryPath");
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
  // After a restart the database is there already: the page may still be
  // loading, without Tauri's bridge yet.
  await waitFor(
    () =>
      kanade.run(
        `return document.readyState === "complete" && "__TAURI_INTERNALS__" in window ` +
          `&& document.querySelector(".app") !== null;`,
      ),
    "Kanade's page loaded",
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

/** The heart and the stars of the row of track `id`, as the list shows them. */
function marksOf(id) {
  return kanade.run(
    `const row = document.getElementById("track-" + arguments[0]);
    return row && {
      favorite: row.querySelector('[aria-label="Favori"]').getAttribute("aria-pressed"),
      stars: row.querySelectorAll('.stars [aria-pressed="true"]').length,
    };`,
    id,
  );
}

// KAN-32: a favourite and a rating set from the list are kept by the Rust
// side, on the track, and shown again after a restart.
it("keeps a favourite and a rating set from the list after a restart", async () => {
  await launch();
  await allTracks();
  const first = '//div[@role="row"][@aria-rowindex="2"]';
  const id = await kanade.run(
    `return document.querySelector('[role="row"][aria-rowindex="2"]').id.replace("track-", "");`,
  );
  // Selected, the row shows its heart; the 4 key rates the selection.
  await kanade.click(`${first}//div[@role="gridcell"][1]`);
  await kanade.type('//div[@role="grid"]', "4");
  await kanade.click(`${first}//button[@aria-label="Favori"]`);
  await waitFor(
    () =>
      kanade.run(
        `return window.__TAURI_INTERNALS__.invoke("tracks_list").then((rows) => {
          const row = rows.find((r) => String(r[0]) === arguments[0]);
          return row[21] === true && row[22] === 4;
        });`,
        id,
      ),
    "the favourite and the rating kept in the database",
  );
  expect(await marksOf(id)).toEqual({ favorite: "true", stars: 4 });

  await kanade.quit();
  await launch();
  await allTracks();
  expect(await marksOf(id)).toEqual({ favorite: "true", stars: 4 });
});

// KAN-27: a file copied into the library's folder while Kanade is open
// comes into the list by itself, through the watch of the folder.
it("shows a file copied into the library while it is open", async () => {
  await launch();
  await allTracks();
  mkdirSync(join(libraryPath, "Ajouts"));
  copyFileSync(join(libraryPath, files[0]), join(libraryPath, "Ajouts", files[0]));
  let seen = [];
  await waitFor(
    async () => {
      seen = await rows();
      return seen.length === files.length + 1;
    },
    () => `${files.length + 1} tracks after the copy, ${seen.length} shown`,
  );
  await waitFor(
    () => kanade.run(`return document.querySelector(".watch-news")?.textContent;`),
    "the line saying what the watch brought",
  );
  expect(await kanade.run(`return document.querySelector(".watch-news").textContent;`)).toBe(
    "1 morceau ajouté",
  );
});

/** Opens the track menu on the first row, as a right click does. */
function menuOnFirstRow() {
  return kanade.run(`
    const row = document.querySelector('[role="row"][aria-rowindex="2"]');
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + 5,
    }));
    return row.id.replace("track-", "");
  `);
}

/** The title of the editor's window, once it shows one. */
function editorTitle(title) {
  return waitFor(
    () =>
      kanade.run(
        `return document.getElementById("tag-editor-title")?.textContent === arguments[0];`,
        title,
      ),
    `the tag editor's « ${title} »`,
  );
}

/** Whether the file holds `text`, in the encodings the tags use. */
function holds(path, text) {
  const bytes = readFileSync(path);
  return (
    bytes.includes(Buffer.from(text, "latin1")) || bytes.includes(Buffer.from(text, "utf16le"))
  );
}

// KAN-7: a title typed in the tag editor is written into the file itself,
// then the undo takes it out again.
it("writes a title into the file from the tag editor, and undoes it", async () => {
  await launch();
  let seen = [];
  await waitFor(
    async () => {
      seen = await rows();
      return seen.length >= files.length;
    },
    () => `the tracks in the list, ${seen.length} shown`,
  );
  const id = await menuOnFirstRow();
  const path = await kanade.run(
    `return window.__TAURI_INTERNALS__.invoke("tracks_list").then(
      (rows) => rows.find((r) => String(r[0]) === arguments[0])[4],
    );`,
    id,
  );
  const title = "Written by Kanade";
  expect(holds(path, title)).toBe(false);

  await kanade.click(`//button[normalize-space()="Modifier les tags…"]`);
  await editorTitle("Modifier les tags");
  await kanade.type(`//input[@id="tag-title"]`, title);
  await kanade.click(`//button[normalize-space()="Enregistrer"]`);
  await editorTitle("Tags enregistrés");
  expect(holds(path, title)).toBe(true);
  await kanade.click(`//button[normalize-space()="Fermer"]`);
  await waitFor(
    async () => (await rows()).some((row) => row.Titre === title),
    "the new title in the list",
  );

  await menuOnFirstRow();
  await kanade.click(`//button[normalize-space()="Annuler la dernière modification des tags"]`);
  await editorTitle("Modification annulée");
  expect(holds(path, title)).toBe(false);
});
