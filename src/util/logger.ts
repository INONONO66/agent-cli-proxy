import { AsyncLocalStorage } from "node:async_hooks";

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
  const scopedLevel = new AsyncLocalStorage<Level>();
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

  export function withLevel<T>(level: Level, fn: () => T): T {
    return scopedLevel.run(level, fn);
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
      const activeLevel = scopedLevel.getStore() ?? this.options.level;
      if (LEVELS[level] < LEVELS[activeLevel]) return;

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

      if (level === "warn" || level === "error") {
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
    return /authorization|cookie|set-cookie|x[-_]?api[-_]?key|api[-_]?key|x[-_]?proxy[-_]?key|proxy[-_]?key|x[-_]?admin[-_]?token|admin[-_]?token|token|password|secret/i.test(key);
  }

  const SENSITIVE_LABEL = "authorization|cookie|set-cookie|api[_-]?key|x[_-]?api[_-]?key|x[_-]?proxy[_-]?key|proxy[_-]?key|x[_-]?admin[_-]?token|admin[_-]?token|token|password|secret";
  const quotedSensitiveValuePattern = new RegExp(`(["'](?:${SENSITIVE_LABEL})["']\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\2).)*\\2`, "gi");
  const escapedQuotedSensitiveValuePattern = new RegExp(`(\\\\["'](?:${SENSITIVE_LABEL})\\\\["']\\s*[:=]\\s*\\\\["'])(?:(?!\\\\["']).)*(\\\\["'])`, "gi");

  function redactString(value: string): string {
    return value
      .replace(quotedSensitiveValuePattern, "$1$2[REDACTED]$2")
      .replace(escapedQuotedSensitiveValuePattern, "$1[REDACTED]$2")
      .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
      .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?(?:["'])?[^\s,;&"']+(?:\s+[^\s,;&"']+)?(?:["'])?/gi, "$1[REDACTED]")
      .replace(/(cookie\s*[:=]\s*)(?:(?!\sset-cookie\s*[:=])[^\r\n])+/gi, redactHeaderValue)
      .replace(/(set-cookie\s*[:=]\s*)([^\r\n]+)/gi, redactHeaderValue)
      .replace(/((?:api[_-]?key|x[_-]?api[_-]?key|x[_-]?proxy[_-]?key|proxy[_-]?key|x[_-]?admin[_-]?token|admin[_-]?token|token|password|secret)\s*[:=]\s*)(?:["'])?([^\s,;&"']+)(?:["'])?/gi, "$1[REDACTED]");
  }

  function redactHeaderValue(_match: string, prefix: string): string {
    return `${prefix}[REDACTED]`;
  }

  function redact(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return redactString(value);
    if (typeof value !== "object") return value;

    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
        stack: value.stack ? redactString(value.stack) : undefined,
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
        out[key] = isSensitiveKey(key) ? REDACTED : redactString(headerValue);
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
