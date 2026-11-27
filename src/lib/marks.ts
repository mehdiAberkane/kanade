// Favourites and ratings (KAN-32): what the user thinks of each track, kept
// by the Rust side on the track (library/marks.rs). The lists change them
// through useMarks(), which the music's page gives so that they show at
// once; an imported file's tracks are found again here, as Ongaku does.
import { createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";
import { count } from "./libraries";
import { fromRow, type Track, type TrackRow } from "./tracks";

/** Stars a track may have; 0 is none. */
export const MAX_RATING = 5;

export interface MarkChange {
  favorite?: boolean;
  rating?: number;
}

/** What tracks_mark takes: a field left out stays as it is. */
export function markArgs(ids: number[], change: MarkChange) {
  return { ids, favorite: change.favorite ?? null, rating: change.rating ?? null };
}

export type Marker = (ids: number[], change: MarkChange) => void;

/** Without the music's page (a list on its own): straight to the Rust side. */
export const MarksContext = createContext<Marker>((ids, change) => {
  invoke("tracks_mark", markArgs(ids, change)).catch(() => undefined);
});

export function useMarks(): Marker {
  return useContext(MarksContext);
}

/** One track of an exchange file, as the Rust side reads it. */
export interface Mark {
  title: string;
  artist: string;
  album: string;
  favorite: boolean;
  rating: number;
}

/** As Ongaku compares names (searchKey): no accents, no case, trimmed. */
export function matchKey(text: string | null): string {
  return (text ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export interface Found {
  /** Tracks to make favourites. */
  favorites: number[];
  /** Tracks to rate, by number of stars. */
  ratings: Map<number, number[]>;
  found: number;
  missing: number;
}

/**
 * The tracks of an imported file found again, as Ongaku finds them: same
 * title, artist and album, else same title and artist. A favourite or a
 * rating is added; none is taken away.
 */
export function findMarks(tracks: Track[], marks: Mark[]): Found {
  const exact = new Map<string, Track>();
  const loose = new Map<string, Track>();
  for (const t of tracks) {
    if (t.status === "missing") continue;
    const named = `${matchKey(t.title)}\u0000${matchKey(t.artist)}`;
    exact.set(`${named}\u0000${matchKey(t.album)}`, t);
    loose.set(named, t);
  }
  const result: Found = { favorites: [], ratings: new Map(), found: 0, missing: 0 };
  for (const mark of marks) {
    const named = `${matchKey(mark.title)}\u0000${matchKey(mark.artist)}`;
    const track = exact.get(`${named}\u0000${matchKey(mark.album)}`) ?? loose.get(named);
    if (!track) {
      result.missing += 1;
      continue;
    }
    result.found += 1;
    if (mark.favorite) result.favorites.push(track.id);
    if (mark.rating > 0) {
      const rated = result.ratings.get(mark.rating);
      if (rated) rated.push(track.id);
      else result.ratings.set(mark.rating, [track.id]);
    }
  }
  return result;
}

/** « 4 étoiles », « 1 étoile », « Pas de note ». */
export function ratingText(rating: number): string {
  if (rating === 0) return "Pas de note";
  return `${String(rating)} étoile${rating > 1 ? "s" : ""}`;
}

/** What marks_export says: how many tracks went in the file. */
interface Exported {
  tracks: number;
}

export function exportedText(tracks: number): string {
  if (tracks === 0) return "Aucun favori ni aucune note pour l'instant : le fichier est vide.";
  return `${count(tracks, "morceau enregistré", "morceaux enregistrés")} dans le fichier.`;
}

export function importedText(marks: number, found: Found): string {
  if (marks === 0) return "Ce fichier ne contient aucun favori ni aucune note.";
  const missing =
    found.missing > 0
      ? ` ; ${count(found.missing, "introuvable", "introuvables")} dans tes bibliothèques`
      : "";
  return `${count(found.found, "morceau retrouvé", "morceaux retrouvés")} sur ${String(marks)}${missing}.`;
}

/**
 * Exports the favourites and ratings to a file the user picks; what to
 * say, or null when the dialog was closed.
 */
export async function exportMarks(): Promise<string | null> {
  const done = await invoke<Exported | null>("marks_export");
  return done && exportedText(done.tracks);
}

/**
 * Reads a file the user picks, finds its tracks in the libraries and adds
 * their favourites and ratings; what to say, or null when the dialog was
 * closed.
 */
export async function importMarks(): Promise<string | null> {
  const marks = await invoke<Mark[] | null>("marks_import");
  if (!marks) return null;
  const rows = await invoke<TrackRow[]>("tracks_list");
  const found = findMarks(rows.map(fromRow), marks);
  if (found.favorites.length > 0) {
    await invoke("tracks_mark", markArgs(found.favorites, { favorite: true }));
  }
  for (const [rating, ids] of found.ratings) {
    await invoke("tracks_mark", markArgs(ids, { rating }));
  }
  return importedText(marks.length, found);
}
