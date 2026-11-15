// Terminal Panel: term.create/input via Bridge. Output streaming lewat WS event term.output.
import { bridge } from './bridge-client.js';

let sessionId = '';

export async function initTerminal(outEl: HTMLElement, inputEl: HTMLInputElement, cwd: string) {
  try {
    const r: any = await bridge.call('term.create', { cwd });
    sessionId = r.sessionId;
    outEl.textContent = `Terminal ${sessionId} terhubung. Ketik perintah lalu Enter.\n`;
  } catch (e: any) {
    outEl.textContent = `Gagal buka terminal: ${e.message}`;
    return;
  }
  bridge.onEvent((ev: any) => {
    if (ev.event === 'term.output' && ev.payload?.sessionId === sessionId) {
      outEl.textContent += ev.payload.data;
      outEl.scrollTop = outEl.scrollHeight;
    }
    if (ev.event === 'term.exit' && ev.payload?.sessionId === sessionId) {
      outEl.textContent += '\n[Terminal tertutup]\n';
    }
  });
  inputEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const cmd = inputEl.value;
    inputEl.value = '';
    outEl.textContent += `> ${cmd}\n`;
    try { await bridge.call('term.input', { sessionId, data: cmd + '\r\n' }); }
    catch (err: any) { outEl.textContent += `Gagal kirim: ${err.message}\n`; }
  });
}
