# BroAgentAI - Granular Backlog

Dokumen ini memecah roadmap (`06-ROADMAP.md`) menjadi tugas-tugas kecil yang dapat dikerjakan secara inkremental. Centang [x] saat tugas selesai, lulus typecheck, dan teruji.

## Cara Kerja
1. Pilih 1-2 tugas dari fase aktif (saat ini: Fase 0).
2. Kerjakan, jalankan `npm run typecheck` dan `npm run test`.
3. Centang tugas dan commit perubahan.
4. Ulangi.

---

## Fase 0: Foundation & Plumbing (M0) - Fokus Saat Ini
Target: Panel terbuka, host terhubung, workspace list berfungsi, provider manifest generator berjalan.

### 0.1. Inisialisasi & Struktur Proyek
- [x] 0.1.1. Pastikan `package.json` root memiliki workspaces: `["shared", "extension", "bridge"]`.
- [x] 0.1.2. Buat folder dasar: `shared/src`, `extension/src`, `bridge/src`.
- [x] 0.1.3. Setup `tsconfig.base.json` di root dan `tsconfig.json` di masing-masing workspace.
- [x] 0.1.4. Pastikan `npm install` dan `npm run typecheck` berjalan tanpa error di root.

### 0.2. Shared Protocol & Types
- [x] 0.2.1. Buat `shared/src/protocol.ts` (definisi tipe dasar: Envelope, ErrorCode, RiskClass).
- [x] 0.2.2. Tambahkan tipe Config, MCP, dan Provider ke `protocol.ts`.
- [x] 0.2.3. Export semua tipe dari `shared/src/index.ts`.

### 0.3. Native Host (Bridge) - Core
- [x] 0.3.1. Setup `bridge/package.json` dengan script `build` (esbuild/tsup) dan `start`.
- [x] 0.3.2. Implementasi `bridge/src/frames.ts` (pembaca/penulis framing untuk Native Messaging).
- [x] 0.3.3. Implementasi `bridge/src/logger.ts` untuk logging yang aman (no sensitive data).
- [x] 0.3.4. Buat handler `system.ping` dan `system.info` di bridge.
- [x] 0.3.5. Buat script `scripts/native-host.mjs` untuk `install` dan `uninstall` dev registry.

### 0.4. Extension (MV3) - Core
- [x] 0.4.1. Setup `extension/package.json` dengan Vite + CRXJS.
- [x] 0.4.2. Buat `extension/manifest.json` dengan `side_panel`, `nativeMessaging`, `storage`.
- [x] 0.4.3. Implementasi koneksi dari Service Worker ke Native Host (ping/pong).
- [x] 0.4.4. Buat UI panel dasar (React + Vite): Header, Status Bar (Offline/Ready/Error).

### 0.5. Workspace Management
- [x] 0.5.1. Implementasi `workspace.list`, `workspace.add`, `workspace.remove` di Bridge.
- [x] 0.5.2. Simpan daftar workspace di host config file (`~/.broagentai/config.json`).
- [x] 0.5.3. Tampilkan daftar workspace (recent) di Side Panel UI.
- [x] 0.5.4. Tambahkan validasi path (cek apakah folder valid, hindari duplikat).

### 0.6. Provider Extensibility (M0 Exit Criteria)
- [x] 0.6.1. Buat struktur folder `extension/src/providers/` dengan 1 fixture plugin (misal: `dummy-provider`).
- [x] 0.6.2. Buat script generator yang memindai folder provider dan menyuntikkan host permissions ke manifest.
- [x] 0.6.3. Verifikasi: Menambah folder fixture mengubah manifest tanpa mengedit core code.

---

## Fase 1: Workspace, Config & Filesystem (M1)
Target: Konfigurasi dimuat, resource (AGENTS.md, rules) ditemukan, filesystem tree dapat dibaca dengan aman.

### 1.1. Filesystem Operations (Bridge)
- [x] 1.1.1. Implementasi `fs.listDir` dan `fs.listTree` dengan batasan depth.
- [x] 1.1.2. Implementasi `fs.stat` dan `fs.readFile` dengan batasan ukuran (cap).
- [x] 1.1.3. Tambahkan deteksi file biner dan pencegahan path escape (`../`, symlink).
- [x] 1.1.4. Tambahkan aturan ignore default (`.git`, `node_modules`, `dist`).

