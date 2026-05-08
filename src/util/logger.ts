export namespace Logger {
  export type Level = "debug" | "info" | "warn" | "error";
  export type Format = "json" | "pretty";
  export type Fields = Record<string, unknown>;

  export interface Sink {
    stdout(line: string): void;
    stderr(line: string): void;
  }

  export interface Options {
    level?: Level;
    base?: Fields;
    format?: Format;
    sink?: Sink;
  }

  export interface Logger {
    child(base: Fields): Logger;
    debug(msg: string, fields?: Fields): void;
    info(msg: string, fields?: Fields): void;
    warn(msg: string, fields?: Fields): void;
    error(msg: string, fields?: Fields): void;
  }

  type LogRecord = {
    ts: string;
    level: Level;
    msg: string;
  } & Fields;

  const LEVELS: Record<Level, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };

  const REDACTED = "[REDACTED]";

  const MAX_PENDING = 1000;
  const pendingLines: string[] = [];
  let stdoutBackpressured = false;
  let droppedCount = 0;

  function flushPending(): void {
    while (pendingLines.length > 0) {
      const line = pendingLines.shift()!;
      const ok = process.stdout.write(`${line}\n`);
      if (!ok) {
        stdoutBackpressured = true;
        return;
      }
    }
    stdoutBackpressured = false;
    if (droppedCount > 0) {
      const summary = JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "stdout backpressure caused line drops",
        event: "logger.dropped_lines",
        count: droppedCount,
      });
      process.stderr.write(`${summary}\n`);
      droppedCount = 0;
    }
  }

  process.stdout.on("drain", flushPending);

  export function _resetBackpressure(): void {
    pendingLines.length = 0;
    stdoutBackpressured = false;
    droppedCount = 0;
  }

  const defaultSink: Sink = {
    stdout(line) {
      if (stdoutBackpressured) {
        if (pendingLines.length >= MAX_PENDING) {
          pendingLines.shift();
          droppedCount++;
        }
        pendingLines.push(line);
        return;
      }
      const ok = process.stdout.write(`${line}\n`);
      if (!ok) {
        stdoutBackpressured = true;
      }
    },
    stderr(line) {
      process.stderr.write(`${line}\n`);
    },
  };

  export function create(options: Options = {}): Logger {
    return new StructuredLogger({
      level: normalizeLevel(options.level),
      format: normalizeFormat(options.format),
      base: redact(options.base ?? {}) as Fields,
      sink: options.sink ?? defaultSink,
    });
  }

  export function fromConfig(options: Omit<Options, "level" | "format"> = {}): Logger {
    return create({
      ...options,
      level: normalizeLevel(process.env.LOG_LEVEL),
      format: normalizeFormat(process.env.LOG_FORMAT),
    });
  }

  export function redactValue(value: unknown): unknown {
    return redact(value);
  }

  class StructuredLogger implements Logger {
    constructor(private readonly options: Required<Pick<Options, "level" | "format" | "sink">> & { base: Fields }) {}

    child(base: Fields): Logger {
      return new StructuredLogger({
        ...this.options,
        base: {
          ...this.options.base,
          ...(redact(base) as Fields),
        },
      });
    }

    debug(msg: string, fields?: Fields): void {
      this.write("debug", msg, fields);
    }

    info(msg: string, fields?: Fields): void {
      this.write("info", msg, fields);
    }

    warn(msg: string, fields?: Fields): void {
      this.write("warn", msg, fields);
    }

    error(msg: string, fields?: Fields): void {
      this.write("error", msg, fields);
    }

    private write(level: Level, msg: string, fields: Fields = {}): void {
      if (LEVELS[level] < LEVELS[this.options.level]) return;

      const record: LogRecord = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...this.options.base,
        ...(redact(fields) as Fields),
      };

      const line = this.options.format === "pretty"
        ? formatPretty(record)
        : JSON.stringify(record);

      if (level === "error") {
        this.options.sink.stderr(line);
        return;
      }
      this.options.sink.stdout(line);
    }
  }

  function normalizeLevel(value: unknown): Level {
    if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
    return "info";
  }

  function normalizeFormat(value: unknown): Format {
    if (value === "pretty") return "pretty";
    return "json";
  }

  function isSensitiveKey(key: string): boolean {
    return /authorization|x[-_]?api[-_]?key|api[-_]?key|token|password|secret/i.test(key);
  }

  function redact(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => redact(item, seen));
    }

    if (value instanceof Headers) {
      const out: Fields = {};
      for (const [key, headerValue] of value.entries()) {
        out[key] = isSensitiveKey(key) ? REDACTED : headerValue;
      }
      return out;
    }

    const out: Fields = {};
    for (const [key, entry] of Object.entries(value as Fields)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(entry, seen);
    }
    return out;
  }

  function formatPretty(record: LogRecord): string {
    const { ts, level, msg, ...fields } = record;
    const suffix = Object.entries(fields)
      .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
      .join(" ");
    return suffix ? `${ts} ${level.toUpperCase()} ${msg} ${suffix}` : `${ts} ${level.toUpperCase()} ${msg}`;
  }

  function formatPrettyValue(value: unknown): string {
    if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
    return JSON.stringify(value);
  }
}
