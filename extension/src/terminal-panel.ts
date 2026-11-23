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
let confirmed = false;
let confirmOverlay: HTMLElement | null = null;

function setStatus(text: string): void {
  $('termStatus').textContent = text;
}

// VS Code Dark+ / Light+ integrated terminal palettes (terminal.* / terminal.ansi* colors).
const DARK_TERMINAL = {
  background: '#1e1e1e', foreground: '#cccccc', cursor: '#aeafad', cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};
const LIGHT_TERMINAL = {
  background: '#ffffff', foreground: '#333333', cursor: '#000000', cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
  brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
};
const terminalTheme = () => (document.documentElement.dataset.theme === 'light' ? LIGHT_TERMINAL : DARK_TERMINAL);

function dismissConfirmation(): void {
  confirmOverlay?.remove();
  confirmOverlay = null;
}

function requireConfirmation(onConfirm: () => void): void {
  dismissConfirmation();
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);border:1px solid var(--vscode-panel-border,#444);border-radius:6px;max-width:420px;padding:16px;font:13px sans-serif';
  const title = document.createElement('div');
  title.textContent = 'Konfirmasi terminal / Terminal confirmation';
  title.style.cssText = 'font-weight:600;margin-bottom:8px';
  const body = document.createElement('div');
  body.textContent = 'Terminal membuka shell Anda dengan hak akses penuh di workspace aktif. Hanya Anda yang dapat memulai atau mengetik di terminal ini; agen tidak memakai terminal ini. Lanjutkan?';
  body.style.cssText = 'line-height:1.5;margin-bottom:12px';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  const cancel = document.createElement('button');
  cancel.textContent = 'Batal';
  const accept = document.createElement('button');
  accept.textContent = 'Mulai terminal';
  cancel.addEventListener('click', () => { dismissConfirmation(); setStatus('Terminal dibatalkan.'); });
  accept.addEventListener('click', () => {
    dismissConfirmation();
    confirmed = true;
    onConfirm();
  });
  actions.append(cancel, accept);
  card.append(title, body, actions);
  overlay.append(card);
  document.body.append(overlay);
  confirmOverlay = overlay;
  accept.focus();
}

function ensureXterm(): Terminal {
  if (term) return term;
  term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    lineHeight: 1.15,
    fontFamily: "Consolas, 'Courier New', monospace",
    theme: terminalTheme(),
    scrollback: 5000,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('termView'));
  term.onData((data) => {
    if (!sessionId || !confirmed) return;
    bridge.call('term.input', { sessionId, data }).catch((err) => setStatus('Gagal kirim: ' + (err?.message || err)));
  });
  term.onResize(({ cols, rows }) => {
    if (sessionId) bridge.call('term.resize', { sessionId, cols, rows }).catch(() => {});
  });
  new ResizeObserver(() => fitNow()).observe($('termView'));
  // Follow the panel theme (Settings or the OS) like VS Code's terminal does.
  new MutationObserver(() => { if (term) term.options.theme = terminalTheme(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
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
  if (!confirmed) {
    requireConfirmation(() => { void startSession(); });
    return;
  }
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
      confirmed = false;
      setStatus('Terminal tertutup. Klik New untuk membuka lagi.');
    }
  });

  $('termNew').addEventListener('click', async () => {
    await killSession();
    sessionId = null;
    confirmed = false;
    term?.reset();
    await startSession();
  });
  $('termKill').addEventListener('click', () => { killSession(); });
  $('termClear').addEventListener('click', () => term?.clear());
}
