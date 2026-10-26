use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};
use velopack::{UpdateCheck, UpdateInfo, UpdateManager, sources::GithubSource};

const REPO: &str = "https://github.com/LordVersA/personal-downloader";

#[derive(Default)]
struct Jobs(Mutex<HashMap<u32, Child>>);

// An app update that is downloaded and waiting for a restart
#[derive(Default)]
struct Pending(Mutex<Option<UpdateInfo>>);

fn bin_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("no app data dir").join("bin")
}

const YTDLP: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const FFBUILDS: &str = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest";

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

fn text(url: &str) -> Result<String, String> {
    ureq::get(url).call().and_then(|mut r| r.body_mut().read_to_string()).map_err(|e| format!("{url}: {e}"))
}

// First 64-hex token on the line naming `file` (any line when `file` is empty); covers `sha256sum` and PowerShell output
fn sha_in(sums: &str, file: &str) -> Option<String> {
    sums.lines()
        .filter(|l| file.is_empty() || l.split_whitespace().any(|w| w.trim_start_matches('*') == file))
        .flat_map(str::split_whitespace)
        .find(|w| w.len() == 64 && w.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
}

// Download `url`, and fail on a missing or mismatched SHA-256; `sums` gets the URL after redirects
fn fetch(url: &str, sums: impl FnOnce(&str) -> String, file: &str) -> Result<Vec<u8>, String> {
    use sha2::Digest;
    use ureq::ResponseExt;
    let mut res = ureq::get(url).call().map_err(|e| format!("{url}: {e}"))?;
    let sums_url = sums(&res.get_uri().to_string());
    let data = res.body_mut().with_config().limit(1 << 30).read_to_vec().map_err(|e| format!("{url}: {e}"))?;
    match sha_in(&text(&sums_url)?, file) {
        Some(want) if want == format!("{:x}", sha2::Sha256::digest(&data)) => Ok(data),
        _ => Err(format!("checksum mismatch: {url}")),
    }
}

// Write via a .part file so a failed run never leaves a broken binary behind
fn put(dir: &std::path::Path, name: &str, data: &[u8]) -> Result<(), String> {
    let (to, tmp) = (dir.join(name), dir.join(format!("{name}.part")));
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(tmp, to).map_err(|e| e.to_string())
}

// Pull the named files out of a zip, wherever they sit inside it
fn unzip(dir: &std::path::Path, zip: Vec<u8>, names: &[String]) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().rsplit('/').next().unwrap_or_default().to_string();
        if names.contains(&name) {
            let mut data = Vec::new();
            f.read_to_end(&mut data).map_err(|e| e.to_string())?;
            put(dir, &name, &data)?;
        }
    }
    Ok(())
}

fn fetch_ffmpeg(dir: &std::path::Path) -> Result<(), String> {
    let names = [exe("ffmpeg"), exe("ffprobe")];
    if cfg!(target_os = "macos") {
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" };
        for t in ["ffmpeg", "ffprobe"] {
            // the "latest" link redirects to a versioned file whose .sha256 sits next to it
            let url = format!("https://ffmpeg.martin-riedl.de/redirect/latest/macos/{arch}/snapshot/{t}.zip");
            unzip(dir, fetch(&url, |u| format!("{u}.sha256"), "")?, &names)?;
        }
        return Ok(());
    }
    let file = if cfg!(windows) { "ffmpeg-master-latest-win64-gpl.zip" } else { "ffmpeg-master-latest-linux64-gpl.tar.xz" };
    let data = fetch(&format!("{FFBUILDS}/{file}"), |_| format!("{FFBUILDS}/checksums.sha256"), file)?;
    if cfg!(windows) {
        return unzip(dir, data, &names);
    }
    // no xz decoder in-tree; every Linux has tar with xz
    let tmp = dir.join(file);
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    let ok = Command::new("tar")
        .arg("-xJf")
        .arg(&tmp)
        .arg("-C")
        .arg(dir)
        .args(["--strip-components=2", "--wildcards", "*/bin/ffmpeg", "*/bin/ffprobe"])
        .status()
        .is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(tmp);
    if ok { Ok(()) } else { Err("Couldn't unpack ffmpeg".into()) }
}

