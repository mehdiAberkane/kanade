// @vitest-environment jsdom
// jsdom draws nothing: the image and the canvas are stand-ins, to check
// what is asked of them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { standalone, summaryPng, SummaryImageError } from "./summaryImage";

function card(viewBox: string | null = "0 0 800 340") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (viewBox) svg.setAttribute("viewBox", viewBox);
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("style", "fill: red");
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.textContent = "50 000 morceaux";
  svg.append(rect, text);
  document.body.append(svg);
  return svg;
}

function fakeDrawing(options: { context?: boolean; blob?: boolean } = {}) {
  const drawn: unknown[][] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () =>
      options.context === false ? null : { drawImage: (...args: unknown[]) => drawn.push(args) },
    toBlob: (done: (blob: Blob | null) => void, type: string) => {
      done(options.blob === false ? null : new Blob([new Uint8Array([0x89, 0x50])], { type }));
    },
  };
  // Only the canvas is made by createElement here: the card is made by
  // createElementNS.
  vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLElement);
  const images: { src: string }[] = [];
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      constructor() {
        images.push(this);
      }
      decode() {
        return Promise.resolve();
      }
    },
  );
  return { canvas, drawn, images };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("the summary as a picture", () => {
  it("writes each element's styles on it, and its size", () => {
    const xml = standalone(card());
    expect(xml).toContain('width="800"');
    expect(xml).toContain('height="340"');
    expect(xml.match(/xmlns="http:\/\/www.w3.org\/2000\/svg"/g)).toHaveLength(1);
    expect(xml).toMatch(/<rect style="fill:rgb\(255, 0, 0\)/);
    expect(xml).toContain("50 000 morceaux");
  });

  it("draws it twice its size, as a PNG", async () => {
    const { canvas, drawn, images } = fakeDrawing();
    const png = await summaryPng(card());
    expect([canvas.width, canvas.height]).toEqual([1600, 680]);
    expect(images[0].src).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    expect(drawn[0].slice(1)).toEqual([0, 0, 1600, 680]);
    expect([...png]).toEqual([0x89, 0x50]);
  });

  it("says when it cannot be drawn", async () => {
    fakeDrawing({ context: false });
    await expect(summaryPng(card())).rejects.toBeInstanceOf(SummaryImageError);
    vi.restoreAllMocks();
    fakeDrawing({ blob: false });
    await expect(summaryPng(card())).rejects.toThrow("Impossible de dessiner l'image du résumé.");
    expect(() => standalone(card(null))).toThrow("Ce résumé n'a pas de taille.");
  });
});
