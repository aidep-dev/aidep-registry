import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Parser, Provider, RegistryRow } from "./schema.ts";
import { sortRows, validateRows } from "./schema.ts";
import { parseOpenAI } from "./parsers/openai.ts";
import { parseAnthropic } from "./parsers/anthropic.ts";
import { parseGoogle } from "./parsers/google.ts";

export const SOURCES: { provider: Provider; url: string; parse: Parser }[] = [
  {
    provider: "openai",
    url: "https://developers.openai.com/api/docs/deprecations.md",
    parse: parseOpenAI,
  },
  {
    provider: "anthropic",
    url: "https://platform.claude.com/docs/en/about-claude/model-deprecations.md",
    parse: parseAnthropic,
  },
  {
    provider: "google",
    // hl=en + the Accept-Language header below: without them the CDN
    // intermittently serves localized pages whose headers don't parse
    url: "https://ai.google.dev/gemini-api/docs/deprecations?hl=en",
    parse: parseGoogle,
  },
];

const FETCH_HEADERS = {
  "accept-language": "en",
  "user-agent": "aidep-registry-poller (+https://github.com/aidep)",
};

/** Fields the parser owns; everything else on an existing row is hand-owned. */
const PARSER_FIELDS = [
  "status",
  "announced",
  "dies",
  "dies_is_earliest_possible",
  "replacement_id",
  // replacement_id and replacement_notes are two halves of one fact: a page that
  // swaps a single replacement for several options sets id=null + notes, so notes
  // must move with id or the new replacement info is lost.
  "replacement_notes",
  "source_url",
] as const;

export interface FieldChange {
  id: string;
  field: string;
  old: string | boolean | null;
  new: string | boolean | null;
}

export interface Diff {
  added: RegistryRow[];
  changed: FieldChange[];
  /** ids present in the registry but gone from the page; kept, never auto-deleted */
  gone: string[];
}

export function readRegistry(dir: string, provider: Provider): RegistryRow[] {
  const p = join(dir, `${provider}.json`);
  if (!existsSync(p)) return []; // first run
  return validateRows(JSON.parse(readFileSync(p, "utf8")));
}

export function writeRegistry(dir: string, provider: Provider, rows: RegistryRow[]): void {
  writeFileSync(join(dir, `${provider}.json`), JSON.stringify(rows, null, 2) + "\n");
}

/**
 * Merge parse output into the existing registry file. Parser-owned fields
 * overwrite; hand-owned fields (api_ids, replacement_notes, migration_url)
 * are preserved on existing rows. Rows gone from the page are kept and
 * flagged for review. verified_at moves only on rows that actually changed.
 */
function mergeRows(
  existing: RegistryRow[],
  parsed: RegistryRow[],
  verifiedAt: string,
  diff: Diff,
): RegistryRow[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: RegistryRow[] = [];

  for (const p of parsed) {
    seen.add(p.id);
    const old = byId.get(p.id);
    if (!old) {
      diff.added.push(p);
      out.push(p);
      continue;
    }
    const changes = PARSER_FIELDS.filter((f) => old[f] !== p[f]);
    if (changes.length === 0) {
      out.push(old);
      continue;
    }
    for (const f of changes) diff.changed.push({ id: p.id, field: f, old: old[f], new: p[f] });
    out.push({
      ...old,
      status: p.status,
      announced: p.announced,
      dies: p.dies,
      dies_is_earliest_possible: p.dies_is_earliest_possible,
      replacement_id: p.replacement_id,
      replacement_notes: p.replacement_notes,
      source_url: p.source_url,
      verified_at: verifiedAt,
    });
  }

  for (const r of existing) {
    if (!seen.has(r.id)) {
      diff.gone.push(r.id);
      out.push(r);
    }
  }
  return sortRows(out);
}

