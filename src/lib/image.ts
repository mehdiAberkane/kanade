// The background image of the Appearance page (KAN-44): the picked file is
// read and reduced here, then its JPEG bytes go to the Rust side, which keeps
// them in a file of its own (background.rs). No path ever leaves the page.

/** The longest side kept, sharp enough full-screen (background.rs checks it). */
export const MAX_SIDE = 2560;
const QUALITY = 0.85;

export class ImageError extends Error {}

/** A JPEG of the picked image, at most MAX_SIDE pixels a side. */
export async function imageToBackground(file: File): Promise<Uint8Array<ArrayBuffer>> {
  if (!file.type.startsWith("image/")) {
    throw new ImageError("Ce fichier n'est pas une image : choisis une photo (JPEG, PNG, WebP…).");
  }
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new ImageError("Cette image ne s'ouvre pas : elle est peut-être abîmée.");
  });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new ImageError("Impossible de préparer l'image.");
  // JPEG has no transparency: a transparent PNG would turn black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", QUALITY);
  });
  if (!blob) throw new ImageError("Impossible de préparer l'image.");
  return new Uint8Array(await blob.arrayBuffer());
}
