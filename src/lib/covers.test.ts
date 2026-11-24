// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

/** A fresh module: its covers kept and its queue start empty. */
async function fresh() {
  vi.resetModules();
  return import("./covers");
}

const JPEG = () => new Uint8Array([0xff, 0xd8, 0xff]);
let made: string[];
let released: string[];

beforeEach(() => {
  made = [];
  released = [];
  // jsdom has no object URLs.
  URL.createObjectURL = () => {
    const url = `blob:${made.length + 1}`;
    made.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    released.push(url);
  };
});

afterEach(() => {
  clearMocks();
});

describe("toBlob", () => {
  it("takes JPEG from the Rust side, SVG from the fake backend, nothing when empty", async () => {
    const { toBlob } = await fresh();
    expect(toBlob(JPEG())?.type).toBe("image/jpeg");
    expect(toBlob(new TextEncoder().encode("<svg/>"))?.type).toBe("image/svg+xml");
    expect(toBlob([0xff, 0xd8])?.size).toBe(2);
    expect(toBlob(new ArrayBuffer(3))?.size).toBe(3);
    expect(toBlob(new Uint8Array(0))).toBeNull();
  });
});

describe("loadCover", () => {
  it("asks once per cover and version, then keeps it", async () => {
    const asked: unknown[] = [];
    mockIPC((cmd, args) => {
      asked.push({ cmd, args });
      return JPEG();
    });
    const { loadCover } = await fresh();
    const [a, b] = await Promise.all([loadCover(7, 1, "small"), loadCover(7, 1, "small")]);
    expect(a).toBe("blob:1");
    expect(b).toBe("blob:1");
    expect(await loadCover(7, 1, "small")).toBe("blob:1");
    expect(asked).toEqual([{ cmd: "track_cover", args: { id: 7, size: "small" } }]);
    // Another size, or the file changed since: asked again.
    await loadCover(7, 1, "large");
    await loadCover(7, 2, "small");
    expect(asked).toHaveLength(3);
  });

  it("gives null for a track without cover, or when the Rust side fails", async () => {
    mockIPC((_, args) => {
      const id = (args as { id: number }).id;
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return id === 1 ? new Uint8Array(0) : Promise.reject({ code: "track_not_found" });
    });
    const { loadCover } = await fresh();
    expect(await loadCover(1, 0, "small")).toBeNull();
    expect(await loadCover(2, 0, "small")).toBeNull();
    // Kept too: not asked again.
    expect(await loadCover(1, 0, "small")).toBeNull();
    expect(made).toEqual([]);
  });

  it("asks six covers at a time", async () => {
    const answers: (() => void)[] = [];
    mockIPC(
      () =>
        new Promise((resolve) => {
          answers.push(() => {
            resolve(JPEG());
          });
        }),
    );
    const { loadCover } = await fresh();
    const all = Promise.all(Array.from({ length: 8 }, (_, i) => loadCover(i, 0, "small")));
    await vi.waitFor(() => {
      expect(answers).toHaveLength(6);
    });
    answers[0]();
    await vi.waitFor(() => {
      expect(answers).toHaveLength(7);
    });
    for (const answer of answers.slice(1)) answer();
    await vi.waitFor(() => {
      expect(answers).toHaveLength(8);
    });
    answers[7]();
    expect(await all).toHaveLength(8);
    expect(made).toHaveLength(8);
  });

  it("keeps the last 400 covers and releases the older ones", async () => {
    mockIPC((_, args) => ((args as { id: number }).id === 1000 ? new Uint8Array(0) : JPEG()));
    const { loadCover } = await fresh();
    // The oldest has no cover: nothing to release for it.
    await loadCover(1000, 0, "small");
    for (let id = 0; id < 401; id++) await loadCover(id, 0, "small");
    expect(released).toEqual(["blob:1"]);
    // The first is asked again; the second is still kept.
    await loadCover(1, 0, "small");
    expect(made).toHaveLength(401);
    await loadCover(0, 0, "small");
    expect(made).toHaveLength(402);
  });
});

describe("useCover", () => {
  it("says loading, then the cover; a cover already kept comes at once", async () => {
    mockIPC(() => JPEG());
    const covers = await fresh();
    const { renderHook, waitFor } = await import("@testing-library/react");
    await covers.loadCover(2, 0, "small");
    const hook = renderHook(({ id }) => covers.useCover(id, 0, "small"), {
      initialProps: { id: 1 },
    });
    expect(hook.result.current).toBeUndefined();
    await waitFor(() => {
      expect(hook.result.current).toBe("blob:2");
    });
    // Another track whose cover is kept: no waiting.
    hook.rerender({ id: 2 });
    expect(hook.result.current).toBe("blob:1");
    // Gone before its answer: nothing is set any more.
    hook.rerender({ id: 3 });
    hook.unmount();
  });
});