fn fetch_deno(dir: &std::path::Path) -> Result<(), String> {
    let target = if cfg!(windows) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "aarch64-apple-darwin" } else { "x86_64-apple-darwin" }
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    };
    let url = format!("https://github.com/denoland/deno/releases/latest/download/deno-{target}.zip");
    unzip(dir, fetch(&url, |_| format!("{url}.sha256sum"), "")?, &[exe("deno")])
}

// The app ships without yt-dlp, ffmpeg and deno; fetch whichever are missing on first launch
#[tauri::command]
async fn install_tools(app: AppHandle) -> Result<(), String> {
    let dir = bin_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let has = |n: &str| dir.join(exe(n)).exists();
    if !ytdlp_exe(&app).exists() {
        fetch_ytdlp(&dir)?;
        // macOS scans a new executable on its first run (~14 s); take that hit now, not on the user's first fetch
        let _ = ytdlp_out(&app, &["--version"]);
    }
    if !has("ffmpeg") || !has("ffprobe") {
        fetch_ffmpeg(&dir)?;
    }
    if !has("deno") {
        fetch_deno(&dir)?;
    }
    Ok(())
}

// (release zip, executable inside it); the unpacked build starts in ~0.2 s, the single-file one unpacks itself on every run (~14 s on macOS)
fn ytdlp_build() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("yt-dlp_win.zip", "yt-dlp.exe")
    } else if cfg!(target_os = "macos") {
        ("yt-dlp_macos.zip", "yt-dlp_macos")
    } else if cfg!(target_arch = "aarch64") {
        ("yt-dlp_linux_aarch64.zip", "yt-dlp_linux_aarch64")
    } else {
        ("yt-dlp_linux.zip", "yt-dlp_linux")
    }
}

// Download and unpack the latest yt-dlp into bin/yt-dlp-app, swapping it in only once it is complete
fn fetch_ytdlp(bin: &std::path::Path) -> Result<(), String> {
    let (zip, _) = ytdlp_build();
    let data = fetch(&format!("{YTDLP}/{zip}"), |_| format!("{YTDLP}/SHA2-256SUMS"), zip)?;
    let (to, tmp) = (bin.join("yt-dlp-app"), bin.join("yt-dlp-app.part"));
    let _ = std::fs::remove_dir_all(&tmp);
    zip::ZipArchive::new(std::io::Cursor::new(data))
        .and_then(|mut z| z.extract(&tmp))
        .map_err(|e| format!("Couldn't unpack yt-dlp: {e}"))?;
    let _ = std::fs::remove_dir_all(&to);
    std::fs::rename(&tmp, &to).map_err(|e| e.to_string())?;
    // the single-file build that older versions installed
    let _ = std::fs::remove_file(bin.join(exe("yt-dlp")));
    Ok(())
}

fn ytdlp_exe(app: &AppHandle) -> PathBuf {
    bin_dir(app).join("yt-dlp-app").join(ytdlp_build().1)
}

fn cookies_file(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("no app data dir").join("cookies.txt")
}

// Copies the browser's cookies (all sites) into cookies.txt; yt-dlp saves the jar on exit even though it then complains there's no URL
#[tauri::command]
async fn import_cookies(app: AppHandle, browser: String) -> Result<String, String> {
    let (to, tmp) = (cookies_file(&app), cookies_file(&app).with_extension("txt.part"));
    let _ = std::fs::remove_file(&tmp);
    // owner-only before yt-dlp writes login sessions into it; the mode survives its truncating writes and the rename.
    // yt-dlp also loads the file first, and rejects one without the Netscape header
    let mut f = std::fs::OpenOptions::new();
    f.write(true).create(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut f, 0o600);
    std::io::Write::write_all(&mut f.open(&tmp).map_err(|e| e.to_string())?, b"# Netscape HTTP Cookie File\n")
        .map_err(|e| e.to_string())?;
    let o = ytdlp(&app).args(["--cookies-from-browser", &browser, "--cookies"]).arg(&tmp).output().map_err(start_err)?;
    let n = std::fs::read_to_string(&tmp).map(|t| t.lines().filter(|l| !l.is_empty() && !l.starts_with("# ")).count()).unwrap_or(0);
    if n == 0 {
        let _ = std::fs::remove_file(&tmp);
        let err = last_error(&String::from_utf8_lossy(&o.stderr));
        // macOS privacy protection hides other apps' data, which yt-dlp reports as "could not find … in \"<dir>\""
        let dir = err.split('"').nth(1).unwrap_or_default();
        if !dir.is_empty() && std::fs::read_dir(dir).is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied) {
            let raw = err.lines().last().unwrap_or_default();
            // apps can't grant themselves Full Disk Access (not even with an admin password), so open the exact pane
            let _ = Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles").status();
            return Err(format!(
                "macOS is blocking access to {browser}'s data. In the Full Disk Access list that just opened, turn on Personal Downloader (use + if it's missing), then reopen the app and import again.\n{raw}"
            ));
        }
        return Err(err);
    }
    std::fs::rename(&tmp, &to).map_err(|e| e.to_string())?;
    Ok(format!("{n} cookies from {browser}"))
}

