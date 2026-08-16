import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "./schema.ts";
import { SOURCES, writeRegistry } from "./poller.ts";

/** Seed (or re-seed) registry/*.json from the checked-in fixtures. */
const FIXTURE_FILES: Record<Provider, string> = {
  openai: "openai-deprecations.md",
  anthropic: "anthropic-deprecations.md",
  google: "google-deprecations.html",
};

const verifiedAt = process.argv[2] ?? "2026-08-16";
const root = fileURLToPath(new URL("..", import.meta.url));
const registryDir = join(root, "registry");
mkdirSync(registryDir, { recursive: true });

for (const src of SOURCES) {
  const raw = readFileSync(join(root, "test", "fixtures", FIXTURE_FILES[src.provider]), "utf8");
  const rows = src.parse(raw, { verifiedAt });
  writeRegistry(registryDir, src.provider, rows);
  console.log(`${src.provider}: ${rows.length} rows`);
}
