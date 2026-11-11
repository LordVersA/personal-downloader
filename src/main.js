import { supportedSources } from "./supported-sources.js";
import { toolVersion } from "./tool-version.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { opener, notification } = window.__TAURI__;
const isMac = navigator.userAgent.includes("Mac");
const finder = isMac ? "Show in Finder" : "Show in folder";

const ICON = {
  stop: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v12m-5-5 5 5 5-5M5 20h14"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="m7 4 13 8-13 8z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
};

const $ = (s) => document.querySelector(s);
const form = $("#intake");
const pick = $("#pick");
const strip = $("#strip");
const queue = $("#queue");
const store = (k, v) => { try { v === undefined ? (v = localStorage[k]) : (localStorage[k] = v); } catch {} return v; };
const load = (k) => { try { return JSON.parse(store(k)); } catch {} };

let nextId = 1;
let toolsBusy = true;
const items = []; // this session's queue: queued, active or failed; done ones move to history
let batch = 0, finished = 0; // "n of m" since the queue last emptied
let saved = null; // last finished download, shown in the strip for a few seconds
let dir = store("dir");
// "" = direct connection; credentials are URL-encoded so @ and : in a password survive
const PROXY_KEYS = ["type", "host", "port", "user", "pass"];
const pf = (k) => $(`#proxy-${k}`);
function proxy() {
  const [type, host, port, user, pass] = PROXY_KEYS.map((k) => pf(k).value.trim());
  if (!type || !host) return "";
  const auth = user ? `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ""}@` : "";
  return `${type}://${auth}${host}${port ? `:${port}` : ""}`;
}
let history = load("history") ?? [];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`);
// shortcut: wraps past 24 h; fine for videos
const dur = (s) => new Date(s * 1000).toISOString().slice(s >= 3600 ? 11 : 14, 19);
const eta = (s) => (s < 60 ? `${Math.round(s)} s left` : `${Math.round(s / 60)} min left`);
const codec = (c) => { c = c?.split(".")[0]; return { avc1: "h264", vp09: "vp9", av01: "av1", mp4a: "aac" }[c] ?? c ?? ""; };
// English dates even on a Farsi system, since the UI is English
function when(t) {
  const d = new Date(t), days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) });
}

// Shared rows for queue and media previews. meta entries are trusted HTML; escape before passing.
const metaHtml = (meta) => meta.filter(Boolean).map((m) => `<span class="nums" dir="auto">${m}</span>`).join("");
const thumbnails = new Map();
async function loadThumbnail(el, url) {
  const key = `${proxy()}|${url}`;
  if (!thumbnails.has(key)) {
    const request = invoke("thumbnail", { url, proxy: proxy() }).then(({ mime, bytes }) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    })).catch(() => { thumbnails.delete(key); return null; });
    thumbnails.set(key, request);
    // shortcut: cache 80 previews in memory; use a disk cache if offline previews become necessary.
    if (thumbnails.size > 80) thumbnails.delete(thumbnails.keys().next().value);
  }
  const data = await thumbnails.get(key);
  if (data) {
    const img = new Image();
    img.alt = "";
    img.onerror = () => { el.title = "Preview unavailable. You can still download this item."; };
    img.onload = () => el.replaceChildren(img);
    img.src = data;
  } else el.title = "Preview unavailable. You can still download this item.";
}
const thumbObserver = new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) if (isIntersecting) {
    thumbObserver.unobserve(target);
    loadThumbnail(target, target.dataset.thumb);
  }
}, { rootMargin: "120px" });
function row(tag, cls, thumb, title, meta, right = "", mid = "") {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = `
    <span class="thumb-img" aria-hidden="true">${ICON.down}</span>
    <span class="body">
      <span class="name" dir="auto" title="${esc(title)}">${esc(title)}</span>${mid}
      <span class="meta">${metaHtml(meta)}</span>
    </span>${right}`;
  if (thumb) { e.firstElementChild.dataset.thumb = thumb; thumbObserver.observe(e.firstElementChild); }
  return e;
}
const btn = (act, label, icon) => `<button class="icon" type="button" data-act="${act}" aria-label="${label}" title="${label}">${icon}</button>`;

/* Pages */

const tabs = [...document.querySelectorAll(".toolbar [role=tab]")];
function show(page) {
  for (const t of tabs) {
    const on = t.dataset.page === page;
    t.setAttribute("aria-selected", on);
    $(`#${t.dataset.page}`).hidden = !on;
  }
  scrollTo(0, 0);
}
tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.page)));
document.querySelectorAll("[data-setting]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-setting]").forEach((b) => b.setAttribute("aria-pressed", b === button));
  document.querySelectorAll("[data-settings]").forEach((panel) => panel.hidden = panel.dataset.settings !== button.dataset.setting);
}));

// ⌘V / Ctrl+V outside a text field pastes into the link field
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "v" && !e.target.closest("input, select, textarea")) {
    show("download");
    form.link.focus();
  }
});

/* Quality picker */

let info, infoUrl, choices = [];
let opts = { container: "mp4", afmt: "mp3", ...(load("opts") ?? { metadata: true, embed: true, thumbnail: false, sponsors: false, subs: [], auto: "" }) };
const compact = (n) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
const unit = () => (info?.music || pl?.music ? "song" : "video");
const plural = (n, w) => `${compact(n)} ${w}${n === 1 ? "" : "s"}`; // chapters, subtitles

// A playlist's videos each have their own formats, so it gets height caps that fit any video
const HEIGHTS = [2160, 1440, 1080, 720, 480];
const LANGS = { en: "English", fa: "Farsi", ar: "Arabic", es: "Spanish", fr: "French", de: "German", ru: "Russian", tr: "Turkish", pt: "Portuguese", it: "Italian", hi: "Hindi", ja: "Japanese", ko: "Korean", zh: "Chinese" };

function buildChoices() {
  // Spotify songs: audio only, chosen before yt-dlp has seen the video
  if (info._type === "playlist" || info.music) {
    choices = [
      { group: "Video", q: "Best", d: ["", "Highest available"], format: "bv*+ba/b", size: 0 },
      ...HEIGHTS.map((h) => ({ group: "Video", q: `${h}p`, d: ["", "or the best below"], format: `bv*[height<=${h}]+ba/b[height<=${h}]`, size: 0 })),
      { group: "Audio", q: "Convert", d: ["", "Best audio, re-encoded"], format: "ba/b", convert: true, audio: true, size: 0 },
      // m4a first: it takes a cover; webm audio can't
      { group: "Audio", q: "Original", d: ["", "Best audio as served"], format: "ba[ext=m4a]/ba/b", audio: true, ext: "m4a", size: 0 },
    ].filter((c) => c.audio || !info.music);
    return;
  }
  const d = info.duration;
  const size = (f) => f.filesize ?? f.filesize_approx ?? (f.tbr && d ? f.tbr * d * 125 : 0);
  const hls = (f) => (f.protocol?.startsWith("m3u8") ? 1 : 0); // prefer direct downloads over HLS duplicates
  const mp4 = (f) => (f.ext === "mp4" ? 0 : 1); // files always end up as .mp4; native mp4 streams play everywhere
  const fs = (info.formats ?? []).filter((f) => f.ext !== "mhtml"); // storyboards
  const audio = fs.filter((f) => f.vcodec === "none" && f.acodec !== "none")
    .sort((a, b) => hls(a) - hls(b) || (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0));
  const video = fs.filter((f) => f.vcodec !== "none")
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || mp4(a) - mp4(b) || (b.fps ?? 0) - (a.fps ?? 0) || hls(a) - hls(b) || (b.tbr ?? 0) - (a.tbr ?? 0));
  const ba = audio[0] ? size(audio[0]) : 0;
  const withAudio = (f) => size(f) + (f.acodec === "none" ? ba : 0);
  const fps = (f) => (f.fps > 30 ? Math.round(f.fps) : "");
  const vid = (f, group, q) => ({
    group,
    q,
    d: [codec(f.vcodec), f.width && f.height && `${f.width}×${f.height}`, fps(f) && `${fps(f)} fps`, f.dynamic_range && f.dynamic_range !== "SDR" && f.dynamic_range,
      f.vbr || f.tbr ? `${Math.round(f.vbr || f.tbr)} kbps` : "", f.acodec !== "none" && "+ audio"],
    format: f.acodec === "none" ? `${f.format_id}+ba[ext=m4a]/${f.format_id}+ba/${f.format_id}` : f.format_id,
    size: withAudio(f),
  });
  const aud = (f, group, q) => ({ group, q, d: [codec(f.acodec), f.abr && `${Math.round(f.abr)} kbps`, f.asr && `${f.asr / 1000} kHz`, f.audio_channels > 2 && `${f.audio_channels} ch`, f.language], format: f.format_id, audio: true, ext: f.ext, size: size(f) });
  // video is sorted best-first, so the first format of each height is that height's best
  const heights = new Set();
  const perHeight = video.filter((f) => f.height && !heights.has(f.height) && heights.add(f.height));
  const top = video[0];
  // audio-only sources (SoundCloud, podcasts…) get no Video section; no formats at all keeps yt-dlp's own "best"
  const audioOnly = !video.length && audio.length;
  choices = [
    audioOnly ? null : top ? { ...vid(top, "Video", "Best"), d: [codec(top.vcodec), top.height && `${top.height}p`, fps(top) && `${fps(top)} fps`] } : { group: "Video", q: "Best", d: ["", "Highest available"], format: "bv*+ba/b", size: 0 },
    ...perHeight.map((f) => vid(f, "Video", `${f.height}p`)),
    { group: "Audio", q: "Convert", d: ["", "Best audio, re-encoded"], format: "ba/b", convert: true, audio: true, size: ba },
    ...(audio[0] ? [aud(audio[0], "Audio", "Original")] : []),
    ...video.map((f) => vid(f, "All", f.height ? `${f.height}p${fps(f)}` : (f.format_note ?? f.format_id))),
    ...audio.map((f) => aud(f, "All", f.abr ? `${Math.round(f.abr)} kbps` : (f.format_note ?? f.format_id))),

  ].filter(Boolean);
}

