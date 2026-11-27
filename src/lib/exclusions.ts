// What a library leaves out (KAN-43): sub-folders and extensions, kept by
// the Rust side with the library (library/exclusions.rs). The interface
// shows them and asks for changes; a folder to leave out comes from the
// picker opened on the Rust side, or from a track of the list, by its id.

/** What a library leaves out, as the Rust side lists it. */
export interface Exclusions {
  /** Under the library's folder (« Podcasts », « Divers\Livres audio »). */
  folders: string[];
  /** In lower case, without the dot. */
  extensions: string[];
}

/**
 * The extensions Kanade reads (library/track.rs, AUDIO_EXTENSIONS): one box
 * each. A Rust test checks that this list has them all.
 */
export const AUDIO_EXTENSIONS = [
  "mp3",
  "flac",
  "m4a",
  "m4b",
  "mp4",
  "aac",
  "ogg",
  "oga",
  "opus",
  "wav",
  "aif",
  "aiff",
  "wv",
  "ape",
  "mpc",
  "spx",
  "wma",
] as const;

/** Folders and extensions left out, together. */
export function exclusionCount(exclusions: Exclusions): number {
  return exclusions.folders.length + exclusions.extensions.length;
}

/** Without the trailing `\` a drive root has (« D:\ »). */
const trimmed = (folder: string) => folder.replace(/\\+$/, "");

/**
 * The folder of the file at `path`, under the library's folder `root`;
 * null when the file is at the root itself, which cannot be left out.
 * Compared without case, as Windows does.
 */
export function folderUnder(path: string, root: string): string | null {
  const base = trimmed(root);
  const folder = path.slice(0, Math.max(0, path.lastIndexOf("\\")));
  if (!folder.toLowerCase().startsWith(`${base.toLowerCase()}\\`)) return null;
  return folder.slice(base.length + 1);
}

/** The last part of a folder: « Album » for « Artiste\Album ». */
export function folderName(folder: string): string {
  return folder.slice(folder.lastIndexOf("\\") + 1);
}

/** Whether the file at `path`, in the library at `root`, is left out. */
export function leftOut(path: string, root: string, exclusions: Exclusions): boolean {
  const lower = path.toLowerCase();
  const base = trimmed(root).toLowerCase();
  const dot = lower.lastIndexOf(".");
  return (
    exclusions.folders.some((f) => lower.startsWith(`${base}\\${f.toLowerCase()}\\`)) ||
    (dot > lower.lastIndexOf("\\") && exclusions.extensions.includes(lower.slice(dot + 1)))
  );
}
