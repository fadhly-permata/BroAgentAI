/**
 * Structured logger for the BroAgentAI bridge.
 *
 * Two rules are non-negotiable here:
 *
 *  1. Logs go to **stderr**, never stdout. stdout is the Native Messaging
 *     channel: a stray `console.log` would interleave with length-prefixed
 *     JSON frames and corrupt the protocol. `process.stderr` is the only
 *     safe sink.
 *
 *  2. Every logged value passes through {@link sanitize} first. That means
 *     secret-looking keys are redacted, long strings are truncated, absolute
 *     paths outside the workspace are shortened, and Error objects are
 *     reduced to `{name, message, code}`. We would rather lose a little
 *     debugging fidelity than leak a token or a user's home directory.
 */

import { homedir } from "node:os";

/** Ordered log severities, from most to least verbose. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Environment variable used to pick a minimum level at startup. */
export const LOG_LEVEL_ENV = "BROAGENTAI_LOG_LEVEL";

/** Maximum characters kept for any single string value. */
export const MAX_STRING_LENGTH = 400;

/**
 * Keys whose values are never logged verbatim, regardless of their type.
 * Matching is case-insensitive on the raw key.
 */
const SECRET_KEY_PATTERN =
  /password|passwd|passphrase|secret|token\b|api[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?id/i;

/** Placeholder substituted for any redacted value. */
export const REDACTED = "[redacted]";

/** Placeholder substituted for values that could not be serialized. */
export const UNSERIALIZABLE = "[unserializable]";

/** Events emitted by {@link Logger.log}. */
export interface LogEntry {
  /** ISO-8601 timestamp for the event. */
  ts: string;

  /** Severity of the event. */
  level: LogLevel;

  /** Short, stable message. Must not contain user data. */
  msg: string;

  /** Optional module/subsystem label, e.g. `"frames"` or `"system.ping"`. */
  scope?: string;

  /** Sanitized structured fields that accompany the event. */
  fields?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Minimum level to emit. Defaults to `info`, or `BROAGENTAI_LOG_LEVEL`. */
  level?: LogLevel;

  /** Sink for emitted lines. Defaults to writing to `process.stderr`. */
  sink?: (line: string) => void;

  /** Clock used for timestamps, injectable for deterministic tests. */
  now?: () => Date;

  /** Module label attached to every entry emitted by this logger. */
  scope?: string;

  /** Home directory used to abbreviate paths. Defaults to `os.homedir()`. */
  homeDir?: string;
}

export interface LogCallOptions {
  /** Structured fields to sanitize and attach to the log entry. */
  fields?: Record<string, unknown>;
}

/**
 * Sanitize an arbitrary value so it is safe to include in a log entry.
 *
 * - Error instances become `{ name, message, code? }` (no stack: stacks often
 *   embed file paths and PII).
 * - Strings longer than {@link MAX_STRING_LENGTH} are truncated with an ellipsis.
 * - Objects and arrays recurse, with secret-looking keys replaced by
 *   {@link REDACTED}.
 * - BigInt becomes a string; functions and symbols become {@link UNSERIALIZABLE}.
 * - Circular structures are detected and replaced rather than recursed forever.
 */
export function sanitize(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncate(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "function" || typeof value === "symbol") return UNSERIALIZABLE;

  if (value instanceof Error) {
    return sanitizeError(value);
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : sanitize(child, seen);
    }
    return out;
  }

  return UNSERIALIZABLE;
}

/**
 * Create a logger. Call sites should create one per module at import time so
 * the scope and level settings are resolved once.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger({
    level: options.level ?? parseLevel(process.env[LOG_LEVEL_ENV]) ?? "info",
    sink: options.sink ?? ((line) => process.stderr.write(line + "\n")),
    now: options.now ?? (() => new Date()),
    scope: options.scope,
    homeDir: options.homeDir ?? homedir(),
  });
}

/** Fully-resolved options accepted by the {@link Logger} constructor. */
interface ResolvedLoggerOptions {
  level: LogLevel;
  sink: (line: string) => void;
  now: () => Date;
  scope: string | undefined;
  homeDir: string;
}

/** Logger instance returned by {@link createLogger}. */
export class Logger {
  readonly #level: LogLevel;
  readonly #sink: (line: string) => void;
  readonly #now: () => Date;
  readonly #scope: string | undefined;
  readonly #homeDir: string;

  constructor(options: ResolvedLoggerOptions) {
    this.#level = options.level;
    this.#sink = options.sink;
    this.#now = options.now;
    this.#scope = options.scope;
    this.#homeDir = options.homeDir;
  }

  /** Emit an entry at `debug` level. */
  debug(msg: string, call: LogCallOptions = {}): void {
    this.#emit("debug", msg, call.fields);
  }

  /** Emit an entry at `info` level. */
  info(msg: string, call: LogCallOptions = {}): void {
    this.#emit("info", msg, call.fields);
  }

  /** Emit an entry at `warn` level. */
  warn(msg: string, call: LogCallOptions = {}): void {
    this.#emit("warn", msg, call.fields);
  }

  /** Emit an entry at `error` level. */
  error(msg: string, call: LogCallOptions = {}): void {
    this.#emit("error", msg, call.fields);
  }

  /**
   * Return a logger that prefixes every entry with `scope`. Useful for
   * sub-modules that share a base logger.
   */
  child(scope: string): Logger {
    const combined = this.#scope ? `${this.#scope}.${scope}` : scope;
    return new Logger({
      level: this.#level,
      sink: this.#sink,
      now: this.#now,
      scope: combined,
      homeDir: this.#homeDir,
    });
  }

  #emit(level: LogLevel, msg: string, fields: Record<string, unknown> | undefined): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#level]) return;

    const entry: LogEntry = { ts: this.#now().toISOString(), level, msg };
    if (this.#scope) entry.scope = this.#scope;
    if (fields) entry.fields = redactPaths(sanitize(fields), this.#homeDir) as Record<string, unknown>;

    this.#sink(JSON.stringify(entry));
  }
}

function sanitizeError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: truncate(error.message),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out.code = code;
  return out;
}

function truncate(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}â€¦(${value.length} chars)`;
}

function parseLevel(raw: string | undefined): LogLevel | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  return lower === "debug" || lower === "info" || lower === "warn" || lower === "error"
    ? (lower as LogLevel)
    : undefined;
}

/**
 * Replace the user's home directory prefix with `~` so logs never contain a
 * usable absolute path to a personal folder. Recurses through sanitized JSON.
 */
function redactPaths(value: unknown, home: string): unknown {
  if (!home) return value;

  if (typeof value === "string") {
    return value
      .split(home)
      .join("~");
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactPaths(item, home));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactPaths(child, home);
    }
    return out;
  }

  return value;
}