### 1.2. Configuration & Resources
- [x] 1.2.1. Buat parser JSONC untuk `broagentai.jsonc`.
- [x] 1.2.2. Implementasi logika merge config: Global < Project < Local.
- [x] 1.2.3. Buat resource loader untuk menemukan `AGENTS.md`, `rules/`, `skills/`.
- [x] 1.2.4. Buat RPC `config.get`, `instructions.list`, `skills.list` di Bridge.

### 1.3. UI Explorer
- [x] 1.3.1. Buat komponen Tree View di Side Panel untuk menampilkan direktori.
- [x] 1.3.2. Implementasi lazy loading (expand/collapse folder memanggil `fs.listDir`).
- [x] 1.3.3. Tambahkan ikon file/folder dan indikator status (ignored, binary).

---

## Fase 2: Editor & Search (M2) - Selesai
- [x] 2.1.1. Setup halaman `editor.html` terpisah dengan CodeMirror 6.
- [x] 2.1.2. Implementasi `read_file_lines` dan tampilan isi file di editor.
- [x] 2.1.3. Implementasi `write_file` dengan deteksi konflik `MTIME_CONFLICT`.
- [x] 2.1.4. Buat UI Search: input query, toggle case/regex, dan tampilan hasil grouped.
- [x] 2.1.5. Ganti stub UI: New File/Folder, context menu (rename, delete, copy path).
- [x] 2.1.6. Ganti stub UI: show ignored checkbox, ignore patterns input.
- [x] 2.1.7. Ganti stub UI: diagnostics, create project config.
- [x] 2.1.8. Ganti stub UI: theme/language/editor settings (localStorage persistence).

---

## Fase 3: SCM (M3 + remote) - Selesai
- [x] 3.1. `git.status` (parser porcelain v2), `git.diff`, stage/unstage/discard, commit, branch, init.
- [x] 3.2. Remote: fetch, pull (ff-only/merge/rebase), push tanpa force, abort, test remote.
- [x] 3.3. Panel SCM nyata + test repo fixture + e2e terhadap bare remote lokal.

## Fase 4: Terminal - Selesai
- [x] 4.1. Kanal event bridge -> extension, request ditangani konkuren.
- [x] 4.2. `term.*` di atas node-pty; tab Terminal dengan xterm.js.

## Fase 5: MCP (M7/M8) - Selesai
- [x] 5.1. Layer config global/project/local, trust store berbasis hash.
- [x] 5.2. Transport stdio + Streamable HTTP (fallback SSE), risk mapping, timeout, cap hasil.
- [x] 5.3. Settings > MCP nyata (review, trust, start/stop/restart, tool browser).

