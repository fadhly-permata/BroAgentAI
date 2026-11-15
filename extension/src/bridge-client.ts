// Bridge client: WS ke localhost bridge. Token dari Settings. Offline = error BRIDGE_OFFLINE, bukan data palsu.
type Handler = (ev: any) => void;
class BridgeClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private handlers: Handler[] = [];
  private seq = 0;
  url = 'ws://127.0.0.1:8765';
  token = '';
  onEvent(h: Handler) { this.handlers.push(h); }
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => reject(new Error('BRIDGE_OFFLINE'));
      ws.onclose = () => { this.ws = null; };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!; this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
        } else { this.handlers.forEach((h) => h(msg)); }
      };
    });
  }
  async call(method: string, params: any = {}): Promise<any> {
    await this.connect();
    const id = `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params, token: this.token }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('TIMEOUT')); } }, 15000);
    });
  }
}
export const bridge = new BridgeClient();
