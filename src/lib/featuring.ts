// « A feat. B »: the main artist and the guest, cut as Ongaku cuts them
// (ONG-21), so that the phone and the PC file the same way. Only « feat »,
// « ft » and « featuring » cut, with or without a dot or a bracket before;
// « & » and commas never do (« Simon & Garfunkel », « Earth, Wind & Fire »).

/** What follows the main artist: « feat. B », « (ft. B) », « featuring B ». */
const FEATURING = /\s+[([]?(?:feat|ft|featuring)\b\.?\s.*$/i;
const FEATURING_HEAD = /^\s+[([]?(?:feat|ft|featuring)\b\.?\s+/i;

/** The main artist of a tag, and the guest after « feat. », if any. */
export function splitFeaturing(artist: string): { main: string; guest: string | null } {
  const whole = artist.trim();
  const match = FEATURING.exec(artist);
  const main = match ? artist.slice(0, match.index).trim() : "";
  if (!match || !main) return { main: whole, guest: null };
  const guest = match[0]
    .replace(FEATURING_HEAD, "")
    .replace(/[)\]]\s*$/, "")
    .trim();
  return { main, guest: guest || null };
}
