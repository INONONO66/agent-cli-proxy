import { afterEach, expect, test } from "bun:test";
import { Supervisor } from "../../src/runtime/supervisor";
import { Logger } from "../../src/util/logger";

type LogRecord = Record<string, unknown>;

function captureSink() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    logger: Logger.create({
      level: "debug",
      sink: {
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
      },
    }).child({ component: "supervisor-test" }),
  };
}

function parseLogs(lines: string[]): LogRecord[] {
  return lines.map((line) => JSON.parse(line) as LogRecord);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 600): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("timed out waiting for supervisor condition");
}

afterEach(async () => {
  await Supervisor.stopAll();
  Supervisor.__setLoggerForTests(null);
});

test("a loop that throws on the first tick is retried with backoff", async () => {
  const capture = captureSink();
  Supervisor.__setLoggerForTests(capture.logger);
  let ticks = 0;

  const handle = Supervisor.run("retry-once", () => {
    ticks += 1;
    if (ticks === 1) throw new Error("first tick failed");
  }, { intervalMs: 10, jitterRatio: 0 });

  await waitUntil(() => ticks >= 2);
  await handle.stop();

  const errors = parseLogs(capture.stderr).filter((log) => log.event === "loop.error");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ name: "retry-once", attempt: 1, next_delay_ms: 20 });
});

test("healthSnapshot reports warn after one failure and pass after recovery", async () => {
  let attempts = 0;

  const handle = Supervisor.run("snapshot-recovery", () => {
    attempts += 1;
    if (attempts === 1) throw new Error("first attempt failed");
  }, {
    intervalMs: 10,
    jitterRatio: 0,
  });

  await waitUntil(() => {
    const snapshot = Supervisor.healthSnapshot().find((entry) => entry.name === "snapshot-recovery");
    return snapshot?.status === "warn" && snapshot.consecutiveFailures > 0 && typeof snapshot.lastErrorAgeMs === "number";
  });

  await waitUntil(() => {
    const snapshot = Supervisor.healthSnapshot().find((entry) => entry.name === "snapshot-recovery");
    return snapshot?.status === "pass" && snapshot.consecutiveFailures === 0 && typeof snapshot.lastSuccessAgeMs === "number";
  });

  const finalSnapshot = Supervisor.healthSnapshot().find((entry) => entry.name === "snapshot-recovery");
  expect(finalSnapshot).toBeDefined();
  expect(finalSnapshot).toMatchObject({
    name: "snapshot-recovery",
    consecutiveFailures: 0,
    status: "pass",
  });
  expect(typeof finalSnapshot?.lastSuccessAgeMs).toBe("number");

  await handle.stop();
});

test("after 3 consecutive failures delay reaches base interval times 2^3", async () => {
  const capture = captureSink();
  Supervisor.__setLoggerForTests(capture.logger);

  const handle = Supervisor.run("triple-failure", () => {
    throw new Error("still failing");
  }, { intervalMs: 10, jitterRatio: 0 });

  await waitUntil(() => parseLogs(capture.stderr).filter((log) => log.event === "loop.error").length >= 3);
  await handle.stop();

  const delays = parseLogs(capture.stderr)
    .filter((log) => log.event === "loop.error")
    .slice(0, 3)
    .map((log) => log.next_delay_ms);
  expect(delays).toEqual([20, 40, 80]);
});

test("successful tick resets consecutive failure backoff", async () => {
  const capture = captureSink();
  Supervisor.__setLoggerForTests(capture.logger);
  let ticks = 0;

  const handle = Supervisor.run("reset-backoff", () => {
    ticks += 1;
    if (ticks === 1 || ticks === 3) throw new Error(`failure ${ticks}`);
  }, { intervalMs: 10, jitterRatio: 0 });

  await waitUntil(() => parseLogs(capture.stderr).filter((log) => log.event === "loop.error").length >= 2);
  await handle.stop();

  const errors = parseLogs(capture.stderr).filter((log) => log.event === "loop.error");
  expect(errors.map((log) => log.attempt)).toEqual([1, 1]);
  expect(errors.map((log) => log.next_delay_ms)).toEqual([20, 20]);
  expect(parseLogs(capture.stdout).some((log) => log.event === "loop.tick")).toBe(true);
});

test("stop cancels future ticks and resolves promptly", async () => {
  const capture = captureSink();
  Supervisor.__setLoggerForTests(capture.logger);
  let ticks = 0;

  const handle = Supervisor.run("stop-one", () => {
    ticks += 1;
  }, { intervalMs: 10, jitterRatio: 0 });

  await waitUntil(() => ticks >= 1);
  const stoppedAt = Date.now();
  await handle.stop();
  const elapsedMs = Date.now() - stoppedAt;
  const finalTicks = ticks;

  await sleep(40);
  expect(elapsedMs).toBeLessThan(500);
  expect(ticks).toBe(finalTicks);
  expect(parseLogs(capture.stdout).some((log) => log.event === "loop.stopped" && log.name === "stop-one")).toBe(true);
});