// Main domain of a cookie line ("#HttpOnly_.www.youtube.com\t…" → ("youtube.com", "youtube")); handles two-part suffixes like co.uk
fn cookie_domain(line: &str) -> Option<(String, String)> {
    let host = line.strip_prefix("#HttpOnly_").unwrap_or(line);
    if host.starts_with('#') {
        return None;
    }
    let labels: Vec<&str> = host.split('\t').next()?.trim_start_matches('.').split('.').filter(|l| !l.is_empty()).collect();
    let n = labels.len();
    let k = if n >= 3 && ["co", "com", "org", "net", "ac", "gov", "edu"].contains(&labels[n - 2]) { 3 } else { 2 };
    if n < k {
        return None;
    }
    Some((labels[n - k..].join("."), labels[n - k].to_ascii_lowercase()))
}

// Sites in the imported cookies that yt-dlp has an extractor for, matched by name (x.com is yt-dlp's "twitter")
#[tauri::command]
async fn cookie_sites(app: AppHandle) -> Result<Vec<String>, String> {
    let Ok(text) = std::fs::read_to_string(cookies_file(&app)) else { return Ok(vec![]) };
    let o = ytdlp(&app).arg("--list-extractors").output().map_err(start_err)?;
    let names: std::collections::HashSet<String> = String::from_utf8_lossy(&o.stdout)
        .lines()
        .map(|l| {
            l.split(':').next().unwrap_or_default().chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase()
        })
        .collect();
    let mut sites: Vec<String> = text
        .lines()
        .filter_map(cookie_domain)
        .filter(|(_, name)| names.contains(if name == "x" { "twitter" } else { name }))
        .map(|(domain, _)| domain)
        .collect();
    sites.sort();
    sites.dedup();
    Ok(sites)
}

#[tauri::command]
fn remove_cookies(app: AppHandle) -> Result<(), String> {
    std::fs::remove_file(cookies_file(&app)).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e.to_string()) })
}

fn ytdlp(app: &AppHandle) -> Command {
    let dir = bin_dir(app);
    let exe = ytdlp_exe(app);
    // until install_tools has run (or if it failed), fall back to yt-dlp on PATH
    let mut cmd = Command::new(if exe.exists() { exe.into_os_string() } else { "yt-dlp".into() });
    // ffmpeg and deno are found through PATH
    let path = std::env::var_os("PATH").unwrap_or_default();
    let paths = std::iter::once(dir).chain(std::env::split_paths(&path));
    if let Ok(p) = std::env::join_paths(paths) {
        cmd.env("PATH", p);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    // signed-in sessions imported from a browser; yt-dlp also writes refreshed cookies back to this file
    let cookies = cookies_file(app);
    if cookies.exists() {
        cmd.arg("--cookies").arg(cookies);
    }
    // own process group, so cancel() can stop yt-dlp's child processes too
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    cmd
}

fn start_err(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        "yt-dlp isn't installed yet. Open Settings and install it, or wait for the first-launch download to finish.".into()
    } else {
        format!("Couldn't start yt-dlp: {e}")
    }
}

