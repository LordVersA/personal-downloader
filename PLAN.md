# Personal Downloader — Plan

Desktop app (macOS, Windows, Linux) on top of yt-dlp. Mobile is out of scope.

## Stack
| Part | Choice | License |
|---|---|---|
| Shell | Tauri v2 (Rust) | MIT/Apache-2.0 |
| UI | Vanilla HTML/JS (Svelte only if it grows) | — |
| Downloader | `yt-dlp` standalone binary | Unlicense (binaries: GPLv3+) |
| Media | `ffmpeg` static build | GPL/LGPL |
| JS runtime | `deno` (yt-dlp needs an external JS runtime for full YouTube support) | MIT |
| App updater (delta) | Velopack (`velopack` crate + `vpk` CLI) | MIT |
| Releases / CI | GitHub Releases + GitHub Actions | — |

Tauri's built-in updater has no delta support (full bundle only), so Velopack does packaging + updates.
Output: `Setup.exe` (Windows), `.pkg` (macOS), `.AppImage` (Linux).

## Architecture
```
App (signed, Velopack delta updates)
 ├─ UI (webview) ──invoke──► Rust commands: download / cancel / update_ytdlp
 ├─ resources/bin/  yt-dlp, ffmpeg, deno   (seed copies, put there by CI)
 └─ first run → copied to app data dir:
      macOS   ~/Library/Application Support/<app>/bin
      Windows %APPDATA%\<app>\bin
      Linux   ~/.local/share/<app>/bin
      └─ all downloads use this copy; only this copy gets updated
```
Why the app data dir: modifying files inside a signed macOS `.app` breaks its code signature.

## yt-dlp updater
- Use `yt-dlp -U` (it checks GitHub, verifies checksum, replaces itself). No custom updater.
- Run in background on startup + "Check for updates" button.
- Setting: Stable / Nightly → `yt-dlp --update-to nightly` (nightly fixes YouTube breaks sooner).
- `deno upgrade` for deno. ffmpeg updates only with the app.

## App updater (Velopack + GitHub)
- Rust startup: `VelopackApp::build().run()`, then `UpdateManager` with `GithubSource` → check, download delta in background, apply on restart.
- UI shows "Restart to update".
- Release: push tag `vX.Y.Z` → GitHub Actions:
  1. Matrix: `macos-14` (arm64), `macos-13` (x64), `windows-latest`, `ubuntu-22.04`
  2. Download yt-dlp / ffmpeg / deno for the platform into `src-tauri/resources/bin/`
  3. `npm run tauri build -- --no-bundle`
  4. `vpk download github` (previous release, base for the delta)
  5. `vpk pack` (sign + installer + full and delta packages)
  6. `vpk upload github`

## Signing
- macOS: required — Apple Developer ID ($99/yr) + notarization (`vpk pack` flags).
- Windows: optional, SmartScreen warns without it. SignPath Foundation signs OSS for free.
- Linux: none.

## License
GPL-3.0. yt-dlp's PyInstaller binaries are GPLv3+ as a combined work, and common ffmpeg builds are GPL.

## MVP (v1)
1. Paste URL → title + thumbnail (`yt-dlp -J`)
2. Video (best) / Audio (mp3)
3. Output folder picker
4. Queue with progress + cancel (`--newline --progress-template "%(progress)j"` → one JSON line per update)
5. Settings: yt-dlp channel, check for updates
6. yt-dlp errors shown in plain text

Not in v1: playlist UI, subtitles, cookies/login, scheduling, i18n (all just yt-dlp flags later).

## Phases
1. **Spike** — minimal Tauri + Velopack hello-world, delta update from GitHub working on all 3 OSes. Riskiest integration, prove it first.
2. **Core** — bin bootstrap (copy to app data dir), download command, progress, cancel.
3. **UI** — form + queue.
4. **Updaters** — yt-dlp `-U` and Velopack wired into the UI.
5. **CI + release** — Actions matrix, signing, first tagged release.

## Status
- [x] Tauri v2 scaffold (vanilla), GPL-3.0, git init
- [x] Design system (DESIGN.md) + static main screen
- [ ] Phase 1 spike (Velopack) — needs a GitHub repo + releases
- [x] Phase 2 core: bin bootstrap, download/cancel commands, JSON progress events
- [x] Phase 3 UI: queue wired to real downloads, folder picker, Show in Finder
- [x] Quality picker (`yt-dlp -J`: every format with size, subtitles, embed/sponsor options), one-at-a-time queue in a bottom dock, history, Settings (Save to)
- [x] Phase 4a yt-dlp updater: on startup + Settings (Stable/Nightly)
- [x] Redesign: native look, Download / Library / Settings tabs, curated qualities, auto-RTL Farsi content (Vazirmatn), OS notifications
- [x] Phase 4b Velopack app updater: check on startup + Settings, "Restart to update"
- [x] Phase 5 CI + release: `ci.yml` (fmt, clippy), `release.yml` on `v*` tags (4 platforms, delta packages, notes from commits)
- [x] Playlists & channels: streamed flat listing (`-j --flat-playlist`), search + select, YouTube channel tabs, one quality for all (height caps), one queue item per video in a playlist folder, Cancel all / Retry failed
- [x] macOS self-signed certificate in CI (stable identity, so permissions survive updates)
- [ ] macOS Developer ID signing + notarization (needs an Apple Developer ID)