test("stopAll resolves all registered loops", async () => {
  const capture = captureSink();
  Supervisor.__setLoggerForTests(capture.logger);
  let firstTicks = 0;
  let secondTicks = 0;

  Supervisor.run("stop-all-a", () => {
    firstTicks += 1;
  }, { intervalMs: 10, jitterRatio: 0 });
  Supervisor.run("stop-all-b", () => {
    secondTicks += 1;
  }, { intervalMs: 10, jitterRatio: 0 });

  await waitUntil(() => firstTicks >= 1 && secondTicks >= 1);
  await Supervisor.stopAll();
  const stoppedFirst = firstTicks;
  const stoppedSecond = secondTicks;

  await sleep(40);
  expect(firstTicks).toBe(stoppedFirst);
  expect(secondTicks).toBe(stoppedSecond);

  const stopped = parseLogs(capture.stdout).filter((log) => log.event === "loop.stopped");
  expect(stopped.map((log) => log.name)).toEqual(expect.arrayContaining(["stop-all-a", "stop-all-b"]));
});

test("a throwing loop never crashes the test process", async () => {
  const capture = captureSink();
  Supervisor.__setLoggerForTests(capture.logger);
  let attempts = 0;

  const handle = Supervisor.run("isolated-thrower", () => {
    attempts += 1;
    throw new Error("isolated crash");
  }, { intervalMs: 10, jitterRatio: 0 });

  await waitUntil(() => attempts >= 2);
  await handle.stop();

  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(parseLogs(capture.stderr).filter((log) => log.event === "loop.error").length).toBeGreaterThanOrEqual(1);
});

test("structured logger emits loop.error and loop.tick events", async () => {
  const capture = captureSink();
  Supervisor.__setLoggerForTests(capture.logger);
  let ticks = 0;

  const handle = Supervisor.run("structured-events", () => {
    ticks += 1;
    if (ticks === 1) throw new Error("structured failure");
  }, { intervalMs: 10, jitterRatio: 0 });

  await waitUntil(() => parseLogs(capture.stdout).some((log) => log.event === "loop.tick"));
  await handle.stop();

  expect(parseLogs(capture.stderr)).toContainEqual(expect.objectContaining({
    event: "loop.error",
    name: "structured-events",
    attempt: 1,
    next_delay_ms: 20,
  }));
  expect(parseLogs(capture.stdout)).toContainEqual(expect.objectContaining({
    event: "loop.tick",
    name: "structured-events",
  }));
});

test("loop disables after reaching maxConsecutiveFailures and reports failed state", async () => {
  const capture = captureSink();
  Supervisor.__setLoggerForTests(capture.logger);
  let attempts = 0;

  const handle = Supervisor.run("max-failure-cap", () => {
    attempts += 1;
    throw new Error(`failure #${attempts}`);
  }, {
    intervalMs: 10,
    jitterRatio: 0,
    maxConsecutiveFailures: 2,
  });

  await waitUntil(() => {
    return Supervisor.statuses().some((entry) => entry.name === "max-failure-cap" && entry.failed);
  });
  expect(Supervisor.list()).toContain("max-failure-cap");
  const afterDisable = Supervisor.statuses().find((entry) => entry.name === "max-failure-cap");
  expect(afterDisable).toMatchObject({ name: "max-failure-cap", failed: true, consecutiveFailures: 2 });

  const loopErrors = parseLogs(capture.stderr).filter((entry) => entry.event === "loop.error");
  expect(loopErrors).toHaveLength(1);
  expect(loopErrors.map((entry) => entry.attempt)).toEqual([1]);

  const disabled = parseLogs(capture.stderr).filter((entry) => entry.event === "loop.disabled");
  expect(disabled).toHaveLength(1);
  expect(disabled[0]).toMatchObject({
    name: "max-failure-cap",
    total_failures: 2,
  });

  await sleep(40);
  expect(attempts).toBe(2);
  await handle.stop();
});

test("a successful tick resets the consecutive failure counter", async () => {
  const capture = captureSink();
  Supervisor.__setLoggerForTests(capture.logger);
  let attempts = 0;

  const handle = Supervisor.run("failure-reset", () => {
    attempts += 1;
    if (attempts === 1) throw new Error("initial failure");
  }, {
    intervalMs: 10,
    jitterRatio: 0,
    maxConsecutiveFailures: 2,
  });

  await waitUntil(() => parseLogs(capture.stderr).some((entry) => entry.event === "loop.error"));
  await waitUntil(() => parseLogs(capture.stdout).some((entry) => entry.event === "loop.tick"));
  await sleep(30);

  const loop = Supervisor.statuses().find((entry) => entry.name === "failure-reset");
  expect(loop).toMatchObject({ name: "failure-reset", failed: false, consecutiveFailures: 0 });
  expect(parseLogs(capture.stderr).filter((entry) => entry.event === "loop.disabled")).toHaveLength(0);

  await handle.stop();
});

test("invalid maxConsecutiveFailures is rejected", () => {
  expect(() =>
    Supervisor.run("invalid-max-failures", () => {}, { intervalMs: 10, maxConsecutiveFailures: 0 }),
  ).toThrow("Supervisor maxConsecutiveFailures must be a positive finite integer");
  expect(() =>
    Supervisor.run("invalid-max-failures", () => {}, { intervalMs: 10, maxConsecutiveFailures: 2.2 }),
  ).toThrow("Supervisor maxConsecutiveFailures must be a positive finite integer");
  expect(() =>
    Supervisor.run("invalid-max-failures", () => {}, { intervalMs: 10, maxConsecutiveFailures: Number.POSITIVE_INFINITY }),
  ).toThrow("Supervisor maxConsecutiveFailures must be a positive finite integer");
});
