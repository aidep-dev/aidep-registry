import { describe, expect, it } from "vitest";
import { validateRows } from "../src/schema.ts";
import type { RegistryRow } from "../src/schema.ts";

const base: RegistryRow = {
  id: "openai:model:x",
  provider: "openai",
  surface: "model",
  api_ids: ["x"],
  status: "deprecated",
  announced: null,
  dies: null,
  dies_is_earliest_possible: false,
  replacement_id: null,
  replacement_notes: null,
  migration_url: "https://example.com/guide",
  source_url: "https://example.com/deprecations",
  verified_at: "2026-08-16",
  platform: "first-party",
};

describe("RegistryRowSchema migration_url", () => {
  it("accepts an https migration_url (and null)", () => {
    expect(() => validateRows([base])).not.toThrow();
    expect(() => validateRows([{ ...base, migration_url: null }])).not.toThrow();
  });

  // defense in depth: a page could hand us an http/ftp/javascript link
  it("rejects a non-https migration_url", () => {
    expect(() => validateRows([{ ...base, migration_url: "http://insecure.example" }])).toThrow();
  });
});