// yt-dlp's error text (lowercase needles) → what it means and what to do; first match wins, so specific causes come before general ones
#[rustfmt::skip]
const EXPLAIN: &[(&[&str], &str)] = &[
    (&["cookies database", "no such browser", "unsupported browser"], "Couldn't find that browser's cookies. Make sure it's installed and you've opened it at least once."),
    (&["could not copy", "database is locked"], "The browser has its cookies locked. Quit the browser completely and import again."),
    (&["failed to decrypt", "app-bound", "dpapi", "keyring", "keychain"], "Couldn't decrypt the browser's cookies. Allow access if your system asks, or use Firefox, which doesn't encrypt them."),
    (&["binarycookies", "cookies.binarycookies"], "macOS blocks reading Safari's cookies. Give the app Full Disk Access in System Settings → Privacy & Security, or use another browser."),
    (&["is not a valid url"], "That isn't a valid link. Copy the full address from the browser, starting with https://."),
    (&["unsupported url"], "yt-dlp doesn't support this site or kind of link. Check the link, or see Settings → Supported sites."),
    (&["confirm you\u{2019}re not a bot", "confirm you're not a bot", "confirm that you're not a bot"], "YouTube is blocking this connection as a bot. Import your browser cookies in Settings → Browser cookies (signed in to YouTube), or try another proxy."),
    (&["confirm your age", "age-restricted", "age restricted", "inappropriate for some users"], "This video is age-restricted. Sign in to the site in your browser, then import its cookies in Settings → Browser cookies."),
    (&["drm"], "This media is DRM-protected; yt-dlp can't download it."),
    (&["private video", "video is private", "this account is private", "content isn't available"], "This post is private or only for signed-in users. If your account can see it, sign in in your browser and import its cookies in Settings → Browser cookies."),
    (&["members-only", "members only", "join this channel", "available to this channel's members", "subscriber"], "This is for members or subscribers only. If you are one, import your browser cookies in Settings → Browser cookies."),
    (&["not available in your country", "not made this video available in your country", "geo restrict", "geo-restrict", "blocked it in your country", "not available from your location"], "This is blocked in your region. Turn on a proxy in another country (Settings → Proxy) and try again."),
    (&["premieres in", "live event will begin", "is upcoming", "will begin in"], "This live stream or premiere hasn't started yet. Try again once it's live."),
    (&["has been terminated", "has been removed", "no longer available", "video unavailable", "video is unavailable", "does not exist", "has been deleted"], "This video was removed, made unavailable or never existed."),
    (&["requested format is not available", "requested formats are incompatible"], "The chosen quality isn't available for this video anymore. Fetch the link again and pick another quality."),
    (&["no video formats found", "no video could be found", "there's no video", "only images are available"], "There's no downloadable video or audio at this link."),
    (&["login required", "log in", "login to", "sign in", "--cookies", "requires authentication", "account is required", "rate-limit reached"], "This site wants you signed in. Sign in in your browser, then import its cookies in Settings → Browser cookies. If cookies are already imported, they may have expired; import again."),
    (&["http error 429", "too many requests"], "The site is rate-limiting you (too many requests). Wait a few minutes, or switch proxy."),
    (&["http error 401", "http error 403", "forbidden"], "The site refused the request (403). Update yt-dlp in Settings; if it keeps happening, try another proxy."),
    (&["http error 404", "not found (404)"], "The site says this page doesn't exist (404). Check the link."),
    (&["http error 410"], "This content is gone from the site (410)."),
    (&["http error 5", "bad gateway", "service unavailable", "internal server error"], "The site's server is having trouble. Try again in a little while."),
    (&["unable to connect to proxy", "proxyerror", "proxy error", "socks", "tunnel connection failed"], "Couldn't connect through the proxy. Check the proxy in Settings (use Test), or turn it off."),
    (&["certificate_verify_failed", "certificate verify failed", "ssl:", "sslerror", "tlsv1"], "A secure (TLS) connection failed. A proxy, VPN or antivirus may be intercepting traffic, or the system clock is wrong."),
    (&["getaddrinfo failed", "name or service not known", "nodename nor servname", "temporary failure in name resolution", "failed to resolve", "no address associated"], "Couldn't look up the site's address. Check your internet connection or DNS."),
    (&["timed out", "timeout"], "The connection timed out. Check your internet or proxy and try again; the download resumes where it stopped."),
    (&["connection reset", "connection refused", "connection aborted", "remote end closed", "incompleteread", "did not get any data blocks", "giving up after", "network is unreachable", "broken pipe"], "The connection dropped. Try again; the download resumes where it stopped."),
    (&["n challenge", "nsig", "signature extraction", "javascript runtime", "player response", "unable to extract", "jsinterp"], "The site changed and this yt-dlp can't read it anymore. Update yt-dlp in Settings and try again."),
    (&["ffmpeg not found", "ffprobe not found", "ffmpeg and ffprobe", "ffprobe and ffmpeg", "ffmpeg is not installed"], "ffmpeg is missing, so the file can't be merged or converted. Restart the app to reinstall its tools."),
    (&["no space left", "errno 28", "disk full", "not enough space"], "The disk is full. Free some space or choose another download folder."),
    (&["read-only file system", "errno 30"], "The download folder is read-only. Choose another folder in Settings."),
    (&["permission denied", "errno 13", "access is denied", "operation not permitted"], "The app isn't allowed to write to the download folder. Choose another folder or check its permissions."),
    (&["file name too long", "errno 36", "errno 63", "filename too long"], "The file name is too long for this disk. Choose a shorter download folder path."),
    (&["unable to rename", "being used by another process", "winerror 32"], "The file is open in another app. Close it and try again."),
    (&["postprocessing", "conversion failed", "error opening input", "invalid data found"], "Downloaded, but converting or merging the file failed. The chosen file format may not fit this video's codec: pick MKV (fits everything), or another quality."),
    (&["downloaded file is empty"], "The site sent an empty file. Try again, or pick another quality."),
];