function renderPrBody(diff: Diff): string {
  const lines: string[] = [
    `Provider deprecation pages changed: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.gone.length} gone from page.`,
    "",
  ];
  if (diff.added.length) {
    lines.push("## Added", "", "| id | dies | replacement |", "| --- | --- | --- |");
    for (const r of diff.added) {
      lines.push(`| ${r.id} | ${r.dies ?? "-"} | ${r.replacement_id ?? "-"} |`);
    }
    lines.push("");
  }
  if (diff.changed.length) {
    lines.push("## Changed", "", "| id | field | old → new |", "| --- | --- | --- |");
    for (const c of diff.changed) {
      lines.push(`| ${c.id} | ${c.field} | ${c.old} → ${c.new} |`);
    }
    lines.push("");
  }
  if (diff.gone.length) {
    lines.push(
      "## Gone from page (review: page removed the row — do not auto-delete)",
      "",
      "| id |",
      "| --- |",
    );
    for (const id of diff.gone) lines.push(`| ${id} |`);
    lines.push("");
  }
  lines.push("## Sources", "");
  for (const s of SOURCES) lines.push(`- ${s.provider}: ${s.url}`);
  lines.push("", "Merging this PR is the approval step.", "");
  return lines.join("\n");
}

export async function runPoller(opts: {
  fetchImpl?: typeof fetch;
  registryDir?: string;
  stateDir?: string;
  dryRun?: boolean;
  verifiedAt: string;
}): Promise<{ changed: boolean; diff: Diff; prBody: string; anomalies: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const registryDir = opts.registryDir ?? "registry";
  const stateDir = opts.stateDir ?? "state";
  const hashPath = join(stateDir, "hashes.json");
  const hashes: Record<string, string> = existsSync(hashPath)
    ? JSON.parse(readFileSync(hashPath, "utf8"))
    : {};

  const diff: Diff = { added: [], changed: [], gone: [] };
  const merged = new Map<Provider, RegistryRow[]>();
  const anomalies: string[] = [];

  for (const src of SOURCES) {
    const res = await fetchImpl(src.url, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`${src.provider}: HTTP ${res.status} for ${src.url}`);
    const raw = await res.text();
    const hash = createHash("sha256").update(raw).digest("hex");
    // No byte-identical short-circuit: status is derived from dies vs verifiedAt,
    // so a shutdown date passing must be able to flip a row even on an unchanged
    // page. The merge still records a diff only when a parser field moved.
    let parsed: RegistryRow[];
    try {
      parsed = src.parse(raw, { verifiedAt: opts.verifiedAt });
    } catch (e) {
      // One provider's page breaking the parser must not block the other two.
      // Leave its hash unwritten so the next run retries this source.
      anomalies.push(
        `${src.provider}: parse failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    const existing = readRegistry(registryDir, src.provider);
    if (parsed.length === 0) {
      // A provider page never legitimately parses to zero rows; that's a fetch or
      // page-shape anomaly (e.g. a localized variant), never a mass removal. This
      // must fire even on an empty registry, or a broken first run seeds nothing
      // and persists the bad page's hash.
      anomalies.push(
        `${src.provider}: parsed 0 rows but registry has ${existing.length}; skipping source`,
      );
      continue;
    }
    hashes[src.provider] = hash;
    merged.set(src.provider, mergeRows(existing, parsed, opts.verifiedAt, diff));
  }

  const changed = diff.added.length + diff.changed.length + diff.gone.length > 0;
  const prBody = renderPrBody(diff);

  if (changed) {
    if (opts.dryRun) {
      console.log(prBody);
    } else {
      mkdirSync(registryDir, { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      for (const [provider, rows] of merged) writeRegistry(registryDir, provider, rows);
      writeFileSync(hashPath, JSON.stringify(hashes, null, 2) + "\n");
      // sibling of the state dir, i.e. the repo root in production
      writeFileSync(join(dirname(stateDir), ".poller-pr-body.md"), prBody);
    }
  }

  return { changed, diff, prBody, anomalies };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runPoller({
    dryRun: process.argv.includes("--dry-run"),
    verifiedAt: new Date().toISOString().slice(0, 10),
  })
    .then((r) => {
      for (const a of r.anomalies) console.error(`ANOMALY ${a}`);
      console.log(
        r.changed
          ? `changed: ${r.diff.added.length} added, ${r.diff.changed.length} changed, ${r.diff.gone.length} gone`
          : "no change",
      );
      // Anomalies are logged, never fatal: exiting non-zero here would fail the
      // poll step and block liveness, tripwire, and the PR for the providers that
      // DID parse. Only a real crash (the catch below) aborts the pipeline.
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
