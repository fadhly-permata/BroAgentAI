# FSD — BroAgentAI (Standalone + Own Bridge)

## 1. Prinsip
- Produk ini HANYA terdiri dari 2 komponen buatan sendiri:
  1. **BroAgentAI Extension** (Chrome/Edge, MV3)
  2. **BroAgentAI Bridge** (`broagentai-bridge`: native-messaging host Node.js, id `com.broagentai.host`)
- TIDAK ada dependency ke editor atau aplikasi eksternal apa pun.
- Prasyarat di mesin user: Node.js (menjalankan bridge) dan, untuk fitur SCM, Git CLI. Jika Git tidak terpasang, SCM menampilkan status yang jelas; fitur lain tetap jalan.
- Jika sebuah fitur butuh sesuatu di luar itu, fitur itu TIDAK boleh dibangun dengan cara itu.

## 2. Arsitektur

```
Halaman Chat Asli (DeepSeek/Gemini/dll)
  | user mengetik perintah (bahasa natural)
  v
BroAgentAI Extension (MV3 Side Panel)
  - Explorer / Search / SCM / Terminal / Agent / Settings
  - Approval Card (Allow once / Allow session / Deny)
  - Deteksi perintah dari halaman chat (content script, read-only DOM)
  | Native Messaging (chrome.runtime.connectNative, stdio, frame 4-byte length + JSON)
  v
BroAgentAI Bridge (Node.js, dijalankan browser lewat launcher)
  - RPC router (system.*, workspace.*, fs.*, git.*, config/instructions/skills)
  - File System — hanya di dalam workspace aktif, symlink escape ditolak
  - Git — memanggil Git CLI sistem dari bridge (bukan dari extension)
  - Akses dibatasi `allowed_origins` di manifest host (hanya extension ini)
  v
Folder Project User (filesystem asli)
```

## 3. Komponen

### 3.1 Extension (`extension/`)
- Manifest V3, Side Panel only. Tidak ada popup chat.
- Side Panel TIDAK punya input chat dan TIDAK punya provider selector.
  Chat terjadi di halaman chat asli. Panel hanya: monitor + approval + log + editor/SCM/terminal.
- Tabs: Explorer, Search, SCM, Terminal, Agent, Settings.
- Semua aksi Write/Execute/Delete HARUS lewat approval kecuali mode Auto + allowlist.
- Jika Bridge offline: panel tampilkan banner "Companion not running" + tombol Restart/Setup. TIDAK ada mode demo yang pura-pura sukses.

### 3.2 Bridge (`bridge/`)
- Bahasa: TypeScript (Node.js >= 22.6). Output build: `bridge/dist/index.js`.
- Dijalankan oleh browser sebagai native-messaging host; tidak ada port jaringan, tidak ada token.
- Install dev: `npm run host:install:dev` (atau `install.bat`). Menulis launcher `bridge/broagentai-host.cmd` (di luar `dist`, karena build membersihkan `dist`), manifest host, dan registry key HKCU di Windows.
- stdout hanya untuk frame Native Messaging; semua log ke stderr.
- Config dan daftar workspace: `~/.broagentai/` (override: `BROAGENTAI_CONFIG_DIR`).

### 3.3 Protocol RPC (JSON di atas Native Messaging)
Request: `{ id, method, params? }`
Response: `{ id, result? }` atau `{ id, error: { code, message, data? } }`
Event (bridge -> extension): `{ event, data? }`.

Method v1:
- `system.ping`, `system.info`
- `workspace.list|add|remove|rename|setActive|validate|settings|setIgnore|openFolderDialog|trust|untrust`
- `fs.listDir|listTree|stat|readFile|readFileLines|writeFile|searchFiles|createFile|mkdir|rename|delete`
- `git.status`, `git.diff { path, staged? }`, `git.stage { paths[] }`, `git.unstage { paths[] }`, `git.discard { paths[] }`, `git.commit { message }`, `git.branches`, `git.createBranch { name }`, `git.checkout { branch }`, `git.init`
- `git.fetch`, `git.pull { mode: ff-only|merge|rebase }`, `git.push` (tanpa force), `git.abort`, `git.testRemote`
- `term.create|input|resize|close|list` + event `term.output`, `term.exit`
- `mcp.servers|tools|start|stop|restart|callTool` + event `mcp.status`
- `tools.list`, `agent.prompt`, `agent.check`, `agent.callTool`

