import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { albumLine, missingTracks, NO_ALBUM, VARIOUS_ARTISTS, type Album } from "../lib/albums";
import { errorText } from "../lib/libraries";
import { formatDuration, formatSize, formatTotalDuration } from "../lib/tracks";
import { Cover } from "./AlbumGrid";

const FLAGS = { present: null, missing: "introuvable", unreadable: "illisible" } as const;

/** « la piste 3 », « les pistes 3 et 5 », « les pistes 2, 3 et 7 ». */
function missingText(numbers: number[]): string {
  if (numbers.length === 1) return `Il manque la piste ${numbers[0]}.`;
  const last = numbers[numbers.length - 1];
  return `Il manque les pistes ${numbers.slice(0, -1).join(", ")} et ${last}.`;
}

interface Props {
  album: Album;
  /** Libraries offline: their tracks are greyed. */
  offline: Set<number>;
  onBack: () => void;
}

/**
 * One album: its cover, what it is made of, its tracks disc by disc, and
 * the numbers missing among them. « ‹ Albums » or Escape goes back.
 */
export function AlbumPage({ album, offline, onBack }: Props) {
  const back = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const missing = missingTracks(album);
  const discs = [...new Set(album.tracks.map((t) => t.disc))];
  const title = album.title || NO_ALBUM;
  // Each track's artist, unless the album's says it all.
  const showArtists =
    album.artist === VARIOUS_ARTISTS ||
    album.tracks.some((t) => (t.track.artist ?? album.artist) !== album.artist);

  useEffect(() => {
    back.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onBack]);

  async function reveal() {
    setStatus(null);
    try {
      await invoke("track_reveal", { id: album.tracks[0].track.id });
    } catch (e) {
      setStatus(errorText(e));
    }
  }

  const facts = [
    formatTotalDuration(album.durationMs),
    formatSize(album.size),
    [album.format, album.bitrateKbps === null ? null : `${album.bitrateKbps} kb/s`]
      .filter(Boolean)
      .join(" · "),
  ].filter(Boolean);

  return (
    <article className="album-page" aria-labelledby="album-heading">
      <button ref={back} type="button" className="btn album-back" onClick={onBack}>
        ‹ Albums
      </button>
      <header className="album-header">
        <Cover album={album} size={220} large />
        <div>
          <h2 id="album-heading">{title}</h2>
          <p className="album-page-artist">{album.artist}</p>
          <p>{albumLine(album)}</p>
          <p className="hint">{facts.join(" · ")}</p>
          {album.yearsVary && (
            <p className="hint">L'année n'est pas la même sur toutes les pistes.</p>
          )}
          <p className="hint album-folders">
            {album.folders.length > 1 ? "Dossiers" : "Dossier"} : {album.folders.join(" ; ")}
          </p>
          <div className="settings-row">
            <button type="button" className="btn" onClick={() => void reveal()}>
              Afficher dans l'Explorateur
            </button>
            {status && (
              <span className="status status-error" role="alert">
                {status}
              </span>
            )}
          </div>
        </div>
      </header>
      {discs.map((disc) => {
        const gaps = missing.get(disc);
        return (
          <section key={disc} className="album-disc" aria-label={`Disque ${disc}`}>
            {discs.length > 1 && <h3>Disque {disc}</h3>}
            {gaps && <p className="notice">{missingText(gaps)}</p>}
            <ol className="album-tracks">
              {album.tracks
                .filter((t) => t.disc === disc)
                .map(({ track }) => {
                  const flag = FLAGS[track.status];
                  const dim = flag !== null || offline.has(track.libraryId);
                  return (
                    <li key={track.id} className={dim ? "dim" : undefined}>
                      <span className="num">{track.track ?? ""}</span>
                      <span className="album-track-title">
                        {track.title}
                        {flag && <span className="track-flag">{flag}</span>}
                      </span>
                      {showArtists && <span className="hint">{track.artist ?? ""}</span>}
                      <span className="num">{formatDuration(track.durationMs)}</span>
                    </li>
                  );
                })}
            </ol>
          </section>
        );
      })}
    </article>
  );
}
