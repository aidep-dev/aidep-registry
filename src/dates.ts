const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/**
 * OpenAI's page uses U+2011 non-breaking hyphens in a handful of date cells
 * (including the Assistants API row). Normalize the whole unicode dash family
 * before any date parsing.
 */
export function normalizeDashes(s: string): string {
  return s.replace(/[‐‑‒–—―]/g, "-");
}

/**
 * Parse the three date formats observed on provider pages into YYYY-MM-DD:
 *   "2026-08-26" (ISO, sometimes with U+2011), "Dec 11, 2026", "June 3, 2026".
 * "Sept" is matched via its first three letters. Returns null on anything else
 * ("No shutdown date announced", "N/A", prose) so callers can carry a null date.
 */
export function parseDateCell(raw: string): string | null {
  const s = normalizeDashes(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^([A-Z][a-z]+)\.?\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3)];
  if (!month) return null;
  return `${m[3]}-${month}-${m[2].padStart(2, "0")}`;
}
