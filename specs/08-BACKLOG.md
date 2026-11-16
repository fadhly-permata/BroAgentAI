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

---

## Aturan Pengerjaan
- Validasi Wajib: Jangan lanjut ke tugas berikutnya jika `npm run typecheck` atau `npm run test` gagal.
- Commit Message: Gunakan format konvensional, misal: `feat(bridge): add fs.listDir with path confinement`.
- Scope: Jika sebuah tugas terasa >4 jam, pecah lagi menjadi sub-tugas yang lebih kecil.