# Personal Downloader — More Downloaders Plan

Add aria2c, gallery-dl, streamlink, spotDL and N_m3u8DL-RE next to yt-dlp, without making the app harder to use.

## Principles
- **One URL box.** Users paste a link; the app picks the tool. Tool names stay out of the main flow.
- **Override is hidden.** A `Use: Auto ▾` dropdown under Advanced forces a specific tool.
- **Nothing installs until it's needed** (except aria2c). First launch stays fast.
- **Same queue, same look.** Every tool reports into the existing progress event and queue item.
- **No DRM decryption, ever.**

## Decisions (grill-me, 2026-11-11)
| # | Topic | Decision |
|---|---|---|
| 1 | Routing | Auto-route from the URL, plus a hidden override dropdown (Auto / yt-dlp / aria2c / gallery-dl / streamlink / spotDL / N_m3u8DL-RE). |
| 2 | Install | On first use: a queue item shows "Getting gallery support…" while the tool downloads. **Exception:** aria2c is fetched at first launch with yt-dlp/ffmpeg/deno. |
| 3 | Preview | Light preview: streamlink → quality list; spotDL → track list (existing playlist select UI); gallery-dl → file count; torrent → file list; aria2c direct / N_m3u8DL-RE → filename + Download. |
| 4 | Torrents | No seeding (`--seed-time=0`). Show: file picker, seeds & peers, a "Fetching metadata…" stage for magnets, upload speed + ratio. |
| 5 | Python tools | Install gallery-dl, streamlink and spotDL with `uv tool install` into the app's bin dir. uv brings its own Python, so there's one code path on every OS. |
| 6 | aria2c process | One process per job (cancel = kill, same as today), each with `--enable-rpc` on a random localhost port plus a secret token. Rust polls `aria2.tellStatus` every second and emits the usual progress event. |
| 7 | yt-dlp + aria2c | On by default (`--downloader http:aria2c`). If a download fails, retry it automatically with yt-dlp's native downloader. Settings toggle: "Faster downloads (aria2c)". |
| 8 | Fallback | Specialist first; if it fails, fall back to yt-dlp. |
| 9 | Detection | A small built-in rules table (below). No probing just to route. |
| 10 | Live | Record until Stop or until the stream ends, with an optional "Stop after [__] min". Runs alongside the one-at-a-time queue. Shows `LIVE ● 00:12:34 · 340 MB`. Remux `.ts` → `.mp4` with ffmpeg at the end. |
| 11 | spotDL | Reuse the app's Audio format setting (mp3 default). Playlists and albums go into a subfolder, like yt-dlp playlists. |
| 12 | Updates | Settings → **Tools** list: one row per tool showing version or "Installs on first use", with a Remove button. One "Update all" button, plus the same startup auto-check as yt-dlp. yt-dlp keeps Stable/Nightly. |
| 13 | Order | Foundation first (phases below). |

Also decided (follows from existing code, no question needed):
- The router lives in Rust (`pick_tool(url)`), next to `probe` and `download`.
- The existing `cookies.txt` and proxy setting are passed to every tool that supports them.

### Routing rules
| Match | Tool | Fallback |
|---|---|---|
| `magnet:` or `*.torrent` | aria2c (torrent) | none |
| `open.spotify.com/{track,album,playlist,artist}` | Spotify embed → yt-dlp (YouTube Music) | none |
| `*.m3u8`, `*.mpd` | N_m3u8DL-RE | yt-dlp |
| `twitch.tv/<channel>`, `kick.com/<channel>`, `youtube.com/.../live` | streamlink | yt-dlp |
| instagram, pixiv, deviantart, imgur, reddit gallery, tumblr, x.com `/photo/` | gallery-dl | yt-dlp |
| Direct file extension (`.zip .iso .pdf .exe .dmg .7z .rar …`) | aria2c (http) | none |
| anything else | yt-dlp | none |

## Phases
Each phase ships as its own release.

1. **Foundation**: router, override, on-demand install, Tools list, and aria2c for yt-dlp and direct files.
2. **Torrents**: aria2c RPC, file picker, peers/seeds, metadata stage.
3. **Images**: uv and gallery-dl.
4. **Live**: streamlink.
5. **Spotify**: track list from Spotify's embed page, audio through yt-dlp (spotDL dropped, see Phase 5).
6. **HLS/DASH**: N_m3u8DL-RE.

## Tasks