function renderPick() {
  pick.dataset.step = "pick";
  buildChoices();
  const subs = Object.keys(info.subtitles ?? {}).filter((l) => l !== "live_chat");
  const auto = Object.entries(info.automatic_captions ?? {});
  const list = info._type === "playlist";
  const opt = (c, i) => `
    <label class="opt"><input type="radio" name="q" value="${i}" ${i ? "" : "checked"} />
      <span class="q">${esc(c.q)}</span><span class="d">${c.d[0] ? `<i class="tag">${esc(c.d[0])}</i>` : ""}${c.d.slice(1).filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")}</span><span class="s nums">${c.size ? mb(c.size) : ""}</span></label>`;
  const group = (g) => choices.map((c, i) => (c.group === g ? opt(c, i) : "")).join("");
  const toggle = (name, label) => `<label class="toggle"><input type="checkbox" name="${name}" ${opts[name] ? "checked" : ""} /><span>${label}</span></label>`;
  const select = (name, vals) => `<select name="${name}">${vals.map((v) => `<option value="${v}" ${opts[name] === v ? "selected" : ""}>${v.toUpperCase()}</option>`).join("")}</select>`;
  const all = choices.filter((c) => c.group === "All").length;
  const count = info._type === "playlist" && plural(info.entries.length, unit());
  pick.innerHTML = `
    <header class="pick-head">${btn("close", "Close", ICON.stop)}</header>
    <div class="picker-guide"><b>Choose your quality</b><span>Best keeps the highest available quality. Choose Audio to save music only.</span></div>
    <div class="choices">
      ${group("Video") ? `<fieldset><legend>Video</legend>${group("Video")}</fieldset>` : ""}
      <fieldset><legend>Audio</legend>${group("Audio")}</fieldset>
      ${all ? `<details class="all"><summary>All formats (${all})</summary><fieldset>${group("All")}</fieldset></details>` : ""}
    </div>
    <footer class="pick-foot">
      <details class="opts"><summary><b>Options</b><svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg><span id="opts-sum"></span></summary>
        <div class="panel card">
          ${list ? `<fieldset class="subs"><legend>Subtitles</legend>
            <select name="sublang" aria-label="Subtitle language"><option value="">None</option>
              ${Object.entries(LANGS).map(([l, n]) => `<option value="${l}" ${l === opts.lang ? "selected" : ""}>${n}</option>`).join("")}</select>
            ${toggle("autosubs", "Auto-generated if none")}
          </fieldset>` : ""}
          ${subs.length || auto.length ? `<fieldset class="subs"><legend>Subtitles</legend>
            ${subs.map((l) => `<label class="chip"><input type="checkbox" name="sub" value="${esc(l)}" ${opts.subs.includes(l) ? "checked" : ""} /><span>${esc(info.subtitles[l][0]?.name ?? l)}</span></label>`).join("")}
            ${auto.length ? `<select name="auto" aria-label="Auto-generated subtitles"><option value="">Auto-generated: none</option>
              ${auto.map(([l, f]) => `<option value="${esc(l)}" ${l === opts.auto ? "selected" : ""}>${esc(f[0]?.name ?? l)}</option>`).join("")}</select>` : ""}
          </fieldset>` : ""}
          <fieldset><legend>Options</legend>
            ${subs.length || auto.length || list ? toggle("embed", "Embed subtitles in video") : ""}
            ${list ? toggle("number", "Number files by playlist order") : ""}
            ${toggle("metadata", "Add metadata and chapters")}
            ${toggle("thumbnail", "Embed thumbnail")}
            ${info.extractor_key === "Youtube" ? toggle("sponsors", "Cut sponsor segments") : ""}
          </fieldset>
          <fieldset class="formats"><legend>File format</legend>
            <label>Video ${select("container", ["mp4", "mkv", "webm", "mov"])}</label>
            <label>Audio ${select("afmt", ["mp3", "m4a", "opus", "flac", "wav"])}</label>
          </fieldset>
        </div>
      </details>
      <button class="key" type="submit" id="go"></button>
    </footer>`;
  pick.firstElementChild.prepend(row("div", "item", info.thumbnail ?? info.thumbnails?.at(-1)?.url, info.title ?? infoUrl,
    [esc(info.uploader ?? info.channel ?? info.extractor_key ?? ""), info.duration && dur(info.duration), count]));
  if (!list && !info.music) pick.firstElementChild.after(about());
  pick.hidden = false;
  updatePick();
  renderHistory();
}

// Facts yt-dlp found about the video; each shows only when the site reports it
function about() {
  const i = info;
  const day = i.upload_date && new Date(`${i.upload_date.slice(0, 4)}-${i.upload_date.slice(4, 6)}-${i.upload_date.slice(6)}`);
  const live = { is_live: "Live now", was_live: "Live recording", is_upcoming: "Upcoming", post_live: "Live recording (processing)" }[i.live_status];
  const stats = [[i.view_count, "views"], [i.like_count, "likes"], [i.comment_count, "comments"], [i.channel_follower_count, "followers"]].filter(([n]) => n != null);
  const facts = [
    day && day.toLocaleDateString(undefined, { dateStyle: "medium" }),
    live,
    i.age_limit >= 18 && "18+",
    i.availability && i.availability !== "public" && i.availability.replace(/_/g, " "),
    i.chapters?.length && plural(i.chapters.length, "chapter"),
    Object.keys(i.subtitles ?? {}).filter((l) => l !== "live_chat").length && plural(Object.keys(i.subtitles).filter((l) => l !== "live_chat").length, "subtitle"),
    i.categories?.[0],
  ].filter(Boolean);
  const el = document.createElement("div");
  el.className = "about";
  el.innerHTML = (stats.length ? `<p class="stats nums">${stats.map(([n, w]) => `<span><b>${compact(n)}</b> ${w}</span>`).join("")}</p>` : "") +
    `<p class="facts">${facts.map((f) => `<i class="tag">${esc(f)}</i>`).join("")}</p>` +
    (i.description ? `<details class="desc"><summary>Description</summary><p dir="auto">${esc(i.description)}</p></details>` : "");
  return el;
}

// Reads the current choices; the Download label, options summary and remembered options follow them
function readPick() {
  const c = choices[pick.q.value];
  const subs = [...pick.querySelectorAll("[name=sub]:checked")].map((x) => x.value);
  const autoLang = pick.auto?.value ?? "";
  // a playlist's language matches every regional variant (en-US, en-GB…); yt-dlp skips videos without it
  if (pick.sublang?.value) subs.push(`${pick.sublang.value}.*`);
  return { c, subs, autoLang, has: (n) => !!pick[n]?.checked };
}

function updatePick() {
  const { c, subs, autoLang, has } = readPick();
  $("#go").textContent = `Download ${info._type === "playlist" ? `${plural(info.entries.length, unit())} · ` : ""}${c?.audio ? (c.convert ? pick.afmt.value : c.ext ?? "") .toUpperCase() : pick.container.value.toUpperCase()}${c?.size ? ` · ${mb(c.size)}` : ""}`.replace("  ", " ");
  const langs = [...subs, autoLang].filter(Boolean);
  $("#opts-sum").textContent = [langs.length && `Subtitles (${langs.join(", ")})`, has("metadata") && "Metadata", has("thumbnail") && "Thumbnail", has("sponsors") && "Sponsors cut"]
    .filter(Boolean).join(" · ") || "None";
}

function closePick() {
  if (pl?.loading) invoke("cancel", { id: probeId });
  pl = null;
  delete pick.dataset.step;
  pick.hidden = true;
  pick.replaceChildren();
  renderHistory();
}