// Last ERROR line, plus a plain-language explanation on its own first line when we recognise it
fn last_error(stderr: &str) -> String {
    let raw = stderr
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix("ERROR:"))
        .or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()))
        .unwrap_or("yt-dlp stopped without saying why")
        .trim();
    let low = raw.to_lowercase();
    match EXPLAIN.iter().find(|(needles, _)| needles.iter().any(|n| low.contains(n))) {
        Some((_, why)) => format!("{why}\n{raw}"),
        None => raw.to_string(),
    }
}

// Distinct WARNING lines, e.g. missing subtitles or a fallback format; shown on the finished download
fn warnings(stderr: &str) -> Vec<String> {
    let mut w: Vec<String> = stderr.lines().filter_map(|l| l.strip_prefix("WARNING:")).map(|l| l.trim().to_string()).collect();
    w.dedup();
    w
}

#[derive(serde::Deserialize)]
struct Opts {
    format: String,
    // video container (mp4, mkv, webm, mov) and audio conversion target ("" keeps the original audio)
    container: String,
    convert: String,
    #[serde(default)]
    audio: bool,
    subs: Vec<String>,
    auto_subs: bool,
    embed_subs: bool,
    thumbnail: bool,
    metadata: bool,
    sponsors: bool,
    #[serde(default)]
    prefix: String,
}

// One JSON line per item: a single video comes back whole (with formats), a playlist or channel as flat entries streamed
// as each page loads ("probe-entry"); cancel(id) stops a long listing
#[tauri::command]
async fn probe(app: AppHandle, id: u32, url: String, proxy: String) -> Result<(), String> {
    // --no-quiet: -j hides yt-dlp's step lines; they come on stdout between the JSON lines and go to the UI as "probe-log"
    let mut child = ytdlp(&app)
        .args(["--proxy", &proxy])
        .args(["-j", "--no-quiet", "--flat-playlist", "--no-playlist", "--"])
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(start_err)?;
    let out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    app.state::<Jobs>().0.lock().unwrap().insert(id, child);
    let errs = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    for line in BufReader::new(out).lines().map_while(Result::ok) {
        match serde_json::from_str::<Value>(&line) {
            Ok(entry) => drop(app.emit("probe-entry", json!({"id": id, "entry": entry}))),
            Err(_) if !line.trim().is_empty() => drop(app.emit("probe-log", &line)),
            Err(_) => {}
        }
    }
    let stderr = errs.join().unwrap_or_default();
    // cancel() removes the child, so a missing entry means the user stopped it
    let child = app.state::<Jobs>().0.lock().unwrap().remove(&id);
    match child.map(|mut c| c.wait()) {
        Some(Ok(s)) if !s.success() => Err(last_error(&stderr)),
        _ => Ok(()),
    }
}

