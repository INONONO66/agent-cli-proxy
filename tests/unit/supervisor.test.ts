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
