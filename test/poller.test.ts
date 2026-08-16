import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Provider, RegistryRow } from "../src/schema.ts";
import { runPoller, SOURCES } from "../src/poller.ts";
import { runLiveness } from "../src/liveness.ts";
import { runTripwire } from "../src/tripwire.ts";

const V = "2026-08-16";
const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FIXTURE: Record<Provider, string> = {
  openai: readFileSync(join(FIX, "openai-deprecations.md"), "utf8"),
  anthropic: readFileSync(join(FIX, "anthropic-deprecations.md"), "utf8"),
  google: readFileSync(join(FIX, "google-deprecations.html"), "utf8"),
};

function bodies(overrides: Partial<Record<Provider, string>> = {}): Record<string, string> {
  return Object.fromEntries(
    SOURCES.map((s) => [s.url, overrides[s.provider] ?? FIXTURE[s.provider]]),
  );
}

function fakeFetch(byUrl: Record<string, string>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const body = byUrl[url];
    if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(body);
  }) as typeof fetch;
}

function tmp() {
  const root = mkdtempSync(join(tmpdir(), "aidep-"));
  return { root, registryDir: join(root, "registry"), stateDir: join(root, "state") };
}

function readRows(dir: string, provider: Provider): RegistryRow[] {
  return JSON.parse(readFileSync(join(dir, `${provider}.json`), "utf8"));
}

async function seedRun(t: ReturnType<typeof tmp>) {
  return runPoller({
    fetchImpl: fakeFetch(bodies()),
    registryDir: t.registryDir,
    stateDir: t.stateDir,
    verifiedAt: V,
  });
}

describe("runPoller", () => {
  it("first run seeds all three registry files, every row Added", async () => {
    const t = tmp();
    const r = await seedRun(t);
    expect(r.changed).toBe(true);
    expect(r.diff.changed).toEqual([]);
    expect(r.diff.gone).toEqual([]);

    let total = 0;
    for (const p of ["openai", "anthropic", "google"] as const) {
      expect(existsSync(join(t.registryDir, `${p}.json`))).toBe(true);
      total += readRows(t.registryDir, p).length;
    }
    expect(total).toBeGreaterThan(0);
    expect(r.diff.added.length).toBe(total);

    expect(existsSync(join(t.stateDir, "hashes.json"))).toBe(true);
    expect(existsSync(join(t.root, ".poller-pr-body.md"))).toBe(true);
    expect(r.prBody).toContain("## Added");
    expect(r.prBody).toContain("Merging this PR is the approval step.");
  });

  it("second identical run short-circuits on hashes: changed false", async () => {
    const t = tmp();
    await seedRun(t);
    const before = readFileSync(join(t.registryDir, "openai.json"), "utf8");
    const r2 = await seedRun(t);
    expect(r2.changed).toBe(false);
    expect(r2.diff).toEqual({ added: [], changed: [], gone: [] });
    expect(readFileSync(join(t.registryDir, "openai.json"), "utf8")).toBe(before);
  });

  it("merges page changes while preserving hand-owned fields", async () => {
    const t = tmp();
    await seedRun(t);

    // hand-edit the stored assistants row
    const file = join(t.registryDir, "openai.json");
    const stored: RegistryRow[] = JSON.parse(readFileSync(file, "utf8"));
    const assistants = stored.find((r) => r.id === "openai:endpoint:assistants-api")!;
    assistants.api_ids = ["my-custom-grep"];
    assistants.migration_url = "https://example.com/assistants-migration";
    writeFileSync(file, JSON.stringify(stored, null, 2) + "\n");

    // mutate the page: U+2011 Assistants date cell moves, one new model row appears
    const oldDate = "2026‑08‑26";
    const newDate = "2026‑09‑30";
    expect(FIXTURE.openai).toContain(oldDate);
    const anchor =
      "| Jan 20, 2027  | `gpt-4o-mini-transcribe-2025-03-20` | `gpt-4o-mini-transcribe-2025-12-15` |";
    expect(FIXTURE.openai).toContain(anchor);
    const mutated = FIXTURE.openai.replace(oldDate, newDate).replace(
      anchor,
      anchor + "\n| Jan 20, 2027  | `gpt-new-audio` | `gpt-audio-1.5` |",
    );

    const r2 = await runPoller({
      fetchImpl: fakeFetch(bodies({ openai: mutated })),
      registryDir: t.registryDir,
      stateDir: t.stateDir,
      verifiedAt: V,
    });

    expect(r2.changed).toBe(true);
    expect(r2.diff.added.map((r) => r.id)).toEqual(["openai:model:gpt-new-audio"]);
    expect(r2.diff.changed).toEqual([
      {
        id: "openai:endpoint:assistants-api",
        field: "dies",
        old: "2026-08-26",
        new: "2026-09-30",
      },
    ]);
    expect(r2.diff.gone).toEqual([]);

    expect(r2.prBody).toContain("## Added");
    expect(r2.prBody).toContain("| openai:model:gpt-new-audio | 2027-01-20 | gpt-audio-1.5 |");
    expect(r2.prBody).toContain("## Changed");
    expect(r2.prBody).toContain(
      "| openai:endpoint:assistants-api | dies | 2026-08-26 → 2026-09-30 |",
    );

    // hand-owned fields survived the merge; parser-owned dies updated
    const after: RegistryRow[] = JSON.parse(readFileSync(file, "utf8"));
    const merged = after.find((r) => r.id === "openai:endpoint:assistants-api")!;
    expect(merged.api_ids).toEqual(["my-custom-grep"]);
    expect(merged.migration_url).toBe("https://example.com/assistants-migration");
    expect(merged.dies).toBe("2026-09-30");
    expect(merged.status).toBe("deprecated");
    const added = after.find((r) => r.id === "openai:model:gpt-new-audio")!;
    expect(added.replacement_id).toBe("gpt-audio-1.5");
  });

  it("dryRun writes nothing", async () => {
    const t = tmp();
    const r = await runPoller({
      fetchImpl: fakeFetch(bodies()),
      registryDir: t.registryDir,
      stateDir: t.stateDir,
      dryRun: true,
      verifiedAt: V,
    });
    expect(r.changed).toBe(true);
    expect(existsSync(t.registryDir)).toBe(false);
    expect(existsSync(t.stateDir)).toBe(false);
    expect(existsSync(join(t.root, ".poller-pr-body.md"))).toBe(false);
  });

  it("treats a zero-row parse as an anomaly, never as mass removal", async () => {
    const t = tmp();
    await seedRun(t);
    const before = readRows(t.registryDir, "google");
    expect(before.length).toBeGreaterThan(0);

    // real localized variant captured live 2026-08-16: same 11 tables, but
    // Japanese headers, so the parser finds nothing
    const ja = readFileSync(join(FIX, "google-deprecations-ja.html"), "utf8");
    const r = await runPoller({
      fetchImpl: fakeFetch(bodies({ google: ja })),
      registryDir: t.registryDir,
      stateDir: t.stateDir,
      verifiedAt: V,
    });
    expect(r.anomalies).toEqual([
      `google: parsed 0 rows but registry has ${before.length}; skipping source`,
    ]);
    expect(r.changed).toBe(false);
    expect(r.diff.gone).toEqual([]);
    expect(readRows(t.registryDir, "google")).toEqual(before);

    // the anomalous page's hash was not persisted, so a good page next run parses again
    const r2 = await seedRun(t);
    expect(r2.changed).toBe(false);
    expect(r2.anomalies).toEqual([]);
  });
});

