// Git Panel: status + commit lewat Bridge (go-git). Tanpa git.exe.
import { bridge } from './bridge-client.js';

export async function renderGit(rootEl: HTMLElement, cwd: string) {
  rootEl.innerHTML = '<div>Memuat status git...</div>';
  try {
    const st: any = await bridge.call('git.status', { cwd });
    const files = (st.files || []).map((f: any) => `<label><input type="checkbox" data-file="${f.file}" checked> ${f.file} [${f.status}]</label>`).join('<br>');
    rootEl.innerHTML = `<div>Branch: <b>${st.branch || '(belum ada commit)'}</b></div><div>${files || 'Working tree bersih.'}</div><input id="ba-commit-msg" placeholder="Pesan commit..." style="width:100%;margin-top:8px"><button id="ba-commit-btn">Commit yang dipilih</button><div id="ba-git-status"></div>`;
    document.getElementById('ba-commit-btn')?.addEventListener('click', async () => {
      const msg = (document.getElementById('ba-commit-msg') as HTMLInputElement).value.trim();
      const statusEl = document.getElementById('ba-git-status')!;
      if (!msg) { statusEl.textContent = 'Pesan commit tidak boleh kosong.'; return; }
      const checked = [...rootEl.querySelectorAll('input[type=checkbox]:checked')].map((el: any) => el.dataset.file);
      try {
        await bridge.call('git.stage', { cwd, files: checked });
        const r: any = await bridge.call('git.commit', { cwd, message: msg });
        statusEl.textContent = `Commit berhasil: ${r.hash}`;
        renderGit(rootEl, cwd);
      } catch (e: any) { statusEl.textContent = `Gagal commit: ${e.message}`; }
    });
  } catch (e: any) {
    rootEl.innerHTML = `<div>Git belum tersedia: ${e.message}. Jika folder ini belum repo, buat repo dulu dari Bridge (git.init menyusul di M3b) atau buka folder yang sudah punya .git.</div>`;
  }
}