const recount = () => ({ list: listCount, torrent: torrentCount, pick: updatePick })[pick.dataset.step]?.();
pick.addEventListener("change", recount);
pick.addEventListener("click", (e) => e.target.closest("[data-act=close]") && closePick());
document.addEventListener("pointerdown", (e) => { const d = pick.querySelector(".opts[open]"); if (d && !d.contains(e.target)) d.open = false; });
pick.addEventListener("submit", (e) => {
  e.preventDefault();
  if (pick.dataset.step === "list") return; // Enter in the list's search field
  if (pick.dataset.step === "file" || pick.dataset.step === "gallery") {
    const g = pick.dataset.step === "gallery";
    enqueue({ ...pick.file, label: g ? "Images" : "File", tool: g ? "gallery-dl" : pick.file.tool ?? "aria2c", opts: null });
    form.link.value = "";
    return closePick();
  }
  if (pick.dataset.step === "live") {
    const { url, title, author } = pick.live, quality = pick.q.value, minutes = Math.round(Math.max(0, Number(pick.minutes.value))) || null;
    enqueue({ url, title, author, quality, minutes, label: quality, tool: "streamlink", live: true, opts: null });
    form.link.value = "";
    return closePick();
  }
  if (pick.dataset.step === "torrent") {
    const { torrent, name, files } = pick.torrent, sel = torrentSel();
    if (!sel.length) return;
    enqueue({ url: torrent, title: name || files[0].path, label: "Torrent", tool: "aria2c", opts: null, size: sel.reduce((a, f) => a + f.length, 0),
      files: sel.length === files.length ? null : sel.map((f) => f.index).join(",") });
    form.link.value = "";
    return closePick();
  }
  const { c, subs, autoLang, has } = readPick();
  // remember the toggles that exist for this video; keep the others as they were
  for (const n of ["metadata", "embed", "thumbnail", "sponsors", "autosubs", "number"]) if (pick[n]) opts[n] = has(n);
  Object.assign(opts, { container: pick.container.value, afmt: pick.afmt.value });
  if (pick.querySelector("[name=sub], [name=auto]")) Object.assign(opts, { subs, auto: autoLang });
  if (pick.sublang) opts.lang = pick.sublang.value;
  store("opts", JSON.stringify(opts));
  const it = {
    label: c.audio ? (c.convert ? opts.afmt.toUpperCase() : "Audio") : `${c.q === "Best" ? c.d.find((value) => /^\d+p$/.test(value)) ?? c.q : c.q} · ${opts.container.toUpperCase()}`,
    size: c.size,
    opts: {
      format: c.format,
      container: opts.container,
      convert: c.convert ? opts.afmt : "",
      audio: !!c.audio,
      subs: autoLang ? [...subs, autoLang] : subs,
      auto_subs: !!autoLang || (!!pick.sublang?.value && has("autosubs")),
      embed_subs: !c.audio && has("embed"),
      // music always gets full tags and cover art; WAV and WebM audio can't hold a cover
      thumbnail: has("thumbnail") || (!!c.audio && !["wav", "webm"].includes(c.convert ? opts.afmt : c.ext)),
      metadata: has("metadata") || !!c.audio,
      sponsors: has("sponsors"),
    },
  };
  if (info._type !== "playlist") enqueue({ ...it, url: infoUrl, title: info.title ?? infoUrl, thumb: info.thumbnail ?? info.thumbnails?.at(-1)?.url });
  else {
    // each video is its own queue item, saved in a folder named after the playlist
    const folder = `${dir}${dir.endsWith(SEP) ? "" : SEP}${safeName(info.title)}`;
    const width = String(pl.entries.length).length;
    enqueue(...info.entries.map((e) => ({
      ...it, url: e.webpage_url ?? e.url, title: e.title ?? e.url, thumb: thumbOf(e), dir: folder,
      opts: { ...it.opts, prefix: has("number") ? `${String(Number.isInteger(e.playlist_index) ? e.playlist_index : pl.entries.indexOf(e) + 1).padStart(width, "0")} - ` : "" },
    })));
  }
  form.link.value = "";
  closePick();
});

const errorEl = $("#error");
$("#open-torrent").addEventListener("click", async () => {
  if (toolsBusy) { errorEl.textContent = "Tools are being prepared. Please try again when they’re ready."; errorEl.hidden = false; return; }
  try {
    const path = await window.__TAURI__.dialog.open({ multiple: false, filters: [{ name: "Torrent file", extensions: ["torrent"] }] });
    if (path) { errorEl.hidden = true; resetProbeLog(); infoUrl = path; await torrentPick(path); }
  } catch (error) { errorEl.innerHTML = errHtml(error); errorEl.hidden = false; }
});
$("#use").addEventListener("change", () => {
  $("#engine-note").textContent = TOOLS[$("#use").value]?.[0] ?? "Chooses the right tool for your link.";
});
const logEl = $("#probe-log");
const logLines = [], fullLog = $("#log-full");
let logTotal = 0, logAnimation;
function resetProbeLog() {
  logLines.length = logTotal = 0;
  fullLog.replaceChildren();
  $("#log-lines").replaceChildren();
  $("#log-latest").textContent = "";
  $("#log-toggle").setAttribute("aria-expanded", "false");
  $("#log-toggle").textContent = "Show all";
  fullLog.hidden = true;
  $("#log-preview").hidden = false;
  logEl.hidden = true;
}
function appendProbeLog(message) {
  const lines = String(message).split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return;
  const follow = fullLog.hidden || fullLog.scrollHeight - fullLog.scrollTop - fullLog.clientHeight < 24;
  for (const line of lines) {
    logLines.push(line);
    logTotal++;
    fullLog.append(document.createTextNode(`${line}\n`));
    // shortcut: retain 2,000 lines per link to bound memory during long-running probes.
    if (logLines.length > 2000) { logLines.shift(); fullLog.firstChild.remove(); }
  }
  const preview = $("#log-lines");
  preview.replaceChildren(...logLines.slice(-5).map((line) => {
    const p = document.createElement("p");
    p.textContent = line;
    p.dir = "auto";
    return p;
  }));
  $("#log-count").textContent = `${logTotal > logLines.length ? `${logLines.length.toLocaleString("en")} latest of ` : ""}${logTotal.toLocaleString("en")} ${logTotal === 1 ? "line" : "lines"}`;
  $("#log-latest").textContent = logLines.at(-1);
  logEl.hidden = false;
  if (follow) fullLog.scrollTop = fullLog.scrollHeight;
  if (fullLog.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    logAnimation?.cancel();
    logAnimation = preview.animate([{ transform: "translateY(22px)" }, { transform: "translateY(0)" }], { duration: 220, easing: "ease-out" });
  }
}
$("#log-toggle").addEventListener("click", () => {
  const expanded = fullLog.hidden;
  fullLog.hidden = !expanded;
  $("#log-preview").hidden = expanded;
  $("#log-toggle").setAttribute("aria-expanded", expanded);
  $("#log-toggle").textContent = expanded ? "Show less" : "Show all";
  if (expanded) fullLog.scrollTop = fullLog.scrollHeight;
});
listen("probe-log", (e) => appendProbeLog(e.payload));
const fetchBtn = $("#fetch");
let probeId = 0; // the running fetch; a newer one makes older results stale
let got = 0; // lines the running fetch has sent
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = form.link.value.trim();
  errorEl.hidden = true;
  if (toolsBusy) {
    errorEl.textContent = "Tools are being prepared. Please try again when they’re ready.";
    errorEl.hidden = false;
    return;
  }
  if (!url) {
    form.classList.remove("shake");
    void form.offsetWidth; // restart the animation
    form.classList.add("shake");
    return;
  }
  try { aria2Options(); } catch (error) { errorEl.textContent = error; errorEl.hidden = false; return; }
  resetProbeLog();
  infoUrl = url;
  // Direct files, torrents and galleries skip the video probe; the tool selector overrides routing.
  const use = $("#use").value || (await invoke("route", { url }));
  if (use === "N_m3u8DL-RE") return filePick(url, use);
  if (use === "aria2c") return isTorrent(url) ? torrentPick(url) : filePick(url);
  if (use === "gallery-dl") return galleryPick(url, !!$("#use").value);
  if (use === "streamlink") return livePick(url, !!$("#use").value);
  if (use === "spotify") return spotifyPick(url);
  // a YouTube channel lists one tab at a time
  const base = url.match(CHANNEL)?.[1];
  fetchLink(base ? `${base}/videos` : url, base && { base, tab: "videos" });
});

// tab: open the list right away for that channel tab; otherwise the first line says whether it's a video or a list
async function fetchLink(url, tab) {
  if (probeId) invoke("cancel", { id: probeId });
  const id = (probeId = nextId++);
  got = 0;
  pl = null;
  if (tab) openList(tab);
  fetchBtn.classList.add("busy");
  fetchBtn.textContent = "Fetching…";
  appendProbeLog("Reading the link…");
  logEl.hidden = false;
  try {
    await invoke("probe", { id, url, proxy: proxy() });
    if (id === probeId && !got) throw "There's nothing to download at this link.";
  } catch (err) {
    if (id !== probeId) return;
    err = signedInAnyway(err);
    errorEl.innerHTML = errHtml(err);
    errorEl.hidden = false;
    if (needsCookies(err)) askCookies(err, () => fetchLink(url, tab));
  } finally {
    if (id === probeId) {
      fetchBtn.classList.remove("busy");
      fetchBtn.textContent = "Find download";
      if (pl) pl.loading = false;
      if (pick.dataset.step === "list") listCount();
    }
  }
}

listen("probe-entry", ({ payload: { id, entry } }) => {
  // past the list step the selection is fixed
  if (id !== probeId || (pl && pick.dataset.step !== "list")) return;
  got++;
  // a single video comes back whole; list entries carry their place in the playlist
  if (!pl && entry.playlist_index == null && entry._type !== "url") {
    info = entry;
    return renderPick();
  }
  if (!pl) openList({});
  addEntry(entry);
});

// A direct file or torrent: its name (from the link) and a Download button
function filePick(url, tool = "aria2c") {
  if (probeId) invoke("cancel", { id: probeId });
  probeId = 0;
  closePick();
  fetchBtn.classList.remove("busy");
  fetchBtn.textContent = "Fetch";
  logEl.hidden = true;
  let name = url;
  try {
    const u = new URL(url);
    name = u.searchParams.get("dn") || decodeURIComponent(u.pathname.split("/").at(-1)) || url;
  } catch {}
  pick.dataset.step = "file";
  pick.innerHTML = `<header class="pick-head">${btn("close", "Close", ICON.stop)}</header>
    <footer class="pick-foot"><span class="grow"></span><button class="key" type="submit">Download</button></footer>`;
  pick.firstElementChild.prepend(row("div", "item", null, name, ["File"]));
  pick.file = { url, title: name, tool };
  pick.hidden = false;
  renderHistory();
}

