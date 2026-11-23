import { validateHandoffSnapshot, type HandoffSnapshot } from './agent-handoff.ts';

export interface BridgeRpc {
  call(method: string, params?: unknown, timeoutMs?: number): Promise<any>;
}

export interface KeyValueStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  provider: string;
  totalCalls: number;
}

export const SESSION_ID_KEY = 'broagentai.sessionResumeId';
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LISTED = 50;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

export function normalizeSessionId(id: unknown): string | null {
  const value = typeof id === 'string' ? id.trim() : id;
  return isValidSessionId(value) ? value : null;
}

export function createSessionId(now = Date.now(), random = Math.random()): string {
  const stamp = Math.max(0, Math.floor(now)).toString(36);
  const entropy = Math.floor(Math.max(0, Math.min(1, random)) * 0xffffffff).toString(36);
  return `ba-${stamp}-${entropy}`.slice(0, 64);
}

function normalizeSummary(value: unknown): SessionSummary | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = normalizeSessionId(raw.id);
  if (!id || typeof raw.createdAt !== 'string' || typeof raw.provider !== 'string') return null;
  const totalCalls = typeof raw.totalCalls === 'number' && Number.isFinite(raw.totalCalls)
    ? Math.max(0, Math.floor(raw.totalCalls)) : 0;
  return { id, createdAt: raw.createdAt.slice(0, 80), provider: raw.provider.slice(0, 200), totalCalls };
}

export function normalizeSessionSummaries(value: unknown, limit = MAX_LISTED): SessionSummary[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SessionSummary[] = [];
  for (const item of value) {
    const summary = normalizeSummary(item);
    if (!summary || seen.has(summary.id)) continue;
    seen.add(summary.id);
    out.push(summary);
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return out.slice(0, limit);
}

export async function ensureSessionId(storage: KeyValueStore): Promise<string> {
  try {
    const stored = await storage.get(SESSION_ID_KEY);
    const existing = normalizeSessionId(stored?.[SESSION_ID_KEY]);
    if (existing) return existing;
    const created = createSessionId();
    await storage.set({ [SESSION_ID_KEY]: created });
    return created;
  } catch {
    return createSessionId();
  }
}

export async function setSessionId(storage: KeyValueStore, id: unknown): Promise<string> {
  const sessionId = normalizeSessionId(id);
  if (!sessionId) throw new Error('invalid session id');
  await storage.set({ [SESSION_ID_KEY]: sessionId });
  return sessionId;
}

export async function saveSession(bridge: BridgeRpc, id: unknown, snapshot: unknown): Promise<SessionSummary | null> {
  const sessionId = normalizeSessionId(id);
  if (!sessionId) return null;
  const valid = validateHandoffSnapshot(snapshot);
  if (!valid) return null;
  const result: unknown = await bridge.call('session.save', { id: sessionId, snapshot: valid });
  return normalizeSummary(result) ?? {
    id: sessionId,
    createdAt: valid.createdAt,
    provider: valid.provider,
    totalCalls: valid.totalCalls,
  };
}

export async function loadSession(bridge: BridgeRpc, id: unknown): Promise<HandoffSnapshot | null> {
  const sessionId = normalizeSessionId(id);
  if (!sessionId) return null;
  const result: unknown = await bridge.call('session.load', { id: sessionId });
  return result ? validateHandoffSnapshot(result) : null;
}

export async function listSessions(bridge: BridgeRpc): Promise<SessionSummary[]> {
  const result: any = await bridge.call('session.list');
  return normalizeSessionSummaries(result?.sessions ?? result);
}

export async function clearSession(bridge: BridgeRpc, id: unknown): Promise<boolean> {
  const sessionId = normalizeSessionId(id);
  if (!sessionId) return false;
  const result: any = await bridge.call('session.clear', { id: sessionId });
  return result?.cleared === true;
}

export class SessionResumeService {
  cachedId: string | null;

  constructor(bridge: BridgeRpc, storage: KeyValueStore) {
    this.bridge = bridge;
    this.storage = storage;
    this.cachedId = null;
  }

  bridge: BridgeRpc;
  storage: KeyValueStore;

  async ensureSessionId(): Promise<string> {
    if (this.cachedId) return this.cachedId;
    this.cachedId = await ensureSessionId(this.storage);
    return this.cachedId;
  }

  async useSessionId(id: unknown): Promise<string> {
    this.cachedId = await setSessionId(this.storage, id);
    return this.cachedId;
  }

  currentSessionId(): string | null {
    return this.cachedId;
  }

  async save(snapshot: unknown): Promise<SessionSummary | null> {
    const id = await this.ensureSessionId();
    return saveSession(this.bridge, id, snapshot);
  }

  async load(id: unknown = this.cachedId): Promise<HandoffSnapshot | null> {
    return loadSession(this.bridge, id);
  }

  async list(): Promise<SessionSummary[]> {
    return listSessions(this.bridge);
  }

  async clear(id: unknown): Promise<boolean> {
    const cleared = await clearSession(this.bridge, id);
    if (cleared && normalizeSessionId(id) === this.cachedId) {
      this.cachedId = null;
      try { await this.storage.set({ [SESSION_ID_KEY]: null }); } catch {}
    }
    return cleared;
  }
}
