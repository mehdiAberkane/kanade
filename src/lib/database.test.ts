import { describe, expect, it } from "vitest";
import { backupDate, databaseMessage } from "./database";

const BROKEN = String.raw`C:\Data\kanade-broken-20261124-101500.db`;
const NOON_UTC = Date.UTC(2026, 10, 23, 12);

describe("databaseMessage", () => {
  it("says nothing when the database opened normally", () => {
    expect(databaseMessage({ state: "ready" })).toBeNull();
  });

  it("tells a restoration, with the date of the backup and the damaged file", () => {
    const message = databaseMessage(
      { state: "restored", broken: BROKEN, backupTakenMs: NOON_UTC },
      "UTC",
    );
    expect(message?.tone).toBe("warning");
    expect(message?.text).toContain("restaurée depuis la sauvegarde du 23 novembre 2026");
    expect(message?.text).toContain("12:00");
    expect(message?.text).toContain("Ce qui a changé depuis est perdu.");
    expect(message?.text).toContain(BROKEN);
  });

  it("tells a fresh start when no backup could be read", () => {
    const message = databaseMessage({ state: "started_empty", broken: BROKEN });
    expect(message?.tone).toBe("warning");
    expect(message?.text).toContain("repart d'une base vide");
    expect(message?.text).toContain(BROKEN);
  });

  it("asks for an update when the database comes from a newer Kanade", () => {
    const message = databaseMessage({
      state: "failed",
      error: { code: "newer_version", found: 3, supported: 2 },
    });
    expect(message).toEqual({
      tone: "error",
      text:
        "Cette base vient d'une version plus récente de Kanade : mets Kanade à jour " +
        "(Réglages › Mises à jour). Rien n'a été modifié.",
    });
  });

  it.each(["io", "database"] as const)("shows the cause of a %s failure", (code) => {
    const message = databaseMessage({ state: "failed", error: { code, message: "disk full" } });
    expect(message).toEqual({
      tone: "error",
      text: "Impossible d'ouvrir la base de Kanade : disk full",
    });
  });
});

describe("backupDate", () => {
  it("reads in French, in the given time zone", () => {
    expect(backupDate(NOON_UTC, "UTC")).toBe("23 novembre 2026 à 12:00");
    expect(backupDate(NOON_UTC, "Europe/Paris")).toBe("23 novembre 2026 à 13:00");
  });
});
