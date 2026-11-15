# BroAgentAI Bridge (Go)

Aplikasi desktop kita sendiri. 1 file .exe, tanpa dependency lain.

## Build (Windows)
```
cd bridge
go mod tidy
go build -o BroAgentAI-Bridge.exe .
```

## Jalankan
Double-click `BroAgentAI-Bridge.exe`. Cek tray + file `%APPDATA%/BroAgentAI/port.txt`.

## Pairing pertama
1. Buka `%APPDATA%/BroAgentAI/token.txt`, salin token.
2. Di Extension > Settings > Bridge, paste token + klik Connect.
3. Tambahkan workspace di `%APPDATA%/BroAgentAI/workspaces.json`, contoh:
```json
["D:\\Projects\\toko-saya"]
```
4. Restart bridge.

## Status
- M1: ping + fs.list/read/write/mkdir/delete + auth + allowlist â€” DONE (skeleton)
- M2: fs end-to-end â€” perlu extension Explorer (berikutnya)
- M3: git.status/log/stage/commit â€” DONE (skeleton, diff detail menyusul)
- M4: term.create/input/close via cmd.exe pipes â€” DONE (skeleton, ConPTY menyusul)
