import { describe, expect, it } from "vitest";
import { extractTables } from "../src/tables.ts";

describe("extractTables", () => {
  // A hard-wrapped row used to end the table early, dropping every row after it.
  it("keeps rows after a hard-wrapped row instead of dropping them", () => {
    const md = [
      "| a | b | c |",
      "| --- | --- | --- |",
      "| one | two | three |",
      "| a long first cell that", // wrapped row: starts with | but no closing |
      "wrapped | y | z |", // continuation supplies the closing |
      "| four | five | six |",
      "",
    ].join("\n");
    const tables = extractTables(md);
    expect(tables.length).toBe(1);
    const t = tables[0];
    expect(t.rows.length).toBe(3);
    expect(t.rows[0]).toEqual(["one", "two", "three"]);
    expect(t.rows[1]).toEqual(["a long first cell that wrapped", "y", "z"]);
    expect(t.rows[2]).toEqual(["four", "five", "six"]);
  });

  it("still parses ordinary single-line tables unchanged", () => {
    const md = ["| h1 | h2 |", "| --- | --- |", "| x | y |", ""].join("\n");
    const [t] = extractTables(md);
    expect(t.headers).toEqual(["h1", "h2"]);
    expect(t.rows).toEqual([["x", "y"]]);
  });
});
