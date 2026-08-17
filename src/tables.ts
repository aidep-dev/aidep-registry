export interface MdTable {
  headers: string[];
  rows: string[][];
  /** text of the nearest preceding markdown heading, or null */
  heading: string | null;
  /** level of that heading (1 for #, 2 for ##, ...) or 0 */
  headingLevel: number;
  /** text of the nearest preceding h2, tracked separately (OpenAI splits Upcoming/Past at h2) */
  h2: string | null;
}

/**
 * Extract every pipe table from a markdown document, tagged with the heading
 * context it sits under. Cells are trimmed; backticks and other inline markup
 * are left intact for the caller. No escaped-pipe handling: none of the three
 * provider pages uses it.
 */
export function extractTables(md: string): MdTable[] {
  const lines = md.split("\n");
  const tables: MdTable[] = [];
  let heading: string | null = null;
  let headingLevel = 0;
  let h2: string | null = null;
  let current: string[][] | null = null;

  // a row whose closing "|" wrapped onto a later physical line, held until it closes
  let pending: string | null = null;

  const flush = () => {
    if (current && current.length >= 2) {
      // row 1 must be the separator (---) row; drop it
      const [headers, sep, ...rows] = current;
      if (sep.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")))) {
        tables.push({ headers, rows, heading, headingLevel, h2 });
      }
    }
    current = null;
  };

  const pushRow = (rowText: string) => {
    const cells = rowText
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    (current ??= []).push(cells);
  };

  for (const line of lines) {
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      pending = null; // a heading ends any table, a half-wrapped row included
      flush();
      headingLevel = hm[1].length;
      heading = hm[2].trim();
      if (headingLevel === 2) h2 = heading;
      continue;
    }
    const t = line.trim();
    if (pending !== null) {
      // continuation of a hard-wrapped row; a blank line means it never closed
      if (t === "") {
        pending = null;
        flush();
        continue;
      }
      pending = `${pending} ${t}`;
      if (pending.endsWith("|")) {
        pushRow(pending);
        pending = null;
      }
      continue;
    }
    if (t.startsWith("|") && t.length > 1) {
      // a "| ..." line with no closing "|" is a wrapped row: hold it, don't end
      // the table (which would silently drop every row that follows)
      if (t.endsWith("|")) pushRow(t);
      else pending = t;
    } else {
      flush();
    }
  }
  pending = null;
  flush();
  return tables;
}

/** Strip surrounding backticks from a cell fragment: "`gpt-4`" -> "gpt-4". */
export function unbacktick(s: string): string {
  return s.replace(/`([^`]*)`/g, "$1").trim();
}

/** All backticked code spans in a cell, in order. */
export function codeSpans(s: string): string[] {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}
