use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};
use velopack::{HttpOptions, UpdateCheck, UpdateInfo, UpdateManager, sources::HttpSource};

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

// aria2 publishes no macOS build and no checksums, so .github/workflows/aria2.yml builds and mirrors 1.37.0 into this repo
fn fetch_aria2(dir: &std::path::Path) -> Result<(), String> {
    let file = if cfg!(windows) {
        "aria2c-windows-x86_64.zip"
    } else if cfg!(target_os = "macos") {
        "aria2c-macos.zip"
    } else if cfg!(target_arch = "aarch64") {
        "aria2c-linux-aarch64.zip"
    } else {
        "aria2c-linux-x86_64.zip"
    };
    let base = format!("{REPO}/releases/download/aria2-1.37.0");
    unzip(dir, fetch(&format!("{base}/{file}"), |_| format!("{base}/SHA2-256SUMS"), file)?, &[exe("aria2c")])
}

// uv installs and runs the Python tools (gallery-dl, later streamlink and spotDL) with a Python of its own
fn fetch_uv(dir: &std::path::Path) -> Result<(), String> {
    let target = if cfg!(windows) {
        "x86_64-pc-windows-msvc.zip"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "aarch64-apple-darwin.tar.gz" } else { "x86_64-apple-darwin.tar.gz" }
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu.tar.gz"
    } else {
        "x86_64-unknown-linux-gnu.tar.gz"
    };
    let url = format!("https://github.com/astral-sh/uv/releases/latest/download/uv-{target}");
    let data = fetch(&url, |_| format!("{url}.sha256"), "")?;
    if cfg!(windows) {
        return unzip(dir, data, &[exe("uv")]);
    }
    // the archive holds uv-<target>/uv and uvx; tar ships with macOS and every Linux
    let tmp = dir.join("uv.tar.gz");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    let ok = Command::new("tar").arg("-xzf").arg(&tmp).arg("-C").arg(dir).arg("--strip-components=1").status().is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(tmp);
    if ok { Ok(()) } else { Err("Couldn't unpack uv".into()) }
}

// The Python tools uv may install; Settings → Tools lists them
const UV_TOOLS: &[&str] = &["gallery-dl"];

// uv with every path inside the app's own folders, its own Python only, and the app's proxy
fn uv(app: &AppHandle, proxy: &str) -> Result<Command, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?.join("uv");
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("uv");
    let mut cmd = tool(app, bin_dir(app).join(exe("uv")));
    cmd.env("UV_TOOL_DIR", data.join("tools"))
        .env("UV_TOOL_BIN_DIR", bin_dir(app))
        .env("UV_PYTHON_INSTALL_DIR", data.join("python"))
        .env("UV_CACHE_DIR", cache)
        .env("UV_PYTHON_PREFERENCE", "only-managed");
    if !proxy.is_empty() {
        cmd.env("HTTP_PROXY", proxy).env("HTTPS_PROXY", proxy).env("ALL_PROXY", proxy);
    }
    Ok(cmd)
}

fn uv_run(app: &AppHandle, proxy: &str, args: &[&str]) -> Result<(), String> {
    let o = uv(app, proxy)?.args(args).output().map_err(|e| format!("Couldn't start uv: {e}"))?;
    if o.status.success() { Ok(()) } else { Err(last_error(&String::from_utf8_lossy(&o.stderr))) }
}

// Installs a Python tool the first time a link needs it (uv itself and a Python, ~50 MB, come along the first time)
// shortcut: the install can't be cancelled and two first uses at once would both install; lock it if that ever happens
fn ensure_tool(app: &AppHandle, name: &str, proxy: &str) -> Result<PathBuf, String> {
    let exe_path = bin_dir(app).join(exe(name));
    if exe_path.exists() {
        return Ok(exe_path);
    }
    let what = match name {
        "gallery-dl" => "gallery",
        _ => name,
    };
    let _ = app.emit("probe-log", format!("Getting {what} support… (first time only)"));
    if !bin_dir(app).join(exe("uv")).exists() {
        fetch_uv(&bin_dir(app))?;
    }
    // pysocks lets gallery-dl use a SOCKS proxy
    uv_run(app, proxy, &["tool", "install", "--force", name, "--with", "pysocks"])?;
    if exe_path.exists() { Ok(exe_path) } else { Err(format!("Couldn't install {name}")) }
}

