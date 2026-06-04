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

  expect(capture.stdout).toHaveLength(0);
  const parsed = JSON.parse(capture.stderr[0]);
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

  expect(capture.stdout).toHaveLength(0);
  expect(capture.stderr).toHaveLength(1);
  expect(JSON.parse(capture.stderr[0]).msg).toBe("visible warn");
});

test("scoped level filters logs only inside the async context", async () => {
  const capture = captureSink();
  const logger = Logger.create({ level: "info", sink: capture.sink });

  await Logger.withLevel("error", async () => {
    logger.info("hidden scoped info");
    await Promise.resolve();
    logger.warn("hidden scoped warn");
    logger.error("visible scoped error");
  });
  logger.info("visible outer info");

  expect(capture.stdout.map((line) => JSON.parse(line).msg)).toEqual(["visible outer info"]);
  expect(capture.stderr.map((line) => JSON.parse(line).msg)).toEqual(["visible scoped error"]);
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

test("redacts sensitive substrings inside error objects", () => {
  const capture = captureSink();
  const logger = Logger.create({ sink: capture.sink });
  const err = new Error("upstream rejected Authorization: Bearer secret-token and x-api-key=raw-key");
  err.stack = "Error: token=stack-secret at test";

  logger.error("failed with embedded secret", { err });

  const parsed = JSON.parse(capture.stderr[0]);
  expect(parsed.err.message).toContain("Authorization: [REDACTED]");
  expect(parsed.err.message).toContain("x-api-key=[REDACTED]");
  expect(parsed.err.message).not.toContain("secret-token");
  expect(parsed.err.message).not.toContain("raw-key");
  expect(parsed.err.stack).toContain("token=[REDACTED]");
  expect(parsed.err.stack).not.toContain("stack-secret");
});

test("redacts cookie substrings inside error objects", () => {
  const capture = captureSink();
  const logger = Logger.create({ sink: capture.sink });
  const err = new Error("Authorization: Basic dXNlcjpwYXNz Cookie: theme=dark; __dashboard_session=session-secret; Set-Cookie: __dashboard_session=next-secret; HttpOnly");

  logger.error("failed with cookie", { err });

  const parsed = JSON.parse(capture.stderr[0]);
  expect(parsed.err.message).toContain("Authorization: [REDACTED]");
  expect(parsed.err.message).toContain("Cookie: [REDACTED]");
  expect(parsed.err.message).toContain("Set-Cookie: [REDACTED]");
  expect(parsed.err.message).not.toContain("dXNlcjpwYXNz");
  expect(parsed.err.message).not.toContain("theme=dark");
  expect(parsed.err.message).not.toContain("session-secret");
  expect(parsed.err.message).not.toContain("next-secret");
});

test("redacts all cookie pairs regardless of cookie name", () => {
  const capture = captureSink();
  const logger = Logger.create({ sink: capture.sink });
  const err = new Error("Cookie: first=visible; second=also-visible; Set-Cookie: third=hidden; Path=/");

  logger.error("failed with cookie", { err });

  const parsed = JSON.parse(capture.stderr[0]);
  expect(parsed.err.message).toContain("Cookie: [REDACTED]");
  expect(parsed.err.message).toContain("Set-Cookie: [REDACTED]");
  expect(parsed.err.message).not.toContain("first=visible");
  expect(parsed.err.message).not.toContain("second=also-visible");
  expect(parsed.err.message).not.toContain("third=hidden");
});


test("redacts JSON-style sensitive substrings inside error objects", () => {
  const capture = captureSink();
  const logger = Logger.create({ sink: capture.sink });
  const err = new Error(JSON.stringify({
    authorization: "Basic dXNlcjpwYXNz",
    cookie: "theme=dark; __dashboard_session=session-secret",
    "set-cookie": "__dashboard_session=next-secret; HttpOnly",
    "x-api-key": "raw-key",
    password: "raw-password",
  }));

  logger.error("failed with json", { err });

  const parsed = JSON.parse(capture.stderr[0]);
  expect(parsed.err.message).toContain('"authorization":"[REDACTED]"');
  expect(parsed.err.message).toContain('"cookie":"[REDACTED]"');
  expect(parsed.err.message).toContain('"set-cookie":"[REDACTED]"');
  expect(parsed.err.message).toContain('"x-api-key":"[REDACTED]"');
  expect(parsed.err.message).toContain('"password":"[REDACTED]"');
  expect(parsed.err.message).not.toContain("dXNlcjpwYXNz");
  expect(parsed.err.message).not.toContain("session-secret");
  expect(parsed.err.message).not.toContain("next-secret");
  expect(parsed.err.message).not.toContain("raw-key");
  expect(parsed.err.message).not.toContain("raw-password");
});


test("redacts escaped JSON-style sensitive substrings", () => {
  const capture = captureSink();
  const logger = Logger.create({ sink: capture.sink });
  const err = new Error(String.raw`{\"authorization\":\"Basic dXNlcjpwYXNz\",\"cookie\":\"session-secret\",\"x-api-key\":\"raw-key\"}`);

  logger.error("failed with escaped json", { err });

  const parsed = JSON.parse(capture.stderr[0]);
  expect(parsed.err.message).toContain(String.raw`\"authorization\":\"[REDACTED]\"`);
  expect(parsed.err.message).toContain(String.raw`\"cookie\":\"[REDACTED]\"`);
  expect(parsed.err.message).toContain(String.raw`\"x-api-key\":\"[REDACTED]\"`);
  expect(parsed.err.message).not.toContain("dXNlcjpwYXNz");
  expect(parsed.err.message).not.toContain("session-secret");
  expect(parsed.err.message).not.toContain("raw-key");
});
