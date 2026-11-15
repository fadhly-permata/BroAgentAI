// Editor: baca + simpan file lewat Bridge. Simpan gagal = jangan anggap berhasil.
import { bridge } from './bridge-client.js';

let currentPath = '';
let dirty = false;

export async function openFile(path: string, textarea: HTMLTextAreaElement, statusEl: HTMLElement) {
  currentPath = path;
  dirty = false;
  try {
    const res: any = await bridge.call('fs.read', { path });
    textarea.value = res.content ?? '';
    statusEl.textContent = `Membuka: ${path}`;
  } catch (e: any) {
    statusEl.textContent = `Gagal membuka ${path}: ${e.message}`;
  }
}
export function markDirty(statusEl: HTMLElement) {
  dirty = true;
  statusEl.textContent = `${currentPath} - belum disimpan`;
}
export async function saveFile(textarea: HTMLTextAreaElement, statusEl: HTMLElement) {
  if (!currentPath) { statusEl.textContent = 'Tidak ada file yang dibuka.'; return; }
  statusEl.textContent = 'Menyimpan...';
  try {
    await bridge.call('fs.write', { path: currentPath, content: textarea.value });
    dirty = false;
    statusEl.textContent = `Tersimpan: ${currentPath}`;
  } catch (e: any) {
    statusEl.textContent = `GAGAL menyimpan: ${e.message} - file di disk TIDAK berubah.`;
  }
}
export function isDirty() { return dirty; }
