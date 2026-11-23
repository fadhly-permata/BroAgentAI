// real-bridge.mjs - drive the REAL broagentai-bridge host from Playwright e2e.
//
// Chrome cannot launch a native-messaging host inside the test browser without
// a per-machine registry entry, so the test replaces only the pipe:
// chrome.runtime.connectNative() is stubbed with a port that forwards every
// message to a real `bridge/dist/index.js` process (same stdio framing Chrome
// uses) and delivers its real responses. No RPC result is faked, so a contract
// mismatch between panel and bridge fails the test.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridgeEntry = path.join(repoRoot, 'bridge', 'dist', 'index.js');

/** Spawn the bridge with an isolated config dir. Returns { rpc, call, stop, stderr }. */
export function startRealBridge({ configDir }) {
  const child = spawn(process.execPath, [bridgeEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BROAGENTAI_CONFIG_DIR: configDir,
      // The OS folder picker would block a headless run; the panel then falls
      // back to its manual path input, which is what the test drives.
      BROAGENTAI_DISABLE_DIALOG: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  const eventListeners = [];
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  const state = { stderr: '', exited: false };

  child.stderr.on('data', (chunk) => { state.stderr += chunk.toString(); });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      if (typeof message.event === 'string') {
        eventListeners.forEach((fn) => fn(message));
        continue;
      }
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry.resolve({ ...message, id: entry.originalId });
      }
    }
  });
  child.on('exit', () => {
    state.exited = true;
    for (const entry of pending.values()) entry.reject(new Error('bridge exited'));
    pending.clear();
  });

  /** Send one request envelope; resolves with the bridge's response envelope. */
  function rpc(message) {
    if (state.exited) return Promise.reject(new Error('bridge exited'));
    // Several pages number their requests independently, so ids are remapped.
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, originalId: message.id });
      const body = Buffer.from(JSON.stringify({ ...message, id }), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      child.stdin.write(Buffer.concat([header, body]));
    });
  }

  /** Convenience for the test itself: returns result or throws the RPC error. */
  async function call(method, params = {}) {
    const response = await rpc({ id: 0, method, params });
    if (response.error) throw new Error(`${method}: ${response.error.message} (${response.error.code})`);
    return response.result;
  }

  function stop() {
    if (!state.exited) { child.stdin.end(); child.kill(); }
  }

  /** Subscribe to bridge -> extension events (term.output, mcp.status, ...). */
  function onEvent(fn) { eventListeners.push(fn); }

  return { rpc, call, stop, state, onEvent };
}

/**
 * Route chrome.runtime.connectNative in every page of `ctx` to `bridge`.
 * A page opened with the `#offline` hash gets a port that disconnects at once,
 * which is how Chrome behaves when the host is not installed.
 */
export async function attachBridge(ctx, bridge) {
  await ctx.exposeBinding('__broagentaiBridgeRpc', async (_source, json) => {
    return JSON.stringify(await bridge.rpc(JSON.parse(json)));
  });
  // Events are pushed by the bridge, so they are fanned out to every open page.
  bridge.onEvent((message) => {
    const json = JSON.stringify(message);
    for (const page of ctx.pages()) {
      page.evaluate((m) => window.__broagentaiBridgeEvent?.(m), json).catch(() => {});
    }
  });
  await ctx.addInitScript(() => {
    if (!globalThis.chrome?.runtime) return;
    const offline = location.hash === '#offline';
    const openPorts = new Set();
    window.__broagentaiBridgeEvent = (json) => {
      const message = JSON.parse(json);
      openPorts.forEach((deliver) => deliver(message));
    };
    const connectNative = () => {
      const messageListeners = [];
      const disconnectListeners = [];
      let open = true;
      const port = {
        name: 'com.broagentai.host',
        onMessage: { addListener(fn) { messageListeners.push(fn); } },
        onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
        disconnect() { open = false; },
        postMessage(message) {
          if (!open || offline) return;
          window.__broagentaiBridgeRpc(JSON.stringify(message)).then((json) => {
            if (!open) return;
            const response = JSON.parse(json);
            messageListeners.forEach((fn) => fn(response));
          });
        },
      };
      if (!offline) openPorts.add((message) => { if (open) messageListeners.forEach((fn) => fn(message)); });
      if (offline) setTimeout(() => { open = false; disconnectListeners.forEach((fn) => fn(port)); }, 0);
      return port;
    };
    globalThis.chrome.runtime.connectNative = connectNative;
    if (globalThis.browser?.runtime) globalThis.browser.runtime.connectNative = connectNative;
  });
}