#[rustfmt::skip]
const DOWNLOAD_ARGS: &[&str] = &[
    "--newline", "--progress", "--no-simulate", "--no-playlist",
    // 8 parallel connections for fragmented streams (HLS/DASH: Instagram, X, Twitch, most live/VOD sites)
    "--concurrent-fragments", "8",
    "--progress-template", "download:%(progress)j",
    "--print", "video:%(.{title,thumbnail})j",
    "--print", "after_move:filepath",
    "-P",
];

#[tauri::command]
fn download(app: AppHandle, jobs: State<Jobs>, id: u32, url: String, dir: String, proxy: String, opts: Opts) -> Result<(), String> {
    let mut cmd = ytdlp(&app);
    // an empty --proxy means a direct connection
    cmd.args(["--proxy", &proxy]);
    // playlist downloads number files by playlist order: "003 - Title.mp4"
    cmd.arg("-o").arg(format!("{}%(title)s.%(ext)s", opts.prefix));
    cmd.args(DOWNLOAD_ARGS).arg(&dir).arg("--merge-output-format").arg(&opts.container).arg("-f").arg(&opts.format);
    // video lands in the chosen container even when the site serves a single file in another one
    if !opts.audio {
        cmd.arg("--remux-video").arg(&opts.container);
    }
    if !opts.convert.is_empty() {
        cmd.args(["-x", "--audio-format"]).arg(&opts.convert);
    }
    if !opts.subs.is_empty() {
        cmd.args(["--write-subs", "--sub-langs"]).arg(opts.subs.join(","));
        if opts.auto_subs {
            cmd.arg("--write-auto-subs");
        }
        if opts.embed_subs {
            cmd.arg("--embed-subs");
        }
    }
    if opts.thumbnail {
        cmd.args(["--embed-thumbnail", "--convert-thumbnails", "jpg"]);
        if opts.audio {
            // square album cover: crop the (usually 16:9) thumbnail to its centre
            cmd.args(["--ppa", r#"ThumbnailsConvertor+ffmpeg_o:-c:v mjpeg -vf crop='min(iw\,ih)':'min(iw\,ih)'"#]);
        }
    }
    if opts.audio && opts.metadata {
        // "Artist - Song" titles give the artist tag when the site has none (SoundCloud, most YouTube uploads)
        cmd.args(["--parse-metadata", "%(artist&HAS_ARTIST|)s%(title)s:^(?!HAS_ARTIST)(?P<artist>.+?) - .+$"]);
        // the title tag (yt-dlp writes it from `track`) drops the "Artist - " prefix; the file name keeps the full title
        cmd.args(["--parse-metadata", "%(track,title)s:^.+? - (?P<track>.+)$"]);
        // album artist and album fall back to the artist and the title, so players group the file properly
        cmd.args(["--parse-metadata", "%(album_artist,artist,uploader)s:%(album_artist)s"]);
        cmd.args(["--parse-metadata", "%(album,track,title)s:%(album)s"]);
    }
    if opts.metadata {
        cmd.args(["--embed-metadata", "--embed-chapters"]);
    }
    if opts.sponsors {
        cmd.args(["--sponsorblock-remove", "sponsor"]);
    }
    let mut child = cmd.arg("--").arg(&url).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(start_err)?;
    let out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    jobs.0.lock().unwrap().insert(id, child);

    std::thread::spawn(move || {
        let errs = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        });
        let mut path = String::new();
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            match serde_json::from_str::<Value>(&line) {
                Ok(p) if p.get("status").is_some() => drop(app.emit("dl", json!({"id": id, "kind": "progress", "p": p}))),
                Ok(info) => drop(app.emit("dl", json!({"id": id, "kind": "info", "info": info}))),
                Err(_) => path = line,
            }
        }
        let stderr = errs.join().unwrap_or_default();
        // cancel() removes the child, so a missing entry means the user stopped it
        let child = app.state::<Jobs>().0.lock().unwrap().remove(&id);
        let ev = match child.map(|mut c| c.wait()) {
            None => json!({"id": id, "kind": "cancelled"}),
            Some(Ok(s)) if s.success() => json!({"id": id, "kind": "done", "path": path, "warnings": warnings(&stderr)}),
            _ => json!({"id": id, "kind": "failed", "error": last_error(&stderr)}),
        };
        let _ = app.emit("dl", ev);
    });
    Ok(())
}

