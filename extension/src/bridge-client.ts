// Bridge client: Native Messaging ke host lokal. Offline = error BRIDGE_OFFLINE, bukan data palsu.
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
} as const;

const DEFAULT_TIMEOUT_MS = 15000;

class BridgeClient {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private handlers: Handler[] = [];
  private seq = 0;
  private connectPromise: Promise<void> | null = null;

  onEvent(h: Handler) { this.handlers.push(h); }

  async connect(): Promise<void> {
    if (this.port) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      try {
        this.port = chrome.runtime.connectNative("com.broagentai.host");
        
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
          const err = chrome.runtime.lastError;
          this.port = null;
          this.connectPromise = null;
          for (const [, p] of this.pending.entries()) {
            p.reject(new Error(err ? err.message : 'BRIDGE_DISCONNECTED'));
          }
          this.pending.clear();
        });

        this.call('system.ping', {}).then(() => {
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

export const bridge = new BridgeClient();