## Fase 6: Agent relay (M5) - Selesai, provider experimental
- [x] 6.1. Katalog tool, tabel approval, `agent.check` / `agent.callTool` / `agent.prompt` di bridge.
- [x] 6.2. Provider sebagai data + manifest digenerate dari `provider.json`; content script relay.
- [x] 6.3. Parser balasan, kartu approval, log aktivitas; e2e di halaman chat tiruan.
- [x] 6.4a. Selector DeepSeek diverifikasi di situs asli (2026-11-17): composer, kirim via Enter, elemen balasan, code block, status tombol idle/generating. Status `ready`.
- [x] 6.4b-qwen. Selector Qwen diverifikasi di situs asli (2026-11-17, login): composer `textarea.message-input-textarea`, kirim via Enter, jawaban `.phase-answer` (kartu thinking tidak ikut), `button.stop-button` saat generating, bubble user. Code block Qwen = Monaco yang hanya menggambar baris di layar, jadi balasan dibaca dari markdown di React props lewat helper MAIN-world (`content/page-source.iife.ts`); fallback baris Monaco.
- [x] 6.4b. Selector + loop penuh Gemini diverifikasi di situs asli lewat Chrome (2026-11-17, login, mode Auto Approve): composer Quill diisi lewat insertText, tombol `.send-button.submit`, ikon `stop` saat generating (selector tanpa aria-label karena ikut bahasa UI), `pre > code`, bubble user; fs.readFile LICENSE + fs.writeFile gemini-check.txt identik byte-per-byte. Temuan: persona kustom di akun Gemini membuat model mengganti ``` dengan penanda `[KONTAINER_KODE]json` sehingga tidak ada code block (bukan perilaku bawaan Gemini); parser kini juga membaca objek JSON yang berdiri di baris sendiri, untuk balasan tanpa fence seperti itu; kartu saran (`elicitations`) dan label code block dibuang dari teks lewat selector `exclude`; label screen-reader "You said" (`.cdk-visually-hidden`) diabaikan saat menandai pesan agent. Status `ready`.
- [x] 6.4d. Loop penuh di Qwen asli lewat Chrome (2026-11-17, mode Auto Approve): fs.readFile (ENOENT dikembalikan ke AI), fs.listDir, jawaban final; lalu fs.readFile LICENSE + fs.writeFile qwen-check.txt, hasilnya identik byte-per-byte. Balasan dibaca dari markdown saat DOM hanya berisi label "json". Status `ready`.
- [x] 6.4c. Loop penuh di DeepSeek asli lewat Chrome stable (2026-11-17): prompt pembuka, fs.readFile otomatis, fs.createFile + fs.writeFile dengan approval, jawaban akhir; file tertulis di disk.
- [x] 6.5. Relay tahan terhadap daftar pesan ter-virtualisasi (pakai kunci urutan pesan, bukan jumlah elemen di DOM).
- [x] 6.7. Empat mode approval (read-only, always-ask, ask-once, auto-approve) dan tool `shell.run` yang memilih shell per OS.
  Diverifikasi di DeepSeek asli lewat Chrome (2026-11-17, mode ask-once): approval pertama lalu PowerShell jalan, perintah yang sama tidak ditanya lagi, perintah berbeda ditanya dan Deny dikembalikan ke AI.
- [ ] 6.6. Gemini/Qwen: cari kunci urutan pesan yang setara sebelum status dinaikkan dari experimental.

## Fase 7: E2E
- [x] 7.1. `npm run e2e`: panel + bridge asli, dan lewat native messaging Chromium asli.
- [x] 7.2. Native messaging di Chrome stable terverifikasi (host dijalankan Chrome, sesi agent berjalan).

## Fase 8: Advanced Agent Features (Future)
- [ ] 8.1. Cross-Context Session Resume (Opsi B): Menyimpan state sesi (handoff) ke bridge agar bisa di-resume di jendela baru, incognito, atau profil berbeda. Memerlukan mekanisme Session ID, persistensi state yang aman, dan handshake antar konteks ekstensi.

## Fase 9: Web Chat Plugins (rencana, lihat `09-WEBCHAT-PLUGINS.md`)
- [ ] 9.0. Spike P0: buktikan toggle userScripts, `worldId`, field world pengirim pesan, persistensi content script dinamis, CSS lewat `registerContentScripts`, bridge event antar world, `permissions.request` dari side panel.
- [ ] 9.1. P1: format `plugin.json` + validator, registry async, 5 provider jadi plugin bawaan tanpa perubahan perilaku.
- [ ] 9.2. P2: bridge hook + hook bawaan (ChatGPT `readCode`/`findComposer`, DeepSeek `detectError`, Ptero `prepare`), CSS dasar netral + `style.css` per plugin.
- [ ] 9.3. P3: import plugin tanpa rebuild dari folder atau `.zip` (selector + CSS), update dengan diff, izin domain, penanganan konflik domain.
- [ ] 9.3a. Halaman Settings → Plugins (spec §4.6), satu-satunya tempat ngatur plugin (tanpa mode developer): tombol Import + status toggle User Scripts; tiap baris plugin dengan label + saklar on/off; aksi Update, Export `.zip`, Remove, Reset to built-in, Re-grant access, Reload open tabs, Health check; layar review yang sama buat install & update.
- [ ] 9.4. P4: `plugin.js` user lewat `chrome.userScripts`, deteksi toggle, fallback, aturan keamanan plugin custom.
- [ ] 9.5. P5: template plugin, panduan README, e2e isolasi plugin, ADR-020 diterima.

---

## Aturan Pengerjaan
- Validasi Wajib: Jangan lanjut ke tugas berikutnya jika `npm run typecheck` atau `npm run test` gagal.
- Commit Message: Gunakan format konvensional, misal: `feat(bridge): add fs.listDir with path confinement`.
- Scope: Jika sebuah tugas terasa >4 jam, pecah lagi menjadi sub-tugas yang lebih kecil.