#[tauri::command]
async fn remove_tool(app: AppHandle, name: String) -> Result<(), String> {
    if !UV_TOOLS.contains(&name.as_str()) {
        return Err("Unknown tool".into());
    }
    uv_run(&app, "", &["tool", "uninstall", &name])
}

// The app ships without yt-dlp, ffmpeg, deno and aria2c; fetch whichever are missing on first launch
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
    if !has("aria2c") {
        fetch_aria2(&dir)?;
    }
    Ok(())
}

// First version-looking word of each tool's version line ("ffmpeg version N-1234-g…" → "N-1234-g…"); null when missing
#[tauri::command]
async fn tool_versions(app: AppHandle) -> Value {
    let v = |name: &str, flag: &str| {
        let o = tool(&app, bin_dir(&app).join(exe(name))).arg(flag).output().ok()?;
        let out = String::from_utf8_lossy(&o.stdout);
        out.lines()
            .next()?
            .split_whitespace()
            .find(|w| w.starts_with(|c: char| c.is_ascii_digit()) || w.starts_with("N-"))
            .map(str::to_string)
    };
    let mut out = json!({"ffmpeg": v("ffmpeg", "-version"), "deno": v("deno", "--version"), "aria2c": v("aria2c", "--version")});
    for t in UV_TOOLS {
        out[*t] = json!(v(t, "--version"));
    }
    out
}

// "Update all": yt-dlp only when a new release is out; ffmpeg and deno track "latest", so re-fetch them. aria2c is pinned.
// The Python tools upgrade through uv
// shortcut: uv itself stays at the version first fetched; re-fetch it here if a tool ever needs a newer uv
#[tauri::command]
async fn update_tools(app: AppHandle, proxy: String) -> Result<String, String> {
    let dir = bin_dir(&app);
    fetch_ffmpeg(&dir)?;
    fetch_deno(&dir)?;
    let py = UV_TOOLS.iter().any(|t| dir.join(exe(t)).exists());
    if py {
        uv_run(&app, &proxy, &["tool", "upgrade", "--all"])?;
    }
    let y = update_ytdlp(app).await?;
    Ok(format!("{y}; ffmpeg{} refreshed", if py { ", deno and the Python tools" } else { " and deno" }))
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
async fn import_cookies(app: AppHandle, browser: String) -> Result<usize, String> {
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
    Ok(n)
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

// Browsers on this computer yt-dlp can import from: the profile folder it reads cookies from must exist, and on macOS
// the app too, since uninstalling leaves the folder behind.
// shortcut: Windows and Linux check the folder only; add an install check if leftover folders confuse people there
#[tauri::command]
fn browsers(app: AppHandle) -> Vec<&'static str> {
    let p = app.path();
    let [home, local, roaming, config] = [p.home_dir(), p.local_data_dir(), p.data_dir(), p.config_dir()].map(|d| d.unwrap_or_default());
    let mac = cfg!(target_os = "macos");
    // (id, macOS apps, profile folder: macOS under Application Support, Windows, Linux under ~/.config), in display order
    let table: [(&str, &[&str], &str, PathBuf, &str); 8] = [
        ("chrome", &["Google Chrome"], "Google/Chrome", local.join("Google/Chrome/User Data"), "google-chrome"),
        (
            "firefox",
            &["Firefox", "Firefox Developer Edition", "Firefox Nightly"],
            "Firefox/Profiles",
            roaming.join("Mozilla/Firefox/Profiles"),
            "",
        ),
        ("edge", &["Microsoft Edge"], "Microsoft Edge", local.join("Microsoft/Edge/User Data"), "microsoft-edge"),
        (
            "brave",
            &["Brave Browser"],
            "BraveSoftware/Brave-Browser",
            local.join("BraveSoftware/Brave-Browser/User Data"),
            "BraveSoftware/Brave-Browser",
        ),
        ("opera", &["Opera"], "com.operasoftware.Opera", roaming.join("Opera Software/Opera Stable"), "opera"),
        ("vivaldi", &["Vivaldi"], "Vivaldi", local.join("Vivaldi/User Data"), "vivaldi"),
        ("chromium", &["Chromium"], "Chromium", local.join("Chromium/User Data"), "chromium"),
        ("whale", &["Whale", "Naver Whale"], "Naver/Whale", local.join("Naver/Naver Whale/User Data"), "naver-whale"),
    ];
    let mut ids: Vec<&str> = table
        .into_iter()
        .filter(|(id, apps, mac_dir, win_dir, linux_dir)| {
            let dirs = if mac {
                vec![config.join(mac_dir)]
            } else if cfg!(windows) {
                vec![win_dir.clone()]
            } else if *id == "firefox" {
                // regular, Snap and Flatpak installs
                ["", "snap/firefox/common/", ".var/app/org.mozilla.firefox/"]
                    .iter()
                    .map(|pre| home.join(format!("{pre}.mozilla/firefox")))
                    .collect()
            } else {
                vec![config.join(linux_dir)]
            };
            let app_found = !mac
                || apps.iter().any(|a| {
                    [PathBuf::from("/Applications"), home.join("Applications")].iter().any(|d| d.join(format!("{a}.app")).exists())
                });
            app_found && dirs.iter().any(|d| d.is_dir())
        })
        .map(|(id, ..)| id)
        .collect();
    // every Mac has Safari, and its cookie folder stays hidden from the app until it has Full Disk Access
    if mac {
        ids.insert(ids.len().min(1), "safari");
    }
    ids
}

#[tauri::command]
fn remove_cookies(app: AppHandle) -> Result<(), String> {
    std::fs::remove_file(cookies_file(&app)).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e.to_string()) })
}

