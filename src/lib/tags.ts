// The tag editor (KAN-7): its fields, the values the tracks share, what
// writing them would change, and what to say of a change once written. The
// Rust side checks the values again and writes the files (tag_write.rs).
import { count } from "./libraries";
import type { Track } from "./tracks";

export type TagField =
  "title" | "artist" | "albumArtist" | "album" | "track" | "disc" | "year" | "genre";

type Kind = "text" | "number" | "year";

interface FieldSpec {
  field: TagField;
  label: string;
  kind: Kind;
  /** The track's value, as the field shows it: empty when it has none. */
  of: (track: Track) => string;
}

const text = (value: string | null) => value ?? "";
const number = (value: number | null) => (value === null ? "" : String(value));

export const TAG_FIELDS: FieldSpec[] = [
  // Without a title tag, the list shows the file's name: not a value.
  { field: "title", label: "Titre", kind: "text", of: (t) => (t.untitled ? "" : t.title) },
  { field: "artist", label: "Artiste", kind: "text", of: (t) => text(t.artist) },
  {
    field: "albumArtist",
    label: "Artiste de l'album",
    kind: "text",
    of: (t) => text(t.albumArtist),
  },
  { field: "album", label: "Album", kind: "text", of: (t) => text(t.album) },
  { field: "track", label: "N° de piste", kind: "number", of: (t) => number(t.track) },
  { field: "disc", label: "N° de disque", kind: "number", of: (t) => number(t.disc) },
  { field: "year", label: "Année", kind: "year", of: (t) => number(t.year) },
  { field: "genre", label: "Genre", kind: "text", of: (t) => text(t.genre) },
];

/** The same limits as the Rust side (tag_write.rs). */
const MAX_TAG_CHARS = 1024;
const MAX_NUMBER = 9999;

/** The fields touched in the editor, with their new value ("" removes it). */
export type TagValues = Partial<Record<TagField, string>>;

/** Whether Kanade can write a track's tags: its file there and read, not a WMA. */
export function writable(track: Track): boolean {
  return track.status === "present" && track.format !== "WMA";
}

/** Each field's value when every track has the same one, null when they differ. */
export function sharedValues(tracks: Track[]): Record<TagField, string | null> {
  const shared = {} as Record<TagField, string | null>;
  for (const { field, of } of TAG_FIELDS) {
    const first = tracks.length > 0 ? of(tracks[0]) : "";
    shared[field] = tracks.every((t) => of(t) === first) ? first : null;
  }
  return shared;
}

// Control characters (a tab, a line break pasted): no tag holds them.
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Why a field's value cannot be written; null when it can. Empty removes it. */
export function fieldError(field: TagField, raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  switch (kindOf(field)) {
    case "number": {
      const n = /^\d+$/.test(value) ? Number(value) : NaN;
      return n >= 1 && n <= MAX_NUMBER ? null : "Un nombre de 1 à 9 999.";
    }
    case "year":
      return /^[1-9]\d{3}$/.test(value) ? null : "Une année de quatre chiffres, comme 1959.";
    case "text":
      // Counted as the Rust side counts them: by code point.
      // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points are what is counted
      if ([...value].length > MAX_TAG_CHARS) return "1 024 caractères au plus.";
      return CONTROL.test(value) ? "Pas de tabulation ni de retour à la ligne." : null;
  }
}

const KINDS = Object.fromEntries(TAG_FIELDS.map((f) => [f.field, f.kind])) as Record<
  TagField,
  Kind
>;

function kindOf(field: TagField): Kind {
  return KINDS[field];
}

/** Whether writing `raw` into `field` changes `track`. */
function changes(spec: FieldSpec, track: Track, raw: string): boolean {
  const value = raw.trim();
  const current = spec.of(track).trim();
  // "03" is track 3.
  if (spec.kind !== "text" && value !== "" && current !== "") {
    return Number(value) !== Number(current);
  }
  return value !== current;
}

