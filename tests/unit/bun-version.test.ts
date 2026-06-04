import { expect, test } from "bun:test";
import {
  MIN_BUN_VERSION,
  UnsupportedBunVersionError,
  assertSupportedBunVersion,
  isSupportedBunVersion,
} from "../../src/runtime/bun-version";

test("Bun runtime version guard accepts the pinned minimum and newer versions", () => {
  expect(MIN_BUN_VERSION).toBe("1.3.0");
  expect(isSupportedBunVersion("1.3.0")).toBe(true);
  expect(isSupportedBunVersion("1.3.14")).toBe(true);
  expect(isSupportedBunVersion("2.0.0")).toBe(true);
});

test("Bun runtime version guard rejects older and malformed versions", () => {
  expect(isSupportedBunVersion("1.2.99")).toBe(false);
  expect(isSupportedBunVersion("not-a-version")).toBe(false);

  expect(() => assertSupportedBunVersion("1.2.99")).toThrow(UnsupportedBunVersionError);
  expect(() => assertSupportedBunVersion("not-a-version")).toThrow(UnsupportedBunVersionError);
});