fn tool(app: &AppHandle, exe: PathBuf) -> Command {
    let mut cmd = Command::new(exe);
    // ffmpeg, deno and aria2c are found through PATH
    let path = std::env::var_os("PATH").unwrap_or_default();
    let paths = std::iter::once(bin_dir(app)).chain(std::env::split_paths(&path));
    if let Ok(p) = std::env::join_paths(paths) {
        cmd.env("PATH", p);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    // own process group, so cancel() can stop the tool's child processes too
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    cmd
}

fn ytdlp(app: &AppHandle) -> Command {
    let exe = ytdlp_exe(app);
    // until install_tools has run (or if it failed), fall back to yt-dlp on PATH
    let mut cmd = tool(app, if exe.exists() { exe } else { "yt-dlp".into() });
    // signed-in sessions imported from a browser; yt-dlp also writes refreshed cookies back to this file
    let cookies = cookies_file(app);
    if cookies.exists() {
        cmd.arg("--cookies").arg(cookies);
    }
    cmd
}

// gallery-dl with the app's cookies and proxy; Python buffers a pipe, so make it print each file as it happens
fn gallery(app: &AppHandle, proxy: &str) -> Result<Command, String> {
    let mut cmd = tool(app, ensure_tool(app, "gallery-dl", proxy)?);
    cmd.env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8");
    if !proxy.is_empty() {
        cmd.args(["--proxy", proxy]);
    }
    let cookies = cookies_file(app);
    if cookies.exists() {
        cmd.arg("--cookies").arg(cookies);
    }
    Ok(cmd)
}

// How many files a gallery link holds (-G prints one URL per file, "| " lines are fallbacks); null when cancelled
// shortcut: a large profile is listed in full before the Download button shows; show the button early if that's too slow
#[tauri::command]
async fn gallery_files(app: AppHandle, id: u32, url: String, proxy: String) -> Result<Option<u64>, String> {
    let mut cmd = gallery(&app, &proxy)?;
    cmd.args(["-G", "--"]).arg(&url);
    let mut n = 0u64;
    let count = |line: &str| -> Option<Value> {
        if !line.trim().is_empty() && !line.starts_with("| ") {
            n += 1;
            let _ = app.emit("probe-log", format!("Found {n} files…"));
        }
        None
    };
    match watch(&app, id, start(&app, id, cmd)?, count) {
        None => Ok(None),
        Some(Err(e)) => Err(e),
        Some(Ok(_)) => Ok(Some(n)),
    }
}

// gallery-dl prints each file's path as it saves it ("# path" when it was already there); history keeps their folder
fn gallery_download(app: &AppHandle, id: u32, url: &str, dir: &str, proxy: &str) -> Result<(), String> {
    let mut cmd = gallery(app, proxy)?;
    cmd.arg("-d").arg(dir).arg("--").arg(url);
    let io = start(app, id, cmd)?;
    let (app, dir) = (app.clone(), dir.to_string());
    std::thread::spawn(move || {
        let (mut n, mut last) = (0u64, String::new());
        let r = watch(&app, id, io, |line: &str| {
            let path = line.trim().trim_start_matches("# ");
            if path.is_empty() {
                return None;
            }
            n += 1;
            last = path.to_string();
            Some(json!({"status": "downloading", "files_done": n}))
        });
        let folder = Path::new(&last).parent().map_or(dir, |p| p.to_string_lossy().into_owned());
        finish(&app, id, r.map(|r| r.map(|(_, w)| (folder, w))));
    });
    Ok(())
}

// Direct files and torrents. aria2c has no SOCKS support, and sending the download around the proxy would leak it
// The caller adds its own options, then `--` and the link
fn aria2(app: &AppHandle, dir: &Path, proxy: &str) -> Result<Command, String> {
    if proxy.starts_with("socks") {
        return Err("aria2c can't use a SOCKS proxy. Switch the proxy to HTTP in Settings, or turn it off for this download.".into());
    }
    let exe = bin_dir(app).join(exe("aria2c"));
    if !exe.exists() {
        return Err("aria2c isn't installed yet. Restart the app to fetch it.".into());
    }
    let mut cmd = tool(app, exe);
    // -c resumes the .aria2 control file, so pause (a kill) and resume work; --seed-time=0: never upload after finishing.
    // --follow-*=false: a direct link that serves a .torrent or metalink must not turn into a peer download around the proxy
    // Into a pipe aria2c only flushes its progress line along with the summary, so print that every second
    #[rustfmt::skip]
    cmd.args([
        "--no-conf", "-c", "--console-log-level=notice", "--summary-interval=1", "--download-result=hide",
        "--file-allocation=none", "-x16", "-s16", "--min-split-size=1M", "--seed-time=0", "--auto-file-renaming=true",
        "--follow-torrent=false", "--follow-metalink=false",
    ]);
    cmd.arg("--dir").arg(dir);
    if !proxy.is_empty() {
        cmd.arg(format!("--all-proxy={proxy}"));
    }
    let cookies = cookies_file(app);
    if cookies.exists() {
        cmd.arg("--load-cookies").arg(cookies);
    }
    Ok(cmd)
}

// A magnet's metadata, or the .torrent file a link points to, saved into a folder of its own, then its file list.
// download() gets the saved .torrent, so the metadata is fetched only once
#[tauri::command]
async fn torrent_files(app: AppHandle, id: u32, url: String, proxy: String) -> Result<Value, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("torrents").join(id.to_string());
    // ids restart each launch; the folder may hold an earlier session's torrent
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cmd = aria2(&app, &dir, &proxy)?;
    cmd.args(["--bt-metadata-only=true", "--bt-save-metadata=true", "--"]).arg(&url);
    // shortcut: a magnet nobody seeds waits until the user fetches something else; add a timeout if that confuses people
    match watch(&app, id, start(&app, id, cmd)?, readout) {
        None => return Ok(Value::Null),
        Some(Err(e)) => return Err(e),
        Some(Ok(_)) => {}
    }
    let torrent = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| Some(e.ok()?.path()))
        .find(|p| p.extension().is_some_and(|e| e == "torrent"))
        .ok_or("This link isn't a torrent.")?;
    let out = tool(&app, bin_dir(&app).join(exe("aria2c"))).args(["--no-conf", "-S", "-T"]).arg(&torrent).output().map_err(start_err)?;
    let (name, files) = torrent_list(&String::from_utf8_lossy(&out.stdout));
    if files.is_empty() {
        return Err(format!("Couldn't read this torrent.\n{}", String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or_default()));
    }
    Ok(json!({"torrent": torrent, "name": name, "files": files}))
}

