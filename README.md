# Personal Downloader

A calm, native desktop app for downloading video and audio from YouTube and the
[1,000+ sites yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).
macOS, Windows and Linux. Built with Tauri v2, yt-dlp and Velopack.

- Paste a link and pick a quality: one row per resolution, MP3 or original audio, or any raw format.
- Videos are always saved as **.mp4**.
- Subtitles, metadata, chapters, thumbnails and SponsorBlock, all remembered between downloads.
- A queue with progress, a searchable library, and notifications when downloads finish.
- Farsi and other right-to-left titles display correctly (bundled Vazirmatn font).
- Ships its own yt-dlp, ffmpeg and deno, and keeps yt-dlp up to date (stable or nightly).
- The app updates itself with small **delta updates** from GitHub Releases.

## Install
Download the installer for your platform from [Releases](https://github.com/LordVersA/personal-downloader/releases/latest):
`-Setup.exe` (Windows), `-Setup.pkg` (macOS), `.AppImage` (Linux).

macOS builds aren't notarized yet: the first time, right-click the app → **Open**.

## Develop
```sh
npm install
npm run tauri dev
```
Dev builds use the `yt-dlp` on your `PATH`. Settings → **Use built-in yt-dlp** downloads the standalone one the app can update.
The Rust toolchain is pinned in `src-tauri/rust-toolchain.toml`.

## Release
Push a version tag; CI does the rest:
```sh
git tag v0.2.0 && git push origin v0.2.0
```
[`release.yml`](.github/workflows/release.yml) builds every platform, bundles yt-dlp/ffmpeg/deno, packs with Velopack
(a delta against the previous release), and publishes one GitHub Release. The release notes are generated from the commits
since the last tag, grouped by [Conventional Commits](https://www.conventionalcommits.org) type (`feat:`, `fix:`, …).

## License
GPL-3.0, see [LICENSE](LICENSE).
