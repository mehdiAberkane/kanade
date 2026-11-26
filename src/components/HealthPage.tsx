// The Santé page (KAN-28): what is wrong in the collection, check by check,
// from the gravest to the mildest; a click opens the list. Read only: it
// shows, explains and proposes, and changes nothing in the files.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CHECKS,
  ignoredKey,
  score,
  shown,
  type Check,
  type CheckId,
  type Health,
  type Issue,
  type Severity,
} from "../lib/health";
import { formatNumber } from "../lib/libraries";
import type { Track } from "../lib/tracks";
import { useHealth } from "../lib/useHealth";

const SEVERITY: Record<Severity, string> = {
  grave: "Grave",
  fix: "À corriger",
  look: "À voir",
};

/** Lines of a list shown at once, then more on demand. */
const PAGE = 100;

export function HealthPage() {
  const { tracks, health, coversPending, ignored, toggleIgnored, error } = useHealth();
  const [open, setOpen] = useState<CheckId | null>(null);
  const check = CHECKS.find((c) => c.id === open);
  /** A list, or back to the dashboard: from the top of the page. */
  const show = (next: CheckId | null) => {
    setOpen(next);
    const main = document.querySelector("main");
    if (main) main.scrollTop = 0;
  };

  return (
    <section className="page health">
      <h1>Santé</h1>
      {error && (
        <p className="status status-error" role="alert">
          {error}
        </p>
      )}
      {!tracks || !health ? (
        <p className="hint">Contrôle de la bibliothèque…</p>
      ) : tracks.length === 0 ? (
        <p className="empty">Rien à contrôler : ajoute d'abord une bibliothèque.</p>
      ) : check ? (
        <CheckList
          check={check}
          issues={health.get(check.id) ?? []}
          ignored={ignored}
          onToggle={toggleIgnored}
          onBack={() => {
            show(null);
          }}
        />
      ) : (
        <Dashboard
          tracks={tracks}
          health={health}
          coversPending={coversPending}
          ignored={ignored}
          onOpen={show}
        />
      )}
    </section>
  );
}

function Dashboard(props: {
  tracks: Track[];
  health: Health;
  coversPending: boolean;
  ignored: Set<string>;
  onOpen: (check: CheckId) => void;
}) {
  const { health, ignored } = props;
  return (
    <>
      <p className="hint">
        Ce qui ne va pas dans ta collection, du plus grave au plus bénin. Cet écran ne change rien à
        tes fichiers : il montre, explique et propose.
      </p>
      <p className="health-score">
        <strong>{score(props.tracks, health, ignored)} %</strong> des morceaux sans problème à
        corriger
      </p>
      <ul className="health-checks">
        {CHECKS.map((c) => {
          const all = health.get(c.id) ?? [];
          const left = shown(all, ignored).length;
          const pending = c.id === "no-cover" && props.coversPending;
          return (
            <li key={c.id}>
              <button
                className={`health-check severity-${c.severity}${left === 0 ? " clear" : ""}`}
                disabled={pending}
                onClick={() => {
                  props.onOpen(c.id);
                }}
              >
                <span className="health-severity">{SEVERITY[c.severity]}</span>
                <span className="health-label">{c.label}</span>
                <span className="health-count">{pending ? "…" : formatNumber(left)}</span>
                {all.length > left && (
                  <span className="hint">{formatNumber(all.length - left)} ignorés</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function CheckList(props: {
  check: Check;
  issues: Issue[];
  ignored: Set<string>;
  onToggle: (issue: Issue) => Promise<void>;
  onBack: () => void;
}) {
  const { check, issues, ignored } = props;
  const [withIgnored, setWithIgnored] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const left = shown(issues, ignored);
  const list = withIgnored ? issues : left;
  const more = Math.min(PAGE, list.length - limit);

  return (
    <>
      <button className="btn-link" onClick={props.onBack}>
        ← Tous les contrôles
      </button>
      <h2>{check.label}</h2>
      <p className="hint">{check.explain}</p>
      {issues.length > left.length && (
        <label className="settings-row">
          <input
            type="checkbox"
            checked={withIgnored}
            onChange={(event) => {
              setWithIgnored(event.target.checked);
            }}
          />
          Montrer aussi les signalements ignorés ({formatNumber(issues.length - left.length)})
        </label>
      )}
      {list.length === 0 ? (
        <p className="empty">Rien à signaler.</p>
      ) : (
        <ul className="health-issues" aria-label={check.label}>
          {list.slice(0, limit).map((issue) => (
            <IssueRow
              key={ignoredKey(issue)}
              issue={issue}
              ignored={ignored.has(ignoredKey(issue))}
              onToggle={props.onToggle}
            />
          ))}
        </ul>
      )}
      {more > 0 && (
        <button
          className="btn"
          onClick={() => {
            setLimit(limit + PAGE);
          }}
        >
          Afficher {formatNumber(more)} de plus ({formatNumber(list.length - limit)} restants)
        </button>
      )}
    </>
  );
}

function IssueRow(props: {
  issue: Issue;
  ignored: boolean;
  onToggle: (issue: Issue) => Promise<void>;
}) {
  const { issue } = props;
  return (
    <li className={`health-issue${props.ignored ? " ignored" : ""}`}>
      <div className="health-issue-text">
        <strong>{issue.title}</strong>
        <span className="hint">{issue.detail}</span>
        {issue.proposal !== null && <span>Proposé : « {issue.proposal} »</span>}
      </div>
      <div className="health-issue-actions">
        <button
          className="btn"
          onClick={() => {
            // A track gone since the list was made: nothing to open.
            invoke("track_reveal", { id: issue.trackIds[0] }).catch(() => undefined);
          }}
        >
          Afficher dans l'Explorateur
        </button>
        <button className="btn" onClick={() => void props.onToggle(issue)}>
          {props.ignored ? "Ne plus ignorer" : "Ignorer"}
        </button>
      </div>
    </li>
  );
}
