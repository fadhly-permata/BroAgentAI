# Installer BroAgentAI

Installer menyiapkan Node.js 22.6+ (portable copy bila perlu), `npm ci`, build, lalu mendaftarkan native messaging host `com.broagentai.host` untuk browser yang dipilih. Semua registrasi bersifat per-user; tidak ada instalasi system-wide dan tidak perlu hak admin.

## GUI

Cara paling singkat di semua OS:

```sh
node scripts/install-gui.mjs
```

`scripts/install-gui.mjs` adalah dispatcher lintas platform. Ia memilih wrapper GUI sesuai OS, meneruskan argumen, dan memakai `process.execPath` untuk memastikan child process melihat Node.js yang sama dengan yang menjalankan dispatcher. Bila wrapper GUI tidak ada, gagal dimulai, atau tidak ada tampilan/GUI tool, dispatcher jatuh ke installer konsol (`install.ps1` / `install.sh`). `--gui` memaksa wrapper GUI, `--cli` memaksa installer konsol. Exit code diteruskan apa adanya; `3` dari wrapper berarti "GUI tidak usable" dan memicu fallback.

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File install-gui.ps1
powershell -ExecutionPolicy Bypass -File install-gui.ps1 -Browser chrome,firefox
```

Wizard WinForms berisi checkbox browser (Chrome, Edge, Brave, Chromium, Firefox), tombol **Install**, **Uninstall** dan **Cancel**, progress bar serta kotak output yang menampilkan stdout/stderr dari `install.ps1`. Default checkbox: Chrome dan Edge; `-Browser` mengisi pilihan awal. Tombol dinonaktifkan saat installer berjalan, **Cancel** menghentikan child process. Tidak ada permintaan UAC atau `Run as Administrator`: `install.ps1` menulis ke `HKCU` dan `.runtime/` di folder repo.

### Linux dan macOS

```sh
bash install-gui.sh
bash install-gui.sh --browser chrome,firefox
bash install-gui.sh --uninstall
```

Urutan pemilihan browser:

1. `zenity --checklist` bila tersedia (dan `DISPLAY`/`WAYLAND_DISPLAY` ada).
2. `osascript` dialog `choose from list` pada macOS bila zenity tidak ada.
3. Fallback terminal: daftar browser diminta di `/dev/tty`; bila tidak ada TTY, pakai `chrome`.

Wrapper selalu memanggil `install.sh --yes`, meneruskan mode uninstall, `--rebuild` dan `--portable-node` bila diberikan, dan menduplikasi browser yang dipilih sebagai `--browser <nama>` repeated. Pilihan yang tidak dikenal dibuang; bila tidak ada yang tersisa, `chrome` dipakai.

## CLI

| OS | Perintah |
| --- | --- |
| Windows | `powershell -ExecutionPolicy Bypass -File install.ps1` atau double-click `install.bat` |
| Linux / macOS | `bash install.sh` |

Opsi yang sama di kedua dunia:

| Opsi Windows | Opsi POSIX | Fungsi |
| --- | --- | --- |
| `-Browser chrome,firefox` | `--browser chrome,firefox` | Daftarkan hanya browser tersebut. |
| `-Rebuild` | `--rebuild` | Build ulang extension dan bridge. |
| `-PortableNode` | `--portable-node` | Pakai Node.js portable walau ada Node di PATH. |
| `-Uninstall` | `--uninstall` | Hapus registrasi native host. |
| - | `--yes` | Jawab ya otomatis untuk prompt (misalnya install build tools). |
| `-h` | `-h`, `--help` | Tampilkan usage. |

Nilai browser yang dikenal: `chrome`, `chromium`, `edge`, `brave`, `firefox`. Tanpa `--browser`, installer mendeteksi browser yang terpasang; bila tidak ada, Chrome dipakai sebagai default. Untuk Firefox, lihat [docs/firefox.md](firefox.md): host didaftarkan dengan `allowed_extensions: ["broagentai@local"]`.

## Update

Tidak ada auto-update silent: setiap update memakai konfirmasi atau flag eksplisit. Alur update yang didukung:

1. `node scripts/update.mjs --check-only` untuk mengecek rilis terbaru, lalu `node scripts/update.mjs --yes` untuk mengunduh bundle per-platform, memverifikasi `SHA256SUMS.txt`, mengganti file, dan mendaftarkan ulang native host untuk browser yang sudah terdaftar. Tanpa `--yes`, updater bertanya dulu di terminal. Setelah update, reload extension di browser.
2. Atau tarik kode/zip versi baru, verifikasi checksum (`sha256sum -c SHA256SUMS.txt`), lalu jalankan ulang installer dengan `-Rebuild` / `--rebuild` dari folder bundle.
3. Reload extension (tombol Reload pada kartu di `chrome://extensions`, `edge://extensions`, `brave://extensions`; untuk Firefox, reload temporary add-on di `about:debugging`). `--rebuild` / `-Rebuild` juga dipakai setelah `git pull` bila `extension/dist` atau `bridge/dist` tidak ikut ter-update.

