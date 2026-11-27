import { formatNumber } from "../lib/libraries";
import type { Choice, Facets, Filters, MinBitrate, MinRating, Recent } from "../lib/search";

interface Props {
  facets: Facets;
  filters: Filters;
  onFilters: (filters: Filters) => void;
}

/** A list of boxes, any of which may be ticked. */
function Boxes<T extends string | number>({
  legend,
  choices,
  chosen,
  onChosen,
}: {
  legend: string;
  choices: Choice<T>[];
  chosen: T[];
  onChosen: (chosen: T[]) => void;
}) {
  if (choices.length === 0) return null;
  return (
    <fieldset className="filter-group">
      <legend>{legend}</legend>
      <ul>
        {choices.map((choice) => (
          <li key={String(choice.value)}>
            <label>
              <input
                type="checkbox"
                checked={chosen.includes(choice.value)}
                onChange={(event) => {
                  onChosen(
                    event.target.checked
                      ? [...chosen, choice.value]
                      : chosen.filter((c) => c !== choice.value),
                  );
                }}
              />{" "}
              {choice.label} <span className="count">{formatNumber(choice.count)}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** One choice at most, « Tous » for none. */
function Radios<T extends number>({
  legend,
  name,
  choices,
  chosen,
  onChosen,
}: {
  legend: string;
  name: string;
  choices: Choice<T>[];
  chosen: T | null;
  onChosen: (chosen: T | null) => void;
}) {
  return (
    <fieldset className="filter-group">
      <legend>{legend}</legend>
      <ul>
        <li>
          <label>
            <input
              type="radio"
              name={name}
              checked={chosen === null}
              onChange={() => {
                onChosen(null);
              }}
            />{" "}
            Tous
          </label>
        </li>
        {choices.map((choice) => (
          <li key={choice.value}>
            <label>
              <input
                type="radio"
                name={name}
                checked={chosen === choice.value}
                onChange={() => {
                  onChosen(choice.value);
                }}
              />{" "}
              {choice.label} <span className="count">{formatNumber(choice.count)}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * The filters, each choice with the tracks it would leave. Within a group
 * any choice will do; the groups add up.
 */
export function FilterPanel({ facets, filters, onFilters }: Props) {
  const set =
    <K extends keyof Filters>(key: K) =>
    (value: Filters[K]) => {
      onFilters({ ...filters, [key]: value });
    };
  return (
    <div className="filter-panel-groups">
      <fieldset className="filter-group">
        <legend>Favoris</legend>
        <ul>
          <li>
            <label>
              <input
                type="checkbox"
                checked={filters.favorite}
                onChange={(event) => {
                  set("favorite")(event.target.checked);
                }}
              />{" "}
              Seulement les favoris <span className="count">{formatNumber(facets.favorite)}</span>
            </label>
          </li>
        </ul>
      </fieldset>
      <Radios<MinRating>
        legend="Note"
        name="filter-rating"
        choices={facets.minRating}
        chosen={filters.minRating}
        onChosen={set("minRating")}
      />
      <Boxes
        legend="Genre"
        choices={facets.genres}
        chosen={filters.genres}
        onChosen={set("genres")}
      />
      <Boxes
        legend="Décennie"
        choices={facets.decades}
        chosen={filters.decades}
        onChosen={set("decades")}
      />
      <Boxes
        legend="Format"
        choices={facets.formats}
        chosen={filters.formats}
        onChosen={set("formats")}
      />
      <Boxes
        legend="Qualité"
        choices={facets.quality}
        chosen={filters.quality}
        onChosen={set("quality")}
      />
      <Radios<MinBitrate>
        legend="Débit minimal"
        name="filter-bitrate"
        choices={facets.minBitrate}
        chosen={filters.minBitrate}
        onChosen={set("minBitrate")}
      />
      <Boxes
        legend="Durée"
        choices={facets.durations}
        chosen={filters.durations}
        onChosen={set("durations")}
      />
      <Radios<Recent>
        legend="Ajoutés"
        name="filter-recent"
        choices={facets.recent}
        chosen={filters.recent}
        onChosen={set("recent")}
      />
      <fieldset className="filter-group">
        <legend>À compléter</legend>
        <ul>
          <li>
            <label>
              <input
                type="checkbox"
                checked={filters.noCover}
                onChange={(event) => {
                  set("noCover")(event.target.checked);
                }}
              />{" "}
              Sans pochette dans les tags{" "}
              <span className="count">{formatNumber(facets.noCover)}</span>
            </label>
          </li>
          <li>
            <label>
              <input
                type="checkbox"
                checked={filters.incomplete}
                onChange={(event) => {
                  set("incomplete")(event.target.checked);
                }}
              />{" "}
              Tags incomplets (artiste, album, année, n°){" "}
              <span className="count">{formatNumber(facets.incomplete)}</span>
            </label>
          </li>
        </ul>
      </fieldset>
    </div>
  );
}
