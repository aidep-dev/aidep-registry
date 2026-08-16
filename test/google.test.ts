import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGoogle } from "../src/parsers/google.ts";

const raw = readFileSync(new URL("./fixtures/google-deprecations.html", import.meta.url), "utf8");
const rows = parseGoogle(raw, { verifiedAt: "2026-08-16" });
const byId = (id: string) => rows.find((r) => r.id === id);

describe("parseGoogle", () => {
  it("marks gemini-2.0-flash and gemini-2.0-flash-001 retired with replacement", () => {
    for (const id of ["google:model:gemini-2.0-flash", "google:model:gemini-2.0-flash-001"]) {
      const row = byId(id);
      expect(row).toBeDefined();
      expect(row!.status).toBe("retired");
      expect(row!.dies).toBe("2026-06-01");
      expect(row!.replacement_id).toBe("gemini-3.6-flash");
      expect(row!.dies_is_earliest_possible).toBe(false);
    }
  });

  it("marks gemini-2.5-flash-image deprecated with an earliest-possible future date", () => {
    const row = byId("google:model:gemini-2.5-flash-image");
    expect(row).toBeDefined();
    expect(row!.status).toBe("deprecated");
    expect(row!.dies).toBe("2026-10-02");
    expect(row!.dies_is_earliest_possible).toBe(true);
    expect(row!.replacement_id).toBe("gemini-3.1-flash-image-preview");
  });

  it("turns Veo anchor replacement cells into notes, not an id", () => {
    const row = byId("google:model:veo-3.0-generate-001");
    expect(row).toBeDefined();
    expect(row!.replacement_id).toBeNull();
    expect(row!.replacement_notes).toContain("Gemini Enterprise Agent Platform");
    expect(row!.replacement_notes).toContain("veo-3.1-generate-preview");
  });

  it("never emits a row without a shutdown date", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.dies).not.toBeNull();
  });

  it("survives the Lyria table (no divider row, no shutdown dates)", () => {
    // every Lyria model says "No shutdown date announced", so none appear;
    // the point is the divider-less table parsed without throwing
    expect(() => parseGoogle(raw, { verifiedAt: "2026-08-16" })).not.toThrow();
    expect(rows.some((r) => r.id.startsWith("google:model:lyria"))).toBe(false);
  });

  it("matches the full-output snapshot", () => {
    expect(rows).toMatchSnapshot();
  });
});
