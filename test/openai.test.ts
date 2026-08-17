import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseOpenAI } from "../src/parsers/openai.ts";
import type { RegistryRow } from "../src/schema.ts";

const raw = readFileSync(new URL("./fixtures/openai-deprecations.md", import.meta.url), "utf8");
const rows = parseOpenAI(raw, { verifiedAt: "2026-08-16" });

function byId(id: string): RegistryRow {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`missing row ${id}`);
  return row;
}

describe("parseOpenAI", () => {
  it("parses the Assistants API row exactly (U+2011 date, future death)", () => {
    expect(byId("openai:endpoint:assistants-api")).toEqual({
      id: "openai:endpoint:assistants-api",
      provider: "openai",
      surface: "endpoint",
      api_ids: [
        "client.beta.assistants",
        "client.beta.threads",
        "openai.beta.assistants",
        "openai.beta.threads",
        "/v1/assistants",
        "/v1/threads",
        "OpenAI-Beta: assistants",
      ],
      status: "deprecated",
      announced: "2025-08-20",
      dies: "2026-08-26",
      dies_is_earliest_possible: false,
      replacement_id: null,
      replacement_notes: "Responses API + Conversations API",
      migration_url: "https://developers.openai.com/api/docs/assistants/migration",
      source_url: "https://developers.openai.com/api/docs/deprecations",
      verified_at: "2026-08-16",
      platform: "first-party",
    });
  });

  it("parses the reusable prompts shutdown from its timeline table", () => {
    const row = byId("openai:endpoint:v1-prompts");
    expect(row.dies).toBe("2026-11-30");
    expect(row.announced).toBe("2026-06-03");
    expect(row.status).toBe("deprecated");
    expect(row.api_ids).toEqual(["/v1/prompts"]);
  });

  it("parses gpt-5-2025-08-07 with a single replacement", () => {
    const row = byId("openai:model:gpt-5-2025-08-07");
    expect(row.dies).toBe("2026-12-11");
    expect(row.replacement_id).toBe("gpt-5.6-sol");
    expect(row.status).toBe("deprecated");
    expect(row.announced).toBe("2026-06-11");
  });

  it("splits replacement config into replacement_notes", () => {
    const row = byId("openai:model:o3-pro-2025-06-10");
    expect(row.replacement_id).toBe("gpt-5.6-sol");
    expect(row.replacement_notes).toContain("reasoning.mode: pro");
  });

  it("marks past deprecations as retired", () => {
    const dalle = byId("openai:model:dall-e-3");
    expect(dalle.status).toBe("retired");
    expect(dalle.dies).toBe("2026-05-12");
    // multiple replacement options -> no single id
    expect(dalle.replacement_id).toBeNull();

    const chatgpt4o = byId("openai:model:chatgpt-4o-latest");
    expect(chatgpt4o.status).toBe("retired");
    expect(chatgpt4o.dies).toBe("2026-02-17");
    expect(chatgpt4o.replacement_id).toBe("gpt-5.1-chat-latest");
  });

  it("handles all three date formats", () => {
    // ISO cell
    expect(byId("openai:model:sora-2").dies).toBe("2026-09-24");
    // "Dec 11, 2026" style
    expect(byId("openai:model:gpt-5-mini-2025-08-07").dies).toBe("2026-12-11");
    // "October 23, 2026" full-month style
    expect(byId("openai:model:gpt-4.1-nano").dies).toBe("2026-10-23");
  });

  it("collects aliases from escaped-pipe cells into api_ids", () => {
    expect(byId("openai:model:gpt-4-turbo").api_ids).toEqual([
      "gpt-4-turbo",
      "gpt-4-turbo-2024-04-09",
      "gpt-4-turbo-completions",
    ]);
    expect(byId("openai:model:gpt-4.1-nano").api_ids).toEqual([
      "gpt-4.1-nano",
      "gpt-4.1-nano-2025-04-14",
    ]);
  });

  it("emits header rows for OpenAI-Beta deprecations", () => {
    const realtime = byId("openai:header:openai-beta-realtime-v1");
    expect(realtime.surface).toBe("header");
    expect(realtime.api_ids).toEqual(["OpenAI-Beta: realtime=v1"]);
    expect(realtime.dies).toBe("2026-05-12"); // U+2011 hyphens in the cell
    expect(realtime.status).toBe("retired");
  });

  it("parses 2023-era endpoint history under h4 subsections", () => {
    const ft = byId("openai:endpoint:v1-fine-tunes");
    expect(ft.api_ids).toEqual(["/v1/fine-tunes"]);
    expect(ft.dies).toBe("2024-01-04");
    expect(ft.announced).toBe("2023-08-22");
    expect(ft.status).toBe("retired");
    expect(ft.replacement_id).toBe("/v1/fine_tuning/jobs");
  });

  it("keeps one row per id, preferring the definite/earlier death", () => {
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // listed both as retired 2026-03-26 (past) and scheduled 2026-10-23 (upcoming)
    expect(byId("openai:model:gpt-4-1106-preview").dies).toBe("2026-03-26");
    // legacy "at earliest" row loses to the definite 2026-03-26 retirement
    expect(byId("openai:model:gpt-4-0314").status).toBe("retired");
    expect(byId("openai:model:code-davinci-002").dies).toBe("2023-03-23");
  });

  it("matches the full-parse snapshot (page-shape drift tripwire)", () => {
    expect(rows.length).toMatchSnapshot("row count");
    expect(rows).toMatchSnapshot();
  });

  // Finding 1(a): one odd model-cell id must not crash the parser (which would
  // crash the whole poller). A weird id sanitizes to a valid slug; an id that
  // sanitizes to nothing is dropped, never fed to the schema regex.
  it("sanitizes a weird model-cell id instead of throwing", () => {
    const mutant = [
      "## Upcoming deprecations",
      "",
      "### 2026-01-01: Odd ids",
      "",
      "| Shutdown date | Model | Recommended replacement |",
      "| --- | --- | --- |",
      "| Dec 1, 2026 | `Weird ID!!!` | `gpt-x` |",
      "| Dec 1, 2026 | `!!!` | `gpt-y` |",
      "| Dec 1, 2026 | `gpt-4.5-preview` | `gpt-5` |",
      "",
    ].join("\n");
    let out: RegistryRow[] = [];
    expect(() => {
      out = parseOpenAI(mutant, { verifiedAt: "2026-08-16" });
    }).not.toThrow();
    const ids = out.map((r) => r.id);
    expect(ids).toContain("openai:model:weird-id");
    // dots survive (not kebab'd away) so a dotted id keeps its shape
    expect(ids).toContain("openai:model:gpt-4.5-preview");
    // an all-symbol id sanitizes to "" and is dropped, not emitted invalid
    expect(out.every((r) => r.id !== "openai:model:")).toBe(true);
  });

  // Finding openai(A): dropped product shutdowns / prose model cells are logged,
  // never silent, so a human can add the missing SPECIAL/PRODUCTS entry.
  it("logs what it drops instead of silently swallowing it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mutant = [
      "## Upcoming deprecations",
      "",
      "### 2026-01-01: Mystery product",
      "",
      "| Date | Update |",
      "| --- | --- |",
      "| Jan 1, 2026 | Deprecation announced. |",
      "| Feb 1, 2026 | Scheduled to shut down. |",
      "",
      "### 2026-01-02: Prose cell",
      "",
      "| Shutdown date | Model | Recommended replacement |",
      "| --- | --- | --- |",
      "| Dec 1, 2026 | see the note below | `gpt-z` |",
      "",
    ].join("\n");
    parseOpenAI(mutant, { verifiedAt: "2026-08-16" });
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(msgs.some((m) => m.includes("Mystery product"))).toBe(true);
    expect(msgs.some((m) => m.includes("see the note below"))).toBe(true);
  });
});