Semua method `fs.*` dan `git.*` bekerja pada workspace aktif; path selalu relatif terhadap root workspace.

## 4. Keamanan
- Hanya extension dengan origin terdaftar yang bisa menjalankan bridge.
- Semua path dikurung di workspace aktif (realpath, anti symlink escape).
- Approval: setiap `fs.write/delete`, `git.commit/push`, `term.input` yang dikirim dari chat HARUS approval. Aksi manual user di panel (klik tombol sendiri) tidak butuh approval kedua.
- Mode Agent: `read-only` | `ask` (default) | `auto-edit` | `full-auto`. Tabel keputusan ada di bridge (`agent.ts`) dan ditegakkan di sana: `agent.callTool` menolak yang dilarang mode, dan yang butuh approval kecuali panel menyatakan user sudah menyetujui. Push/pull dan tool MCP destruktif selalu minta approval.
- Loop agent berjalan di side panel, bukan service worker: menutup panel menghentikan loop, jadi tidak ada tool yang jalan tanpa UI approval terbuka.
- Terminal (PTY) bukan tool agent; hanya user yang mengetik di tab Terminal.
- MCP: server dari file project tidak bisa start sebelum user Review & trust; trust terikat hash command/URL/cwd/nama env+header, jadi perubahan config mencabutnya.
- Provider chat adalah data (`extension/src/providers/<id>/provider.json`: pola URL + selector). Content script hanya mengetik prompt dan melaporkan balasan; tidak punya akses file/Git/MCP.
- Bridge TIDAK pernah mengirim file/token user ke internet. Git dijalankan dengan `GIT_TERMINAL_PROMPT=0` sehingga tidak pernah menggantung menunggu kredensial.

## 5. SCM = Git Asli
- Bridge memanggil Git CLI sistem (`git status --porcelain=v2`, `git diff`, dst.), jadi hooks, config, dan credential helper user berlaku apa adanya.
- Workspace dianggap repo hanya jika root workspace = root repo. Workspace di dalam repo induk ditampilkan sebagai "bukan repo" agar aksi tidak menyentuh file di luar workspace.
- `git.discard` butuh konfirmasi di UI dan tidak boleh menarget root workspace.
- `git.checkout` ditolak bila ada perubahan tracked yang belum di-commit.
- SCM UI dan Terminal memakai sumber yang sama (repo di disk).
- Tidak ada Git pura-pura, tidak ada snapshot lokal sebagai pengganti Git.

## 6. Terminal = PTY Asli
- Terminal di panel adalah PTY asli (node-pty, ConPTY di Windows) via Bridge, dirender dengan xterm.js.
- Mendukung perintah apapun yang bisa jalan di shell user, termasuk `git`, `npm`, `dir`.
- Output streaming via event `term.output`.

## 7. Yang DILARANG
- Dilarang memanggil editor lain atau aplikasi pihak ketiga.
- Dilarang memanggil `git`, `code`, atau binary sistem apa pun dari extension. Hanya bridge yang boleh menjalankan Git CLI.
- Dilarang mode demo yang menampilkan hasil palsu sebagai hasil nyata. Panel yang belum terhubung wajib diberi label "Demo".
- Dilarang menyimpan token/credential di repo.

## 8. Milestone
- M1: Bridge skeleton (native messaging + ping) + extension deteksi bridge (online/offline). — selesai
- M2: fs.* + Explorer/Editor/Search end-to-end lewat Bridge. — selesai
- M3: git.* + SCM end-to-end, termasuk remote (fetch/pull/push/abort). — selesai
- M4: term.* + Terminal tab end-to-end. — selesai
- M5: relay chat + approval + log end-to-end. — selesai di halaman chat tiruan; selector DeepSeek sudah diverifikasi di situs asli; Gemini/Qwen masih experimental.
- M7/M8: MCP stdio + Streamable HTTP/SSE, trust, katalog tool. — selesai
- M6: Playwright E2E (extension + bridge asli) — setiap perubahan UI wajib screenshot + cek console error. — berjalan (`npm run e2e`)
