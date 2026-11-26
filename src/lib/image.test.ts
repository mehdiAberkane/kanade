// @vitest-environment jsdom
// jsdom draws nothing: the bitmap and the canvas are stand-ins, to check
// what is asked of them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageError, imageToBackground, MAX_SIDE } from "./image";

const picture = (type = "image/png") => new File([new Uint8Array([1, 2, 3])], "fond.png", { type });

function fakeCanvas(options: { context?: boolean; blob?: boolean } = {}) {
  const drawn: unknown[][] = [];
  const context = {
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: (...args: unknown[]) => drawn.push(args),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => (options.context === false ? null : context),
    toBlob: (done: (blob: Blob | null) => void, type: string, quality: number) => {
      done(
        options.blob === false
          ? null
          : new Blob([new Uint8Array([0xff, 0xd8, 0xff, quality > 0.8 ? 1 : 0])], { type }),
      );
    },
  };
  vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLElement);
  return { canvas, context, drawn };
}

function fakeBitmap(width: number, height: number) {
  const bitmap = { width, height, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", () => Promise.resolve(bitmap));
  return bitmap;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("imageToBackground", () => {
  it("reduces a large picture to 2,560 px on a white ground, as a JPEG", async () => {
    const bitmap = fakeBitmap(5120, 2880);
    const { canvas, context, drawn } = fakeCanvas();
    const jpeg = await imageToBackground(picture());
    expect([canvas.width, canvas.height]).toEqual([MAX_SIDE, 1440]);
    expect(context.fillStyle).toBe("#ffffff");
    expect(drawn).toEqual([[bitmap, 0, 0, MAX_SIDE, 1440]]);
    expect(bitmap.close).toHaveBeenCalled();
    expect([...jpeg]).toEqual([0xff, 0xd8, 0xff, 1]);
  });

  it("keeps a small picture at its size", async () => {
    fakeBitmap(800, 600);
    const { canvas } = fakeCanvas();
    await imageToBackground(picture("image/webp"));
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
  });

  it("refuses what is not an image, or does not open", async () => {
    await expect(imageToBackground(picture("audio/mpeg"))).rejects.toThrow(ImageError);
    vi.stubGlobal("createImageBitmap", () => Promise.reject(new Error("broken")));
    await expect(imageToBackground(picture())).rejects.toThrow(/ne s'ouvre pas/);
  });

  it("says so when the canvas cannot draw or encode", async () => {
    fakeBitmap(10, 10);
    fakeCanvas({ context: false });
    await expect(imageToBackground(picture())).rejects.toThrow(/préparer/);
    vi.restoreAllMocks();
    fakeBitmap(10, 10);
    fakeCanvas({ blob: false });
    await expect(imageToBackground(picture())).rejects.toThrow(/préparer/);
  });
});