// aria2c -S: "Name: X", then after the "idx|path/length" header "  1|./X/a.mkv" and "   |1.2GiB (1,234,567,890)"
fn torrent_list(s: &str) -> (String, Vec<Value>) {
    let mut name = String::new();
    let mut lines = s.lines();
    for l in lines.by_ref() {
        if let Some(n) = l.strip_prefix("Name: ") {
            name = n.to_string();
        }
        if l == "idx|path/length" {
            break;
        }
    }
    let mut files = vec![];
    while let Some(l) = lines.next() {
        let Some((i, path)) = l.split_once('|') else { continue };
        let Ok(index) = i.trim().parse::<u32>() else { continue };
        let size = lines.next().and_then(|n| n.rsplit_once('(')).map(|(_, n)| n.trim_end_matches(')').replace(',', ""));
        let path = path.strip_prefix("./").unwrap_or(path);
        files.push(json!({"index": index, "path": path, "length": size.and_then(|n| n.parse::<u64>().ok()).unwrap_or(0)}));
    }
    (name, files)
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Tool {
    YtDlp,
    Aria2,
    GalleryDl,
    Streamlink,
    SpotDl,
    Nm3u8,
}

// File types that are never media pages; yt-dlp can't fetch these, aria2c can
#[rustfmt::skip]
const DIRECT: &[&str] = &[
    "zip", "7z", "rar", "tar", "gz", "tgz", "xz", "bz2", "zst", "iso", "img", "dmg", "pkg", "exe", "msi",
    "deb", "rpm", "apk", "appimage", "jar", "bin", "pdf", "epub",
];

// TOOLS-PLAN.md's routing table; no network, only the URL's shape
fn pick_tool(url: &str) -> Tool {
    let u = url.trim().to_ascii_lowercase();
    if u.starts_with("magnet:") {
        return Tool::Aria2;
    }
    let rest = u.split_once("://").map_or(u.as_str(), |(_, r)| r);
    let rest = &rest[..rest.find(['?', '#']).unwrap_or(rest.len())];
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.rsplit('@').next().unwrap_or_default().split(':').next().unwrap_or_default();
    let host = host.strip_prefix("www.").or_else(|| host.strip_prefix("m.")).unwrap_or(host);
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let ext = segs.last().and_then(|s| s.rsplit_once('.')).map_or("", |(_, e)| e);
    let site = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    if ext == "torrent" {
        Tool::Aria2
    } else if site("open.spotify.com") && segs.iter().any(|s| ["track", "album", "playlist", "artist"].contains(s)) {
        Tool::SpotDl
    } else if ext == "m3u8" || ext == "mpd" {
        Tool::Nm3u8
    } else if (site("twitch.tv") || site("kick.com")) && segs.len() == 1 || site("youtube.com") && segs.last() == Some(&"live") {
        Tool::Streamlink
    } else if ["instagram.com", "pixiv.net", "deviantart.com", "imgur.com", "tumblr.com"].iter().any(|d| site(d))
        || site("reddit.com") && segs.first() == Some(&"gallery")
        || (site("x.com") || site("twitter.com")) && segs.contains(&"photo")
    {
        Tool::GalleryDl
    } else if DIRECT.contains(&ext) {
        Tool::Aria2
    } else {
        Tool::YtDlp
    }
}

// The tool the UI should use for this link.
// shortcut: streamlink, spotDL and N_m3u8DL-RE arrive in later phases; until then their links go to yt-dlp
#[tauri::command]
fn route(url: String) -> &'static str {
    match pick_tool(&url) {
        Tool::Aria2 => "aria2c",
        Tool::GalleryDl => "gallery-dl",
        _ => "yt-dlp",
    }
}

