// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Outcome, Player, Players } from "./player";

const vlc: Player = {
  id: "vlc",
  name: "VLC",
  path: String.raw`C:\Program Files\VideoLAN\VLC\vlc.exe`,
  enqueue: true,
};

const outcome = (fields: Partial<Outcome> = {}): Outcome => ({
  launched: true,
  player: "VLC",
  online: 0,
  playlist: false,
  onlyFirst: false,
  fellBack: false,
  ...fields,
});

/** A fresh module: its icons cache starts empty. */
async function fresh() {
  vi.resetModules();
  return import("./player");
}

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

describe("the player in use", () => {
  it("names Kanade's own, the program chosen, else what Windows opens with", async () => {
    const { playerInUse, WINDOWS_PLAYER } = await fresh();
    const program = (available: boolean): Players => ({
      chosen: { kind: "program", player: vlc, available },
      detected: [vlc],
    });
    const other = { builtin: false, other: null };
    expect(playerInUse(program(true))).toEqual({ name: "VLC", enqueue: true, ...other });
    // Gone: Windows' own plays.
    expect(playerInUse(program(false))).toEqual({
      name: WINDOWS_PLAYER,
      enqueue: false,
      ...other,
    });
    expect(playerInUse({ chosen: { kind: "default", opensWith: vlc }, detected: [] })).toEqual({
      name: "VLC",
      enqueue: true,
      ...other,
    });
    expect(playerInUse({ chosen: { kind: "default", opensWith: null }, detected: [] }).name).toBe(
      "le lecteur de Windows",
    );
    // Kanade's own (KAN-8), by default too; « Lire avec » what Windows opens with.
    expect(playerInUse({ chosen: { kind: "builtin", opensWith: vlc }, detected: [] })).toEqual({
      name: "Kanade",
      enqueue: true,
      builtin: true,
      other: "VLC",
    });
    expect(playerInUse(null)).toMatchObject({ builtin: true, other: WINDOWS_PLAYER });
  });

  it("says what a play did when there is something to say", async () => {
    const { onlineQuestion, outcomeText } = await fresh();
    expect(outcomeText(outcome())).toBeNull();
    expect(outcomeText(outcome({ onlyFirst: true }))).toMatch(/^Le lecteur de Windows ne lit/);
    expect(outcomeText(outcome({ fellBack: true }))).toMatch(/^Le lecteur choisi est introuvable/);
    expect(outcomeText(outcome({ playlist: true }))).toMatch(/liste de lecture \(M3U8\)\.$/);
    expect(onlineQuestion(1)).toBe(
      "1 morceau n'est que sur OneDrive : les lire les fera télécharger. Les lire quand même ?",
    );
    expect(onlineQuestion(3)).toMatch(/^3 morceaux ne sont que sur OneDrive/);
  });
});

describe("a player's icon", () => {
  it("is asked once, as a PNG or an SVG, and none when there is none", async () => {
    const asked: unknown[] = [];
    mockIPC((_, args) => {
      const { id } = args as { id: string };
      asked.push(id);
      if (id === "png") return new Uint8Array([0x89, 0x50]);
      if (id === "svg") return new TextEncoder().encode("<svg/>");
      if (id === "none") return new Uint8Array(0);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the Rust side rejects with the error object
      return Promise.reject({ code: "player_not_found" });
    });
    const types: string[] = [];
    // jsdom makes no blob URL: one of the test's own.
    URL.createObjectURL = (blob: Blob) => {
      types.push(blob.type);
      return `blob:${String(types.length)}`;
    };
    const { playerIcon } = await fresh();
    expect(await playerIcon("png")).toBe("blob:1");
    expect(await playerIcon("png")).toBe("blob:1");
    expect(await playerIcon("svg")).toBe("blob:2");
    expect(await playerIcon("none")).toBeNull();
    expect(await playerIcon("gone")).toBeNull();
    expect(types).toEqual(["image/png", "image/svg+xml"]);
    expect(asked).toEqual(["png", "svg", "none", "gone"]);
  });
});
