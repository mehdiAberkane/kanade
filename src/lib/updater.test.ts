import { describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import {
  checkFailureText,
  createUpdater,
  NBSP,
  releaseNotes,
  statusLine,
  type FoundUpdate,
  type UpdateSource,
} from "./updater";

const NO_RELEASE = "Could not fetch a valid release JSON from the remote";

/** An update whose download sends the given events, then succeeds or fails. */
function fakeUpdate(version: string, events: DownloadEvent[] = [], fail?: string): FoundUpdate {
  return {
    version,
    downloadAndInstall: vi.fn((onEvent?: (event: DownloadEvent) => void) => {
      for (const event of events) onEvent?.(event);
      return fail ? Promise.reject(new Error(fail)) : Promise.resolve();
    }),
  };
}

function source(found: FoundUpdate | null | Error): UpdateSource {
  return {
    check: vi.fn(() => (found instanceof Error ? Promise.reject(found) : Promise.resolve(found))),
    relaunch: vi.fn(() => Promise.resolve()),
    backup: vi.fn(() => Promise.resolve()),
    automatic: vi.fn(() => Promise.resolve(true)),
  };
}

describe("createUpdater", () => {
  it("starts idle, with no update known", () => {
    const updater = createUpdater(source(null));
    expect(updater.getState()).toEqual({ available: null, notes: [], status: { kind: "idle" } });
  });

  it("says Kanade is up to date when GitHub has nothing newer", async () => {
    const updater = createUpdater(source(null));
    await updater.checkNow();
    expect(updater.getState()).toEqual({
      available: null,
      notes: [],
      status: { kind: "upToDate" },
    });
  });

  it("shows the newer version found", async () => {
    const updater = createUpdater(source(fakeUpdate("0.3.0")));
    await updater.checkNow();
    expect(updater.getState()).toEqual({
      available: "0.3.0",
      notes: [],
      status: { kind: "idle" },
    });
  });

  it("keeps the notes of the version found, a line per change", async () => {
    const update = { ...fakeUpdate("0.3.0"), body: "- KAN-3: the list (#19)\n- KAN-2: libraries" };
    const updater = createUpdater(source(update));
    await updater.checkNow();
    expect(updater.getState().notes).toEqual(["KAN-3: the list", "KAN-2: libraries"]);
  });

  it("shows 'checking' while the check runs, and notifies the screen", async () => {
    const updater = createUpdater(source(null));
    const seen: string[] = [];
    updater.subscribe(() => seen.push(updater.getState().status.kind));
    await updater.checkNow();
    expect(seen).toEqual(["checking", "upToDate"]);
  });

  it("stops notifying once unsubscribed", async () => {
    const updater = createUpdater(source(null));
    const listener = vi.fn();
    const unsubscribe = updater.subscribe(listener);
    unsubscribe();
    await updater.checkNow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("reports a failed check asked for with the button", async () => {
    const updater = createUpdater(source(new Error(NO_RELEASE)));
    await updater.checkNow();
    expect(updater.getState().status).toEqual({ kind: "checkFailed", message: NO_RELEASE });
  });

  it("keeps quiet when the automatic check fails", async () => {
    const updater = createUpdater(source(new Error("offline")));
    await updater.checkInBackground();
    expect(updater.getState()).toEqual({ available: null, notes: [], status: { kind: "idle" } });
  });

  it("finds an update in the background without changing the status line", async () => {
    const updater = createUpdater(source(fakeUpdate("0.3.0")));
    await updater.checkInBackground();
    expect(updater.getState()).toEqual({
      available: "0.3.0",
      notes: [],
      status: { kind: "idle" },
    });
  });

  it("skips the automatic check when the settings turn it off, not the button", async () => {
    const src = source(fakeUpdate("0.3.0"));
    src.automatic = vi.fn(() => Promise.resolve(false));
    const updater = createUpdater(src);
    await updater.checkInBackground();
    expect(src.check).not.toHaveBeenCalled();
    expect(updater.getState().available).toBeNull();
    await updater.checkNow();
    expect(updater.getState().available).toBe("0.3.0");
  });

  it("checks automatically when the settings cannot be read", async () => {
    const src = source(fakeUpdate("0.3.0"));
    src.automatic = vi.fn(() => Promise.reject(new Error("database closed")));
    const updater = createUpdater(src);
    await updater.checkInBackground();
    expect(updater.getState().available).toBe("0.3.0");
  });

  it("does not check in the background if a check started while it read the settings", async () => {
    let answer: (on: boolean) => void = () => {};
    let found: (update: FoundUpdate | null) => void = () => {};
    const src = source(null);
    src.automatic = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    src.check = vi.fn(() => new Promise<FoundUpdate | null>((resolve) => (found = resolve)));
    const updater = createUpdater(src);
    const background = updater.checkInBackground();
    const now = updater.checkNow();
    answer(true);
    await background;
    found(null);
    await now;
    expect(src.check).toHaveBeenCalledOnce();
  });

  it("does nothing on install when no update was found", async () => {
    const src = source(null);
    const updater = createUpdater(src);
    await updater.install();
    expect(updater.getState().status).toEqual({ kind: "idle" });
    expect(src.relaunch).not.toHaveBeenCalled();
  });

  it("downloads with progress, installs, then restarts", async () => {
    const update = fakeUpdate("0.3.0", [
      { event: "Started", data: { contentLength: 1000 } },
      { event: "Progress", data: { chunkLength: 250 } },
      { event: "Progress", data: { chunkLength: 500 } },
      { event: "Progress", data: { chunkLength: 250 } },
      { event: "Finished" },
    ]);
    const src = source(update);
    const updater = createUpdater(src);
    await updater.checkNow();
    const progress: (number | null)[] = [];
    updater.subscribe(() => {
      const status = updater.getState().status;
      if (status.kind === "installing") progress.push(status.progress);
    });
    await updater.install();
    expect(progress).toEqual([null, 0.25, 0.75, 1, 1]);
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
    expect(src.relaunch).toHaveBeenCalledOnce();
  });

  it("copies the data before the download, and says so", async () => {
    const order: string[] = [];
    const update = fakeUpdate("0.3.0");
    update.downloadAndInstall = vi.fn(() => {
      order.push("download");
      return Promise.resolve();
    });
    const src = source(update);
    src.backup = vi.fn(() => {
      order.push("backup");
      return Promise.resolve();
    });
    const updater = createUpdater(src);
    await updater.checkNow();
    const kinds: string[] = [];
    updater.subscribe(() => kinds.push(updater.getState().status.kind));
    await updater.install();
    expect(order).toEqual(["backup", "download"]);
    expect(kinds[0]).toBe("backingUp");
  });

  it("installs nothing when the data cannot be copied, and lets it be tried again", async () => {
    const update = fakeUpdate("0.3.0");
    const src = source(update);
    src.backup = vi.fn(() => Promise.reject(new Error("Erreur de la base de Kanade : disk full")));
    const updater = createUpdater(src);
    await updater.checkNow();
    await updater.install();
    expect(updater.getState().status).toEqual({
      kind: "backupFailed",
      message: "Erreur de la base de Kanade : disk full",
    });
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(src.relaunch).not.toHaveBeenCalled();
    src.backup = vi.fn(() => Promise.resolve());
    await updater.install();
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("ignores a second install while the data is being copied", async () => {
    let copied: () => void = () => {};
    const update = fakeUpdate("0.3.0");
    const src = source(update);
    src.backup = vi.fn(() => new Promise<void>((resolve) => (copied = resolve)));
    const updater = createUpdater(src);
    await updater.checkNow();
    const first = updater.install();
    await updater.install();
    await updater.checkNow();
    expect(src.backup).toHaveBeenCalledOnce();
    expect(src.check).toHaveBeenCalledOnce();
    copied();
    await first;
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("refreshes the progress once per whole percent, not per chunk", async () => {
    const chunks: DownloadEvent[] = Array.from({ length: 1000 }, () => ({
      event: "Progress" as const,
      data: { chunkLength: 10 },
    }));
    const update = fakeUpdate("0.3.0", [
      { event: "Started", data: { contentLength: 10_000 } },
      ...chunks,
    ]);
    const updater = createUpdater(source(update));
    await updater.checkNow();
    const listener = vi.fn();
    updater.subscribe(listener);
    await updater.install();
    // The copy of the data, "installing" with no size yet, then 0 %, 1 % … 100 %.
    expect(listener).toHaveBeenCalledTimes(1 + 1 + 101);
  });

  it("keeps an unknown size as indeterminate progress", async () => {
    const update = fakeUpdate("0.3.0", [
      { event: "Started", data: {} },
      { event: "Progress", data: { chunkLength: 4096 } },
    ]);
    const src = source(update);
    // Stop before the restart to look at the status.
    src.relaunch = vi.fn(() => new Promise<void>(() => {}));
    const updater = createUpdater(src);
    await updater.checkNow();
    void updater.install();
    await vi.waitFor(() => {
      expect(src.relaunch).toHaveBeenCalled();
    });
    expect(updater.getState().status).toEqual({ kind: "installing", progress: null });
  });

  it("reports a failed install and lets it be tried again", async () => {
    const update = fakeUpdate("0.3.0", [], "signature verification failed");
    const src = source(update);
    const updater = createUpdater(src);
    await updater.checkNow();
    await updater.install();
    expect(updater.getState()).toEqual({
      available: "0.3.0",
      notes: [],
      status: { kind: "installFailed", message: "signature verification failed" },
    });
    expect(src.relaunch).not.toHaveBeenCalled();
    await updater.install();
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(2);
  });

  it("ignores a second check or install while one is running", async () => {
    let finish: (value: FoundUpdate | null) => void = () => {};
    const src: UpdateSource = {
      ...source(null),
      check: vi.fn(() => new Promise<FoundUpdate | null>((resolve) => (finish = resolve))),
    };
    const updater = createUpdater(src);
    const first = updater.checkNow();
    await updater.checkNow();
    await updater.checkInBackground();
    expect(src.check).toHaveBeenCalledOnce();
    finish(null);
    await first;
    expect(updater.getState().status).toEqual({ kind: "upToDate" });
  });

  it("forgets an update that GitHub no longer offers", async () => {
    let offered: FoundUpdate | null = fakeUpdate("0.3.0");
    const updater = createUpdater({ ...source(null), check: () => Promise.resolve(offered) });
    await updater.checkInBackground();
    expect(updater.getState().available).toBe("0.3.0");
    offered = null;
    await updater.checkInBackground();
    expect(updater.getState().available).toBeNull();
  });
});

describe("statusLine", () => {
  it("says nothing while idle or checking (the button says it)", () => {
    expect(statusLine({ kind: "idle" })).toBeNull();
    expect(statusLine({ kind: "checking" })).toBeNull();
  });

  it("describes each result", () => {
    expect(statusLine({ kind: "upToDate" })).toEqual({ text: "✓ Kanade est à jour", tone: "ok" });
    expect(statusLine({ kind: "checkFailed", message: "dns error" })).toEqual({
      text: "⚠ Impossible de joindre GitHub, réessaie plus tard.",
      tone: "error",
      detail: "dns error",
    });
    expect(statusLine({ kind: "installFailed", message: "bad signature" })).toEqual({
      text: "⚠ La mise à jour a échoué, réessaie.",
      tone: "error",
      detail: "bad signature",
    });
    expect(statusLine({ kind: "backupFailed", message: "disk full" })).toEqual({
      text: "⚠ Sauvegarde des données impossible : rien n'a été installé.",
      tone: "error",
      detail: "disk full",
    });
  });

  it("shows the copy of the data, the download progress, then the install", () => {
    expect(statusLine({ kind: "backingUp" })?.text).toBe("Sauvegarde des données…");
    expect(statusLine({ kind: "installing", progress: null })?.text).toBe("Téléchargement…");
    expect(statusLine({ kind: "installing", progress: 0.42 })?.text).toBe(
      `Téléchargement… 42${NBSP}%`,
    );
    expect(statusLine({ kind: "installing", progress: 1 })?.text).toBe("Installation…");
  });
});

describe("checkFailureText", () => {
  it("explains that nothing is published yet (GitHub answers 404)", () => {
    expect(checkFailureText(NO_RELEASE)).toBe("Aucune version publiée sur GitHub pour l'instant.");
  });

  it("blames the connection otherwise", () => {
    expect(checkFailureText("error sending request for url (https://github.com/…)")).toBe(
      "Impossible de joindre GitHub, réessaie plus tard.",
    );
  });
});

describe("releaseNotes", () => {
  it("gives a line per change, without list marks nor pull request numbers", () => {
    expect(
      releaseNotes(
        [
          "- KAN-3: the list of tracks (#19)",
          "",
          "* docs: publish a release (#15)  ",
          "Plain line",
        ].join("\r\n"),
      ),
    ).toEqual(["KAN-3: the list of tracks", "docs: publish a release", "Plain line"]);
  });

  it("keeps numbers that are not a pull request at the end", () => {
    expect(releaseNotes("- Fix #12 in the middle (see #3) here")).toEqual([
      "Fix #12 in the middle (see #3) here",
    ]);
  });

  it("is empty without notes", () => {
    expect(releaseNotes(undefined)).toEqual([]);
    expect(releaseNotes("  \n ")).toEqual([]);
  });
});