// aria2c's once-a-second readout "[#2089b0 400.0KiB/33.2MiB(1%) CN:1 DL:115.7KiB ETA:4m51s]" in yt-dlp's progress shape;
// torrents add "SD:3" and "UL:…"
fn readout(line: &str) -> Option<Value> {
    let body = line.trim().strip_prefix("[#")?.split(']').next()?;
    let mut f = body.split_whitespace().skip(1);
    let (done, total) = f.next()?.split('(').next()?.split_once('/')?;
    let done = bytes(done)?;
    let mut p = json!({"status": "downloading", "downloaded_bytes": done, "total_bytes": bytes(total)?});
    for (k, v) in f.filter_map(|kv| kv.split_once(':')) {
        match k {
            "DL" => p["speed"] = json!(bytes(v)),
            "ETA" => p["eta"] = json!(secs(v)),
            // torrents only: connected peers, seeders among them, and "UL:50KiB(1.2MiB)" = upload speed (uploaded so far)
            "CN" => p["peers"] = json!(v.parse::<u32>().ok()),
            "SD" => p["seeds"] = json!(v.parse::<u32>().ok()),
            "UL" => {
                let (speed, sent) = v.split_once('(').unwrap_or((v, ""));
                p["up"] = json!(bytes(speed));
                if let Some(sent) = bytes(sent.trim_end_matches(')')).filter(|_| done > 0.0) {
                    p["ratio"] = json!(sent / done);
                }
            }
            _ => {}
        }
    }
    Some(p)
}

