import type { Parser, RegistryRow, Status, Surface } from "../schema.ts";
import { sortRows, validateRows } from "../schema.ts";
import { normalizeDashes, parseDateCell } from "../dates.ts";
import { codeSpans, extractTables, unbacktick } from "../tables.ts";

const SOURCE_URL = "https://developers.openai.com/api/docs/deprecations";
const DOCS = "https://developers.openai.com/api/docs";

interface Identity {
  slug: string;
  surface: Surface;
  apiIds: string[];
  migrationUrl?: string;
  /** when set, replacement parsing is skipped: replacement_id null, these notes */
  replacementNotes?: string;
}

/**
 * Enrichment map: the page names products and headers in prose, customer code
 * greps concrete strings. Keyed by the exact model-cell text so parser output
 * is the complete seed.
 */
const SPECIAL: Record<string, Identity> = {
  "Assistants API": {
    slug: "assistants-api",
    surface: "endpoint",
    apiIds: [
      "client.beta.assistants",
      "client.beta.threads",
      "openai.beta.assistants",
      "openai.beta.threads",
      "/v1/assistants",
      "/v1/threads",
      "OpenAI-Beta: assistants",
    ],
    replacementNotes: "Responses API + Conversations API",
    migrationUrl: `${DOCS}/assistants/migration`,
  },
  "Videos API": {
    slug: "videos-api",
    surface: "endpoint",
    apiIds: ["/v1/videos"],
  },
  "OpenAI-Beta: realtime=v1": {
    slug: "openai-beta-realtime-v1",
    surface: "header",
    apiIds: ["OpenAI-Beta: realtime=v1"],
    migrationUrl: `${DOCS}/guides/realtime#beta-to-ga-migration`,
  },
  "OpenAI-Beta: assistants=v1": {
    slug: "openai-beta-assistants-v1",
    surface: "header",
    apiIds: ["OpenAI-Beta: assistants=v1"],
    migrationUrl: `${DOCS}/assistants/migration`,
  },
  // 2024-08-29 rows deprecate *training on* these models, not the models
  // themselves (babbage-002/davinci-002 have their own later rows).
  "New fine-tuning training on `babbage-002`": {
    slug: "fine-tuning-training-babbage-002",
    surface: "feature",
    apiIds: ["babbage-002"],
  },
  "New fine-tuning training on `davinci-002`": {
    slug: "fine-tuning-training-davinci-002",
    surface: "feature",
    apiIds: ["davinci-002"],
  },
};

/** Product shutdowns announced as [Date, Update] timeline tables, keyed by h3 title. */
const PRODUCTS: Array<Identity & { match: RegExp }> = [
  {
    match: /reusable prompts/i,
    slug: "v1-prompts",
    surface: "endpoint",
    apiIds: ["/v1/prompts"],
    migrationUrl: `${DOCS}/guides/prompting/migrate-from-prompt-object`,
  },
  {
    match: /evals/i,
    slug: "evals",
    surface: "feature",
    apiIds: ["/v1/evals"],
    migrationUrl:
      "https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo",
  },
  {
    match: /agent builder/i,
    slug: "agent-builder",
    surface: "feature",
    apiIds: ["agent-builder"],
    migrationUrl: `${DOCS}/guides/agent-builder/migrate-from-agent-builder`,
  },
  {
    match: /fine-tuning/i,
    slug: "fine-tuning",
    surface: "feature",
    apiIds: ["/v1/fine_tuning/jobs"],
  },
];

/** Header names observed for the model column; match by name, never position. */
const MODEL_HEADERS = new Set([
  "model / system",
  "model family / snapshot",
  "model snapshot",
  "deprecated model",
  "legacy model",
  "system",
  "model",
]);

const ID_TOKEN = /^\/?[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Slug for the row id. Keeps dots (so `gpt-4.5-preview` stays `gpt-4.5-preview`),
 * folds every other run of non-slug chars to a single dash, and trims junk off
 * the ends. Returns "" when nothing usable survives, so callers drop the row
 * instead of feeding the schema regex an id it will reject and throw on.
 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "");
}

interface Section {
  title: string;
  /** ISO date prefix of the h3 title ("2026-06-11: ...") or null */
  announced: string | null;
  body: string;
}

