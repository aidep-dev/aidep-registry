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

  // Finding 3: columns are mapped by header name, so an inserted column can't
  // shift model/date/replacement into the wrong fields (hardcoded 0/2/3 would).
  it("maps columns by header name even with an inserted column", () => {
    const html = `
      <table class="pricing-table">
        <thead><tr>
          <td><b>Model</b></td>
          <td><b>Release date</b></td>
          <td><b>Notes</b></td>
          <td><b>Shutdown date</b></td>
          <td><b>Recommended replacement</b></td>
        </tr></thead>
        <tbody>
          <tr class="row-gray">
            <td><code>gemini-x</code></td>
            <td>January 1, 2025</td>
            <td>some note</td>
            <td>June 1, 2026</td>
            <td><code>gemini-y</code></td>
          </tr>
        </tbody>
      </table>`;
    const out = parseGoogle(html, { verifiedAt: "2026-08-16" });
    const r = out.find((x) => x.id === "google:model:gemini-x");
    expect(r).toBeDefined();
    expect(r!.dies).toBe("2026-06-01");
    expect(r!.replacement_id).toBe("gemini-y");
    expect(r!.status).toBe("retired"); // row-gray
  });

  // Finding 5: shutdown dates are earliest-possible, not deaths. A non-gray row
  // whose earliest date has already passed stays deprecated, never retired.
  it("keeps a passed earliest-possible date deprecated, not retired", () => {
    // verifiedAt is one day past gemini-3.1-flash-image-preview's 2026-06-25
    // (a non-gray row); it must not flip to retired on that.
    const later = parseGoogle(raw, { verifiedAt: "2026-06-26" });
    const r = later.find((x) => x.id === "google:model:gemini-3.1-flash-image-preview");
    expect(r).toBeDefined();
    expect(r!.dies).toBe("2026-06-25");
    expect(r!.status).toBe("deprecated");
    expect(r!.dies_is_earliest_possible).toBe(true);
    // a genuinely retired (grayed) row with a past date still reads retired
    const gray = later.find((x) => x.id === "google:model:gemini-2.0-flash");
    expect(gray!.status).toBe("retired");
  });
});
