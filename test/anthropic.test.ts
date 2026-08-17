import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnthropic } from "../src/parsers/anthropic.ts";
import type { RegistryRow } from "../src/schema.ts";

const raw = readFileSync(new URL("./fixtures/anthropic-deprecations.md", import.meta.url), "utf8");
const rows = parseAnthropic(raw, { verifiedAt: "2026-08-16" });

const byId = (id: string): RegistryRow | undefined => rows.find((r) => r.id === id);

describe("parseAnthropic", () => {
  it("merges history-only models: claude-3-5-sonnet-20241022", () => {
    const r = byId("anthropic:model:claude-3-5-sonnet-20241022");
    expect(r).toBeDefined();
    expect(r!.status).toBe("retired");
    expect(r!.dies).toBe("2025-10-28");
    expect(r!.announced).toBe("2025-08-13");
    expect(r!.replacement_id).toBe("claude-sonnet-4-6");
  });

  it("merges status + history: claude-opus-4-1-20250805", () => {
    const r = byId("anthropic:model:claude-opus-4-1-20250805");
    expect(r).toBeDefined();
    expect(r!.status).toBe("retired");
    expect(r!.dies).toBe("2026-08-05");
    expect(r!.announced).toBe("2026-06-05");
    expect(r!.replacement_id).toBe("claude-opus-4-8");
  });

  it("emits no rows for Active models", () => {
    for (const active of [
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ]) {
      expect(byId(`anthropic:model:${active}`)).toBeUndefined();
    }
    // every model row except mythos-preview has a concrete death date
    const noDies = rows.filter((r) => r.surface === "model" && r.dies === null);
    expect(noDies.map((r) => r.id)).toEqual(["anthropic:model:claude-mythos-preview"]);
  });

  it("emits the param deprecation row with the exact shape", () => {
    const r = byId("anthropic:param:temperature-top-p-top-k");
    expect(r).toEqual({
      id: "anthropic:param:temperature-top-p-top-k",
      provider: "anthropic",
      surface: "param",
      api_ids: ["temperature", "top_p", "top_k"],
      status: "deprecated",
      announced: null,
      dies: null,
      dies_is_earliest_possible: false,
      replacement_id: null,
      replacement_notes:
        "omit temperature/top_p/top_k on Claude Opus 4.7+ and newer; non-default values return 400. Use prompting instead.",
      migration_url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
      source_url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
      verified_at: "2026-08-16",
      platform: "first-party",
    });
  });

  it("parses the mythos-preview note as a deprecated model row", () => {
    const r = byId("anthropic:model:claude-mythos-preview");
    expect(r).toBeDefined();
    expect(r!.status).toBe("deprecated");
    expect(r!.dies).toBe(null);
    expect(r!.replacement_id).toBe("claude-mythos-5");
    expect(r!.api_ids).toEqual(["claude-mythos-preview"]);
  });

  it("retires both Sonnet 4 and Opus 4 on 2026-06-15", () => {
    for (const id of ["claude-sonnet-4-20250514", "claude-opus-4-20250514"]) {
      const r = byId(`anthropic:model:${id}`);
      expect(r).toBeDefined();
      expect(r!.status).toBe("retired");
      expect(r!.dies).toBe("2026-06-15");
      expect(r!.announced).toBe("2026-04-14");
    }
  });

  it("matches the full-output snapshot", () => {
    expect(rows).toMatchSnapshot();
  });

  // Finding 2: a history/status row with fewer cells than the destructure
  // expects must not throw (undefined.replace / undefined.toLowerCase).
  it("parses table rows with fewer cells without throwing", () => {
    const mutant = [
      "## Deprecation history",
      "",
      "### 2025-01-01: Short history row",
      "",
      "| Retirement date | Deprecated model | Recommended replacement |",
      "| --- | --- | --- |",
      "| June 1, 2025 | `claude-short` |",
      "",
      "## Model status",
      "",
      "| API model name | Current state | Deprecated | Tentative retirement date |",
      "| --- | --- | --- | --- |",
      "| claude-truncated | Retired |",
      "",
    ].join("\n");
    expect(() => parseAnthropic(mutant, { verifiedAt: "2026-08-16" })).not.toThrow();
  });

  // Finding anthropic(i): only Deprecated/Retired states are deprecation events;
  // a Legacy row is not deprecated and must not become a row.
  it("skips Legacy status rows, not just Active ones", () => {
    const mutant = [
      "## Model status",
      "",
      "| API model name | Current state | Deprecated | Tentative retirement date |",
      "| --- | --- | --- | --- |",
      "| claude-legacy-x | Legacy | N/A | Not sooner than June 9, 2027 |",
      "| claude-retired-x | Retired | April 14, 2026 | June 15, 2026 |",
      "",
    ].join("\n");
    const out = parseAnthropic(mutant, { verifiedAt: "2026-08-16" });
    expect(out.find((r) => r.id === "anthropic:model:claude-legacy-x")).toBeUndefined();
    expect(out.find((r) => r.id === "anthropic:model:claude-retired-x")).toBeDefined();
  });

  // Finding anthropic(ii): history sections run newest-first; a re-deprecated
  // model must keep its newest date/replacement, not the oldest table's.
  it("keeps the newest history row for a re-deprecated model", () => {
    const mutant = [
      "## Deprecation history",
      "",
      "### 2026-02-01: Re-deprecation (newest)",
      "",
      "| Retirement date | Deprecated model | Recommended replacement |",
      "| --- | --- | --- |",
      "| August 1, 2026 | `claude-repeat` | `claude-new` |",
      "",
      "### 2025-01-01: Original deprecation (oldest)",
      "",
      "| Retirement date | Deprecated model | Recommended replacement |",
      "| --- | --- | --- |",
      "| March 1, 2025 | `claude-repeat` | `claude-old` |",
      "",
    ].join("\n");
    const out = parseAnthropic(mutant, { verifiedAt: "2026-08-16" });
    const r = out.find((x) => x.id === "anthropic:model:claude-repeat");
    expect(r).toBeDefined();
    expect(r!.dies).toBe("2026-08-01");
    expect(r!.announced).toBe("2026-02-01");
    expect(r!.replacement_id).toBe("claude-new");
  });
});
