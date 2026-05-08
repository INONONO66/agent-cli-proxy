import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Logger } from "../../src/util/logger";

describe("logger stdout backpressure", () => {
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let stdoutLines: string[];
  let stderrLines: string[];

  function mockStdout(returnValue: boolean) {
    process.stdout.write = function write(chunk: string | Uint8Array) {
      stdoutLines.push(String(chunk));
      return returnValue;
    } as typeof process.stdout.write;
  }

  function mockStderr() {
    process.stderr.write = function write(chunk: string | Uint8Array) {
      stderrLines.push(String(chunk));
      return true;
    } as typeof process.stderr.write;
  }

  beforeEach(() => {
    Logger._resetBackpressure();
    stdoutLines = [];
    stderrLines = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    Logger._resetBackpressure();
  });

  test("buffers lines when stdout.write returns false", () => {
    mockStdout(false);
    mockStderr();

    const logger = Logger.create({ level: "info" });

    logger.info("line-0");
    expect(stdoutLines).toHaveLength(1);

    for (let i = 1; i <= 100; i++) {
      logger.info(`line-${i}`);
    }

    expect(stdoutLines).toHaveLength(1);
  });

  test("drops oldest when buffer exceeds MAX_PENDING (1000)", () => {
    mockStdout(false);
    mockStderr();

    const logger = Logger.create({ level: "info" });

    for (let i = 0; i < 2000; i++) {
      logger.info(`line-${i}`);
    }

    expect(stdoutLines).toHaveLength(1);

    mockStdout(true);
    process.stdout.emit("drain");

    // 1 direct write (line-0) + 1000 flushed from bounded buffer
    expect(stdoutLines).toHaveLength(1001);

    // 1999 attempted buffer, cap 1000 → 999 dropped oldest
    const dropLine = stderrLines.find((l) => l.includes("logger.dropped_lines"));
    expect(dropLine).toBeDefined();
    const record = JSON.parse(dropLine!.trim());
    expect(record.count).toBe(999);
    expect(record.level).toBe("warn");

    // buffer retains newest: last flushed should be line-1999
    expect(stdoutLines[stdoutLines.length - 1]).toContain("line-1999");
  });

  test("error logs bypass backpressure queue entirely", () => {
    mockStdout(false);
    mockStderr();

    const logger = Logger.create({ level: "info" });

    logger.info("trigger");

    logger.error("critical failure");
    logger.error("second critical");

    const errorLines = stderrLines.filter((l) => l.includes('"level":"error"'));
    expect(errorLines).toHaveLength(2);
    expect(errorLines[0]).toContain("critical failure");
    expect(errorLines[1]).toContain("second critical");
  });

  test("drain event resets backpressure so new writes go direct", () => {
    mockStdout(false);
    mockStderr();

    const logger = Logger.create({ level: "info" });

    for (let i = 0; i < 10; i++) {
      logger.info(`buffered-${i}`);
    }

    mockStdout(true);
    process.stdout.emit("drain");

    const countAfterDrain = stdoutLines.length;

    logger.info("after-drain");
    expect(stdoutLines).toHaveLength(countAfterDrain + 1);
    expect(stdoutLines[stdoutLines.length - 1]).toContain("after-drain");
  });
});
