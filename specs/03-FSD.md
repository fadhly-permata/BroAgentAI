# FSD â€” BroAgentAI (Standalone + Own Bridge)

## 1. Prinsip
- Produk ini HANYA terdiri dari 2 komponen buatan sendiri:
  1. **BroAgentAI Extension** (Chrome/Edge, MV3)
  2. **BroAgentAI Bridge** (aplikasi desktop Go, 1 file .exe)
- TIDAK ada dependency ke: editor atau aplikasi eksternal apa pun, Git CLI sistem, Python, Node runtime, atau aplikasi pihak ketiga lainnya.
- Jika sebuah fitur butuh sesuatu di luar 2 komponen di atas, fitur itu TIDAK boleh dibangun dengan cara itu.

## 2. Arsitektur

```
Halaman Chat Asli (DeepSeek/Gemini/dll)
  | user mengetik perintah (bahasa natural)
  v
BroAgentAI Extension (MV3 Side Panel)
  - Explorer / Search / SCM / Terminal / Agent / Settings
  - Approval Card (Allow once / Allow session / Deny)
  - Deteksi perintah dari halaman chat (content script, read-only DOM)
  | WebSocket ws://127.0.0.1:<port> + token (localhost only)
  v
BroAgentAI Bridge (Go, single .exe, tray icon)
  - WebSocket server localhost
  - PTY terminal Windows (ConPTY)
  - Git via library Go (go-git) â€” TIDAK memanggil git.exe sistem
  - File System â€” hanya workspace yang di-allowlist
  - Auth: token random, disimpan di %APPDATA%/BroAgentAI/token.txt
  v
Folder Project User (filesystem Windows asli)
```

## 3. Komponen

### 3.1 Extension (`extension/`)
- Manifest V3, Side Panel only. Tidak ada popup chat.
- Side Panel TIDAK punya input chat dan TIDAK punya provider selector.
  Chat terjadi di halaman chat asli. Panel hanya: monitor + approval + log + editor/SCM/terminal.
- Tabs: Explorer, Search, SCM, Terminal, Agent, Settings.
- Semua aksi Write/Execute/Delete HARUS lewat approval kecuali mode Auto + allowlist.
- Jika Bridge offline: panel tampilkan banner "Bridge offline â€” jalankan BroAgentAI-Bridge.exe" + tombol Retry. Semua tombol aksi disabled, TIDAK ada mode demo yang pura-pura sukses.

### 3.2 Bridge (`bridge/`)
- Bahasa: Go. Output: 1 file `BroAgentAI-Bridge.exe`.
- Tanpa installer, tanpa runtime tambahan. Double-click -> tray icon -> jalan.
- Port: default 18741, fallback scan 18741-18760 jika bentrok. Port aktif ditulis ke `%APPDATA%/BroAgentAI/port.txt` agar extension bisa menemukan.
- Hanya bind 127.0.0.1. Tolak koneksi non-localhost.
- Setiap pesan WebSocket wajib sertakan `token`. Token salah -> close.
- Workspace allowlist: disimpan di `%APPDATA%/BroAgentAI/workspaces.json`. Bridge menolak path di luar allowlist.
- Log: `%APPDATA%/BroAgentAI/bridge.log` (rotasi sederhana).

### 3.3 Protocol WebSocket (JSON)
Request: `{ id, token, type, payload }`
Response: `{ id, ok, result?, error? }`
Event (bridge -> extension): `{ event, payload }` untuk terminal output, file watcher, git status berubah.

Types v1:
- `ping` -> `{ pong: true, version }`
- `fs.list { path }`, `fs.read { path }`, `fs.write { path, content }`, `fs.mkdir`, `fs.rename`, `fs.delete`
- `git.status { cwd }`, `git.diff { cwd, file? }`, `git.stage { cwd, files[] }`, `git.unstage`, `git.commit { cwd, message }`, `git.branch { cwd }`, `git.checkout { cwd, branch }`, `git.log { cwd, limit }`, `git.push { cwd, remote?, branch? }`, `git.pull`, `git.fetch`, `git.clone { url, dest }`
- `term.create { cwd }` -> `{ sessionId }`, `term.input { sessionId, data }`, `term.resize`, `term.close`
- `chat.command { text, source }` â€” dicatat di log + diteruskan ke approval (tidak dieksekusi langsung).

## 4. Keamanan
- Localhost only, token auth, workspace allowlist.
- Approval: setiap `fs.write/delete`, `git.commit/push`, `term.input` yang dikirim dari chat HARUS approval. Aksi manual user di panel (klik tombol sendiri) tidak butuh approval kedua.
- Mode Agent: `ask` (default) | `auto` (hanya allowlist tool + workspace, bisa dimatikan kapan saja).
- Bridge TIDAK pernah mengirim file/token user ke internet. Push Git hanya ke remote yang user set di Settings, dengan credential yang user isi.

## 5. SCM = Git Asli
- Format `.git` standar (via go-git). Repo bisa dibuka di Git CLI manapun.
- SCM UI dan Terminal memakai sumber yang sama (repo di disk).
- Tidak ada Git pura-pura, tidak ada snapshot lokal sebagai pengganti Git.

## 6. Terminal = PTY Asli
- Terminal di panel adalah PTY Windows asli (ConPTY) via Bridge.
- Mendukung perintah apapun yang bisa jalan di cmd/PowerShell user, termasuk `git`, `npm`, `dir`.
- Output streaming via event `term.output`.

## 7. Yang DILARANG
- Dilarang memanggil editor lain, aplikasi pihak ketiga, atau aplikasi apa pun di luar 2 komponen ini.
- Dilarang memanggil `git.exe`, `code`, atau binary sistem dari extension.
- Dilarang mode demo yang menampilkan hasil palsu sebagai hasil nyata.
- Dilarang menyimpan token/credential di repo.

## 8. Milestone
- M1: Bridge skeleton (WS + auth + ping + tray) + extension deteksi bridge (online/offline).
- M2: fs.* + Explorer/Editor end-to-end lewat Bridge.
- M3: git.* + SCM end-to-end.
- M4: term.* + Terminal tab end-to-end.
- M5: chat.command + approval + log end-to-end.
- M6: Playwright E2E (extension + bridge test fixture) â€” setiap perubahan UI wajib screenshot + cek console error.
