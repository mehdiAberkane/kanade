// The Appearance page (KAN-44): each change shows at once and is kept from
// one launch to the next (AppearanceProvider).
import { useRef, useState, type ReactNode } from "react";
import {
  ACCENTS,
  accentColors,
  FONTS,
  NEON_COLORS,
  NEON_SPEEDS,
  presetOf,
  PRESETS,
  THEMES,
  ZOOM_LEVELS,
  type Theme,
} from "../lib/appearance";
import { useAppearance } from "../lib/useAppearance";

export function AppearancePage() {
  const { appearance, theme, loaded, failure, update, zoomBy, zoomTo, reset, background } =
    useAppearance();
  const [confirming, setConfirming] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const preset = presetOf(appearance);
  const offered = ACCENTS.some((a) => a.light === appearance.accent);
  const { accent } = accentColors(appearance, theme);
  const adjusted = !offered && accent !== appearance.accent;
  const { neon } = appearance;
  const zoomMin = appearance.zoom <= ZOOM_LEVELS[0];
  const zoomMax = appearance.zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

  return (
    <section className="page appearance">
      <h1>Apparence</h1>
      <p className="hint">
        Chaque changement se voit tout de suite et reste d'un lancement à l'autre.
      </p>
      {failure && (
        <p className="status status-error settings-failure" role="alert">
          {failure}
        </p>
      )}

      <Section title="Thèmes tout faits" disabled={!loaded}>
        <p className="hint">Un clic choisit ensemble le thème, la couleur, la police et le néon.</p>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className="preset"
              aria-pressed={preset === p.id}
              onClick={() => {
                update(p.set);
              }}
            >
              <span
                className="preset-swatch"
                style={{ background: swatchOf(p.set.accent, p.set.theme, theme) }}
                aria-hidden="true"
              />
              <span className="preset-name">{p.name}</span>
              <span className="preset-detail">{p.detail}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Thème" disabled={!loaded}>
        <div className="choice-row" role="radiogroup" aria-label="Thème">
          {THEMES.map((t) => (
            <label key={t.id} className="choice">
              <input
                type="radio"
                name="theme"
                checked={appearance.theme === t.id}
                onChange={() => {
                  update({ theme: t.id });
                }}
              />
              {t.label}
            </label>
          ))}
        </div>
        <p className="hint">La barre de titre de la fenêtre suit le thème choisi.</p>
      </Section>

      <Section title="Couleur principale" disabled={!loaded}>
        <div className="swatches" role="radiogroup" aria-label="Couleur principale">
          {ACCENTS.map((a) => (
            <label key={a.light} className="swatch" title={a.name}>
              <input
                type="radio"
                name="accent"
                className="sr-only"
                checked={appearance.accent === a.light}
                onChange={() => {
                  update({ accent: a.light });
                }}
              />
              <span className="swatch-color" style={{ background: a[theme] }} aria-hidden="true" />
              <span className="sr-only">{a.name}</span>
            </label>
          ))}
          <label className="swatch swatch-free" title="Autre couleur">
            <input
              type="color"
              value={appearance.accent}
              aria-label="Autre couleur"
              onChange={(event) => {
                update({ accent: event.target.value });
              }}
            />
          </label>
        </div>
        <p className="hint">
          {adjusted
            ? `Ta couleur est un peu ${theme === "dark" ? "éclaircie" : "foncée"} (${accent}) pour que le texte reste lisible.`
            : "Boutons, sélection et liens. Chaque couleur a sa variante pour le thème clair et le sombre."}
        </p>
      </Section>

      <Section title="Police" disabled={!loaded}>
        <div className="font-list" role="radiogroup" aria-label="Police">
          {FONTS.map((f) => (
            <label key={f.id} className="choice font-choice">
              <input
                type="radio"
                name="font"
                checked={appearance.font === f.id}
                onChange={() => {
                  update({ font: f.id });
                }}
              />
              <span style={{ fontFamily: f.family }}>{f.label}</span>
              <span className="hint">{f.detail}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Affichage" disabled={!loaded}>
        <Check
          checked={appearance.compact}
          onChange={(compact) => {
            update({ compact });
          }}
        >
          Affichage compact : lignes plus serrées, marges réduites
        </Check>
        <Check
          checked={appearance.highContrast}
          onChange={(highContrast) => {
            update({ highContrast });
          }}
        >
          Contraste élevé
        </Check>
        <Check
          checked={appearance.reduceMotion}
          onChange={(reduceMotion) => {
            update({ reduceMotion });
          }}
        >
          Réduire les animations
        </Check>
        <p className="hint">
          Quand Windows demande moins d'animations ou un contraste élevé, Kanade le suit aussi.
        </p>
      </Section>

      <Section title="Fond d'écran" disabled={!loaded}>
        <div className="background-row">
          <div
            className="background-preview"
            style={background.url ? { backgroundImage: `url("${background.url}")` } : undefined}
          >
            {background.url ? (
              <div className="backdrop-veil" />
            ) : (
              <span className="hint">Aucune image</span>
            )}
          </div>
          <div className="background-actions">
            <button
              className="btn"
              disabled={background.busy}
              onClick={() => {
                picker.current?.click();
              }}
            >
              {background.url ? "Changer d'image…" : "Choisir une image…"}
            </button>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              hidden
              aria-label="Image de fond"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void background.choose(file);
              }}
            />
            {background.url && (
              <button
                className="btn"
                disabled={background.busy}
                onClick={() => void background.clear()}
              >
                Retirer l'image
              </button>
            )}
          </div>
        </div>
        {background.busy && (
          <p className="status status-info" role="status">
            Préparation de l'image…
          </p>
        )}
        {background.error && (
          <p className="status status-error" role="alert">
            {background.error}
          </p>
        )}
        <label className="settings-row">
          Assombrissement
          <input
            type="range"
            min={0}
            max={90}
            step={5}
            value={appearance.backgroundDim}
            disabled={!background.url}
            onChange={(event) => {
              update({ backgroundDim: Number(event.target.value) });
            }}
          />
          <span>{appearance.backgroundDim} %</span>
        </label>
        <p className="hint">
          Un voile {theme === "dark" ? "sombre" : "clair"} sur l'image, pour que le texte reste
          lisible. L'image est réduite à 2 560 pixels et gardée à part de ta base.
        </p>
      </Section>

      <Section title="Effet néon" disabled={!loaded}>
        <Check
          checked={neon.enabled}
          onChange={(enabled) => {
            update({ neon: { ...neon, enabled } });
          }}
        >
          Une lumière qui passe en fond, comme une vague
        </Check>
        <div className="swatches" role="radiogroup" aria-label="Couleur du néon">
          <label className="swatch" title="Couleur principale">
            <input
              type="radio"
              name="neon-color"
              className="sr-only"
              checked={neon.color === ""}
              disabled={!neon.enabled}
              onChange={() => {
                update({ neon: { ...neon, color: "" } });
              }}
            />
            <span className="swatch-color" style={{ background: accent }} aria-hidden="true" />
            <span className="sr-only">Couleur principale</span>
          </label>
          {NEON_COLORS.map((c) => (
            <label key={c.color} className="swatch" title={c.name}>
              <input
                type="radio"
                name="neon-color"
                className="sr-only"
                checked={neon.color === c.color}
                disabled={!neon.enabled}
                onChange={() => {
                  update({ neon: { ...neon, color: c.color } });
                }}
              />
              <span className="swatch-color" style={{ background: c.color }} aria-hidden="true" />
              <span className="sr-only">{c.name}</span>
            </label>
          ))}
          <label className="swatch swatch-free" title="Autre couleur du néon">
            <input
              type="color"
              value={neon.color || accent}
              aria-label="Autre couleur du néon"
              disabled={!neon.enabled}
              onChange={(event) => {
                update({ neon: { ...neon, color: event.target.value } });
              }}
            />
          </label>
        </div>
        <div className="choice-row" role="radiogroup" aria-label="Vitesse du néon">
          {NEON_SPEEDS.map((s) => (
            <label key={s.id} className="choice">
              <input
                type="radio"
                name="neon-speed"
                checked={neon.speed === s.id}
                disabled={!neon.enabled}
                onChange={() => {
                  update({ neon: { ...neon, speed: s.id } });
                }}
              />
              {s.label}
            </label>
          ))}
        </div>
        {neon.enabled && appearance.reduceMotion && (
          <p className="hint">Les animations sont réduites : la lumière reste immobile.</p>
        )}
      </Section>

      <Section title="Zoom" disabled={!loaded}>
        <div className="settings-row">
          <button
            className="btn"
            aria-label="Zoom arrière"
            disabled={zoomMin}
            onClick={() => {
              zoomBy(-1);
            }}
          >
            −
          </button>
          <button
            className="btn zoom-value"
            title="Revenir à 100 %"
            onClick={() => {
              zoomTo(100);
            }}
          >
            {appearance.zoom} %
          </button>
          <button
            className="btn"
            aria-label="Zoom avant"
            disabled={zoomMax}
            onClick={() => {
              zoomBy(1);
            }}
          >
            +
          </button>
        </div>
        <p className="hint">
          Toute la fenêtre, de 50 à 300 %. Aussi Ctrl + molette, Ctrl + +, Ctrl + − et Ctrl + 0.
        </p>
      </Section>

      <div className="settings-section">
        {confirming ? (
          <div className="confirm" role="alertdialog" aria-label="Revenir à l'apparence par défaut">
            <p>Tout remettre comme au premier lancement ? L'image de fond sera retirée.</p>
            <div className="settings-row">
              <button
                className="btn btn-danger"
                onClick={() => {
                  setConfirming(false);
                  void reset();
                }}
              >
                Tout remettre
              </button>
              <button
                className="btn"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn"
            disabled={!loaded}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Revenir à l'apparence par défaut
          </button>
        )}
      </div>
    </section>
  );
}

/** The accent of a preset as the theme it sets shows it. */
function swatchOf(accent: string, set: Theme | "system", shown: Theme): string {
  const offered = ACCENTS.find((a) => a.light === accent);
  return offered ? offered[set === "system" ? shown : set] : accent;
}

function Section(props: { title: string; disabled: boolean; children: ReactNode }) {
  return (
    <fieldset className="settings-section" disabled={props.disabled}>
      <legend>
        <h2>{props.title}</h2>
      </legend>
      {props.children}
    </fieldset>
  );
}

function Check(props: { checked: boolean; onChange: (on: boolean) => void; children: string }) {
  return (
    <label className="settings-row">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => {
          props.onChange(event.target.checked);
        }}
      />
      {props.children}
    </label>
  );
}
