// Explorer: daftar file dari Bridge (bukan demo). Gagal = tampilkan error jujur + tombol Retry.
import { bridge } from './bridge-client.js';

export async function renderExplorer(rootEl: HTMLElement, path: string) {
  rootEl.innerHTML = `<div class="ba-loading">Memuat ${path}...</div>`;
  try {
    const files = await bridge.call('fs.list', { path });
    if (!Array.isArray(files) || files.length === 0) {
      rootEl.innerHTML = `<div class="ba-empty">Folder kosong atau tidak ada file.</div>`;
      return;
    }
    rootEl.innerHTML = files.map((f: any) =>
      `<button class="ba-file" data-path="${path}\\${f.name}" data-dir="${f.isDir}">${f.isDir ? '[DIR]' : '[FILE]'} ${f.name}</button>`
    ).join('');
  } catch (e: any) {
    const msg = e.message === 'BRIDGE_OFFLINE'
      ? 'Bridge offline. Jalankan BroAgentAI-Bridge.exe lalu klik Retry.'
      : `Gagal memuat: ${e.message}`;
    rootEl.innerHTML = `<div class="ba-error">${msg}</div><button id="ba-retry">Retry</button>`;
    document.getElementById('ba-retry')?.addEventListener('click', () => renderExplorer(rootEl, path));
  }
}
