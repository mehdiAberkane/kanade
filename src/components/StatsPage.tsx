// The Statistiques page (KAN-36): what the collection is made of, worked
// out in the interface from the list's rows (src/lib/stats.ts). Read only;
// a figure a filter can tell opens the list of its tracks.
import { useEffect, useMemo, useRef, useState, type Ref, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { count, errorText, formatNumber, type Settings } from "../lib/libraries";
import { NO_FILTERS, type Filters } from "../lib/search";
import {
  durationText,
  folderSizes,
  libraryStats,
  monthLabel,
  monthShort,
  percent,
  summaryText,
  type FolderSize,
  type Slice,
  type Stats,
} from "../lib/stats";
import { summaryPng } from "../lib/summaryImage";
import { formatSize, formatTotalDuration, type Track } from "../lib/tracks";
import { useLibraries } from "../lib/useLibraries";
import { useTracks } from "../lib/useTracks";
import { BarList, Columns, type Bar } from "./Charts";

/** Where the list opens from a figure: a library, and filters. */
export interface TracksStart {
  libraryId: number | null;
  filters: Filters;
}

const ALL = "Toute la musique";

/** « 1 234 morceaux · 3 h 20 min · 4,2 Go ». */
const sliceText = (s: Slice<unknown>) =>
  `${count(s.tracks, "morceau", "morceaux")} · ${formatTotalDuration(s.durationMs)} · ${formatSize(s.size)}`;

export function StatsPage({ onShow }: { onShow: (start: TracksStart) => void }) {
  const { tracks, error } = useTracks();
  const { libraries } = useLibraries();
  const [scope, setScope] = useState<number | null>(null);
  const [featuring, setFeaturing] = useState(true);
  const [stats, setStats] = useState<Stats | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    invoke<Settings>("settings_get").then(
      (settings) => {
        setFeaturing(settings.groupFeaturing);
      },
      () => {
        // Not read: « feat. » grouped, as by default.
      },
    );
  }, []);

  // A library removed while shown: back to all of them.
  const library = libraries?.find((l) => l.id === scope) ?? null;
  const libraryId = library?.id ?? null;
  const scoped = useMemo(
    () => (tracks ?? []).filter((t) => libraryId === null || t.libraryId === libraryId),
    [tracks, libraryId],
  );
  useEffect(() => {
    if (!tracks) return;
    // A moment later: the page shows first, then the tracks are counted.
    const timer = window.setTimeout(() => {
      setStats(libraryStats(scoped, featuring, now));
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [tracks, scoped, featuring, now]);

  const name = library?.name ?? ALL;
  const known = libraries ?? [];
  const show = (filters: Partial<Filters>) => {
    onShow({ libraryId, filters: { ...NO_FILTERS, ...filters } });
  };

  return (
    <section className="page stats">
      <div className="page-head">
        <h1>Statistiques</h1>
        {libraries && libraries.length > 1 && (
          <label className="stats-scope">
            Bibliothèque{" "}
            <select
              value={libraryId ?? ""}
              onChange={(event) => {
                setScope(event.target.value === "" ? null : Number(event.target.value));
              }}
            >
              <option value="">{ALL}</option>
              {libraries.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <p className="status status-error" role="alert">
          {error}
        </p>
      )}
      {!tracks || !stats ? (
        !error && <p className="hint">Calcul des statistiques…</p>
      ) : stats.tracks === 0 ? (
        <p className="empty">
          Rien à compter : ajoute d'abord une bibliothèque, ou attends son scan.
        </p>
      ) : (
        <Figures
          stats={stats}
          scope={name}
          now={now}
          tracks={scoped}
          libraries={libraryId === null ? known : []}
          root={library?.root ?? null}
          show={show}
        />
      )}
    </section>
  );
}

function Figures(props: {
  stats: Stats;
  scope: string;
  now: number;
  tracks: Track[];
  libraries: { id: number; name: string; root: string }[];
  root: string | null;
  show: (filters: Partial<Filters>) => void;
}) {
  const { stats, show } = props;
  const card = useRef<SVGSVGElement>(null);
  const slices = <K,>(list: Slice<K>[], filter?: (s: Slice<K>) => Partial<Filters> | null): Bar[] =>
    list.map((s) => {
      const filters = filter?.(s) ?? null;
      return {
        key: String(s.key),
        label: s.label,
        value: s.tracks,
        text: sliceText(s),
        onShow: filters
          ? () => {
              show(filters);
            }
          : undefined,
      };
    });

  return (
    <>
      <SummaryCard ref={card} stats={stats} scope={props.scope} now={props.now} />
      <Export stats={stats} scope={props.scope} now={props.now} card={card} />
      {stats.missing > 0 && (
        <p className="hint">
          {count(
            stats.missing,
            "fichier introuvable n'est pas compté",
            "fichiers introuvables ne sont pas comptés",
          )}{" "}
          : la liste les montre grisés.
        </p>
      )}

      <div className="stats-grid">
        <section className="stats-section" aria-labelledby="stats-formats">
          <h2 id="stats-formats">Formats</h2>
          <BarList
            label="Morceaux par format"
            bars={slices(stats.formats, (s) => ({ formats: [s.key] }))}
          />
          <h3>Qualité</h3>
          <BarList
            label="Morceaux par qualité"
            bars={[
              {
                key: "lossless",
                label: "Sans perte",
                value: stats.quality.lossless,
                text: `${count(stats.quality.lossless, "morceau", "morceaux")} · ${percent(stats.quality.lossless, stats.tracks)}`,
                onShow: () => {
                  show({ quality: ["lossless"] });
                },
              },
              {
                key: "lossy",
                label: "Avec perte",
                value: stats.quality.lossy,
                text: `${count(stats.quality.lossy, "morceau", "morceaux")} · ${percent(stats.quality.lossy, stats.tracks)}`,
                onShow: () => {
                  show({ quality: ["lossy"] });
                },
              },
              {
                key: "other",
                label: "Format inconnu",
                value: stats.quality.other,
                text: count(stats.quality.other, "morceau", "morceaux"),
              },
            ].filter((b) => b.value > 0)}
          />
          {stats.bitrates.length > 0 && (
            <>
              <h3>Débit des fichiers avec perte</h3>
              <BarList label="Fichiers avec perte par débit" bars={slices(stats.bitrates)} />
            </>
          )}
        </section>

        <section className="stats-section" aria-labelledby="stats-genres">
          <h2 id="stats-genres">Genres</h2>
          <BarList
            label="Morceaux par genre"
            bars={slices(stats.genres, (s) => (s.key === "*" ? null : { genres: [s.key] }))}
          />
        </section>

        <section className="stats-section" aria-labelledby="stats-tags">
          <h2 id="stats-tags">Tags et pochettes</h2>
          <BarList
            label="Tags et pochettes"
            bars={[
              {
                key: "cover",
                label: "Sans pochette dans les tags",
                value: stats.tracks - stats.withCover,
                text: `${count(stats.tracks - stats.withCover, "morceau", "morceaux")} · ${percent(stats.tracks - stats.withCover, stats.tracks)}`,
                onShow: () => {
                  show({ noCover: true });
                },
              },
              {
                key: "incomplete",
                label: "Tags incomplets",
                value: stats.tracks - stats.complete,
                text: `${count(stats.tracks - stats.complete, "morceau", "morceaux")} · ${percent(stats.tracks - stats.complete, stats.tracks)}`,
                onShow: () => {
                  show({ incomplete: true });
                },
              },
            ]}
          />
          <p className="hint">La page Santé dit quoi corriger, album par album.</p>
        </section>

        <section className="stats-section" aria-labelledby="stats-marks">
          <h2 id="stats-marks">Favoris et notes</h2>
          <BarList
            label="Favoris et notes"
            bars={[
              {
                key: "favorite",
                label: "Favoris",
                value: stats.favorites,
                text: count(stats.favorites, "morceau", "morceaux"),
                onShow: () => {
                  show({ favorite: true });
                },
              },
              ...[5, 4, 3, 2, 1].map((n) => ({
                key: `rating-${String(n)}`,
                label: "★".repeat(n),
                value: stats.ratings[n],
                text: count(stats.ratings[n], "morceau", "morceaux"),
              })),
              {
                key: "rating-0",
                label: "Sans note",
                value: stats.ratings[0],
                text: count(stats.ratings[0], "morceau", "morceaux"),
              },
            ]}
          />
        </section>

        <section className="stats-section wide" aria-labelledby="stats-years">
          <h2 id="stats-years">Années</h2>
          {stats.years.length > 0 && (
            <Columns
              label={`Morceaux par année, de ${String(stats.years[0].year)} à ${String(stats.years[stats.years.length - 1].year)}`}
              every={10}
              columns={stats.years.map((y) => ({
                key: String(y.year),
                label: String(y.year),
                value: y.tracks,
                title: `${String(y.year)} : ${count(y.tracks, "morceau", "morceaux")}`,
              }))}
            />
          )}
          <BarList
            label="Morceaux par décennie"
            bars={slices(stats.decades, (s) => ({ decades: [s.key] }))}
          />
        </section>

        <section className="stats-section wide" aria-labelledby="stats-added">
          <h2 id="stats-added">Ajouts</h2>
          <Columns
            label="Morceaux ajoutés par mois, les deux dernières années"
            every={3}
            columns={stats.added.map((m) => ({
              key: m.month,
              label: monthShort(m.month),
              value: m.tracks,
              title: `${monthLabel(m.month)} : ${count(m.tracks, "morceau ajouté", "morceaux ajoutés")}`,
            }))}
          />
          {stats.addedBefore > 0 && (
            <p className="hint">
              Avant, ou à une date inconnue : {count(stats.addedBefore, "morceau", "morceaux")}.
            </p>
          )}
        </section>

        <section className="stats-section" aria-labelledby="stats-artists">
          <h2 id="stats-artists">Classements</h2>
          <Ranking
            title="Artistes les plus représentés"
            items={stats.topArtists.map((r) => ({
              key: r.item,
              label: r.item,
              value: r.value,
              text: count(r.value, "morceau", "morceaux"),
            }))}
          />
          <Ranking
            title="Albums les plus fournis"
            items={stats.biggestAlbums.map((r) => ({
              key: r.item.key,
              label: `${r.item.title} (${r.item.artist})`,
              value: r.value,
              text: count(r.value, "morceau", "morceaux"),
            }))}
          />
          <Ranking
            title="Albums les plus longs"
            items={stats.longestAlbums.map((r) => ({
              key: r.item.key,
              label: `${r.item.title} (${r.item.artist})`,
              value: r.value,
              text: formatTotalDuration(r.value),
            }))}
          />
          <Ranking
            title="Fichiers les plus lourds"
            items={stats.heaviestFiles.map((r) => ({
              key: String(r.item.id),
              label: r.item.path.slice(r.item.path.lastIndexOf("\\") + 1),
              value: r.value,
              text: formatSize(r.value),
            }))}
          />
        </section>

        <section className="stats-section" aria-labelledby="stats-folders">
          <h2 id="stats-folders">Place par dossier</h2>
          <Folders tracks={props.tracks} libraries={props.libraries} root={props.root} />
        </section>
      </div>
    </>
  );
}

/** A numbered ranking, its bars to compare. */
function Ranking({ title, items }: { title: string; items: Bar[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <BarList
        label={title}
        bars={items.map((item, i) => ({ ...item, label: `${String(i + 1)}. ${item.label}` }))}
      />
    </>
  );
}

/** The space taken, folder by folder, one level at a time. */
function Folders(props: {
  tracks: Track[];
  libraries: { id: number; name: string; root: string }[];
  root: string | null;
}) {
  /** The folders opened, from the top. */
  const [path, setPath] = useState<{ path: string; name: string }[]>([]);
  const here = path.length > 0 ? path[path.length - 1].path : props.root;
  const entries: FolderSize[] = useMemo(() => {
    if (here !== null) return folderSizes(props.tracks, here);
    // All the libraries: each one first.
    return props.libraries
      .map((l) => {
        const own = props.tracks.filter((t) => t.libraryId === l.id && t.status !== "missing");
        return {
          path: l.root,
          name: l.name,
          tracks: own.length,
          size: own.reduce((n, t) => n + t.size, 0),
        };
      })
      .filter((f) => f.tracks > 0)
      .sort((a, b) => b.size - a.size);
  }, [here, props.tracks, props.libraries]);

  return (
    <>
      {path.length > 0 && (
        <nav className="stats-path" aria-label="Dossier montré">
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setPath([]);
            }}
          >
            {props.root === null ? ALL : "Bibliothèque"}
          </button>
          {path.map((step, i) => (
            <span key={step.path}>
              {" › "}
              {i === path.length - 1 ? (
                <span aria-current="location">{step.name}</span>
              ) : (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setPath(path.slice(0, i + 1));
                  }}
                >
                  {step.name}
                </button>
              )}
            </span>
          ))}
        </nav>
      )}
      <ul className="bar-list" aria-label="Place par dossier">
        {entries.map((folder) => (
          <li key={`${folder.path}|${folder.name}`}>
            {folder.path ? (
              <button
                type="button"
                className="bar-name link-btn"
                title={`Ouvrir ${folder.name}`}
                onClick={() => {
                  setPath([...path, { path: folder.path, name: folder.name }]);
                }}
              >
                {folder.name}
              </button>
            ) : (
              <span className="bar-name">{folder.name}</span>
            )}
            <span className="bar-track" aria-hidden="true">
              <span
                className="bar-fill"
                style={{ width: `${String((folder.size / Math.max(1, entries[0].size)) * 100)}%` }}
              />
            </span>
            <span className="bar-value">
              {formatSize(folder.size)} · {count(folder.tracks, "morceau", "morceaux")}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The summary as a card: what the picture export saves. */
function SummaryCard({
  ref,
  stats,
  scope,
  now,
}: {
  ref: Ref<SVGSVGElement>;
  stats: Stats;
  scope: string;
  now: number;
}) {
  const figures: [string, string][] = [
    [formatNumber(stats.tracks), stats.tracks > 1 ? "morceaux" : "morceau"],
    [formatNumber(stats.albums), stats.albums > 1 ? "albums" : "album"],
    [formatNumber(stats.artists), stats.artists > 1 ? "artistes" : "artiste"],
    [formatSize(stats.size), "sur le disque"],
  ];
  const shares: [string, number][] = [
    ["Sans perte", stats.quality.lossless],
    ["Pochette dans les tags", stats.withCover],
    ["Tags complets", stats.complete],
  ];
  const genres = stats.genres.filter((g) => g.key && g.key !== "*").slice(0, 5);
  const most = Math.max(1, ...genres.map((g) => g.tracks));
  return (
    <svg
      ref={ref}
      className="summary-card"
      viewBox="0 0 800 340"
      role="img"
      aria-label={`Résumé : ${count(stats.tracks, "morceau", "morceaux")}, ${durationText(stats.durationMs)}`}
    >
      <rect className="summary-bg" x={0} y={0} width={800} height={340} rx={16} />
      <text className="summary-title" x={32} y={48}>
        {scope}
      </text>
      <text className="summary-muted" x={768} y={48} textAnchor="end">
        Kanade · {new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(now))}
      </text>
      <text className="summary-duration" x={32} y={98}>
        {durationText(stats.durationMs)}
      </text>
      {figures.map(([value, label], i) => (
        <g key={label}>
          <text className="summary-figure" x={32 + i * 190} y={160}>
            {value}
          </text>
          <text className="summary-muted" x={32 + i * 190} y={184}>
            {label}
          </text>
        </g>
      ))}
      {shares.map(([label, part], i) => (
        <g key={label}>
          <text className="summary-muted" x={32} y={232 + i * 34}>
            {label} · {percent(part, stats.tracks)}
          </text>
          <rect className="summary-track" x={230} y={220 + i * 34} width={180} height={12} rx={6} />
          <rect
            className="summary-fill"
            x={230}
            y={220 + i * 34}
            width={(180 * part) / stats.tracks}
            height={12}
            rx={6}
          />
        </g>
      ))}
      <text className="summary-muted" x={460} y={232}>
        Genres
      </text>
      {genres.map((g, i) => (
        <g key={g.key}>
          <text className="summary-label" x={460} y={260 + i * 16}>
            {g.label.slice(0, 18)}
          </text>
          <rect
            className="summary-fill"
            x={600}
            y={251 + i * 16}
            width={(168 * g.tracks) / most}
            height={10}
            rx={5}
          />
        </g>
      ))}
    </svg>
  );
}

/** Copy the summary, or save it as text or as a picture, by Windows' dialog. */
function Export(props: {
  stats: Stats;
  scope: string;
  now: number;
  card: RefObject<SVGSVGElement | null>;
}) {
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const text = () => summaryText(props.stats, props.scope, props.now);

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setStatus(null);
    try {
      const said = await action();
      if (said) setStatus({ text: said, error: false });
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stats-export">
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await navigator.clipboard.writeText(text());
            return "Résumé copié.";
          })
        }
      >
        Copier le résumé
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() =>
          void run(async () =>
            (await invoke<boolean>("stats_save_text", { text: text() }))
              ? "Résumé enregistré."
              : null,
          )
        }
      >
        Enregistrer en texte…
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const png = await summaryPng(props.card.current as SVGSVGElement);
            return (await invoke<boolean>("stats_save_image", png)) ? "Image enregistrée." : null;
          })
        }
      >
        Enregistrer en image…
      </button>
      {status && (
        <span
          className={`status ${status.error ? "status-error" : "status-ok"}`}
          role={status.error ? "alert" : "status"}
        >
          {status.text}
        </span>
      )}
    </div>
  );
}