`scripts/release.mjs` menghasilkan bundle per-platform beserta checksum yang dipakai updater di atas. Plugin web chat tidak punya auto-update; setiap update lewat review yang sama seperti instal baru (lihat `specs/09-WEBCHAT-PLUGINS.md`).

## Uninstall

```sh
bash install.sh --uninstall --browser chrome,firefox
```

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall -Browser chrome,firefox
```

GUI memakai tombol **Uninstall**. Perintah ini hanya menghapus manifest/registry key native host per browser. File di `.runtime/node`, `node_modules`, `extension/dist` dan `bridge/dist` tidak dihapus; hapus folder `.runtime` manual bila Node.js portable tidak dipakai lagi. launcher `bridge/broagentai-host.*` tetap dipertahankan selama browser lain masih menggunakannya.

## Perilaku per OS

| Aspek | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Installer konsol | `install.ps1` (via `install.bat`) | `install.sh` | `install.sh` |
| Wrapper GUI | `install-gui.ps1` (WinForms) | `install-gui.sh` + zenity | `install-gui.sh` + zenity atau osascript |
| Node.js portable | `node-v*-win-<arch>.zip` dari nodejs.org, SHA-256 dicek, ke `.runtime/node` | `node-v*-linux-<arch>.tar.gz` (butuh glibc 2.28+; Alpine/musl tidak didukung) | `node-v*-darwin-<arch>.tar.gz` (x64/arm64) |
| Build tools | node-pty sudah punya biner Windows | gcc/g++, make, python3; installer menawarkan perintah apt/dnf/yum/pacman/zypper/apk dengan `sudo` | Xcode Command Line Tools via `xcode-select --install` (tanpa `sudo`); jalankan ulang installer setelah selesai |
| Registrasi host | HKCU per browser | `~/.config/<browser>/NativeMessagingHosts` (Firefox: `~/.mozilla/native-messaging-hosts`) | `~/Library/Application Support/<browser>/NativeMessagingHosts` (Firefox: `.../Mozilla/NativeMessagingHosts`) |
| Deteksi browser | profil di `%LOCALAPPDATA%` | `$XDG_CONFIG_HOME` / `~/.config` dan command di PATH | profil di `~/Library/Application Support` dan app bundle di `/Applications` |
| Catatan | tidak perlu admin | browser Snap/Flatpak tidak didukung; pakai paket .deb/.rpm resmi | zenity butuh X11/Wayland; kalau tidak ada, osascript dipakai |

Ketika build tools belum lengkap, `npm ci --ignore-scripts` dipakai agar instal tidak gagal; tab Terminal baru tersedia setelah node-pty berhasil di-compile dan installer dijalankan ulang.

## Signer requirements untuk distributable bertanda tangan

Installer yang ada adalah script (.ps1/.sh), bukan binary `.exe`, `.msi`, `.pkg` atau `.dmg` yang ditandatangani. Penandatanganan dan notarisasi **belum** diimplementasikan; tidak ada secret, sertifikat atau akun developer di repo ini, dan release otomatis tidak mengklaim signed/notarized.

Bila distributable bertanda tangan mau dibuat, yang dibutuhkan:

- macOS: Apple Developer ID Application certificate, bundle id yang konsisten, dan notarisasi via `xcodebuild notarize`/`notarytool` dengan `APPLE_ID`, `APPLE_TEAM_ID` serta app-specific password yang disimpan sebagai CI secret. Hasilnya `.pkg`/`.dmg` yang di-staple; gatekeeper tidak akan mengabaikan script installer yang tidak ditandatangani.
- Windows: code-signing certificate (OV/EV, EV lebih aman untuk SmartScreen) dan `signtool sign` pada `.exe`/`.msi` installer hasil pembungkus script. Private key dan password harus berada di secret store CI/HSM, bukan di repo.
- Keduanya: checksum publik (`SHA256SUMS.txt`), artefak release yang tidak berubah setelah ditandatangani, dan verifikasi tanda tangan pada mesin bersih sebelum publish.

Sampai semua itu dikonfigurasi dengan secret yang valid, docs, roadmap, dan release notes tidak boleh menyatakan build signed/notarized.