#[tauri::command]
fn cancel(jobs: State<Jobs>, id: u32) {
    let child = jobs.0.lock().unwrap().remove(&id);
    if let Some(mut c) = child {
        // the standalone yt-dlp unpacks itself and runs as a child process (plus ffmpeg), so kill the whole tree
        let pid = c.id().to_string();
        #[cfg(unix)]
        let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
        #[cfg(windows)]
        let _ =
            std::os::windows::process::CommandExt::creation_flags(Command::new("taskkill").args(["/T", "/F", "/PID", &pid]), 0x0800_0000)
                .status();
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn ytdlp_out(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let o = ytdlp(app).args(args).output().map_err(start_err)?;
    let stdout = String::from_utf8_lossy(&o.stdout);
    if !o.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&o.stderr)));
    }
    Ok(stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string())
}

// The unpacked build can't update itself, so compare with the latest release tag and re-download when it differs
#[tauri::command]
async fn update_ytdlp(app: AppHandle) -> Result<String, String> {
    use ureq::ResponseExt;
    let res = ureq::get("https://github.com/yt-dlp/yt-dlp/releases/latest").call().map_err(|e| e.to_string())?;
    let latest = res.get_uri().path().rsplit('/').next().unwrap_or_default().to_string();
    let current = ytdlp_out(&app, &["--version"])?;
    if current == latest {
        return Ok(format!("yt-dlp is up to date ({current})"));
    }
    fetch_ytdlp(&bin_dir(&app))?;
    ytdlp_out(&app, &["--version"]).map(|v| format!("Updated yt-dlp to {v}"))
}

// One small request to YouTube through the proxy; running yt-dlp for this takes 10+ s
#[tauri::command]
async fn test_proxy(proxy: String) -> Result<String, String> {
    let p = ureq::Proxy::new(&proxy).map_err(|e| format!("Bad proxy: {e}"))?;
    let agent: ureq::Agent =
        ureq::Agent::config_builder().proxy(Some(p)).timeout_global(Some(std::time::Duration::from_secs(10))).build().into();
    let t = std::time::Instant::now();
    agent.get("https://www.youtube.com/generate_204").call().map_err(|e| e.to_string())?;
    Ok(format!("Works · {} ms", t.elapsed().as_millis()))
}

#[tauri::command]
async fn list_sites(app: AppHandle) -> Result<Vec<String>, String> {
    let o = ytdlp(&app).arg("--list-extractors").output().map_err(start_err)?;
    if !o.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&o.stderr)));
    }
    Ok(String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

// managed = the app's own standalone copy, which can update itself; otherwise yt-dlp comes from PATH (pip, brew…)
#[tauri::command]
async fn ytdlp_info(app: AppHandle) -> Result<Value, String> {
    let version = ytdlp_out(&app, &["--version"]).ok();
    Ok(json!({"version": version, "managed": ytdlp_exe(&app).exists(), "cookies": cookies_file(&app).exists()}))
}

// Download the standalone yt-dlp into the app data dir; from then on the app uses it instead of PATH
#[tauri::command]
async fn install_ytdlp(app: AppHandle) -> Result<String, String> {
    fetch_ytdlp(&bin_dir(&app)).map_err(|e| format!("Couldn't download yt-dlp: {e}"))?;
    ytdlp_out(&app, &["--version"]).map(|v| format!("yt-dlp {v} installed"))
}

fn updater() -> Result<UpdateManager, String> {
    // fails when the app wasn't installed by Velopack, e.g. `tauri dev`
    UpdateManager::new(GithubSource::new(REPO, None, false), None, None).map_err(|_| "Updates work in installed builds".to_string())
}

// Checks GitHub Releases and downloads the update (a delta when possible); returns the new version, if any
#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<Option<String>, String> {
    let um = updater()?;
    let UpdateCheck::UpdateAvailable(info) = um.check_for_updates().map_err(|e| e.to_string())? else { return Ok(None) };
    um.download_updates(&info, None).map_err(|e| e.to_string())?;
    let version = info.TargetFullRelease.Version.clone();
    *app.state::<Pending>().0.lock().unwrap() = Some(*info);
    Ok(Some(version))
}