// "33.2MiB" → bytes
fn bytes(s: &str) -> Option<f64> {
    let i = s.find(|c: char| c.is_ascii_alphabetic())?;
    let unit = match &s[i..] {
        "B" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    s[..i].parse::<f64>().ok().map(|n| n * unit)
}

// "1h4m51s" → seconds
fn secs(s: &str) -> Option<u64> {
    let (mut total, mut n) = (0, 0);
    for c in s.chars() {
        match c {
            '0'..='9' => n = n * 10 + c.to_digit(10)? as u64,
            'h' => (total, n) = (total + n * 3600, 0),
            'm' => (total, n) = (total + n * 60, 0),
            's' => (total, n) = (total + n, 0),
            _ => return None,
        }
    }
    Some(total)
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
    (&["http error 404", "not found (404)", "resource not found"], "The site says this page doesn't exist (404). Check the link."),
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
    #[serde(default)]
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

// tool: "gallery-dl" for image galleries, "aria2c" for direct files and torrents (opts unused; files = "1,3", the torrent files to get), anything else is
// yt-dlp; fast hands yt-dlp's plain HTTP downloads to aria2c, and a failure retries once with yt-dlp's own downloader
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn download(
    app: AppHandle,
    id: u32,
    url: String,
    dir: String,
    proxy: String,
    opts: Option<Opts>,
    tool: Option<String>,
    fast: Option<bool>,
    files: Option<String>,
) -> Result<(), String> {
    if tool.as_deref() == Some("gallery-dl") {
        return gallery_download(&app, id, &url, &dir, &proxy);
    }
    if tool.as_deref() == Some("aria2c") {
        let mut cmd = aria2(&app, Path::new(&dir), &proxy)?;
        if let Some(f) = files {
            if f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit() || b == b',') {
                return Err("Invalid file selection".into());
            }
            cmd.arg(format!("--select-file={f}"));
        }
        cmd.arg("--").arg(&url);
        let io = start(&app, id, cmd)?;
        std::thread::spawn(move || finish(&app, id, watch(&app, id, io, readout)));
        return Ok(());
    }
    let opts = opts.ok_or("No download options")?;
    // aria2c can't do SOCKS, and isn't there until install_tools has fetched it
    let fast = fast.unwrap_or(true) && !proxy.starts_with("socks") && bin_dir(&app).join(exe("aria2c")).exists();
    let io = start(&app, id, ytdlp_download(&app, &url, &dir, &proxy, &opts, fast)?)?;
    std::thread::spawn(move || {
        let mut r = watch(&app, id, io, readout);
        if fast && matches!(r, Some(Err(_))) {
            r = match ytdlp_download(&app, &url, &dir, &proxy, &opts, false).and_then(|c| start(&app, id, c)) {
                Ok(io) => watch(&app, id, io, readout),
                Err(e) => Some(Err(e)),
            };
        }
        finish(&app, id, r);
    });
    Ok(())
}

fn ytdlp_download(app: &AppHandle, url: &str, dir: &str, proxy: &str, opts: &Opts, fast: bool) -> Result<Command, String> {
    let mut cmd = ytdlp(app);
    // an empty --proxy means a direct connection
    cmd.args(["--proxy", proxy]);
    if fast {
        // yt-dlp sets --summary-interval=0, which leaves aria2c's progress stuck in its pipe buffer (see aria2())
        cmd.args(["--downloader", "http:aria2c", "--downloader-args", "aria2c:--summary-interval=1"]);
    }
    // playlist downloads number files by playlist order: "003 - Title.mp4"; the number comes from site data, so only digits pass
    let n = opts.prefix.strip_suffix(" - ").unwrap_or("x");
    if !opts.prefix.is_empty() && (n.is_empty() || n.len() > 6 || !n.bytes().all(|b| b.is_ascii_digit())) {
        return Err("Invalid file number".into());
    }
    cmd.arg("-o").arg(format!("{}%(title)s.%(ext)s", opts.prefix));
    cmd.args(DOWNLOAD_ARGS).arg(dir).arg("--merge-output-format").arg(&opts.container).arg("-f").arg(&opts.format);
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
    cmd.arg("--").arg(url);
    Ok(cmd)
}

// Runs `cmd` as job `id`, so cancel(id) can stop it
fn start(app: &AppHandle, id: u32, mut cmd: Command) -> Result<(ChildStdout, ChildStderr), String> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(start_err)?;
    let io = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    app.state::<Jobs>().0.lock().unwrap().insert(id, child);
    Ok(io)
}

