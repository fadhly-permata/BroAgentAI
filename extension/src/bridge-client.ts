// Bridge client: Native Messaging ke host lokal. Offline = error BRIDGE_OFFLINE, bukan data palsu.
import { browser, lastError, type Port } from './browser.ts';

type Handler = (ev: any) => void;

interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface RpcSuccess {
  id: number;
  result?: unknown;
}

interface RpcFailure {
  id: number;
  error: {
    code: string | number;
    message: string;
    data?: unknown;
  };
}

interface RpcEvent {
  event: string;
  data?: unknown;
}

type RpcResponse = RpcSuccess | RpcFailure | RpcEvent;

export const PROTOCOL_VERSION_V2 = 2;
export const SUPPORTED_PROTOCOL_VERSIONS = [1, 2] as const;
export const DEPRECATED_PROTOCOL_VERSIONS = [1] as const;

export interface BridgeProtocolInfo {
  version: number;
  supported: number[];
  deprecated: number[];
}

export interface DetectedShellInfo {
  family: string;
  environment: string;
  file: string;
  platform: string;
  arch: string;
}

/** Error from the bridge, carrying the stable numeric code from shared/protocol.ts. */
export class BridgeError extends Error {
  code: string | number;
  data?: unknown;
  constructor(message: string, code: string | number, data?: unknown) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.data = data;
  }
}

/** Numeric codes the UI branches on (mirror of shared/src/protocol.ts ErrorCode). */
export const BridgeErrorCode = {
  METHOD_NOT_FOUND: -32601,
  MTIME_CONFLICT: -32005,
  OPERATION_CANCELLED: -32010,
  NOT_ALLOWED: -32022,
  SHELL_NOT_AVAILABLE: -32023,
  SHELL_START_FAILED: -32024,
  SHELL_UNSUPPORTED: -32025,
  SHELL_CWD_INVALID: -32026,
  SHELL_BUSY: -32027,
  DEPENDENCY_APPROVAL_REQUIRED: -32028,
  DEPENDENCY_INSTALL_FAILED: -32029,
} as const;

export interface RootInfo {
  id: string;
  rootId?: string;
  name: string;
  path: string;
  active: boolean;
}

export interface RootResolvedPath {
  rootId: string;
  rootPath: string;
  relativePath: string;
  path: string;
}

export interface ScriptSummary {
  name: string;
  manager: string;
  command: string[];
  cwd: string;
  timeoutMs: number;
}

export interface SkillRunSummary {
  name: string;
  command: string[];
  cwd: string;
  envKeys: string[];
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

class BridgeClient {
  private port: Port | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private handlers: Handler[] = [];
  private seq = 0;
  private connectPromise: Promise<void> | null = null;
  private protocolInfo: BridgeProtocolInfo | null = null;

  get protocol(): BridgeProtocolInfo {
    return this.protocolInfo ?? {
      version: PROTOCOL_VERSION_V2,
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      deprecated: [...DEPRECATED_PROTOCOL_VERSIONS],
    };
  }

  get protocolDeprecated(): boolean {
    const version = this.protocolInfo?.version ?? PROTOCOL_VERSION_V2;
    return DEPRECATED_PROTOCOL_VERSIONS.includes(version as 1);
  }

  async roots(): Promise<{ roots: RootInfo[]; activeRootId: string | null }> {
    return this.call('root.list', {});
  }

  async setActiveRoot(rootId: string): Promise<{ root: RootInfo; activeRootId: string }> {
    return this.call('root.setActive', { rootId });
  }

  async removeRoot(rootId: string): Promise<unknown> {
    return this.call('root.remove', { rootId });
  }

  async resolveRootPath(path: string): Promise<RootResolvedPath> {
    return this.call('root.resolve', { path });
  }

  async scripts(): Promise<{ scripts: ScriptSummary[] }> {
    return this.call('script.list', {});
  }

  async skillRuns(): Promise<{ skills: SkillRunSummary[] }> {
    return this.call('skill.list', {});
  }

  onEvent(h: Handler) { this.handlers.push(h); }

  async connect(): Promise<void> {
    if (this.port) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      try {
        this.port = browser.runtime.connectNative("com.broagentai.host");
        
        this.port.onMessage.addListener((msg: RpcResponse) => {
          if ('event' in msg) {
            this.handlers.forEach((h) => h(msg));
            return;
          }
          if ('id' in msg && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if ('error' in msg) {
              p.reject(new BridgeError(msg.error.message, msg.error.code, msg.error.data));
            } else {
              p.resolve(msg.result);
            }
          }
        });

        this.port.onDisconnect.addListener(() => {
          const err = lastError();
          this.port = null;
          this.connectPromise = null;
          for (const [, p] of this.pending.entries()) {
            p.reject(new Error(err ? err.message : 'BRIDGE_DISCONNECTED'));
          }
          this.pending.clear();
        });

        this.call('system.ping', {}).then((info: any) => {
          this.protocolInfo = normalizeProtocolInfo(info);
          resolve();
        }).catch(() => {
          try { this.port?.disconnect(); } catch { /* already gone */ }
          this.port = null;
          this.connectPromise = null;
          reject(new Error('BRIDGE_OFFLINE'));
        });

      } catch (e) {
        this.connectPromise = null;
        reject(new Error('BRIDGE_OFFLINE'));
      }
    });

    return this.connectPromise;
  }

  async call(method: string, params: any = {}, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<any> {
    await this.connect();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error('BRIDGE_OFFLINE'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      const req: RpcRequest = { id, method, params };
      this.port.postMessage(req);
      
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('TIMEOUT'));
        }
      }, timeoutMs);
    });
  }
}

function normalizeProtocolInfo(info: any): BridgeProtocolInfo {
  if (!info || typeof info !== 'object') {
    return {
      version: PROTOCOL_VERSION_V2,
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      deprecated: [...DEPRECATED_PROTOCOL_VERSIONS],
    };
  }
  const raw = info.protocol && typeof info.protocol === 'object' ? info.protocol : info;
  const version = typeof raw.version === 'number' ? raw.version
    : typeof info.protocolVersion === 'number' ? info.protocolVersion
    : PROTOCOL_VERSION_V2;
  return {
    version,
    supported: Array.isArray(raw.supported) && raw.supported.every((v: unknown) => typeof v === 'number')
      ? raw.supported
      : [...SUPPORTED_PROTOCOL_VERSIONS],
    deprecated: Array.isArray(raw.deprecated) && raw.deprecated.every((v: unknown) => typeof v === 'number')
      ? raw.deprecated
      : [...DEPRECATED_PROTOCOL_VERSIONS],
  };
}

export const bridge = new BridgeClient();
