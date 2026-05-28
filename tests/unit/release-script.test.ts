import { describe, expect, test } from "bun:test";
import { parseReleaseArgs } from "../../scripts/release";

describe("release script args", () => {
  test("accepts dry-run with or without an explicit bump", () => {
    expect(parseReleaseArgs(["--dry-run"])).toEqual({ dryRun: true });
    expect(parseReleaseArgs(["patch", "--dry-run"])).toEqual({ explicitBump: "patch", dryRun: true });
    expect(parseReleaseArgs(["--dry-run", "minor"])).toEqual({ explicitBump: "minor", dryRun: true });
  });

  test("rejects unknown args and duplicate bump types", () => {
    expect(() => parseReleaseArgs(["--unknown"])).toThrow("Usage:");
    expect(() => parseReleaseArgs(["patch", "minor"])).toThrow("Only one bump type");
  });
});
