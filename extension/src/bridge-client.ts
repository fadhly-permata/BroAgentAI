// Bridge client: Native Messaging ke host lokal. Offline = error BRIDGE_OFFLINE, bukan data palsu.
type Handler = (ev: any) => void;

interface RpcRequest {
  v: 1;
  id: number;
  method: string;
  params?: unknown;
}

interface RpcSuccess {
  v: 1;
  id: number;
  ok: true;
  result: unknown;
}

interface RpcFailure {
  v: 1;
  id: number;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface RpcEvent {
  v: 1;
  event: string;
  data?: unknown;
}

type RpcResponse = RpcSuccess | RpcFailure | RpcEvent;

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
          if ('id' in msg && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (!msg.ok) {
              p.reject(new Error(msg.error.message));
            } else {
              p.resolve(msg.result);
            }
          } else if ('event' in msg) {
            this.handlers.forEach((h) => h(msg));
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

  async call(method: string, params: any = {}): Promise<any> {
    await this.connect();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error('BRIDGE_OFFLINE'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      const req: RpcRequest = { v: 1, id, method, params };
      this.port.postMessage(req);
      
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('TIMEOUT'));
        }
      }, 15000);
    });
  }
}

export const bridge = new BridgeClient();