/**
 * Split the page into h3 sections under the Upcoming/Past deprecation h2s.
 * Tables are extracted per section so h4 subsections (2023-era) still inherit
 * the h3 announcement date.
 */
function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let h2: string | null = null;
  let current: { title: string; body: string[] } | null = null;
  const flush = () => {
    if (current) {
      sections.push({
        title: current.title,
        announced: current.title.match(/^(\d{4}-\d{2}-\d{2}):/)?.[1] ?? null,
        body: current.body.join("\n"),
      });
    }
    current = null;
  };
  for (const line of md.split("\n")) {
    const hm = line.match(/^(#{2,3})\s+(.*)$/);
    if (hm) {
      flush();
      if (hm[1] === "##") {
        h2 = hm[2].trim();
      } else if (h2 === "Upcoming deprecations" || h2 === "Past deprecations") {
        current = { title: hm[2].trim(), body: [] };
      }
      continue;
    }
    current?.body.push(line);
  }
  flush();
  return sections;
}

/**
 * extractTables splits on every "|", including escaped "\|" inside alias cells
 * ("`gpt-4-0613` \| `gpt-4`, ..."). Rejoin: a cell ending in "\" was split at
 * an escaped pipe.
 */
function fixCells(cells: string[], headerCount: number): string[] {
  const out = [...cells];
  let i = 0;
  while (i < out.length - 1 && out.length > headerCount) {
    if (out[i].endsWith("\\")) {
      out.splice(i, 2, `${out[i].slice(0, -1).trimEnd()} | ${out[i + 1]}`);
    } else {
      i++;
    }
  }
  return out;
}

function parseShutdown(cell: string): { dies: string | null; earliest: boolean } {
  const direct = parseDateCell(cell);
  if (direct) return { dies: direct, earliest: false };
  const m = normalizeDashes(cell).match(/at earliest\s+(.+)$/i);
  if (m) {
    const d = parseDateCell(m[1]);
    if (d) return { dies: d, earliest: true };
  }
  return { dies: null, earliest: false };
}

function computeStatus(
  dies: string | null,
  earliest: boolean,
  legacyHeader: boolean,
  verifiedAt: string,
): Status {
  // The page's own designation: "Legacy model" column with only a tentative date.
  if (legacyHeader && (dies === null || earliest)) return "legacy";
  if (dies !== null && !earliest && dies < verifiedAt) return "retired";
  return "deprecated";
}

function parseReplacement(cell: string): {
  id: string | null;
  notes: string | null;
  migration: string | null;
} {
  const s = cell.trim();
  if (!s || s === "---") return { id: null, notes: null, migration: null };
  const link = s.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    const inner = link[1].trim();
    return ID_TOKEN.test(inner)
      ? { id: inner, notes: null, migration: link[2] }
      : { id: null, notes: inner, migration: link[2] };
  }
  // "`gpt-5.6-sol` (`reasoning.mode: pro`)" -> bare id + config notes
  const config = s.match(/^`([^`]+)`\s*\(`([^`]+)`\)$/);
  if (config) return { id: config[1], notes: config[2], migration: null };
  const plain = unbacktick(s).replace(/\s+/g, " ");
  if (ID_TOKEN.test(plain)) return { id: plain, notes: null, migration: null };
  // multiple options or prose: no single replacement id
  return { id: null, notes: plain, migration: null };
}

/** Model/endpoint identity from a model cell: backticked span(s) or a bare id. */
function genericIdentity(modelCell: string): Identity | null {
  const spans = codeSpans(modelCell);
  const ids = spans.length ? spans : ID_TOKEN.test(modelCell) ? [modelCell] : [];
  if (ids.length === 0) return null;
  const primary = ids[0];
  const surface: Surface = primary.startsWith("/") ? "endpoint" : "model";
  const slug = slugify(primary);
  if (!slug) return null; // an id that sanitizes to nothing is not a real row
  // alias spans ("`gpt-4-0613` | `gpt-4`, `gpt-4-completions`") all greppable
  return { slug, surface, apiIds: ids };
}

/**
 * The page lists some ids twice (e.g. gpt-4-1106-preview retired 2026-03-26 AND
 * scheduled 2026-10-23; code-davinci-002 in two past tables). Keep one row per
 * id: a definite death beats a legacy/earliest-only row, then the earlier death
 * wins, then first occurrence.
 */