function modelRow(provider: Provider, apiId: string): RegistryRow {
  return {
    id: `${provider}:model:${apiId}`,
    provider,
    surface: "model",
    api_ids: [apiId],
    status: "deprecated",
    announced: null,
    dies: "2026-12-31",
    dies_is_earliest_possible: false,
    replacement_id: null,
    replacement_notes: null,
    migration_url: null,
    source_url: "https://example.com/deprecations",
    verified_at: V,
    platform: "first-party",
  };
}

describe("runLiveness", () => {
  it("flips deprecated models absent from the live list, leaves present ones", async () => {
    const t = tmp();
    mkdirSync(t.registryDir, { recursive: true });
    writeFileSync(
      join(t.registryDir, "google.json"),
      JSON.stringify([modelRow("google", "gemini-old"), modelRow("google", "gemini-live")], null, 2) +
        "\n",
    );

    const urls: string[] = [];
    const liveFetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({ models: [{ name: "models/gemini-live" }, { name: "models/gemini-3" }] }),
      );
    }) as typeof fetch;

    const r = await runLiveness({
      fetchImpl: liveFetch,
      env: { GEMINI_API_KEY: "test-key" },
      registryDir: t.registryDir,
    });

    expect(urls).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models?key=test-key",
    ]);
    expect(r.flipped).toEqual(["google:model:gemini-old"]);
    const after = readRows(t.registryDir, "google");
    expect(after.find((x) => x.id === "google:model:gemini-old")!.status).toBe("retired");
    expect(after.find((x) => x.id === "google:model:gemini-live")!.status).toBe("deprecated");
  });
});

describe("runTripwire", () => {
  it("alerts only on model deprecations missing from the registry", async () => {
    const t = tmp();
    mkdirSync(t.registryDir, { recursive: true });
    writeFileSync(
      join(t.registryDir, "openai.json"),
      JSON.stringify([modelRow("openai", "gpt-4-0613")], null, 2) + "\n",
    );

    const payload = {
      records: [
        { kind: "model", api_ids: ["gpt-4-0613"] },
        { kind: "model", api_ids: ["mystery-9000"] },
        { kind: "endpoint", api_ids: ["/v1/mystery"] },
      ],
    };
    const r = await runTripwire({
      fetchImpl: (async () => new Response(JSON.stringify(payload))) as typeof fetch,
      registryDir: t.registryDir,
    });
    expect(r.alerts.length).toBe(1);
    expect(r.alerts[0]).toContain("mystery-9000");
  });
});
