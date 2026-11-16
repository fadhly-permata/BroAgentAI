// Terminal tab: a real PTY in the active workspace, rendered with xterm.js.
// Keystrokes go to the bridge (term.input); output arrives as term.output events.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { bridge } from './bridge-client.js';

export interface TerminalDeps {
  toast(message: string): void;
  hasWorkspace(): boolean;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

let deps: TerminalDeps;
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let sessionId: string | null = null;
let starting = false;

function setStatus(text: string): void {
  $('termStatus').textContent = text;
}

function ensureXterm(): Terminal {
  if (term) return term;
  term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
    theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    scrollback: 5000,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('termView'));
  term.onData((data) => {
    if (!sessionId) return;
    bridge.call('term.input', { sessionId, data }).catch((err) => setStatus('Gagal kirim: ' + (err?.message || err)));
  });
  term.onResize(({ cols, rows }) => {
    if (sessionId) bridge.call('term.resize', { sessionId, cols, rows }).catch(() => {});
  });
  new ResizeObserver(() => fitNow()).observe($('termView'));
  // Test/diagnostic hook: read what the terminal currently shows as plain text.
  (window as any).__broagentaiTermText = () => {
    if (!term) return '';
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  };
  return term;
}

function fitNow(): void {
  if (!fit || !$('tab-terminal').classList.contains('active')) return;
  try { fit.fit(); } catch { /* not laid out yet */ }
}

async function startSession(): Promise<void> {
  if (starting || sessionId) return;
  if (!deps.hasWorkspace()) { setStatus('Pilih workspace dulu.'); return; }
  starting = true;
  const xterm = ensureXterm();
  fitNow();
  try {
    const res: any = await bridge.call('term.create', { cols: xterm.cols, rows: xterm.rows });
    sessionId = res.sessionId;
    setStatus(`${res.shell} - ${res.cwd}`);
    xterm.focus();
  } catch (err: any) {
    setStatus('Gagal membuka terminal: ' + (err?.message || err));
  } finally {
    starting = false;
  }
}

async function killSession(): Promise<void> {
  if (!sessionId) return;
  const id = sessionId;
  try { await bridge.call('term.close', { sessionId: id }); } catch { /* already gone */ }
}

/** Called when the Terminal tab becomes visible. */
export function showTerminal(): void {
  ensureXterm();
  requestAnimationFrame(() => {
    fitNow();
    if (!sessionId) startSession(); else term?.focus();
  });
}

export function initTerminal(dependencies: TerminalDeps): void {
  deps = dependencies;

  bridge.onEvent((ev: any) => {
    if (!ev?.data || ev.data.sessionId !== sessionId) return;
    if (ev.event === 'term.output') term?.write(ev.data.data);
    if (ev.event === 'term.exit') {
      term?.write(`\r\n[Terminal selesai, exit code ${ev.data.exitCode}]\r\n`);
      sessionId = null;
      setStatus('Terminal tertutup. Klik New untuk membuka lagi.');
    }
  });

  $('termNew').addEventListener('click', async () => {
    await killSession();
    sessionId = null;
    term?.reset();
    await startSession();
  });
  $('termKill').addEventListener('click', () => { killSession(); });
  $('termClear').addEventListener('click', () => term?.clear());
}