// An image gallery: count its files, then one Download button. A link gallery-dl can't read goes to yt-dlp unless
// the user selected gallery-dl under Download with
async function galleryPick(url, forced) {
  if (probeId) invoke("cancel", { id: probeId });
  closePick();
  const id = (probeId = nextId++);
  fetchBtn.classList.add("busy");
  fetchBtn.textContent = "Fetching…";
  appendProbeLog("Looking for images…");
  logEl.hidden = false;
  let n;
  try {
    n = await invoke("gallery_files", { id, url, proxy: proxy() });
    if (id !== probeId || n == null) return;
    if (!n && forced) throw "There's nothing to download at this link.";
  } catch (err) {
    if (id !== probeId) return;
    if (forced) {
      errorEl.innerHTML = errHtml(err);
      errorEl.hidden = false;
      return;
    }
  } finally {
    if (id === probeId) {
      probeId = 0;
      fetchBtn.classList.remove("busy");
      fetchBtn.textContent = "Find download";
    }
  }
  if (!n) return fetchLink(url);
  let name = url;
  try {
    const u = new URL(url);
    name = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {}
  pick.dataset.step = "gallery";
  pick.innerHTML = `<header class="pick-head">${btn("close", "Close", ICON.stop)}</header>
    <footer class="pick-foot"><span class="grow"></span><button class="key" type="submit">Download · ${plural(n, "file")}</button></footer>`;
  pick.firstElementChild.prepend(row("div", "item", null, name, [plural(n, "file")]));
  pick.file = { url, title: name, count: n };
  pick.hidden = false;
  renderHistory();
}

// A Spotify link: its tracks from Spotify's embed page, each fetched as YouTube Music's first song result. An album,
// playlist or artist opens the song list; a single track goes straight to the audio choices
// shortcut: no check that the YouTube Music match is the same song (duration, artist); compare durations if users hit misses
async function spotifyPick(url) {
  if (probeId) invoke("cancel", { id: probeId });
  closePick();
  const id = (probeId = nextId++);
  fetchBtn.classList.add("busy");
  fetchBtn.textContent = "Fetching…";
  appendProbeLog("Reading the Spotify link…");
  logEl.hidden = false;
  let s;
  try {
    s = await invoke("spotify_tracks", { url, proxy: proxy() });
    if (id !== probeId) return;
  } catch (err) {
    if (id !== probeId) return;
    errorEl.innerHTML = errHtml(err);
    errorEl.hidden = false;
  } finally {
    if (id === probeId) {
      probeId = 0;
      fetchBtn.classList.remove("busy");
      fetchBtn.textContent = "Find download";
    }
  }
  if (!s) return;
  const songs = s.tracks.map((t, i) => ({ music: true, title: `${t.artists} - ${t.title}`, duration: t.duration, playlist_index: i + 1, playlist_title: s.title,
    url: `https://music.youtube.com/search?q=${encodeURIComponent(`${t.artists} ${t.title}`)}#songs` }));
  if (s.kind === "track") {
    infoUrl = songs[0].url;
    info = { ...songs[0], uploader: "Spotify", thumbnail: s.thumb };
    return renderPick();
  }
  openList({ music: true });
  songs.forEach(addEntry);
  pl.loading = false;
  listCount();
}

// A live channel: pick a quality, optionally a time limit, then Record. An offline channel or a link streamlink can't
// read goes to yt-dlp unless the user selected Streamlink under Download with
async function livePick(url, forced) {
  if (probeId) invoke("cancel", { id: probeId });
  closePick();
  const id = (probeId = nextId++);
  fetchBtn.classList.add("busy");
  fetchBtn.textContent = "Fetching…";
  appendProbeLog("Looking for the live stream…");
  logEl.hidden = false;
  let s;
  try {
    s = await invoke("live_streams", { id, url, proxy: proxy() });
    if (id !== probeId || !s) return;
  } catch (err) {
    if (id !== probeId) return;
    if (forced) {
      errorEl.innerHTML = errHtml(err);
      errorEl.hidden = false;
      return;
    }
  } finally {
    if (id === probeId) {
      probeId = 0;
      fetchBtn.classList.remove("busy");
      fetchBtn.textContent = "Find download";
    }
  }
  if (!s?.qualities.length) return fetchLink(url);
  pick.dataset.step = "live";
  pick.live = { url, title: s.title || s.author || url, author: s.author || "Live" };
  pick.innerHTML = `
    <header class="pick-head">${btn("close", "Close", ICON.stop)}</header>
    <div class="choices"><fieldset><legend>Quality</legend>${s.qualities.map((q, i) => `
      <label class="opt"><input type="radio" name="q" value="${esc(q)}" ${i ? "" : "checked"} /><span class="q">${esc(q.replace("_", " "))}</span><span class="d"></span><span class="s"></span></label>`).join("")}
    </fieldset></div>
    <footer class="pick-foot">
      <label class="grow">Stop after <input class="search nums" name="minutes" type="number" min="1" inputmode="numeric" placeholder="—" aria-label="Stop after minutes" /> min</label>
      <button class="key" type="submit">Record</button>
    </footer>`;
  pick.firstElementChild.prepend(row("div", "item", null, pick.live.title, ["LIVE ●", esc(s.author ?? "")]));
  pick.hidden = false;
  renderHistory();
}

const isTorrent = (url) => url.startsWith("magnet:") || /\.torrent$/i.test(url.split(/[?#]/)[0]);

// A torrent: fetch its metadata (magnets need peers for that), then tick the files to get
async function torrentPick(url) {
  if (probeId) invoke("cancel", { id: probeId });
  closePick();
  const id = (probeId = nextId++);
  fetchBtn.classList.add("busy");
  fetchBtn.textContent = "Fetching…";
  appendProbeLog(url.startsWith("magnet:") ? "Fetching metadata from peers…" : "Reading the torrent file…");
  logEl.hidden = false;
  try {
    const t = await invoke("torrent_files", { id, url, proxy: proxy(), aria2Options: aria2Options() });
    if (id !== probeId || !t) return;
    pick.dataset.step = "torrent";
    pick.torrent = t;
    pick.innerHTML = `
      <header class="pick-head"><b class="list-title" dir="auto"></b>${btn("close", "Close", ICON.stop)}</header>
      <div class="list-bar">
        <span class="list-status nums"></span>
        <span class="grow"></span>
        <button class="link-btn" type="button" data-act="all">Select all</button>
        <button class="link-btn" type="button" data-act="none">None</button>
      </div>
      <div class="list entries"></div>
      <footer class="pick-foot"><small class="grow"></small><button class="key" type="submit"></button></footer>`;
    // aria2c sends only tracker and web-seed traffic through an HTTP proxy
    if (proxy()) pick.querySelector(".pick-foot small").textContent = "Peers connect directly, not through your proxy";
    pick.querySelector(".list-title").textContent = t.name;
    pick.querySelector(".entries").append(...t.files.map((f, i) =>
      row("label", "item entry", null, f.path, [mb(f.length)], `<input type="checkbox" value="${i}" checked />`)));
    pick.hidden = false;
    torrentCount();
    renderHistory();
  } catch (err) {
    if (id !== probeId) return;
    errorEl.innerHTML = errHtml(err);
    errorEl.hidden = false;
  } finally {
    if (id === probeId) {
      probeId = 0;
      fetchBtn.classList.remove("busy");
      fetchBtn.textContent = "Find download";
    }
  }
}

const torrentSel = () => [...pick.querySelectorAll(".entries input:checked")].map((c) => pick.torrent.files[c.value]);
function torrentCount() {
  const sel = torrentSel();
  pick.querySelector(".list-status").textContent = `${sel.length} of ${plural(pick.torrent.files.length, "file")}`;
  const next = pick.querySelector("[type=submit]");
  next.textContent = sel.length ? `Download · ${mb(sel.reduce((a, f) => a + f.length, 0))}` : "Select files";
  next.disabled = !sel.length;
}

/* Playlist and channel list: search, select, then pick one quality for all */

const CHANNEL = /^(https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@|channel\/|c\/|user\/)[^/?#]+)\/?(?:[?#]|$)/;
const TABS = { videos: "Videos", shorts: "Shorts", streams: "Live" };
const SEP = navigator.userAgent.includes("Windows") ? "\\" : "/";
// a playlist title as a folder name every OS accepts
const safeName = (t) => String(t ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim().slice(0, 120) || "Playlist";
const thumbOf = (e) => e.thumbnail ?? e.thumbnails?.at(-1)?.url;
const dead = (e) => /^\[(private|deleted)/i.test(e.title ?? "") || e.availability === "private";
const locked = (e) => ["subscriber_only", "premium_only", "needs_auth"].includes(e.availability);
let pl = null; // the list on screen: { base, tab, title, entries, loading }

function openList(tab) {
  pl = { ...tab, title: "", entries: [], loading: true };
  info = null;
  pick.dataset.step = "list";
  pick.innerHTML = `
    <header class="pick-head"><b class="list-title" dir="auto"></b>${btn("close", "Close", ICON.stop)}</header>
    ${pl.tab ? `<nav class="seg">${Object.entries(TABS).map(([t, l]) => `<button type="button" data-tab="${t}" aria-pressed="${t === pl.tab}">${l}</button>`).join("")}</nav>` : ""}
    <div class="list-bar">
      <input class="search" type="search" name="find" dir="auto" placeholder="Search" aria-label="Search videos" spellcheck="false" />
      <span class="list-status nums"></span>
      <button class="link-btn" type="button" data-act="stop-list">Stop</button>
      <span class="grow"></span>
      <button class="link-btn" type="button" data-act="all">Select all</button>
      <button class="link-btn" type="button" data-act="none">None</button>
    </div>
    <div class="list entries"></div>
    <footer class="pick-foot"><span class="grow"></span><button class="key" type="button" data-act="next"></button></footer>`;
  pick.hidden = false;
  listCount();
  renderHistory();
}

function addEntry(e) {
  const i = pl.entries.push(e) - 1;
  if (!pl.title) pick.querySelector(".list-title").textContent = pl.title = e.playlist_title ?? e.playlist ?? "";
  const off = dead(e);
  const el = row("label", `item entry${off ? " dead" : ""}`, off ? null : thumbOf(e), e.title ?? e.url,
    [e.duration && dur(e.duration), locked(e) && "🔒 Members", off && "Unavailable"], `<input type="checkbox" value="${i}" ${off ? "disabled" : ""} />`);
  el.hidden = !matches(e);
  pick.querySelector(".entries").append(el);
  // shortcut: recounts per entry; batch with requestAnimationFrame if huge channels feel slow
  listCount();
}

const matches = (e) => (e.title ?? "").toLowerCase().includes(pick.find?.value.trim().toLowerCase() ?? "");
const checked = () => [...pick.querySelectorAll(".entries input:checked")].map((c) => pl.entries[c.value]);

function listCount() {
  const n = pick.querySelectorAll(".entries input:checked").length, all = pl.entries.length;
  pick.querySelector(".list-status").textContent = pl.loading ? `Loading… ${plural(all, unit())}` : plural(all, unit());
  pick.querySelector("[data-act=stop-list]").hidden = !pl.loading;
  const next = pick.querySelector("[data-act=next]");
  next.textContent = n ? `Choose quality · ${plural(n, unit())}` : `Select ${unit()}s`;
  next.disabled = !n;
}

pick.addEventListener("input", (e) => {
  if (e.target.name !== "find") return;
  for (const el of pick.querySelectorAll(".entry")) el.hidden = !matches(pl.entries[el.querySelector("input").value]);
});
pick.addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab], [data-act]");
  if (!t || !(pl || pick.dataset.step === "torrent")) return;
  if (t.dataset.tab) return t.dataset.tab !== pl.tab && fetchLink(`${pl.base}/${t.dataset.tab}`, { base: pl.base, tab: t.dataset.tab });
  const act = t.dataset.act;
  if (act === "stop-list") invoke("cancel", { id: probeId });
  if (act === "all" || act === "none") {
    for (const c of pick.querySelectorAll(".entry:not([hidden]) input:not(:disabled)")) c.checked = act === "all";
    recount();
  }
  if (act === "next") {
    const sel = checked();
    if (pl.loading) invoke("cancel", { id: probeId });
    info = { _type: "playlist", music: pl.music, title: pl.title || infoUrl, entries: sel, thumbnail: thumbOf(sel[0]), uploader: sel[0].playlist_uploader ?? sel[0].channel, extractor_key: sel[0].ie_key ?? sel[0].extractor_key };
    renderPick();
  }
});

// pasting a URL fetches right away
form.link.addEventListener("paste", () => setTimeout(() => /^(https?:\/\/|magnet:)\S+$/.test(form.link.value.trim()) && form.requestSubmit()));

/* Queue: one download at a time */

function enqueue(...its) {
  for (const it of its) {
    Object.assign(it, { id: nextId++, status: "queued", progress: 0, p: null, dir: it.dir ?? dir });
    items.push(it);
    batch++;
  }
  saved = null;
  pump();
  renderQueue();
}

// file name for a recording: "Channel 2026-11-11 21-05-09", local time; set at start, so a retry gets a fresh name
const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toTimeString().slice(0, 8).replaceAll(":", "-")}`;

async function pump() {
  if (toolsBusy) return;
  // live recordings run alongside the one-at-a-time queue
  const busy = items.some((i) => i.status === "active" && !i.live);
  const it = items.find((i) => i.status === "queued" && (i.live || !busy));
  if (!it) return;
  Object.assign(it, { status: "active", p: null, engine: it.tool ?? "yt-dlp", started: Date.now() });
  pump();
  try {
    await invoke("download", { id: it.id, url: it.url, dir: it.dir ?? dir, proxy: proxy(), aria2Options: aria2Options(), opts: it.opts, tool: it.tool ?? "yt-dlp", fast: $("#fast").checked, files: it.files ?? null,
      quality: it.quality ?? null, name: it.live ? `${it.author} ${stamp()}` : null, minutes: it.minutes ?? null });
  } catch (e) {
    fail(it, e);
    pump();
    renderQueue();
  }
}

// the backend sends "explanation\nyt-dlp's own message"; show the explanation and keep the detail one glance away
const errHtml = (e) => String(e).split("\n").map((l, i) => i ? `<small>${esc(l)}</small>` : esc(l)).join("");

function fail(it, error) {
  error = signedInAnyway(error);
  Object.assign(it, { status: "failed", error });
  finished++;
  // retry every download that failed for want of a sign-in
  if (needsCookies(error)) askCookies(error, () => retryFailed((i) => needsCookies(i.error)));
  notify("Download failed", it.title);
}

async function notify(title, body) {
  if (document.hasFocus()) return;
  try {
    if (!(await notification.isPermissionGranted()) && (await notification.requestPermission()) !== "granted") return;
    notification.sendNotification({ title, body });
  } catch {} // notifications are a nicety; never break the queue over them
}

function itemBadges(it) {
  const format = it.container ?? it.path?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  const values = [...(it.label ?? "").split(/\s*·\s*/), format?.toUpperCase(), it.size != null ? mb(it.size) : ""];
  const engine = it.engine ?? it.tool;
  return [...new Set(values.filter(Boolean))].map((value) => `<span class="file-badge">${esc(value)}</span>`).join("") +
    (engine ? `<span class="file-badge engine-tag">${esc(engine)}</span>` : "");
}
function metaOf(it) {
  if (it.status === "failed") return [esc(String(it.error).split("\n")[0])];
  if (it.status === "queued") return [it.progress ? `${Math.floor(it.progress)}% · Queued` : "Queued"];
  if (it.status === "paused") return [`${Math.floor(it.progress)}% · Paused`];
  const p = it.p;
  if (!p) return ["Starting…"];
  if (p.message) return [esc(p.message)];
  if (p.live) return [`LIVE ● ${dur(p.elapsed)}`, mb(p.downloaded_bytes), it.minutes && `stops at ${it.minutes} min`];
  if (p.files_done) return [`${p.files_done} of ${plural(it.count, "file")}`];
  const total = p.total_bytes ?? p.total_bytes_estimate;
  // torrents: "Seeds 12 · Peers 40 · ↑ 0.1 MB/s · ratio 0.1"
  const swarm = p.seeds != null && [`Seeds ${p.seeds}`, `Peers ${p.peers ?? 0}`, p.up && `↑ ${mb(p.up)}/s`, p.ratio != null && `ratio ${p.ratio.toFixed(1)}`];
  return [p.downloaded_bytes != null && `${mb(p.downloaded_bytes)}${total ? ` / ${mb(total)}` : ""}`, p.speed && `${mb(p.speed)}/s`, p.eta != null && eta(p.eta), ...(swarm || [])];
}

function rowEl(it) {
  const active = it.status === "active";
  const right = `<span class="percent nums">${active && !it.live ? `${Math.floor(it.progress)}%` : ""}</span><span class="actions">` +
    (it.status === "failed" ? btn("retry", "Try again", ICON.retry) + btn("dismiss", "Dismiss", ICON.stop)
      : (active && !it.live ? btn("pause", "Pause", ICON.pause) : it.status === "paused" ? btn("resume", "Resume", ICON.play) : "") +
        btn("stop", it.live && active ? "Stop recording" : active ? "Stop download" : "Remove from queue", ICON.stop)) + "</span>";
  const li = row("li", `item ${it.status}`, it.thumb, it.title, metaOf(it), right, `<span class="item-badges">${itemBadges(it)}</span>${active ? '<span class="tube"></span>' : ""}`);
  li.dataset.id = it.id;
  if (it.status === "failed") li.querySelector(".meta").title = it.error;
  li.style.setProperty("--p", `${it.progress}%`);
  return li;
}

// The strip on the Download page and the Library tab badge
// shortcut: a recording shows only in the Library queue, not in the strip or badge; add a "● REC" state if people miss it
function renderStatus() {
  const act = items.find((i) => i.status === "active" && !i.live);
  const failed = items.filter((i) => i.status === "failed").length;
  const badge = $("#badge");
  badge.className = `badge nums${failed && !act ? " failed" : ""}`;
  badge.textContent = act ? `${Math.floor(act.progress)}%` : "";
  strip.className = `strip card ${act ? "busy" : failed ? "failed" : saved ? "done" : ""}`;
  strip.style.setProperty("--p", `${act?.progress ?? 0}%`);
  strip.hidden = !act && !failed && !saved;
  if (act) strip.innerHTML = `${ICON.down}<span class="grow" dir="auto">${esc(act.title)}</span>
    <span class="sub nums">${finished + 1} of ${batch} · ${Math.floor(act.progress)}%</span>${ICON.chev}`;
  else if (failed) strip.innerHTML = `${ICON.alert}<span class="grow">${failed} failed</span><span>Review</span>${ICON.chev}`;
  else if (saved) strip.innerHTML = `${ICON.check}<span class="grow" dir="auto">Saved · ${esc(saved.title)}</span><span class="sub">${finder}</span>`;
}
strip.addEventListener("click", () => (strip.classList.contains("done") ? reveal(saved.path) : show("library")));

function retryFailed(which = () => true) {
  for (const i of items) if (i.status === "failed" && which(i)) { Object.assign(i, { status: "queued", error: null }); finished--; }
  pump();
  renderQueue();
}
$("#retry-all").addEventListener("click", () => retryFailed());
// drop everything waiting, then stop the active one; its "cancelled" event removes it
$("#cancel-all").addEventListener("click", () => {
  for (const i of items.filter((i) => i.status !== "active")) {
    items.splice(items.indexOf(i), 1);
    batch--;
    if (i.status === "failed") finished--;
  }
  const act = items.find((i) => i.status === "active");
  if (act) invoke("cancel", { id: act.id });
  renderQueue();
});

function renderQueue() {
  if (!items.length) batch = finished = 0;
  $("#q-count").textContent = batch > 1 ? `${finished} / ${batch}` : "";
  $("#retry-all").hidden = !items.some((i) => i.status === "failed");
  queue.replaceChildren(...items.map(rowEl));
  $("#downloads").hidden = !items.length;
  renderStatus();
  renderHistory();
}

let savedTimer;
listen("dl", ({ payload: ev }) => {
  const it = items.find((i) => i.id === ev.id);
  if (!it) return;
  if (ev.kind === "engine") {
    it.engine = ev.engine;
    return renderQueue();
  }
  if (ev.kind === "info") {
    Object.assign(it, { title: ev.info.title ?? it.title, thumb: ev.info.thumbnail ?? it.thumb });
    return renderQueue();
  }
  if (ev.kind === "progress") {
    const p = (it.p = ev.p);
    if (p.engine) it.engine = p.engine;
    const total = p.total_bytes ?? p.total_bytes_estimate;
    // shortcut: video+audio downloads report two passes, so the bar refills once; weight the passes if it bothers anyone
    if (p.percent != null) it.progress = p.percent;
    else if (total) it.progress = Math.min(100, (p.downloaded_bytes / total) * 100);
    // galleries count files, against the number the preview found
    if (p.files_done) it.progress = Math.min(100, (p.files_done / it.count) * 100);
    if (p.live) it.size = p.downloaded_bytes;
    const li = queue.querySelector(`[data-id="${it.id}"]`);
    if (li) {
      li.style.setProperty("--p", `${it.progress}%`);
      li.querySelector(".percent").textContent = it.live ? "" : `${Math.floor(it.progress)}%`;
      li.querySelector(".meta").innerHTML = metaHtml(metaOf(it));
      li.querySelector(".item-badges").innerHTML = itemBadges(it);
    }
    return renderStatus();
  }
  if (ev.kind === "failed") fail(it, ev.error);
  // pause = stop the process but keep the item; yt-dlp picks up the .part file on resume
  else if (ev.kind === "cancelled" && it.pausing) Object.assign(it, { status: "paused", pausing: false });
  else {
    items.splice(items.indexOf(it), 1);
    if (ev.kind === "cancelled") batch--;
    else {
      finished++;
      saved = { title: it.title, path: ev.path };
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => { saved = null; renderStatus(); }, 6000);
      history.unshift({ title: it.title, thumb: it.thumb, path: ev.path, label: it.label, size: ev.size ?? it.size, estimated: ev.size == null, at: Date.now(), warnings: ev.warnings, url: it.url, tool: it.tool ?? "yt-dlp", engine: it.engine, elapsed: it.started ? Date.now() - it.started : null, container: it.opts?.audio ? it.opts.convert || null : it.opts?.container });
      saveHistory();
      notify("Download finished", it.title);
    }
  }
  pump();
  renderQueue();
});

queue.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const it = items.find((i) => i.id === Number(b.closest(".item").dataset.id));
  const act = b.dataset.act;
  if (act === "stop" && it.status === "active") return invoke("cancel", { id: it.id });
  if (act === "pause") {
    it.pausing = true;
    return invoke("cancel", { id: it.id });
  }
  if (act === "resume") it.status = "queued";
  else if (act === "retry") {
    Object.assign(it, { status: "queued", error: null });
    finished--;
  } else {
    items.splice(items.indexOf(it), 1);
    batch--;
    if (act === "dismiss") finished--;
  }
  pump();
  renderQueue();
});

/* History */

function saveHistory() {
  // shortcut: capped at 200 entries in localStorage; move to a file if people want a full log
  history = history.slice(0, 200);
  store("history", JSON.stringify(history));
  renderHistory();
}

const histEl = (h, i) => {
  const actions = `<span class="actions">${btn("open", "Open", ICON.play)}${btn("reveal", finder, ICON.folder)}${btn("remove", "Remove from history", ICON.stop)}</span>`;
  const li = row("li", "item done", h.thumb, h.title, [esc(h.label ?? ""), h.size && mb(h.size), when(h.at)], actions);
  const el = document.createElement("tr");
  el.className = "saved-row";
  el.innerHTML = `<td><div class="file-cell"></div></td><td><div class="item-badges">${itemBadges(h)}${h.warnings?.length ? `<span class="file-badge warning-badge" title="${esc(h.warnings.join("\n"))}">${h.warnings.length} warning${h.warnings.length > 1 ? "s" : ""}</span>` : ""}</div></td><td class="saved-column nums"><time title="${esc(new Date(h.at).toLocaleString("en"))}">${when(h.at)}</time></td><td>${actions}</td>`;
  const name = li.querySelector(".name");
  name.title = [h.title, h.path].filter(Boolean).join("\n");
  el.querySelector(".file-cell").append(li.querySelector(".thumb-img"), name);
  el.dataset.i = i;
  el.tabIndex = 0;
  return el;
};

function renderHistory() {
  $("#library-count").textContent = history.length || "";
  const q = $("#search").value.trim().toLowerCase();
  const list = $("#history");
  const shown = history.map(histEl).filter((li, i) => !q || [history[i].title, history[i].path, history[i].url, history[i].label].some((v) => v?.toLowerCase().includes(q)));
  list.replaceChildren(...shown);
  if (!shown.length) list.innerHTML = `<tr><td colspan="4" class="empty">${q ? "No matching downloads" : "Your saved downloads will appear here"}</td></tr>`;
  $("#clear").hidden = $("#search").hidden = !history.length;
}

// file may have been moved or deleted since; nothing useful to do then
const reveal = (path) => opener.revealItemInDir(path).catch(() => {});
const openFile = (path) => opener.openPath(path).catch(() => {});
$("#repo").addEventListener("click", () => opener.openUrl("https://github.com/LordVersA/personal-downloader").catch(() => {}));
function onHistory(e) {
  const li = e.target.closest("[data-i]");
  if (!li) return;
  const h = history[li.dataset.i];
  const act = e.type === "dblclick" || e.key === "Enter" ? "open" : e.target.closest("[data-act]")?.dataset.act;
  if (e.type === "keydown" && (e.key !== "Enter" || e.target !== li)) return;
  if (act === "open") openFile(h.path);
  if (act === "reveal") reveal(h.path);
  if (act === "remove") { history.splice(li.dataset.i, 1); saveHistory(); }
}
for (const t of ["click", "dblclick", "keydown"]) $("#history").addEventListener(t, onHistory);
$("#search").addEventListener("input", renderHistory);
$("#clear").addEventListener("click", () => { history = []; saveHistory(); });

/* Settings */

// Browser cookies: one snapshot of the signed-in browser, used for every fetch and download
const BROWSERS = { chrome: "Chrome", safari: "Safari", firefox: "Firefox", edge: "Edge", brave: "Brave", opera: "Opera", vivaldi: "Vivaldi", chromium: "Chromium", whale: "Whale" };
// only the browsers on this computer; if none turn up where yt-dlp looks, offer them all rather than nothing
let installed = await invoke("browsers").catch(() => []);
if (!installed.length) installed = Object.keys(BROWSERS);
let browser = installed.includes(store("cookieBrowser")) ? store("cookieBrowser") : installed[0];
const cookieStatus = $("#cookie-status");
const importBtn = $("#cookie-import");
// real radios, so arrow keys and screen readers work as usual
const browserPicker = (el, name) => {
  el.innerHTML = installed.map((id) => `<label class="browser"><input type="radio" name="${name}" value="${id}"><span><img src="browsers/${id}.svg" alt="" width="16" height="16">${BROWSERS[id]}</span></label>`).join("");
  el.addEventListener("change", (e) => pickBrowser(e.target.value));
};
// keeps the Settings and dialog pickers in step
function pickBrowser(id) {
  browser = store("cookieBrowser", id);
  for (const r of document.querySelectorAll(`.browsers input[value="${id}"]`)) r.checked = true;
  importBtn.textContent = `Import from ${BROWSERS[id]}`;
}
browserPicker($("#cookie-browser"), "browser");
browserPicker($("#ask-browser"), "ask-browser");
pickBrowser(browser);

const showCookies = async (on) => {
  $("#cookie-remove").hidden = !on;
  $("#cookie-sites-box").hidden = true;
  cookieStatus.textContent = on ? store("cookieNote") || "Imported; import again when sign-in expires" : "Import a signed-in browser session for sites that require it";
  if (!on) return;
  // the sites in the cookies that yt-dlp can download from
  const sites = await invoke("cookie_sites").catch(() => []);
  $("#cookie-sites").replaceChildren(...sites.map((s) => Object.assign(document.createElement("i"), { className: "tag", textContent: s })));
  $("#cookie-sites-sum").textContent = `Cookies for ${sites.length} supported site${sites.length === 1 ? "" : "s"}`;
  $("#cookie-sites-box").hidden = !sites.length;
};
// true when it worked; the outcome lands in the Settings row and in `out`
async function importCookies(out) {
  out.textContent = cookieStatus.textContent = "Reading cookies; allow access if your system asks…";
  try {
    const n = await invoke("import_cookies", { browser });
    importedAt = Date.now();
    out.textContent = store("cookieNote", `${n.toLocaleString("en")} cookies from ${BROWSERS[browser]} · imported ${new Date().toLocaleDateString("en", { month: "short", day: "numeric" })}`);
    showCookies(true);
    return true;
  } catch (e) {
    out.innerHTML = cookieStatus.innerHTML = errHtml(e);
    return false;
  }
}
importBtn.addEventListener("click", () => busy(importBtn, "Importing…", () => importCookies(cookieStatus)));

// A fetch or download failed in a way signing in fixes: offer to import cookies, then retry
const ask = $("#cookie-ask");
let askRetry;
// shortcut: spotted by the backend's explanation pointing at Settings → Browser cookies; tag errors with a kind if that wording changes
const needsCookies = (e) => String(e).includes("Browser cookies");
let importedAt = 0;
// refused right after a fresh import: importing again won't help (often a yt-dlp bug), so say so instead of asking again
const signedInAnyway = (e) => needsCookies(e) && Date.now() - importedAt < 10 * 60e3
  ? ["Your cookies were just imported, but the site still refused. yt-dlp may not support this page right now; update yt-dlp in Settings or try again later.", ...String(e).split("\n").slice(1)].join("\n")
  : e;
function askCookies(error, retry) {
  if (ask.open) return;
  askRetry = retry;
  $("#ask-why").textContent = String(error).split("\n")[0];
  $("#ask-status").textContent = "";
  ask.showModal();
}
$("#ask-cancel").addEventListener("click", () => ask.close());
$("#ask-import").addEventListener("click", () => busy($("#ask-import"), "Importing…", async () => {
  if (!(await importCookies($("#ask-status")))) return;
  ask.close();
  askRetry?.();
}));
$("#cookie-remove").addEventListener("click", () => invoke("remove_cookies").then(() => showCookies(false, store("cookieNote", "")), (e) => (cookieStatus.textContent = String(e))));

const home = await window.__TAURI__.path.homeDir().catch(() => "");
const showDir = () => {
  $("#dir").textContent = home && dir.startsWith(home) ? `~${dir.slice(home.replace(/[\\/]$/, "").length)}` : dir;
  $("#dir").title = dir;
};
$("#dir-btn").addEventListener("click", async () => {
  const picked = await window.__TAURI__.dialog.open({ directory: true, defaultPath: dir });
  if (picked) showDir(store("dir", (dir = picked)));
});

// yt-dlp: the app's own standalone copy updates itself; a system one (pip, Homebrew…) can be swapped for it
const status = $("#status");
let ytdlp = {};
async function refreshYtdlp(note) {
  ytdlp = await invoke("ytdlp_info").catch(() => ({}));
  showCookies(ytdlp.cookies);
  status.textContent = note ?? (ytdlp.managed ? "" : ytdlp.version ? "System install (pip, Homebrew…); the app can't update it" : "Install it to start downloading");
  if (ytdlp.version) toolVersions["yt-dlp"] = ytdlp.version;
}
async function busy(b, label, work) {
  const text = b.textContent;
  b.disabled = true;
  b.textContent = label;
  try { await work(); } finally { b.disabled = false; b.textContent = text; }
}
async function checkUpdates() {
  if (items.some((i) => i.status === "active")) { status.textContent = "Wait for downloads to finish, then update."; return; }
  status.textContent = "Checking for updates…";
  const note = await invoke("update_ytdlp").catch(String);
  await refreshYtdlp(note);
  renderTools();
}
const ARIA_FIELDS = {
  connections: ["Connections per server", "1–16 · default 16", 16, 1, 16, "", "How many connections one server can receive for a file. Higher values may improve speed, but some servers limit connections. Start with 4–8 if downloads keep failing."],
  splits: ["Parts per file", "1–128 · default 16", 16, 1, 128, "parts", "Downloads a file in several parts at once. The server connection limit and minimum part size can reduce the actual number used."],
  min_split_mib: ["Minimum part size", "1–1024 · default 1", 1, 1, 1024, "MiB", "A file must be at least twice this size before aria2 splits it. A larger value uses fewer connections for small files."],
  download_kib: ["Download limit", "0 means unlimited", 0, 0, 1000000, "KiB/s", "Caps each download’s speed. For example, 1024 KiB/s is about 1 MiB/s. Use a limit to leave bandwidth for other apps."],
  upload_kib: ["Torrent upload limit", "0 means unlimited", 0, 0, 1000000, "KiB/s", "Caps torrent upload speed while downloading. For example, 256 limits uploads to 256 KiB/s. Seeding stops when the download finishes."],
  timeout: ["No-data timeout", "1–600 · default 60", 60, 1, 600, "sec", "Retries a connection after this many seconds without receiving data. Increase it on slow or unreliable connections."],
  connect_timeout: ["Connection timeout", "1–600 · default 60", 60, 1, 600, "sec", "How long to wait when connecting to a server before treating the connection attempt as failed."],
  retries: ["Maximum attempts", "0 means keep trying", 5, 0, 100, "tries", "How many times aria2 tries a failed download. Use 0 for unlimited attempts; a finite value prevents repeated retries from running forever."],
  retry_wait: ["Pause between retries", "0–300 · default 0", 0, 0, 300, "sec", "Waits before trying again after a failure. A short pause can help when a server is busy or rate-limiting requests."],
  peers: ["Torrent peer limit", "0 means unlimited", 55, 0, 1000, "peers", "Maximum connected peers for each torrent. More peers can use more network and CPU resources. The default is 55."],
};
function renderAriaSettings(saved = load("aria2") ?? {}) {
  const field = (key) => {
    const [label, hint, fallback, min, max, unit, help] = ARIA_FIELDS[key];
    const value = Number.isInteger(saved[key]) && saved[key] >= min && saved[key] <= max ? saved[key] : fallback;
    return `<div class="aria-field"><div class="aria-field-copy"><div class="aria-label"><label for="aria-${key}">${label}</label><span class="tool-help aria-help" tabindex="0" aria-label="About ${label}" aria-describedby="hint-${key}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></svg><span class="tool-tip" id="hint-${key}" role="tooltip">${esc(help)}</span></span></div><small id="range-${key}">${hint}</small></div><span class="aria-value"><input id="aria-${key}" name="${key}" type="number" min="${min}" max="${max}" step="1" value="${value}" aria-describedby="range-${key} hint-${key}" required />${unit ? `<span>${unit}</span>` : ""}</span></div>`;
  };
  const allocation = `<div class="aria-field"><div class="aria-field-copy"><label for="aria-allocation">Disk space</label><small>When to reserve file space</small></div><select id="aria-allocation" name="allocation" title="On demand grows the file as it downloads. Preallocate reserves its full size first. Truncate sets its length without filling it."><option value="none">On demand</option><option value="prealloc">Reserve first</option><option value="trunc">Set file size</option></select></div>`;
  $("#aria-fields").innerHTML = [
    ["Connections", "How files are split and downloaded", ["connections", "splits", "min_split_mib"]],
    ["Bandwidth", "Leave room for your other apps", ["download_kib", "upload_kib"]],
    ["Retries & timeouts", "Handle slow or interrupted connections", ["connect_timeout", "timeout", "retries", "retry_wait"]],
    ["Torrents & storage", "Peer connections and disk space", ["peers"]],
  ].map(([title, description, keys], i) => `<section class="aria-group card" aria-label="${title}"><header><h3>${title}</h3><p>${description}</p></header>${keys.map(field).join("")}${i === 3 ? allocation : ""}</section>`).join("");
  $("#aria-allocation").value = ["none", "prealloc", "trunc"].includes(saved.allocation) ? saved.allocation : "none";
}
function aria2Options() {
  const form = $("#aria-settings");
  if (!form.checkValidity()) throw "Check the aria2c settings: a value is outside its allowed range.";
  return { ...Object.fromEntries(Object.keys(ARIA_FIELDS).map((key) => [key, Number(form.elements[key].value)])), allocation: form.elements.allocation.value };
}
renderAriaSettings();
$("#aria-settings").addEventListener("submit", (e) => e.preventDefault());
$("#aria-settings").addEventListener("input", () => {
  const valid = $("#aria-settings").checkValidity();
  $("#aria-error").hidden = valid;
  $("#aria-error").textContent = "Enter a whole number within the range shown.";
  if (valid) store("aria2", JSON.stringify(aria2Options()));
});
$("#aria-reset").addEventListener("click", () => { renderAriaSettings({}); $("#aria-error").hidden = true; store("aria2", JSON.stringify(aria2Options())); });

// Versions and explicit install/update controls for every managed tool.
const fastEl = $("#fast");
fastEl.checked = store("fast") !== "0";
fastEl.addEventListener("change", () => store("fast", fastEl.checked ? "1" : "0"));
const TOOLS = {
  "yt-dlp": ["Finds available video/audio qualities and downloads from supported websites. Used for video pages, playlists and music.", "yt-dlp/yt-dlp", '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>', "Video / audio"],
  ffmpeg: ["Combines separate video and audio tracks, converts formats and embeds subtitles. Needed for most high-quality video downloads.", "FFmpeg/FFmpeg", '<path d="m13 3-8 10h6l-1 8 9-11h-7z"/>', "Merge / convert"],
  ffprobe: ["Reads duration, codecs and other media information so media processing can identify the downloaded tracks. Installed with ffmpeg.", "FFmpeg/FFmpeg", '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M8 10h4m-2-2v4"/>', "Media info"],
  deno: ["Runs JavaScript challenges used by some video sites, including YouTube. Needed when extraction requires a JavaScript runtime.", "denoland/deno", '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>', "Site access"],
  aria2c: ["Downloads direct file URLs, magnet links and torrent files. Also accelerates compatible video downloads with multiple connections. This app uses a pinned build.", "aria2/aria2", '<path d="M5 4v12m-3-3 3 3 3-3M12 4v16m-3-3 3 3 3-3M19 4v12m-3-3 3 3 3-3"/>', "Files / torrents"],
  "gallery-dl": ["Downloads images and galleries from supported art and photo sites. Optional unless you download galleries.", "mikf/gallery-dl", '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-7 5 8"/>', "Images"],
  streamlink: ["Records supported live broadcasts, such as Twitch and Kick. Optional unless you record live streams.", "streamlink/streamlink", '<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/>', "Live recording"],
  "N_m3u8DL-RE": ["Downloads unencrypted HLS (.m3u8) and DASH (.mpd) streams. Optional for direct stream manifests. This app uses a pinned build.", "nilaoda/N_m3u8DL-RE", '<path d="M3 6h12M3 12h8M3 18h8m6-10v12m-4-4 4 4 4-4"/>', "HLS / DASH"],
  uv: ["Installs gallery-dl and Streamlink with a managed Python runtime. Needed to install or update those two tools.", "astral-sh/uv", '<path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5m-9 5v10M7 4l9 5"/>', "Python setup"],
};
let toolVersions = {};
function renderTools() {
  $("#tools-update").disabled = toolsBusy;
  $("#tools-list").innerHTML = Object.entries(TOOLS).map(([name, [description, repo, icon, purpose]]) => `<tr><th scope="row"><div class="tool-identity"><span class="tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></span><a href="https://github.com/${repo}" class="tool-repo" title="${esc(description)} · github.com/${repo}" aria-label="${esc(name)} repository">${esc(name)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></a></div></th><td class="nums" title="${esc(toolVersions[name] ?? "")}">${toolVersion(toolVersions[name])}</td><td><span class="tool-help" tabindex="0" aria-describedby="why-${name}">${purpose}<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></svg><span class="tool-tip" id="why-${name}" role="tooltip">${esc(description)}</span></span></td><td><button class="btn" type="button" data-tool="${name}" ${toolsBusy ? "disabled" : ""}>${toolVersions[name] ? "Update" : "Download"}</button>${toolVersions[name] && ["gallery-dl", "streamlink", "N_m3u8DL-RE"].includes(name) ? `<button class="link-btn danger" type="button" data-remove-tool="${name}" ${toolsBusy ? "disabled" : ""}>Remove</button>` : ""}</td></tr>`).join("");
}
async function refreshTools() {
  toolVersions = await invoke("tool_versions").catch(() => ({}));
  if (ytdlp.version) toolVersions["yt-dlp"] = ytdlp.version;
  renderTools();
}
async function prepareTools(names, remove = false) {
  if (toolsBusy) return;
  if (items.some((i) => i.status === "active") || fetchBtn.classList.contains("busy") || pl?.loading) {
    $("#tools-status").textContent = "Wait for downloads and link checks to finish, then update.";
    return;
  }
  toolsBusy = true;
  renderTools();
  const errors = [];
  try {
    for (const name of names) {
      $("#tools-status").textContent = `${remove ? "Removing" : "Downloading / updating"} ${name}…`;
      try { await invoke(remove ? "remove_tool" : "install_tool", { name, proxy: proxy() }); }
      catch (e) { errors.push(`${name}: ${e}`); }
    }
    await refreshYtdlp();
    await refreshTools();
    siteNames = [];
    $("#tools-status").textContent = errors.length ? errors.join(" · ") : remove ? "Tool removed. You can download it again at any time." : "All requested tools are ready.";
  } finally { toolsBusy = false; renderTools(); pump(); }
}
$("#tools-list").addEventListener("click", (e) => {
  const repo = e.target.closest(".tool-repo");
  if (repo) { e.preventDefault(); opener.openUrl(repo.href).catch(() => {}); return; }
  const name = e.target.closest("[data-tool]")?.dataset.tool;
  const removed = e.target.closest("[data-remove-tool]")?.dataset.removeTool;
  if (name || removed) prepareTools([name || removed], !!removed);
});
$("#tools-update").addEventListener("click", () => prepareTools(Object.keys(TOOLS).filter((n) => n !== "ffprobe")));

function showProxy() {
  $("#proxy-fields").hidden = $("#proxy-test").hidden = !pf("type").value;
  $("#proxy-status").textContent = "";
}
$("#proxy-test").addEventListener("click", () => busy($("#proxy-test"), "Testing…", async () => {
  const st = $("#proxy-status");
  st.className = "";
  st.textContent = "Reaching YouTube through the proxy…";
  try {
    st.textContent = await invoke("test_proxy", { proxy: proxy() });
    st.className = "ok";
  } catch (e) {
    st.textContent = String(e);
    st.className = "bad";
  }
}));
// shortcut: the proxy password sits in localStorage in plain text; move it to the OS keychain if that matters
const savedProxy = load("proxy") ?? {};
for (const k of PROXY_KEYS) {
  pf(k).value = savedProxy[k] ?? "";
  pf(k).addEventListener("change", () => {
    store("proxy", JSON.stringify(Object.fromEntries(PROXY_KEYS.map((k) => [k, pf(k).value.trim()]))));
    thumbnails.clear();
    showProxy();
    renderHistory();
    renderQueue();
  });
}
showProxy();

// One directory, merging each site's capabilities instead of separate nested lists.
const sites = $("#sites");
let siteNames = [], siteFilter = "all";
const SITE_TYPES = { all: "All", media: "Video & audio", images: "Images", live: "Live", files: "Files & torrents" };
function renderSites() {
  const q = $("#sites-search").value.trim().toLowerCase();
  const sources = supportedSources(siteNames);
  const shown = sources.filter((source) => (siteFilter === "all" || source.types.includes(siteFilter)) &&
    (!q || [source.name, source.detail, ...source.tools, ...source.types.map((type) => SITE_TYPES[type])].join(" ").toLowerCase().includes(q)));
  $("#sites-filters").innerHTML = Object.entries(SITE_TYPES).map(([key, label]) => `<button type="button" data-filter="${key}" aria-pressed="${siteFilter === key}">${label}</button>`).join("");
  $("#sites-count").textContent = `${shown.length.toLocaleString("en")} ${shown.length === 1 ? "source" : "sources"}${q || siteFilter !== "all" ? ` of ${sources.length.toLocaleString("en")}` : ""}`;
  $("#sites-list").innerHTML = shown.length ? shown.map((source) => `<li class="site-row"><span class="site-monogram" aria-hidden="true">${esc(source.name[0].toUpperCase())}</span><div class="site-copy"><b>${esc(source.name)}</b>${source.detail ? `<small>${esc(source.detail)}</small>` : ""}<span class="site-kinds">${source.types.map((type) => `<span>${SITE_TYPES[type]}</span>`).join("")}</span></div><span class="site-tools">${source.tools.map((tool) => `<span class="file-badge">${esc(tool)}</span>`).join("")}</span></li>`).join("") : '<li class="sites-empty"><b>No matching sources</b><span>Try a different site name, tool or category.</span></li>';
  $("#sites-list").scrollTop = 0;
}
$("#sites-btn").addEventListener("click", () => busy($("#sites-btn"), "Loading…", async () => {
  siteFilter = "all";
  $("#sites-search").value = "";
  $("#sites-status").textContent = siteNames.length ? "" : "Loading video sites…";
  renderSites();
  sites.showModal();
  $("#sites-search").focus();
  if (!siteNames.length) {
    try { siteNames = await invoke("list_sites"); $("#sites-status").textContent = ""; }
    catch { $("#sites-status").textContent = "Video catalog unavailable. Reopen to retry."; }
    renderSites();
  }
}));
$("#sites-filters").addEventListener("click", (e) => {
  const button = e.target.closest("[data-filter]");
  if (!button) return;
  siteFilter = button.dataset.filter;
  renderSites();
  $("#sites-filters").querySelector(`[data-filter="${siteFilter}"]`).focus();
});
sites.addEventListener("click", (e) => {
  const url = e.target.closest("[data-docs]")?.dataset.docs;
  if (url) opener.openUrl(url).catch(() => {});
});
$("#sites-search").addEventListener("input", renderSites);
$("#sites-close").addEventListener("click", () => sites.close());

// App updates: Velopack downloads a delta in the background, then a restart applies it
const appStatus = $("#app-status");
async function checkApp(quiet) {
  if (!quiet) appStatus.textContent = "Checking for updates…";
  try {
    const v = await invoke("check_app_update");
    appStatus.textContent = v ? `Version ${v} is ready` : "Up to date";
    $("#restart").hidden = !v;
    $("#app-check").hidden = !!v;
  } catch (e) {
    if (!quiet) appStatus.textContent = String(e);
  }
}
$("#app-check").addEventListener("click", () => busy($("#app-check"), "Checking…", () => checkApp(false)));
$("#restart").addEventListener("click", () => invoke("restart_to_update").catch((e) => (appStatus.textContent = String(e))));
window.__TAURI__.app.getVersion().then((v) => ($("#about").textContent = `Personal Downloader ${v}`), () => {});

dir ??= await window.__TAURI__.path.downloadDir();
showDir();
renderHistory();
renderQueue();
// first launch downloads yt-dlp, ffmpeg, deno and aria2c; later launches return at once
renderTools();
status.textContent = "Getting yt-dlp, ffmpeg, deno and aria2c…";
invoke("install_tools").then(() => refreshYtdlp().then(() => ytdlp.managed && checkUpdates()), (e) => refreshYtdlp(`Couldn't download tools: ${e}`)).finally(async () => { toolsBusy = false; await refreshTools(); });
checkApp(true);
// a window left open for days still picks up updates; yt-dlp can't replace itself while a download runs it
setInterval(() => {
  checkApp(true);
  if (!toolsBusy && ytdlp.managed && !items.some((i) => i.status === "active")) checkUpdates();
}, 864e5);