### Phase 1: Foundation
- [x] `lib.rs`: generalize `fetch_*` into a per-tool install (`ensure_tool(name)`) that reuses `fetch()`, the sha check, `put()` and `unzip()`. *Done in Phase 3: `ensure_tool` installs a Python tool through uv on first use; `fetch_uv` reuses `fetch()`/`unzip()`.*
- [x] `lib.rs`: fetch aria2c in `install_tools` at first launch. *Sources: `.github/workflows/aria2.yml` builds macOS (universal, system libs only) from the official 1.37.0 source, mirrors official Windows and abcfy2 static Linux after pinned SHA-256 checks, and publishes them with `SHA2-256SUMS` as the non-latest release `aria2-1.37.0`. **Run that workflow once before shipping.***
- [x] `lib.rs`: `pick_tool(url) -> Tool` implementing the rules table, plus a unit test covering every row. *`route` maps it to aria2c / yt-dlp until the other tools land.*
- [x] `lib.rs`: `download` takes an optional `tool` override and dispatches on `Tool`. Today's yt-dlp path is unchanged.
- [x] `lib.rs`: fallback to yt-dlp on failure, per the rules table. *Done in Phase 3, at the preview: a gallery link that gallery-dl can't read (an error or 0 files) goes to yt-dlp's probe, unless gallery-dl was picked under Advanced. A failed gallery download doesn't retry with yt-dlp, since yt-dlp needs its own format choice first.*
- [x] `lib.rs`: yt-dlp `--downloader http:aria2c`; on failure, retry once without it. Setting `fastDownloads` (default on). *Skipped automatically with a SOCKS proxy, which aria2c can't use.*
- [x] **Verify:** is yt-dlp's `%(progress)j` progress still accurate with aria2c? *No: yt-dlp's external downloader reports only "finished". aria2c's own readout is parsed instead (`readout()`), with `--summary-interval=1`, because aria2c doesn't flush its readout into a pipe otherwise.*
- [x] `lib.rs`: aria2c for direct files. *Progress comes from the console readout rather than RPC, which is less code. RPC moves to Phase 2, where file selection and peers need it. Magnets and .torrent links already download (no seeding, no file picker).*
- [x] `main.js` / `index.html`: "Use: Auto ▾" under Advanced. *The "Getting X support…" state moves to Phase 3 with the first on-demand tool.*
- [x] `main.js`: Settings → Tools list: versions plus Update all (yt-dlp check, re-fetch ffmpeg and deno; aria2c is pinned). *Remove waits for the on-demand tools (core tools reinstall at launch anyway). The startup check stays yt-dlp-only, so ffmpeg (~80 MB) isn't re-downloaded every day.*
- [x] `release.yml`: no change. Tools are fetched at runtime, not bundled.

### Phase 2: Torrents
- [x] Magnet: start aria2c with `--bt-metadata-only --bt-save-metadata` to get the file list → preview with checkboxes (playlist select UI). *`torrent_files` saves the .torrent (a magnet's metadata, or a `.torrent` link's file) into the cache dir and lists it with `aria2c -S`; the download then uses that saved .torrent, so the metadata is fetched once.*
- [x] Download with `--select-file=…` and `--seed-time=0`.
- [x] Extend the progress event with `seeds`, `peers`, `up`, `ratio`. *Not RPC: aria2c's once-a-second readout already carries the same numbers (`CN`, `SD`, `UL:speed(uploaded)`), so there's no port or secret to manage. Decision 6 stays open for when RPC is actually needed.*
- [x] Queue item: "Seeds 12 · Peers 40 · ↑ 0.1 MB/s · ratio 0.1". *"Fetching metadata from peers…" shows under the link box during the preview instead, because the file list has to exist before anything is queued.*

### Phase 3: Images (uv + gallery-dl)
- [x] `ensure_tool("uv")`: fetch the uv binary; set `UV_TOOL_DIR` / `UV_TOOL_BIN_DIR` / `UV_PYTHON_INSTALL_DIR` inside the app data dir. *Also `UV_CACHE_DIR` (app cache), `UV_PYTHON_PREFERENCE=only-managed` (never a system Python), and the app's proxy as `HTTP(S)_PROXY`/`ALL_PROXY`. Measured: Python 71 MB + gallery-dl 7 MB.*
- [x] `uv tool install gallery-dl`; Tools list update = `uv tool upgrade`. *Installed `--with pysocks` so SOCKS proxies work. Settings → Tools has a gallery-dl row ("installs on first use" or its version, plus Remove = `uv tool uninstall`). "Update all" runs `uv tool upgrade --all` when a Python tool is installed. The status line under the link box shows "Getting gallery support… (first time only)" during the install.*
- [x] Preview: `gallery-dl --simulate` → file count. *`-G` (one URL per file, "| " lines are fallbacks) instead, so the count streams in as "Found n files…".*
- [x] Download: `gallery-dl --cookies <cookies.txt> --proxy … -d <dir>`; progress = files done / total. *Each saved path (or "# path" for one already there) counts as a file; the total is the preview's count. History opens the files' folder. `PYTHONUNBUFFERED=1` is set, because Python holds back output written to a pipe.*

