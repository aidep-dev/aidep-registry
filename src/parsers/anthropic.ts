import type { Parser, RegistryRow } from "../schema.ts";
import { sortRows, validateRows } from "../schema.ts";
import { parseDateCell } from "../dates.ts";
import { codeSpans, extractTables, unbacktick } from "../tables.ts";

const PAGE = "https://platform.claude.com/docs/en/about-claude/model-deprecations";

interface ModelInfo {
  announced: string | null;
  dies: string | null;
  replacement: string | null;
}

export const parseAnthropic: Parser = (raw, opts) => {
  const tables = extractTables(raw);
  const models = new Map<string, ModelInfo>();

  // Deprecation history: "### YYYY-MM-DD: <name>" sections, backticked ids.
  // The h3 date is the announcement date; the table carries retirement + replacement.
  for (const t of tables) {
    if (t.headers[0] !== "Retirement date") continue;
    const sectionDate = t.heading?.match(/^(\d{4}-\d{2}-\d{2}):/)?.[1] ?? null;
    for (const [retirement, model, replacement] of t.rows) {
      if (retirement === undefined || model === undefined) continue; // short/malformed row
      const id = unbacktick(model).toLowerCase();
      // History sections run newest-first; a re-deprecated model keeps its
      // newest row, so never overwrite an id a later (older) table also lists.
      if (models.has(id)) continue;
      models.set(id, {
        announced: sectionDate,
        dies: parseDateCell(retirement),
        replacement: unbacktick(replacement ?? "") || null,
      });
    }
  }

  // Model status table: ids not backticked. Active rows are not deprecation
  // events (their "Not sooner than" dates are tentative), so skip them. For
  // the rest, the Deprecated column is the authoritative announced date.
  for (const t of tables) {
    if (t.headers[0] !== "API model name") continue;
    for (const [name, state, deprecated, retirement] of t.rows) {
      if (name === undefined) continue; // short/malformed row
      // Only Deprecated/Retired are deprecation events. Active AND Legacy
      // (which just means "no more updates") are not, so skip anything else.
      if (state !== "Deprecated" && state !== "Retired") continue;
      const id = name.toLowerCase();
      const announced = parseDateCell(deprecated ?? "");
      const retire = retirement ?? "";
      const existing = models.get(id);
      if (existing) {
        if (announced) existing.announced = announced;
      } else {
        models.set(id, {
          announced,
          dies: /not sooner than/i.test(retire) ? null : parseDateCell(retire),
          replacement: null,
        });
      }
    }
  }

  // Deprecations announced only in a <Note>, e.g. mythos-preview:
  // "(`claude-mythos-preview`) is deprecated. To migrate to ... (`claude-mythos-5`)"
  const note = raw.match(/\(`([a-z0-9._-]+)`\)\s+is deprecated\..*?migrate to.*?\(`([a-z0-9._-]+)`\)/is);
  if (note && !models.has(note[1].toLowerCase())) {
    models.set(note[1].toLowerCase(), { announced: null, dies: null, replacement: note[2] });
  }

  const rows: RegistryRow[] = [];
  for (const [id, m] of models) {
    rows.push({
      id: `anthropic:model:${id}`,
      provider: "anthropic",
      surface: "model",
      api_ids: [id],
      status: m.dies !== null && m.dies < opts.verifiedAt ? "retired" : "deprecated",
      announced: m.announced,
      dies: m.dies,
      dies_is_earliest_possible: false,
      replacement_id: m.replacement,
      replacement_notes: null,
      migration_url: PAGE,
      source_url: PAGE,
      verified_at: opts.verifiedAt,
      platform: "first-party",
    });
  }

  // API parameter deprecations: one row per table row, api_ids from code spans.
  for (const t of tables) {
    if (t.headers[0] !== "Parameter") continue;
    for (const r of t.rows) {
      const ids = codeSpans(r[0] ?? "");
      if (ids.length === 0 || !/deprecated/i.test(r[1] ?? "")) continue;
      rows.push({
        id: `anthropic:param:${ids.map((s) => s.replace(/_/g, "-")).join("-")}`,
        provider: "anthropic",
        surface: "param",
        api_ids: ids,
        status: "deprecated",
        announced: null,
        dies: null,
        dies_is_earliest_possible: false,
        replacement_id: null,
        replacement_notes:
          "omit temperature/top_p/top_k on Claude Opus 4.7+ and newer; non-default values return 400. Use prompting instead.",
        migration_url: PAGE,
        source_url: PAGE,
        verified_at: opts.verifiedAt,
        platform: "first-party",
      });
    }
  }

  return sortRows(validateRows(rows));
};