// Streams progress until the job exits: Ok((path, warnings)), Err(explained error), or None when the user stopped it
type Outcome = Option<Result<(String, Vec<String>), String>>;
// `parse` turns a tool's own progress line into a progress event
fn watch(app: &AppHandle, id: u32, (out, mut err): (ChildStdout, ChildStderr), mut parse: impl FnMut(&str) -> Option<Value>) -> Outcome {
    let errs = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    // yt-dlp prints the final path as its last plain line; aria2c logs "Download complete: <path>" before more output
    let (mut last, mut done) = (String::new(), None);
    for line in BufReader::new(out).lines().map_while(Result::ok) {
        match serde_json::from_str::<Value>(&line) {
            Ok(p) if p.get("status").is_some() => drop(app.emit("dl", json!({"id": id, "kind": "progress", "p": p}))),
            Ok(info) => drop(app.emit("dl", json!({"id": id, "kind": "info", "info": info}))),
            Err(_) => match parse(&line) {
                Some(p) => drop(app.emit("dl", json!({"id": id, "kind": "progress", "p": p}))),
                None if line.trim().is_empty() => {}
                // the rest of aria2c's progress summary (see aria2())
                None if [" *** ", "===", "---", "FILE: "].iter().any(|p| line.starts_with(p)) => {}
                None => {
                    if let Some((_, p)) = line.split_once("Download complete: ") {
                        done = Some(p.trim().to_string());
                    }
                    last = line;
                }
            },
        }
    }
    let stderr = errs.join().unwrap_or_default();
    // cancel() removes the child, so a missing entry means the user stopped it
    let child = app.state::<Jobs>().0.lock().unwrap().remove(&id);
    match child.map(|mut c| c.wait()) {
        None => None,
        Some(Ok(s)) if s.success() => Some(Ok((done.unwrap_or(last), warnings(&stderr)))),
        // aria2c reports errors on stdout
        _ => Some(Err(last_error(&format!("{last}\n{stderr}")))),
    }
}

