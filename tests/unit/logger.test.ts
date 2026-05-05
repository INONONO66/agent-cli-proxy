import { afterEach, expect, test } from "bun:test";
import { Logger } from "../../src/util/logger";

function captureSink() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    sink: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

const originalLogLevel = process.env.LOG_LEVEL;
const originalLogFormat = process.env.LOG_FORMAT;

afterEach(() => {
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
  if (originalLogFormat === undefined) delete process.env.LOG_FORMAT;
  else process.env.LOG_FORMAT = originalLogFormat;
});

test("emits JSON logs with base and call fields", () => {
  const capture = captureSink();
  const logger = Logger.create({
    level: "info",
    base: { service: "agent-cli-proxy" },
    sink: capture.sink,
  });

  logger.info("request complete", { request_id: "req-1", provider: "openai", event: "done" });

  expect(capture.stderr).toHaveLength(0);
  expect(capture.stdout).toHaveLength(1);
  const parsed = JSON.parse(capture.stdout[0]);
  expect(parsed).toMatchObject({
    level: "info",
    msg: "request complete",
    service: "agent-cli-proxy",
    request_id: "req-1",
    provider: "openai",
    event: "done",
  });
  expect(typeof parsed.ts).toBe("string");
});

test("child logger adds fields and preserves parent fields", () => {
  const capture = captureSink();
  const logger = Logger.create({ base: { provider: "anthropic" }, sink: capture.sink })
    .child({ request_id: "req-child" });

  logger.warn("upstream warning", { event: "rewrite_failed" });

  const parsed = JSON.parse(capture.stdout[0]);
  expect(parsed).toMatchObject({
    level: "warn",
    msg: "upstream warning",
    provider: "anthropic",
    request_id: "req-child",
    event: "rewrite_failed",
  });
});

test("filters messages below configured level", () => {
  const capture = captureSink();
  const logger = Logger.create({ level: "warn", sink: capture.sink });

  logger.debug("hidden debug");
  logger.info("hidden info");
  logger.warn("visible warn");

  expect(capture.stdout).toHaveLength(1);
  expect(JSON.parse(capture.stdout[0]).msg).toBe("visible warn");
});

test("routes error logs to stderr", () => {
  const capture = captureSink();
  const logger = Logger.create({ sink: capture.sink });

  logger.error("failed", { event: "failure" });

  expect(capture.stdout).toHaveLength(0);
  expect(capture.stderr).toHaveLength(1);
  expect(JSON.parse(capture.stderr[0])).toMatchObject({ level: "error", msg: "failed" });
});

test("redacts sensitive fields recursively", () => {
  const capture = captureSink();
  const logger = Logger.create({ sink: capture.sink });

  logger.info("redaction", {
    authorization: "Bearer abc",
    headers: {
      "X-Api-Key": "key",
      nested: { access_token: "token", password: "pw", clientSecret: "secret" },
    },
    safe: "visible",
  });

  const parsed = JSON.parse(capture.stdout[0]);
  expect(parsed.authorization).toBe("[REDACTED]");
  expect(parsed.headers["X-Api-Key"]).toBe("[REDACTED]");
  expect(parsed.headers.nested.access_token).toBe("[REDACTED]");
  expect(parsed.headers.nested.password).toBe("[REDACTED]");
  expect(parsed.headers.nested.clientSecret).toBe("[REDACTED]");
  expect(parsed.safe).toBe("visible");
});

test("fromConfig supports pretty mode", () => {
  const capture = captureSink();
  process.env.LOG_FORMAT = "pretty";
  process.env.LOG_LEVEL = "debug";

  const logger = Logger.fromConfig({ sink: capture.sink })
    .child({ event: "configured" });

  logger.debug("pretty hello", { request_id: "req-pretty" });
  expect(capture.stdout[0]).toContain("DEBUG pretty hello event=configured request_id=req-pretty");
});
