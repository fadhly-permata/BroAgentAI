import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_STRING_LENGTH,
  REDACTED,
  UNSERIALIZABLE,
  createLogger,
  sanitize,
} from "./logger.ts";

interface CapturedEntry {
  ts: string;
  level: string;
  msg: string;
  scope?: string;
  fields?: Record<string, unknown>;
}

function capture(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    ...options,
    sink: (line) => lines.push(line),
    now: () => new Date("2025-01-02T03:04:05.000Z"),
  });
  return {
    logger,
    lines,
    entries: (): CapturedEntry[] => lines.map((line) => JSON.parse(line) as CapturedEntry),
  };
}

test("emits a structured JSON line with ts, level, msg, scope, fields", () => {
  const { logger, entries } = capture({ level: "debug", scope: "system" });
  logger.info("ping received", { fields: { id: 7 } });

  const [entry] = entries();
  assert.equal(entry.ts, "2025-01-02T03:04:05.000Z");
  assert.equal(entry.level, "info");
  assert.equal(entry.msg, "ping received");
  assert.equal(entry.scope, "system");
  assert.deepEqual(entry.fields, { id: 7 });
});

test("redacts secret-looking keys case-insensitively", () => {
  const { logger, entries } = capture({ level: "debug" });
  logger.info("handshake", {
    fields: {
      password: "hunter2",
      apiKey: "sk-live-123",
      Authorization: "Bearer abc",
      Cookie: "session=xyz",
      private_key: "-----BEGIN-----",
      username: "alice",
    },
  });

  const [entry] = entries();
  assert.equal(entry.fields?.password, REDACTED);
  assert.equal(entry.fields?.apiKey, REDACTED);
  assert.equal(entry.fields?.Authorization, REDACTED);
  assert.equal(entry.fields?.Cookie, REDACTED);
  assert.equal(entry.fields?.private_key, REDACTED);
  assert.equal(entry.fields?.username, "alice");
});

test("redacts secrets inside nested objects and arrays", () => {
  const { logger, entries } = capture({ level: "debug" });
  logger.info("nested", {
    fields: {
      config: { token: "t", nested: [{ password: "p" }] },
    },
  });

  const [entry] = entries();
  const config = entry.fields?.config as { token: string; nested: Array<{ password: string }> };
  assert.equal(config.token, REDACTED);
  assert.equal(config.nested[0]?.password, REDACTED);
});

test("truncates long strings but keeps the length marker", () => {
  const { logger, entries } = capture({ level: "debug" });
  const huge = "x".repeat(MAX_STRING_LENGTH + 50);
  logger.info("huge", { fields: { blob: huge } });

  const [entry] = entries();
  const blob = entry.fields?.blob as string;
  assert.ok(blob.startsWith("x".repeat(MAX_STRING_LENGTH)));
  assert.ok(blob.endsWith(`â€¦(${huge.length} chars)`));
});

test("filters entries below the configured level", () => {
  const { logger, entries } = capture({ level: "warn" });
  logger.debug("ignored debug");
  logger.info("ignored info");
  logger.warn("kept warn");
  logger.error("kept error");

  assert.deepEqual(
    entries().map((e) => e.msg),
    ["kept warn", "kept error"],
  );
});

test("child() prefixes scope and inherits level and sink", () => {
  const { logger, entries } = capture({ level: "debug", scope: "bridge" });
  logger.child("frames").info("encoded");

  const [entry] = entries();
  assert.equal(entry.scope, "bridge.frames");
});

test("abbreviates the user's home directory to ~ in every string", () => {
  const { logger, entries } = capture({ level: "debug", homeDir: "/home/alice" });
  logger.info("open", { fields: { path: "/home/alice/project/file.txt" } });

  const [entry] = entries();
  assert.equal(entry.fields?.path, "~/project/file.txt");
});

test("reduces Error instances to name, message, and code (no stack)", () => {
  const error = Object.assign(new TypeError("boom /home/alice/secret.ts"), { code: "E_BOOM" });
  const result = sanitize(error) as Record<string, unknown>;

  assert.deepEqual(result, {
    name: "TypeError",
    message: "boom /home/alice/secret.ts",
    code: "E_BOOM",
  });
});

test("survives circular structures instead of recursing forever", () => {
  const node: Record<string, unknown> = { name: "root" };
  node.self = node;

  const result = sanitize(node) as Record<string, unknown>;
  assert.equal(result.name, "root");
  assert.equal(result.self, "[circular]");
});

test("marks functions and symbols as unserializable", () => {
  assert.equal(sanitize(() => 1), UNSERIALIZABLE);
  assert.equal(sanitize(Symbol("x")), UNSERIALIZABLE);
});

test("default sink writes to stderr, never stdout", () => {
  const stdoutCalls: string[] = [];
  const stderrCalls: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutCalls.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCalls.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const logger = createLogger({ level: "debug", now: () => new Date("2025-01-02T03:04:05.000Z") });
    logger.info("goes to stderr");
    assert.equal(stderrCalls.length, 1);
    assert.match(stderrCalls[0] ?? "", /goes to stderr/);
    assert.deepEqual(stdoutCalls, []);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
});

test("never writes to stdout (sink receives every line)", () => {
  const original = process.stdout.write.bind(process.stdout);
  const stdoutCalls: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutCalls.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const { logger, lines } = capture({ level: "debug" });
    logger.info("channel-safe");
    assert.equal(lines.length, 1);
    assert.deepEqual(stdoutCalls, []);
  } finally {
    process.stdout.write = original;
  }
});