function betterRow(a: RegistryRow, b: RegistryRow): boolean {
  if ((a.status === "legacy") !== (b.status === "legacy")) return b.status === "legacy";
  if (a.dies !== b.dies) {
    if (a.dies === null) return false;
    if (b.dies === null) return true;
    return a.dies < b.dies;
  }
  return false;
}

export const parseOpenAI: Parser = (raw, opts) => {
  const candidates: RegistryRow[] = [];
  const base = {
    provider: "openai" as const,
    source_url: SOURCE_URL,
    verified_at: opts.verifiedAt,
    platform: "first-party" as const,
  };

  for (const section of splitSections(raw)) {
    for (const table of extractTables(section.body)) {
      const headers = table.headers.map((h) => h.toLowerCase());
      const dateIdx = headers.findIndex((h) => h === "shutdown date" || h === "date");
      if (dateIdx === -1) continue;

      const updateIdx = headers.indexOf("update");
      if (updateIdx !== -1) {
        // product shutdown timeline: [Date, Update]
        const product = PRODUCTS.find((p) => p.match.test(section.title));
        if (!product) {
          // a new product shutdown the PRODUCTS map doesn't know about: don't
          // guess an identity, but surface it so a human adds the entry
          console.warn(`openai: dropped unmapped product shutdown section "${section.title}"`);
          continue;
        }
        const entries = table.rows.map((r) => ({
          date: parseDateCell(r[dateIdx] ?? ""),
          text: r[updateIdx] ?? "",
        }));
        const death =
          entries.find((e) => /shut down/i.test(e.text)) ?? entries[entries.length - 1];
        const dies = death?.date ?? null;
        const announced =
          entries.find((e) => /announced/i.test(e.text))?.date ??
          section.announced ??
          entries[0]?.date ??
          null;
        candidates.push({
          ...base,
          id: `openai:${product.surface}:${product.slug}`,
          surface: product.surface,
          api_ids: product.apiIds,
          status: computeStatus(dies, false, false, opts.verifiedAt),
          announced,
          dies,
          dies_is_earliest_possible: false,
          replacement_id: null,
          replacement_notes: null,
          migration_url: product.migrationUrl ?? null,
        });
        continue;
      }

      const modelIdx = headers.findIndex((h) => MODEL_HEADERS.has(h));
      if (modelIdx === -1) continue;
      const replIdx = headers.findIndex(
        (h) => h.includes("replacement") || h === "substitute model",
      );
      const legacyHeader = headers[modelIdx] === "legacy model";

      for (const rawCells of table.rows) {
        const cells = fixCells(rawCells, table.headers.length);
        const modelCell = (cells[modelIdx] ?? "").trim();
        const identity = SPECIAL[modelCell] ?? genericIdentity(modelCell);
        if (!identity) {
          // a prose model cell with no greppable id: log rather than silently
          // drop, so a human can decide whether it needs a SPECIAL entry
          if (modelCell) console.warn(`openai: dropped model cell with no api id: "${modelCell}"`);
          continue;
        }
        const { dies, earliest } = parseShutdown(cells[dateIdx] ?? "");
        const repl =
          identity.replacementNotes !== undefined
            ? { id: null, notes: identity.replacementNotes, migration: null }
            : parseReplacement(replIdx === -1 ? "" : cells[replIdx] ?? "");
        candidates.push({
          ...base,
          id: `openai:${identity.surface}:${identity.slug}`,
          surface: identity.surface,
          api_ids: identity.apiIds,
          status: computeStatus(dies, earliest, legacyHeader, opts.verifiedAt),
          announced: section.announced,
          dies,
          dies_is_earliest_possible: earliest,
          replacement_id: repl.id,
          replacement_notes: repl.notes,
          migration_url: identity.migrationUrl ?? repl.migration ?? null,
        });
      }
    }
  }

  const byId = new Map<string, RegistryRow>();
  for (const row of candidates) {
    const prev = byId.get(row.id);
    if (!prev || betterRow(row, prev)) byId.set(row.id, row);
  }
  return sortRows(validateRows([...byId.values()]));
};