### Phase 4: Live (streamlink)
- [x] `uv tool install streamlink`. *Same `ensure_tool` path as gallery-dl ("Getting live stream support…"), with its own Settings → Tools row. streamlink has no cookies.txt option, so subscriber-only streams aren't covered.*
- [x] Preview: `streamlink --json <url>` → quality list. *Sorted best first (`1080p60`, `1080p`, … `audio_only`); `best`/`worst` aliases dropped. An offline channel (or one streamlink can't read) falls back to yt-dlp's probe unless streamlink was picked under Advanced.*
- [x] Record to `.ts`; track elapsed time and bytes; Stop = graceful kill that keeps the file; optional `--hls-duration`. *The app reads `streamlink -O` and writes the file itself, counting bytes (and avoiding `-o`'s `{…}` templating of the path). Stop is the usual kill: the `.ts` up to that point is kept and saved. "Stop after [__] min" is the app's own timer instead of `--hls-duration`, which newer streamlink renamed. A stream that drops mid-way still saves what was recorded, with a warning.*
- [x] Live jobs run outside the one-at-a-time queue. *They don't show in the Download-page strip or the tab badge; the Library row shows `LIVE ● 00:12:34 · 340 MB`.*
- [x] ffmpeg remux `.ts` → `.mp4` when done. *`-n` never overwrites; if the remux fails, the `.ts` is kept with a warning. File name: `<channel> YYYY-MM-DD HH-MM-SS`.*

### Phase 5: Spotify (no spotDL)
*spotDL 4.6.0 was tried and dropped: its shared Spotify API key answers 429 with `Retry-After: 86400` (checked 2026-11-11), so every link hangs, and a key of one's own needs a Spotify developer app. spotDL only finds each song on YouTube anyway, which the app's yt-dlp already does.*
- [x] Preview: `spotify_tracks` reads the public embed page (`open.spotify.com/embed/<kind>/<id>`, no key) through the app's proxy → title, cover and tracks (artists, title, duration). *An album, playlist or artist opens the song list (playlist select UI); a single track goes straight to the choices. The embed lists at most 100 tracks of a playlist, and an artist's top 10.*
- [x] Download: each song is a normal yt-dlp queue item for `music.youtube.com/search?q=<artists title>#songs` with `-I 1` (the first song result, an official audio track with artist/album tags, not the music video). Only the Audio choices show (Convert, using the remembered Audio format, mp3 by default; or Original). Lists go into a subfolder named after the album or playlist, like yt-dlp playlists. *The match isn't checked against the Spotify duration.*

### Phase 6: HLS/DASH (N_m3u8DL-RE)
- [x] Fetch the release binary per OS. *On demand: official `v0.6.0-beta` archives for Windows, macOS and Linux (x64 / arm64), pinned SHA-256 digests. Settings → Tools shows its version, Remove and Update all (re-fetches the pinned release).*
- [x] Download: `--save-dir --save-name --auto-select`, the app's ffmpeg path, and the proxy. **Never** pass `--key` / `--key-text-file` / `--use-shaka-packager`. *Auto routing and Advanced override use the filename + Download preview. Muxes to MP4 in a fresh folder to prevent overwrites; first-use installation reports in the queue. Failed downloads retry through yt-dlp only after another protection check. The pinned binary has no cookies.txt option.*
- [x] If the manifest is DRM-encrypted (Widevine/PlayReady/FairPlay), stop and show "This stream is DRM-protected and can't be downloaded." *Checks the manifest and HLS child playlists through the app proxy before installation/download or fallback; unreadable manifests fail closed. Rejects all encryption signaling, including ordinary AES HLS, and disables HLS decryption in the downloader. Live HLS is directed to streamlink; live DASH and external XML references are rejected. Checks are bounded to 64 manifests, 4 MiB each, 20 seconds per request. Cancellation prevents a subsequent process from starting; an in-flight check/install may finish in the background.*
- [x] Parse its progress line → progress event. *Percentage feeds the existing queue. Explicit terminal dimensions prevent Spectre.Console from crashing with piped output. Verified local clear HLS and DASH → playable MP4 on macOS arm64; unit tests cover routing, encryption, nested playlists and progress. Windows/Linux execution remains untested.*

## Risks & guardrails
- **DRM:** no decryption, by any tool, ever (legal reasons: DMCA §1201 / EU InfoSoc Art. 6).
- **Spotify links** are legally gray (nothing is taken from Spotify but the track names; the audio is YouTube's, but it's mostly commercial music). Keep it behind Spotify-URL routing and don't mention it in marketing.
- **Torrents:** the user's IP is visible to peers while downloading. Mention this once in Settings.
- **uv + Python** adds roughly 40–60 MB the first time a Python tool is used.
- **The rules table will miss sites.** The override dropdown and the yt-dlp fallback cover it; add rules as users hit misses.
- **The aria2c RPC port** binds to localhost only and requires a per-job secret.
