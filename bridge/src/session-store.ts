/**
 * Persisted handoff snapshots for cross-context session resume (spec 8.1).
 *
 * A snapshot is the compact, provider-agnostic summary the panel already builds
 * when moving a chat to another provider (see agent-handoff.ts on the extension
 * side). Persisting it lets the same task resume in a new window, an incognito
 * window, or a different profile: that context asks the bridge for the snapshot
 * by Session ID and re-sends it as the first message.
 *
 * Storage: one JSON file per Session ID under `<configDir>/sessions/`. Session
 * IDs are restricted to a safe character set so a caller can never address a
 * path outside that folder. Snapshots hold log summaries and the chat
 * conversation (which can quote file contents), so they stay local and are
 * bounded on write and validated on read.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LOGS = 100;
const MAX_TEXT = 12_000;
const MAX_DETAIL = 2_000;
const MAX_TURNS = 300;
const MAX_TURN_TEXT = 8_000;
const MAX_TOOL_TURN_TEXT = 4_000;
const TURN_ROLES = ["user", "assistant", "tool", "agent"] as const;

/** One activity row, mirroring the extension's HandoffLogEntry. */
export interface SessionLogEntry {
  time: string;
  tool: string;
  category: string;
  decision: string;
  status: "ok" | "denied" | "error" | "info";
  ms: number;
  detail?: string;
}

/** One chat message, mirroring the extension's HandoffTurn. */
export interface SessionTurn {
  role: (typeof TURN_ROLES)[number];
  text: string;
}

/** A persisted handoff snapshot. */
export interface SessionSnapshot {
  version: 1;
  createdAt: string;
  provider: string;
  totalCalls: number;
  lastSent: string | null;
  lastReplyText: string | null;
  logs: SessionLogEntry[];
  /** The chat conversation, oldest first ([] for snapshots written before it existed). */
  transcript: SessionTurn[];
}

/** A saved session as listed by {@link SessionStore.list}. */
export interface SessionSummary {
  id: string;
  createdAt: string;
  provider: string;
  totalCalls: number;
}

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeLog(item: unknown): SessionLogEntry | null {
  if (!item || typeof item !== "object") return null;
  const entry = item as Record<string, unknown>;
  const status = entry.status;
  if (!["ok", "denied", "error", "info"].includes(String(status))) return null;
  return {
    time: text(entry.time, 80),
    tool: text(entry.tool, 200),
    category: text(entry.category, 200),
    decision: text(entry.decision, 200),
    status: status as SessionLogEntry["status"],
    ms: count(entry.ms),
    ...(typeof entry.detail === "string" ? { detail: text(entry.detail, MAX_DETAIL) } : {}),
  };
}

function normalizeTurn(item: unknown): SessionTurn | null {
  if (!item || typeof item !== "object") return null;
  const turn = item as Record<string, unknown>;
  const role = turn.role as SessionTurn["role"];
  if (!TURN_ROLES.includes(role) || typeof turn.text !== "string") return null;
  const body = turn.text.trim();
  if (!body) return null;
  const max = role === "tool" ? MAX_TOOL_TURN_TEXT : MAX_TURN_TEXT;
  if (body.length <= max) return { role, text: body };
  // Same cut as the extension's clip(): never longer than max, so re-saving is a no-op.
  const note = "\n... (dipotong dari " + body.length + " karakter)";
  return { role, text: body.slice(0, Math.max(0, max - note.length)) + note };
}

/** Validate and normalize an untrusted snapshot; throws on a wrong top-level shape. */
export function normalizeSnapshot(value: unknown): SessionSnapshot {
  if (!value || typeof value !== "object") {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "snapshot must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.logs)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "snapshot.version must be 1 and logs must be an array");
  }
  const logs = raw.logs.slice(-MAX_LOGS).flatMap((item): SessionLogEntry[] => {
    const entry = normalizeLog(item);
    return entry ? [entry] : [];
  });
  return {
    version: 1,
    createdAt: text(raw.createdAt, 80),
    provider: text(raw.provider, 200) || "unknown",
    totalCalls: count(raw.totalCalls),
    lastSent: typeof raw.lastSent === "string" ? text(raw.lastSent) : null,
    lastReplyText: typeof raw.lastReplyText === "string" ? text(raw.lastReplyText) : null,
    logs,
    transcript: Array.isArray(raw.transcript)
      ? raw.transcript.slice(-MAX_TURNS).flatMap((item): SessionTurn[] => {
          const turn = normalizeTurn(item);
          return turn ? [turn] : [];
        })
      : [],
  };
}

/** Reject a Session ID that could address anything outside the sessions folder. */
export function validateSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "session id must be 1-64 chars of [A-Za-z0-9_-]");
  }
  return id;
}

/** Filesystem-backed store for handoff snapshots, keyed by Session ID. */
export class SessionStore {
  readonly #dir: string;

  constructor(configDir: string) {
    this.#dir = join(configDir, "sessions");
  }

  #path(id: string): string {
    return join(this.#dir, id + ".json");
  }

  /** Persist (or overwrite) the snapshot for `id`; returns the stored summary. */
  save(id: unknown, snapshot: unknown): SessionSummary {
    const sessionId = validateSessionId(id);
    const normalized = normalizeSnapshot(snapshot);
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(this.#path(sessionId), JSON.stringify(normalized, null, 2), "utf8");
    return {
      id: sessionId,
      createdAt: normalized.createdAt,
      provider: normalized.provider,
      totalCalls: normalized.totalCalls,
    };
  }

  /** Load a snapshot by Session ID; null when it does not exist or is unreadable. */
  load(id: unknown): (SessionSnapshot & { id: string }) | null {
    const sessionId = validateSessionId(id);
    let raw: string;
    try {
      raw = readFileSync(this.#path(sessionId), "utf8");
    } catch {
      return null;
    }
    try {
      return { id: sessionId, ...normalizeSnapshot(JSON.parse(raw)) };
    } catch {
      return null;
    }
  }

  /** Remove a snapshot; true when a file was deleted. */
  clear(id: unknown): boolean {
    const sessionId = validateSessionId(id);
    try {
      rmSync(this.#path(sessionId), { force: false });
      return true;
    } catch {
      return false;
    }
  }

  /** Every stored session, newest first, skipping unreadable files. */
  list(): SessionSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!SESSION_ID_RE.test(id)) continue;
      const loaded = this.load(id);
      if (!loaded) continue;
      out.push({ id, createdAt: loaded.createdAt, provider: loaded.provider, totalCalls: loaded.totalCalls });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  }
}
