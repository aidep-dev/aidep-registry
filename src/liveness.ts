import { pathToFileURL } from "node:url";
import type { Provider } from "./schema.ts";
import { readRegistry, writeRegistry } from "./poller.ts";

interface Check {
  provider: Provider;
  envKey: string;
  request: (key: string) => { url: string; headers: Record<string, string> };
  ids: (json: any) => string[];
  /** URL of the next page given the current page's JSON, or null when done */
  nextUrl: (json: any, key: string) => string | null;
}

const CHECKS: Check[] = [
  {
    provider: "openai",
    envKey: "OPENAI_API_KEY",
    request: (key) => ({
      url: "https://api.openai.com/v1/models?limit=1000",
      headers: { Authorization: `Bearer ${key}` },
    }),
    ids: (json) => (json.data ?? []).map((m: any) => String(m.id)),
    nextUrl: (json) => {
      if (!json?.has_more || !Array.isArray(json.data) || json.data.length === 0) return null;
      const last = json.data[json.data.length - 1]?.id;
      return last
        ? `https://api.openai.com/v1/models?limit=1000&after=${encodeURIComponent(String(last))}`
        : null;
    },
  },
  {
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    request: (key) => ({
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }),
    ids: (json) => (json.data ?? []).map((m: any) => String(m.id)),
    nextUrl: (json) => {
      if (!json?.has_more) return null;
      const last =
        json.last_id ??
        (Array.isArray(json.data) && json.data.length ? json.data[json.data.length - 1]?.id : null);
      return last
        ? `https://api.anthropic.com/v1/models?limit=1000&after_id=${encodeURIComponent(String(last))}`
        : null;
    },
  },
  {
    provider: "google",
    envKey: "GEMINI_API_KEY",
    request: (key) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      headers: {},
    }),
    // names come back as "models/gemini-x"
    ids: (json) => (json.models ?? []).map((m: any) => String(m.name).replace(/^models\//, "")),
    nextUrl: (json, key) =>
      json?.nextPageToken
        ? `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageToken=${encodeURIComponent(String(json.nextPageToken))}`
        : null,
  },
];

/**
 * For each provider with a key: fetch the live models list; any registry row
 * (surface "model", status "deprecated") whose api_ids are ALL absent from the
 * live list is flipped to "retired" in the registry file. The poll.yml
 * git-diff/PR flow picks up the write.
 */
export async function runLiveness(opts: {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  registryDir?: string;
}): Promise<{ flipped: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const registryDir = opts.registryDir ?? "registry";
  const flipped: string[] = [];

  for (const check of CHECKS) {
    const key = env[check.envKey];
    if (!key) continue;
    try {
      // Accumulate ids across ALL pages before deciding: flipping off a partial
      // page would retire live models that only appear on a later page.
      const { url, headers } = check.request(key);
      const live = new Set<string>();
      let nextUrl: string | null = url;
      for (let page = 0; nextUrl && page < 50; page++) {
        const res = await fetchImpl(nextUrl, { headers });
        if (!res.ok) throw new Error(`${check.provider}: HTTP ${res.status} from models list`);
        const json = await res.json();
        for (const id of check.ids(json)) live.add(id);
        nextUrl = check.nextUrl(json, key);
      }
      if (live.size === 0) continue; // empty list = broken response, never flip on it

      const rows = readRegistry(registryDir, check.provider);
      let dirty = false;
      for (const row of rows) {
        if (row.surface !== "model" || row.status !== "deprecated") continue;
        // only retire when EVERY api_id is absent from the full accumulated list
        if (row.api_ids.every((id) => !live.has(id))) {
          row.status = "retired";
          flipped.push(row.id);
          dirty = true;
        }
      }
      if (dirty) writeRegistry(registryDir, check.provider, rows);
    } catch (e) {
      // one provider's HTTP/parse error must not abort the liveness check for the
      // others; log and move on, leaving that provider's rows untouched
      console.error(`${check.provider}: liveness skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { flipped };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runLiveness({})
    .then((r) => {
      console.log(r.flipped.length ? `flipped to retired: ${r.flipped.join(", ")}` : "no flips");
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
