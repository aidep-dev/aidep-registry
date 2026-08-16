import { pathToFileURL } from "node:url";
import { readRegistry, SOURCES } from "./poller.ts";

const BENCHR_URL = "https://benchr.org/api/v1/deprecations";

/**
 * Cross-check our registry against benchr.org's deprecation feed (their terms
 * allow reuse with attribution). Any model deprecation they know about whose
 * api_ids we don't carry at all gets an ALERT line. Alert-only: always exit 0.
 */
export async function runTripwire(opts: {
  fetchImpl?: typeof fetch;
  registryDir?: string;
}): Promise<{ alerts: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const registryDir = opts.registryDir ?? "registry";

  console.log("cross-check data courtesy of benchr.org");

  const ours = new Set<string>();
  for (const src of SOURCES) {
    for (const row of readRegistry(registryDir, src.provider)) {
      for (const id of row.api_ids) ours.add(id);
    }
  }

  const res = await fetchImpl(BENCHR_URL);
  if (!res.ok) throw new Error(`benchr.org: HTTP ${res.status}`);
  const json: any = await res.json();
  const records: any[] = Array.isArray(json) ? json : json.records ?? [];

  const alerts: string[] = [];
  for (const rec of records) {
    if (rec.kind !== "model") continue;
    const ids: string[] = (rec.api_ids ?? []).map(String);
    if (ids.length === 0 || ids.some((id) => ours.has(id))) continue;
    const line = `ALERT: benchr.org lists a model deprecation missing from our registry: ${ids.join(", ")}`;
    console.log(line);
    alerts.push(line);
  }
  if (alerts.length === 0) console.log("no gaps: every benchr model deprecation is in the registry");
  return { alerts };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTripwire({}).catch((e) => {
    // alert-only: report and still exit 0
    console.error(String(e));
  });
}
