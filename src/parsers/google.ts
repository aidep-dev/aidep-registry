import { load } from "cheerio";
import type { Parser, RegistryRow } from "../schema.ts";
import { validateRows, sortRows } from "../schema.ts";
import { parseDateCell } from "../dates.ts";

const SOURCE_URL = "https://ai.google.dev/gemini-api/docs/deprecations";

/**
 * Parse https://ai.google.dev/gemini-api/docs/deprecations (HTML).
 * Every model lives in a <table class="pricing-table">; headers are td>b, not th.
 * Only rows with an announced shutdown date become registry rows: active models
 * with "No shutdown date announced" would alert on everything current.
 */
export const parseGoogle: Parser = (raw, opts) => {
  const $ = load(raw);
  const rows: RegistryRow[] = [];

  $("table.pricing-table").each((_, table) => {
    const $table = $(table);
    // Map columns by header name, never by position: an inserted column would
    // otherwise silently shift model/date/replacement into the wrong fields.
    const headers = $table
      .find("thead td b")
      .map((_, b) => $(b).text().trim())
      .get();
    const modelIdx = headers.findIndex((h) => /^model$/i.test(h));
    const diesIdx = headers.findIndex((h) => /shutdown/i.test(h));
    const replIdx = headers.findIndex((h) => /replacement/i.test(h));
    // Missing any of the three columns: skip the whole table. Its rows just
    // drop, which the poller reads as a parsed-count anomaly rather than junk.
    if (modelIdx === -1 || diesIdx === -1 || replIdx === -1) return;
    const maxIdx = Math.max(modelIdx, diesIdx, replIdx);

    $table.find("tbody tr").each((_, tr) => {
      const tds = $(tr).children("td");
      // "Preview models" divider rows span the table (one colspan cell)
      if (tds.length <= maxIdx || $(tds[0]).attr("colspan")) return;

      const model = $(tds[modelIdx]).find("code").first().text().trim();
      if (!model) return;

      const dies = parseDateCell($(tds[diesIdx]).text());
      if (dies === null) return; // no shutdown date announced -> still active, skip

      // The page's shutdown dates are the *earliest possible*, not deaths, so a
      // passed date does NOT mean retired. Actual death is a grayed-out row (or
      // the model leaving /v1/models, which liveness catches).
      const retired = ($(tr).attr("class") ?? "").includes("row-gray");

      // Replacement cell: usually one <code>; Veo rows add "or the GA models on
      // the <a>Gemini Enterprise Agent Platform</a>" (multiple options -> notes);
      // one Robotics row is a bare-text model id with no <code> at all.
      const repTd = $(tds[replIdx]);
      const codes = repTd
        .find("code")
        .map((_, c) => $(c).text().trim())
        .get()
        .filter(Boolean);
      const anchor = repTd.find("a").first();
      let replacement_id: string | null = null;
      let replacement_notes: string | null = null;
      if (anchor.length) {
        const link = `${anchor.text().trim()} (${anchor.attr("href") ?? ""})`;
        replacement_notes = codes.length ? `${codes.join(", ")} or ${link}` : link;
      } else if (codes.length === 1) {
        replacement_id = codes[0];
      } else if (codes.length === 0) {
        const text = repTd.text().trim();
        if (/^[a-z0-9][a-z0-9.-]*$/.test(text)) replacement_id = text;
        else if (text) replacement_notes = text;
      } else {
        replacement_notes = codes.join(", ");
      }

      rows.push({
        id: `google:model:${model.toLowerCase()}`,
        provider: "google",
        surface: "model",
        api_ids: [model],
        status: retired ? "retired" : "deprecated",
        announced: null, // the page lists release dates, not announcement dates
        dies,
        // shutdown dates are earliest-possible; only a definite (gray) death isn't
        dies_is_earliest_possible: !retired,
        replacement_id,
        replacement_notes,
        migration_url: null,
        source_url: SOURCE_URL,
        verified_at: opts.verifiedAt,
        platform: "first-party",
      });
    });
  });

  return sortRows(validateRows(rows));
};
