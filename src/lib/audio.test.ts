import { describe, expect, it } from "vitest";
import { addedText, clock, nextRepeat, noticeText, REPEAT_LABELS } from "./audio";

describe("the built-in player's texts", () => {
  it("shows times as a clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(187_400)).toBe("3:07");
    expect(clock(3_723_000)).toBe("1:02:03");
    expect(clock(-5)).toBe("0:00");
  });

  it("goes round the repeats", () => {
    expect(nextRepeat("off")).toBe("all");
    expect(nextRepeat("all")).toBe("one");
    expect(nextRepeat("one")).toBe("off");
    expect(REPEAT_LABELS.one).toBe("Répéter : ce morceau");
  });

  it("says why a track was skipped, or the player stopped", () => {
    expect(noticeText({ kind: "skipped", title: "So What", reason: "gone" })).toBe(
      "« So What » passé : fichier introuvable.",
    );
    expect(noticeText({ kind: "skipped", title: "A", reason: "format" })).toMatch(/format non lu/);
    expect(noticeText({ kind: "skipped", title: "A", reason: "unreadable" })).toMatch(/illisible/);
    expect(noticeText({ kind: "stopped" })).toMatch(/^Lecture arrêtée/);
    expect(noticeText({ kind: "no_output", message: "no device" })).toBe(
      "Aucune sortie audio : no device",
    );
  });

  it("says what adding tracks did, when there is something to say", () => {
    expect(addedText({ online: 0, leftOut: 0, windows: null })).toBeNull();
    expect(addedText({ online: 0, leftOut: 2, windows: null })).toBe(
      "2 morceaux laissés de côté : le lecteur intégré ne lit pas leur format (Opus, APE, WavPack…).",
    );
    expect(addedText({ online: 0, leftOut: 0, windows: { launched: true } })).toMatch(
      /lecteur de Windows s'en charge/,
    );
  });
});