fn finish(app: &AppHandle, id: u32, r: Outcome) {
    let ev = match r {
        None => json!({"id": id, "kind": "cancelled"}),
        Some(Ok((path, warnings))) => json!({"id": id, "kind": "done", "path": path, "warnings": warnings}),
        Some(Err(error)) => json!({"id": id, "kind": "failed", "error": error}),
    };
    let _ = app.emit("dl", ev);
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
    // the latest release's files straight from github.com: no API rate limit, and a timeout (GithubSource has none, so a
    // stalled connection left "Checking…" up forever)
    let feed = HttpSource::new_with_options(
        format!("{REPO}/releases/latest/download"),
        HttpOptions { TimeoutMilliseconds: 120_000, ..Default::default() },
    );
    UpdateManager::new(feed, None, None).map_err(|_| "Updates work in installed builds".to_string())
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
            torrent_files,
            gallery_files,
            remove_tool,
            download,
            cancel,
            update_ytdlp,
            ytdlp_info,
            install_ytdlp,
            install_tools,
            tool_versions,
            update_tools,
            route,
            list_sites,
            import_cookies,
            browsers,
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

    #[test]
    fn routes_every_rule() {
        use Tool::*;
        for (url, want) in [
            ("magnet:?xt=urn:btih:abc&dn=Ubuntu", Aria2),
            ("https://releases.ubuntu.com/x/ubuntu.iso.torrent?x=1", Aria2),
            ("https://open.spotify.com/intl-de/track/abc", SpotDl),
            ("https://open.spotify.com/playlist/abc?si=1", SpotDl),
            ("https://cdn.example.com/live/master.m3u8?token=1", Nm3u8),
            ("https://example.com/stream.MPD", Nm3u8),
            ("https://www.twitch.tv/somechannel", Streamlink),
            ("https://kick.com/somechannel", Streamlink),
            ("https://www.youtube.com/@chan/live", Streamlink),
            ("https://www.twitch.tv/videos/123", YtDlp),
            ("https://www.instagram.com/p/abc/", GalleryDl),
            ("https://imgur.com/a/abc", GalleryDl),
            ("https://www.reddit.com/gallery/abc", GalleryDl),
            ("https://x.com/u/status/1/photo/1", GalleryDl),
            ("https://x.com/u/status/1", YtDlp),
            ("https://example.com/files/setup.EXE", Aria2),
            ("https://user:pw@example.com:8080/a.tar.gz#x", Aria2),
            ("https://www.youtube.com/watch?v=abc.zip", YtDlp),
            ("https://soundcloud.com/a/b", YtDlp),
        ] {
            assert_eq!(pick_tool(url), want, "{url}");
        }
    }

    #[test]
    fn reads_aria2_readout() {
        let p = readout("[#2089b0 400.0KiB/33.2MiB(1%) CN:1 DL:115.7KiB ETA:1h4m51s]").unwrap();
        assert_eq!(p["downloaded_bytes"], 409600.0);
        assert_eq!(p["speed"], 115.7 * 1024.0);
        assert_eq!(p["eta"], 3891);
        assert_eq!(readout(" [#a 0B/0B CN:1 DL:0B](+1)").unwrap()["total_bytes"], 0.0);
        assert_eq!(readout("[#a SEED(0.0) CN:0 SD:0]"), None);
        assert_eq!(readout("/Users/x/file.mp4"), None);
    }

    #[test]
    fn reads_torrents() {
        let p = readout("[#a 2.0MiB/10MiB(20%) CN:40 SD:12 DL:1.0MiB UL:50KiB(1.0MiB) ETA:8s]").unwrap();
        assert_eq!((p["peers"].clone(), p["seeds"].clone(), p["up"].clone()), (json!(40), json!(12), json!(51200.0)));
        assert_eq!(p["ratio"], 0.5);
        let s = "*** BitTorrent File Information ***\nComment: 7|x\nName: Big Show\nFiles:\nidx|path/length\n===+===\n  1|./Big Show/a|b.mkv\n   |1.1GiB (1,234,567,890)\n---+---\n 12|./Big Show/c.srt\n   |12KiB (12,288)\n---+---\n";
        let (name, files) = torrent_list(s);
        assert_eq!(name, "Big Show");
        assert_eq!(
            files,
            [
                json!({"index": 1, "path": "Big Show/a|b.mkv", "length": 1234567890u64}),
                json!({"index": 12, "path": "Big Show/c.srt", "length": 12288})
            ]
        );
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
    fn fetches_uv() {
        let dir = std::env::temp_dir().join("pd-uv-test");
        std::fs::create_dir_all(&dir).unwrap();
        fetch_uv(&dir).unwrap();
        assert!(Command::new(dir.join(exe("uv"))).arg("--version").status().unwrap().success());
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
        fetch_aria2(&dir).unwrap();
        for n in ["ffmpeg", "ffprobe", "deno", "aria2c"] {
            assert!(
                Command::new(dir.join(exe(n))).arg(if n.starts_with("ff") { "-version" } else { "--version" }).status().unwrap().success()
            );
        }
    }
}