#[tauri::command]
fn restart_to_update(app: AppHandle) -> Result<(), String> {
    let info = app.state::<Pending>().0.lock().unwrap().take().ok_or("No update downloaded")?;
    updater()?.apply_updates_and_restart(&info).map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Jobs::default())
        .manage(Pending::default())
        .invoke_handler(tauri::generate_handler![
            probe,
            download,
            cancel,
            update_ytdlp,
            ytdlp_info,
            install_ytdlp,
            install_tools,
            list_sites,
            import_cookies,
            cookie_sites,
            remove_cookies,
            test_proxy,
            check_app_update,
            restart_to_update
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, ev| {
            // a downloaded update the user didn't restart for installs silently once the app quits
            if let tauri::RunEvent::Exit = ev
                && let Some(info) = app.state::<Pending>().0.lock().unwrap().take()
                && let Ok(um) = updater()
            {
                let _ = um.wait_exit_then_apply_updates(&info, true, false, Vec::<String>::new());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_domains() {
        assert_eq!(cookie_domain("#HttpOnly_.www.youtube.com\tTRUE\t/"), Some(("youtube.com".into(), "youtube".into())));
        assert_eq!(cookie_domain(".bbc.co.uk\tTRUE\t/"), Some(("bbc.co.uk".into(), "bbc".into())));
        assert_eq!(cookie_domain("# Netscape HTTP Cookie File"), None);
    }

    #[test]
    fn explains_errors() {
        let e = last_error("WARNING: x\nERROR: [youtube] abc: Sign in to confirm you\u{2019}re not a bot.\n");
        assert!(e.starts_with("YouTube is blocking") && e.ends_with("not a bot."), "{e}");
        assert!(last_error("ERROR: unable to download video data: HTTP Error 403: Forbidden").starts_with("The site refused"));
        assert_eq!(last_error("ERROR: something new"), "something new");
        assert_eq!(warnings("WARNING: a\nWARNING: a\nx"), ["a"]);
    }

    #[test]
    fn sha_in_reads_both_formats() {
        let h = "ab".repeat(32);
        assert_eq!(sha_in(&format!("{h}  yt-dlp_macos\n{}  yt-dlp.exe", "cd".repeat(32)), "yt-dlp.exe"), Some("cd".repeat(32)));
        assert_eq!(sha_in(&format!("Algorithm : SHA256\r\nHash      : {}\r\n", h.to_uppercase()), ""), Some(h));
        assert_eq!(sha_in("nothing here", ""), None);
    }

    // network: cargo test -- --ignored
    // needs a SOCKS5 proxy on 127.0.0.1:10808
    #[test]
    #[ignore]
    fn proxy_test_is_fast() {
        let r = tauri::async_runtime::block_on(test_proxy("socks5://127.0.0.1:10808".into()));
        println!("{r:?}");
        assert!(r.is_ok());
    }

    #[test]
    #[ignore]
    fn fetches_tools() {
        let dir = std::env::temp_dir().join("pd-tools-test");
        std::fs::create_dir_all(&dir).unwrap();
        fetch_ytdlp(&dir).unwrap();
        let yt = dir.join("yt-dlp-app").join(ytdlp_build().1);
        assert!(Command::new(&yt).arg("--version").status().unwrap().success());
        let t = std::time::Instant::now();
        assert!(Command::new(&yt).arg("--version").status().unwrap().success());
        assert!(t.elapsed().as_secs() < 3, "second yt-dlp start took {:?}", t.elapsed());
        fetch_ffmpeg(&dir).unwrap();
        fetch_deno(&dir).unwrap();
        for n in ["ffmpeg", "ffprobe", "deno"] {
            assert!(Command::new(dir.join(exe(n))).arg(if n == "deno" { "--version" } else { "-version" }).status().unwrap().success());
        }
    }
}
