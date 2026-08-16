import { pathToFileURL } from "node:url";
import type { Provider } from "./schema.ts";
import { readRegistry, writeRegistry } from "./poller.ts";

interface Check {
  provider: Provider;
  envKey: string;
  request: (key: string) => { url: string; headers: Record<string, string> };
  ids: (json: any) => string[];
}

const CHECKS: Check[] = [
  {
    provider: "openai",
    envKey: "OPENAI_API_KEY",
    request: (key) => ({
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: `Bearer ${key}` },
    }),
    ids: (json) => (json.data ?? []).map((m: any) => String(m.id)),
  },
  {
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    request: (key) => ({
      url: "https://api.anthropic.com/v1/models",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }),
    ids: (json) => (json.data ?? []).map((m: any) => String(m.id)),
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
    const { url, headers } = check.request(key);
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`${check.provider}: HTTP ${res.status} from models list`);
    const live = new Set(check.ids(await res.json()));
    if (live.size === 0) continue; // empty list = broken response, never flip on it

    const rows = readRegistry(registryDir, check.provider);
    let dirty = false;
    for (const row of rows) {
      if (row.surface !== "model" || row.status !== "deprecated") continue;
      if (row.api_ids.every((id) => !live.has(id))) {
        row.status = "retired";
        flipped.push(row.id);
        dirty = true;
      }
    }
    if (dirty) writeRegistry(registryDir, check.provider, rows);
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