/** What writing `values` would do: how many files change, and how many fields. */
export function preview(tracks: Track[], values: TagValues): { files: number; fields: number } {
  const touched = TAG_FIELDS.flatMap((spec) => {
    const value = values[spec.field];
    return value === undefined ? [] : [{ spec, value }];
  });
  const fields = new Set<TagField>();
  let files = 0;
  for (const track of tracks) {
    let changed = false;
    for (const { spec, value } of touched) {
      if (changes(spec, track, value)) {
        fields.add(spec.field);
        changed = true;
      }
    }
    if (changed) files += 1;
  }
  return { files, fields: fields.size };
}

/** « 3 fichiers à modifier · 2 champs ». */
export function previewText({ files, fields }: { files: number; fields: number }): string {
  if (files === 0) return "Rien à écrire : les fichiers ont déjà ces valeurs.";
  return `${count(files, "fichier", "fichiers")} à modifier · ${count(fields, "champ", "champs")}`;
}

/** The event of a change's progress (commands.rs). */
export const TAGS_PROGRESS = "tags-progress";

export interface TagProgress {
  done: number;
  total: number;
}

/** Why the Rust side did not write a file; the original is as it was. */
export type Refusal =
  | {
      kind:
        | "gone"
        | "changed"
        | "read_only"
        | "online_only"
        | "unsupported"
        | "damaged"
        | "too_big"
        | "in_use";
    }
  | { kind: "failed"; message: string };

type TagRefused = Refusal & { id: number; name: string };

export interface TagReport {
  written: number;
  /** Already had these values: left as they were. */
  unchanged: number;
  refused: TagRefused[];
  /** Refused past the ones listed. */
  moreRefused: number;
  cancelled: boolean;
}

/** The change an undo would undo. */
export interface TagChange {
  id: number;
  doneMs: number;
  files: number;
}

export function refusalText(refusal: Refusal): string {
  switch (refusal.kind) {
    case "gone":
      return "fichier introuvable";
    case "changed":
      return "modifié ailleurs depuis que Kanade l'a lu : relis la bibliothèque";
    case "read_only":
      return "fichier en lecture seule";
    case "online_only":
      return "seulement sur OneDrive : l'écrire le téléchargerait";
    case "unsupported":
      return "Kanade n'écrit pas les tags de ce format";
    case "damaged":
      return "tags abîmés : Kanade ne les réécrit pas, pour ne rien perdre";
    case "too_big":
      return "trop gros pour que Kanade le relise";
    case "in_use":
      return "ouvert par un autre programme : ferme-le et réessaie";
    case "failed":
      return `écriture échouée, fichier laissé tel quel (${refusal.message})`;
  }
}

/** The report's title: what came of the change, in a few words. */
export function reportTitle(report: TagReport, undo: boolean): string {
  if (report.written > 0) return undo ? "Modification annulée" : "Tags enregistrés";
  if (report.refused.length + report.moreRefused > 0) {
    return undo ? "Rien n'a été rétabli" : "Aucun fichier modifié";
  }
  return report.cancelled ? "Arrêté" : "Rien à modifier";
}

/** « 12 fichiers modifiés · 2 déjà à jour · 1 refusé », or rétablis for an undo. */
export function reportText(report: TagReport, undo: boolean): string {
  const refused = report.refused.length + report.moreRefused;
  const parts = [
    report.written > 0 || (report.unchanged === 0 && refused === 0)
      ? count(
          report.written,
          undo ? "fichier rétabli" : "fichier modifié",
          undo ? "fichiers rétablis" : "fichiers modifiés",
        )
      : "",
    report.unchanged > 0 ? `${count(report.unchanged, "fichier", "fichiers")} déjà à jour` : "",
    refused > 0 ? count(refused, "refusé", "refusés") : "",
  ];
  const line = parts.filter(Boolean).join(" · ");
  return report.cancelled ? `Arrêté : ${line}` : line;
}
