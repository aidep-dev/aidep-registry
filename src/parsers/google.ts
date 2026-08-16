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

  $("table.pricing-table tbody tr").each((_, tr) => {
    const tds = $(tr).children("td");
    // "Preview models" divider rows span the table
    if (tds.length < 4 || $(tds[0]).attr("colspan")) return;

    const model = $(tds[0]).find("code").first().text().trim();
    if (!model) return;

    const dies = parseDateCell($(tds[2]).text());
    if (dies === null) return; // no shutdown date announced -> still active, skip

    const retired = ($(tr).attr("class") ?? "").includes("row-gray") || dies < opts.verifiedAt;

    // Replacement cell: usually one <code>; Veo rows add "or the GA models on
    // the <a>Gemini Enterprise Agent Platform</a>" (multiple options -> notes);
    // one Robotics row is a bare-text model id with no <code> at all.
    const repTd = $(tds[3]);
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
      // the page says shutdown dates are the earliest possible; moot once retired
      dies_is_earliest_possible: !retired,
      replacement_id,
      replacement_notes,
      migration_url: null,
      source_url: SOURCE_URL,
      verified_at: opts.verifiedAt,
      platform: "first-party",
    });
  });

  return sortRows(validateRows(rows));
};
