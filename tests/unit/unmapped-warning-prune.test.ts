import { afterEach, beforeEach, expect, test } from "bun:test";
import { UsageService, unmappedSubscriptionWarnings } from "../../src/storage/service";
import type { Logger } from "../../src/util/logger";

function mockLogger(): { logger: Logger.Logger; warns: Array<{ msg: string; fields?: Record<string, unknown> }> } {
  const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger.Logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => warns.push({ msg, fields }),
    error: () => {},
  };
  return { logger, warns };
}

beforeEach(() => {
  unmappedSubscriptionWarnings.clear();
});

afterEach(() => {
  unmappedSubscriptionWarnings.clear();
});

test("prunes stale entries older than today", () => {
  const { logger, warns } = mockLogger();

  unmappedSubscriptionWarnings.set("alice:2026-05-06", true);
  unmappedSubscriptionWarnings.set("bob:2026-05-07", true);
  unmappedSubscriptionWarnings.set("charlie:2026-05-08", true);

  UsageService.warnUnmappedSubscription(logger, "dave", new Date("2026-05-08T10:00:00Z"));

  expect(unmappedSubscriptionWarnings.has("alice:2026-05-06")).toBe(false);
  expect(unmappedSubscriptionWarnings.has("bob:2026-05-07")).toBe(false);
  expect(unmappedSubscriptionWarnings.has("charlie:2026-05-08")).toBe(true);
  expect(unmappedSubscriptionWarnings.has("dave:2026-05-08")).toBe(true);
  expect(warns).toHaveLength(1);
  expect(warns[0].msg).toBe("plans unmapped");
  expect(warns[0].fields?.cliproxy_account).toBe("dave");
});

test("preserves dedup for current day after pruning", () => {
  const { logger, warns } = mockLogger();

  unmappedSubscriptionWarnings.set("alice:2026-05-06", true);
  unmappedSubscriptionWarnings.set("bob:2026-05-08", true);

  UsageService.warnUnmappedSubscription(logger, "bob", new Date("2026-05-08T10:00:00Z"));

  expect(unmappedSubscriptionWarnings.has("alice:2026-05-06")).toBe(false);
  expect(unmappedSubscriptionWarnings.has("bob:2026-05-08")).toBe(true);
  expect(warns).toHaveLength(0);
});

test("warns again for same account on a new day", () => {
  const { logger, warns } = mockLogger();

  UsageService.warnUnmappedSubscription(logger, "alice", new Date("2026-05-07T10:00:00Z"));
  expect(warns).toHaveLength(1);

  UsageService.warnUnmappedSubscription(logger, "alice", new Date("2026-05-08T10:00:00Z"));

  expect(unmappedSubscriptionWarnings.has("alice:2026-05-07")).toBe(false);
  expect(unmappedSubscriptionWarnings.has("alice:2026-05-08")).toBe(true);
  expect(warns).toHaveLength(2);
});
