// The statistics' summary as a picture (KAN-36): the SVG card the page shows,
// drawn on a canvas and saved as a PNG by the Rust side (summary.rs). Drawn
// alone, an SVG loses the page's CSS: the styles each element has on screen
// are written on it first, so the picture looks as the page does.

/** What an SVG needs to look as on screen: colours, text, lines. */
const STYLES = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
];

/** Twice the size of the card: sharp on a high-density screen. */
const SCALE = 2;

export class SummaryImageError extends Error {}

/** The card's own size, from its viewBox (« 0 0 800 360 »). */
function sizeOf(svg: SVGSVGElement): { width: number; height: number } {
  const [, , width, height] = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  if (!width || !height) throw new SummaryImageError("Ce résumé n'a pas de taille.");
  return { width, height };
}

/** The card with its styles written on each element, as SVG text. */
export function standalone(svg: SVGSVGElement): string {
  const { width, height } = sizeOf(svg);
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  from.forEach((element, i) => {
    const computed = getComputedStyle(element);
    const style = STYLES.map((name) => [name, computed.getPropertyValue(name)])
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
    to[i].setAttribute("style", style);
  });
  // The serializer names the SVG namespace itself.
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  return new XMLSerializer().serializeToString(copy);
}

/** The card as a PNG, twice its size. */
export async function summaryPng(svg: SVGSVGElement): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height } = sizeOf(svg);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standalone(svg))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const context = canvas.getContext("2d");
  if (!context) throw new SummaryImageError("Impossible de dessiner l'image du résumé.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) throw new SummaryImageError("Impossible de dessiner l'image du résumé.");
  return new Uint8Array(await blob.arrayBuffer());
}
