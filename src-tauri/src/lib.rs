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

// Copy the bundled seed binaries to the app data dir; updates only touch that copy (keeps the macOS signature intact).
// shortcut: never overwrites an existing copy, so a newer bundled ffmpeg won't replace the old one; compare versions when ffmpeg updates matter.
fn seed_bins(app: &AppHandle) -> std::io::Result<()> {
    let dst = bin_dir(app);
    std::fs::create_dir_all(&dst)?;
    // Tauri's resource dir inside the macOS .app; next to the exe in Velopack's Windows/Linux packages
    let exe_dir = std::env::current_exe()?.parent().map(PathBuf::from);
    let Some(entries) =
        [app.path().resource_dir().ok(), exe_dir].into_iter().flatten().find_map(|d| std::fs::read_dir(d.join("resources/bin")).ok())
    else {
        return Ok(());
    };
    for e in entries.flatten() {
        let to = dst.join(e.file_name());
        if e.file_name() != ".gitkeep" && !to.exists() {
            std::fs::copy(e.path(), to)?;
        }
    }
    Ok(())
}

fn ytdlp_exe(app: &AppHandle) -> PathBuf {
    bin_dir(app).join(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" })
}

fn ytdlp(app: &AppHandle) -> Command {
    let dir = bin_dir(app);
    let exe = ytdlp_exe(app);
    // dev builds have no seeded binaries, so fall back to yt-dlp on PATH
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
    cmd
}

fn last_error(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix("ERROR:"))
        .or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()))
        .unwrap_or("yt-dlp failed")
        .trim()
        .to_string()
}

#[derive(serde::Deserialize)]
struct Opts {
    format: String,
    mp3: bool,
    #[serde(default)]
    audio: bool,
    subs: Vec<String>,
    auto_subs: bool,
    embed_subs: bool,
    thumbnail: bool,
    metadata: bool,
    sponsors: bool,
}

#[tauri::command]
async fn probe(app: AppHandle, url: String) -> Result<Value, String> {
    let o = ytdlp(&app)
        .args(["-J", "--flat-playlist", "--no-playlist", "--"])
        .arg(&url)
        .output()
        .map_err(|e| format!("Couldn't start yt-dlp: {e}"))?;
    if !o.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&o.stderr)));
    }
    serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())
}

#[rustfmt::skip]
const DOWNLOAD_ARGS: &[&str] = &[
    "--newline", "--progress", "--no-simulate", "--no-playlist",
    "--progress-template", "download:%(progress)j",
    "--print", "video:%(.{title,thumbnail})j",
    "--print", "after_move:filepath",
    "-o", "%(title)s.%(ext)s", "-P",
];

#[tauri::command]
fn download(app: AppHandle, jobs: State<Jobs>, id: u32, url: String, dir: String, opts: Opts) -> Result<(), String> {
    let mut cmd = ytdlp(&app);
    cmd.args(DOWNLOAD_ARGS).arg(&dir).args(["--merge-output-format", "mp4", "-f"]).arg(&opts.format);
    // video always lands as .mp4, even single-file webm formats
    if !opts.audio {
        cmd.args(["--remux-video", "mp4"]);
    }
    if opts.mp3 {
        cmd.args(["-x", "--audio-format", "mp3"]);
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
        cmd.arg("--embed-thumbnail");
    }
    if opts.metadata {
        cmd.args(["--embed-metadata", "--embed-chapters"]);
    }
    if opts.sponsors {
        cmd.args(["--sponsorblock-remove", "sponsor"]);
    }
    let mut child =
        cmd.arg("--").arg(&url).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Couldn't start yt-dlp: {e}"))?;
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
            Some(Ok(s)) if s.success() => json!({"id": id, "kind": "done", "path": path}),
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
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn ytdlp_out(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let o = ytdlp(app).args(args).output().map_err(|e| format!("Couldn't start yt-dlp: {e}"))?;
    let stdout = String::from_utf8_lossy(&o.stdout);
    if !o.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&o.stderr)));
    }
    Ok(stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string())
}

#[tauri::command]
async fn update_ytdlp(app: AppHandle, nightly: bool) -> Result<String, String> {
    ytdlp_out(&app, &["--update-to", if nightly { "nightly" } else { "stable" }])
}

// managed = the app's own standalone copy, which can update itself; otherwise yt-dlp comes from PATH (pip, brew…)
#[tauri::command]
async fn ytdlp_info(app: AppHandle) -> Result<Value, String> {
    let version = ytdlp_out(&app, &["--version"]).ok();
    Ok(json!({"version": version, "managed": ytdlp_exe(&app).exists()}))
}

// Download the standalone yt-dlp into the app data dir; from then on the app uses it instead of PATH
#[tauri::command]
async fn install_ytdlp(app: AppHandle, nightly: bool) -> Result<String, String> {
    let file = if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else if cfg!(target_arch = "aarch64") {
        "yt-dlp_linux_aarch64"
    } else {
        "yt-dlp_linux"
    };
    let repo = if nightly { "yt-dlp/yt-dlp-nightly-builds" } else { "yt-dlp/yt-dlp" };
    let url = format!("https://github.com/{repo}/releases/latest/download/{file}");
    let fail = |e: &dyn std::fmt::Display| format!("Couldn't download yt-dlp: {e}");
    let dst = ytdlp_exe(&app);
    let tmp = dst.with_extension("part");
    std::fs::create_dir_all(bin_dir(&app)).map_err(|e| fail(&e))?;
    let mut res = ureq::get(&url).call().map_err(|e| fail(&e))?;
    let mut f = std::fs::File::create(&tmp).map_err(|e| fail(&e))?;
    std::io::copy(&mut res.body_mut().as_reader(), &mut f).map_err(|e| fail(&e))?;
    drop(f);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| fail(&e))?;
    }
    // rename last so a failed download never leaves a broken yt-dlp behind
    std::fs::rename(&tmp, &dst).map_err(|e| fail(&e))?;
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
        .setup(|app| Ok(seed_bins(app.handle())?))
        .invoke_handler(tauri::generate_handler![
            probe,
            download,
            cancel,
            update_ytdlp,
            ytdlp_info,
            install_ytdlp,
            check_app_update,
            restart_to_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
