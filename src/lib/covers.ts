// The albums' covers (KAN-4), as the Rust side makes them (track_cover): JPEG
// bytes asked by track id, turned into object URLs for the <img> tags. Kept
// for the session (the last few hundred), and asked a few at a time, so that
// scrolling through 2,000 albums does not queue 2,000 reads at once.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type CoverSize = "small" | "large";

/** Covers kept at most; the oldest gives way (its URL is released). */
const MAX_KEPT = 400;
/** Covers asked at the same time. */
const AT_ONCE = 6;

/** By `id:version:size`: an object URL, or null for no cover. */
const kept = new Map<string, string | null>();
const asked = new Map<string, Promise<string | null>>();
let running = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < AT_ONCE) {
    running += 1;
    return;
  }
  // The slot is handed over by release(): running stays the same.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

function remember(key: string, url: string | null) {
  kept.set(key, url);
  if (kept.size <= MAX_KEPT) return;
  const [oldest, oldUrl] = kept.entries().next().value as [string, string | null];
  kept.delete(oldest);
  // An <img> already drawn keeps its picture.
  if (oldUrl) URL.revokeObjectURL(oldUrl);
}

/** The bytes as an image: JPEG from the Rust side, SVG from the fake backend. */
export function toBlob(bytes: ArrayBuffer | Uint8Array<ArrayBuffer> | number[]): Blob | null {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length === 0) return null;
  const svg = data[0] === 0x3c; // "<"
  return new Blob([data], { type: svg ? "image/svg+xml" : "image/jpeg" });
}

/**
 * The cover of the track `id` as an object URL, or null when it has none.
 * `version` (the file's date) makes a new cover come after a rescan.
 */
export function loadCover(id: number, version: number, size: CoverSize): Promise<string | null> {
  const key = `${id}:${version}:${size}`;
  if (kept.has(key)) return Promise.resolve(kept.get(key) ?? null);
  const pending = asked.get(key);
  if (pending) return pending;
  const promise = (async () => {
    await acquire();
    try {
      const bytes = await invoke<ArrayBuffer | number[]>("track_cover", { id, size });
      const blob = toBlob(bytes);
      return blob ? URL.createObjectURL(blob) : null;
    } catch {
      // A track gone since, a file that went away: the default tile.
      return null;
    } finally {
      release();
    }
  })().then((url) => {
    remember(key, url);
    asked.delete(key);
    return url;
  });
  asked.set(key, promise);
  return promise;
}

/** The cover's URL; null for none, undefined while it is being made. */
export function useCover(id: number, version: number, size: CoverSize): string | null | undefined {
  const key = `${id}:${version}:${size}`;
  const [found, setFound] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void loadCover(id, version, size).then((url) => {
      if (live) setFound({ key, url });
    });
    return () => {
      live = false;
    };
  }, [id, version, size, key]);
  if (found?.key === key) return found.url;
  return kept.has(key) ? kept.get(key) : undefined;
}
