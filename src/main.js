const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { opener, notification } = window.__TAURI__;
const isMac = navigator.userAgent.includes("Mac");
const finder = isMac ? "Show in Finder" : "Show in folder";

const ICON = {
  stop: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15L19 12z"/></svg>',
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

// One row shape for queue, history and recent. meta entries are trusted HTML; escape before passing.
const metaHtml = (meta) => meta.filter(Boolean).map((m) => `<span class="nums" dir="auto">${m}</span>`).join("");
function row(tag, cls, thumb, title, meta, right = "", mid = "") {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = `
    <span class="thumb-img"></span>
    <span class="body">
      <span class="name" dir="auto" title="${esc(title)}">${esc(title)}</span>${mid}
      <span class="meta">${metaHtml(meta)}</span>
    </span>${right}`;
  if (thumb) e.firstElementChild.style.backgroundImage = `url("${encodeURI(thumb)}")`;
  return e;
}
const btn = (act, label, icon) => `<button class="icon" type="button" data-act="${act}" aria-label="${label}" title="${label}">${icon}</button>`;

/* Pages */

const tabs = [...document.querySelectorAll("[role=tab]")];
function show(page) {
  for (const t of tabs) {
    const on = t.dataset.page === page;
    t.setAttribute("aria-selected", on);
    $(`#${t.dataset.page}`).hidden = !on;
  }
  scrollTo(0, 0);
}
tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.page)));
$("#see-all").addEventListener("click", () => show("library"));

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
const plural = (n, w) => `${compact(n)} ${w}${n === 1 ? "" : "s"}`; // chapters, subtitles

function buildChoices() {
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
  buildChoices();
  const subs = Object.keys(info.subtitles ?? {}).filter((l) => l !== "live_chat");
  const auto = Object.entries(info.automatic_captions ?? {});
  const opt = (c, i) => `
    <label class="opt"><input type="radio" name="q" value="${i}" ${i ? "" : "checked"} />
      <span class="q">${esc(c.q)}</span><span class="d">${c.d[0] ? `<i class="tag">${esc(c.d[0])}</i>` : ""}${c.d.slice(1).filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")}</span><span class="s nums">${c.size ? mb(c.size) : ""}</span></label>`;
  const group = (g) => choices.map((c, i) => (c.group === g ? opt(c, i) : "")).join("");
  const toggle = (name, label) => `<label class="toggle"><input type="checkbox" name="${name}" ${opts[name] ? "checked" : ""} /><span>${label}</span></label>`;
  const select = (name, vals) => `<select name="${name}">${vals.map((v) => `<option value="${v}" ${opts[name] === v ? "selected" : ""}>${v.toUpperCase()}</option>`).join("")}</select>`;
  const all = choices.filter((c) => c.group === "All").length;
  const count = info._type === "playlist" && `${info.entries?.length ?? "?"} items`;
  pick.innerHTML = `
    <header class="pick-head">${btn("close", "Close", ICON.stop)}</header>
    <div class="choices">
      ${group("Video") ? `<fieldset><legend>Video</legend>${group("Video")}</fieldset>` : ""}
      <fieldset><legend>Audio</legend>${group("Audio")}</fieldset>
      ${all ? `<details class="all"><summary>All formats (${all})</summary><fieldset>${group("All")}</fieldset></details>` : ""}
    </div>
    <footer class="pick-foot">
      <details class="opts"><summary><b>Options</b><svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg><span id="opts-sum"></span></summary>
        <div class="panel card">
          ${subs.length || auto.length ? `<fieldset class="subs"><legend>Subtitles</legend>
            ${subs.map((l) => `<label class="chip"><input type="checkbox" name="sub" value="${esc(l)}" ${opts.subs.includes(l) ? "checked" : ""} /><span>${esc(info.subtitles[l][0]?.name ?? l)}</span></label>`).join("")}
            ${auto.length ? `<select name="auto" aria-label="Auto-generated subtitles"><option value="">Auto-generated: none</option>
              ${auto.map(([l, f]) => `<option value="${esc(l)}" ${l === opts.auto ? "selected" : ""}>${esc(f[0]?.name ?? l)}</option>`).join("")}</select>` : ""}
          </fieldset>` : ""}
          <fieldset><legend>Options</legend>
            ${subs.length || auto.length ? toggle("embed", "Embed subtitles in video") : ""}
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
  pick.firstElementChild.after(about());
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
  return { c, subs, autoLang, has: (n) => !!pick[n]?.checked };
}

function updatePick() {
  const { c, subs, autoLang, has } = readPick();
  $("#go").textContent = `Download ${c?.audio ? (c.convert ? pick.afmt.value : c.ext ?? "") .toUpperCase() : pick.container.value.toUpperCase()}${c?.size ? ` · ${mb(c.size)}` : ""}`.replace("  ", " ");
  const langs = [...subs, autoLang].filter(Boolean);
  $("#opts-sum").textContent = [langs.length && `Subtitles (${langs.join(", ")})`, has("metadata") && "Metadata", has("thumbnail") && "Thumbnail", has("sponsors") && "Sponsors cut"]
    .filter(Boolean).join(" · ") || "None";
}

function closePick() {
  pick.hidden = true;
  pick.replaceChildren();
  renderHistory();
}

pick.addEventListener("change", updatePick);
pick.addEventListener("click", (e) => e.target.closest("[data-act=close]") && closePick());
document.addEventListener("pointerdown", (e) => { const d = pick.querySelector(".opts[open]"); if (d && !d.contains(e.target)) d.open = false; });
pick.addEventListener("submit", (e) => {
  e.preventDefault();
  const { c, subs, autoLang, has } = readPick();
  // remember the toggles that exist for this video; keep the others as they were
  for (const n of ["metadata", "embed", "thumbnail", "sponsors"]) if (pick[n]) opts[n] = has(n);
  Object.assign(opts, { container: pick.container.value, afmt: pick.afmt.value });
  if (pick.querySelector("[name=sub], [name=auto]")) Object.assign(opts, { subs, auto: autoLang });
  store("opts", JSON.stringify(opts));
  enqueue({
    url: infoUrl,
    title: info.title ?? infoUrl,
    thumb: info.thumbnail ?? info.thumbnails?.at(-1)?.url,
    label: c.audio ? (c.convert ? opts.afmt.toUpperCase() : "Audio") : `${c.q} · ${opts.container.toUpperCase()}`,
    size: c.size,
    opts: {
      format: c.format,
      container: opts.container,
      convert: c.convert ? opts.afmt : "",
      audio: !!c.audio,
      subs: autoLang ? [...subs, autoLang] : subs,
      auto_subs: !!autoLang,
      embed_subs: !c.audio && has("embed"),
      // music always gets full tags and cover art; WAV and WebM audio can't hold a cover
      thumbnail: has("thumbnail") || (c.audio && !["wav", "webm"].includes(c.convert ? opts.afmt : c.ext)),
      metadata: has("metadata") || !!c.audio,
      sponsors: has("sponsors"),
    },
  });
  form.link.value = "";
  closePick();
});

const errorEl = $("#error");
const logEl = $("#probe-log");
// yt-dlp's current step while fetching, e.g. "[youtube] abc: Downloading webpage"
listen("probe-log", (e) => (logEl.textContent = e.payload));
const fetchBtn = $("#fetch");
let probing = 0; // a newer fetch makes older results stale
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = form.link.value.trim();
  errorEl.hidden = true;
  if (!url) {
    form.classList.remove("shake");
    void form.offsetWidth; // restart the animation
    form.classList.add("shake");
    return;
  }
  const n = ++probing;
  fetchBtn.classList.add("busy");
  fetchBtn.textContent = "Fetching…";
  logEl.textContent = "";
  logEl.hidden = false;
  try {
    const res = await invoke("probe", { url, proxy: proxy() });
    if (n !== probing) return;
    info = res;
    infoUrl = url;
    renderPick();
  } catch (err) {
    if (n !== probing) return;
    errorEl.innerHTML = errHtml(err);
    errorEl.hidden = false;
  } finally {
    if (n === probing) {
      logEl.hidden = true;
      fetchBtn.classList.remove("busy");
      fetchBtn.textContent = "Fetch";
    }
  }
});
// pasting a URL fetches right away
form.link.addEventListener("paste", () => setTimeout(() => /^https?:\/\/\S+$/.test(form.link.value.trim()) && form.requestSubmit()));

/* Queue: one download at a time */

function enqueue(it) {
  Object.assign(it, { id: nextId++, status: "queued", progress: 0, p: null });
  items.push(it);
  batch++;
  saved = null;
  pump();
  renderQueue();
}

async function pump() {
  if (items.some((i) => i.status === "active")) return;
  const it = items.find((i) => i.status === "queued");
  if (!it) return;
  Object.assign(it, { status: "active", p: null });
  try {
    await invoke("download", { id: it.id, url: it.url, dir, proxy: proxy(), opts: it.opts });
  } catch (e) {
    fail(it, e);
    pump();
    renderQueue();
  }
}

// the backend sends "explanation\nyt-dlp's own message"; show the explanation and keep the detail one glance away
const errHtml = (e) => String(e).split("\n").map((l, i) => i ? `<small>${esc(l)}</small>` : esc(l)).join("");

function fail(it, error) {
  Object.assign(it, { status: "failed", error });
  finished++;
  notify("Download failed", it.title);
}

async function notify(title, body) {
  if (document.hasFocus()) return;
  try {
    if (!(await notification.isPermissionGranted()) && (await notification.requestPermission()) !== "granted") return;
    notification.sendNotification({ title, body });
  } catch {} // notifications are a nicety; never break the queue over them
}

function metaOf(it) {
  if (it.status === "failed") return [esc(String(it.error).split("\n")[0])];
  if (it.status === "queued") return [esc(it.label), it.progress ? `${Math.floor(it.progress)}% · Queued` : "Queued"];
  if (it.status === "paused") return [esc(it.label), `${Math.floor(it.progress)}% · Paused`];
  const p = it.p;
  if (!p) return [esc(it.label), "Starting…"];
  const total = p.total_bytes ?? p.total_bytes_estimate;
  return [esc(it.label), total && mb(total), p.speed && `${mb(p.speed)}/s`, p.eta != null && eta(p.eta)];
}

function rowEl(it) {
  const active = it.status === "active";
  const right = `<span class="percent nums">${active ? `${Math.floor(it.progress)}%` : ""}</span><span class="actions">` +
    (it.status === "failed" ? btn("retry", "Try again", ICON.retry) + btn("dismiss", "Dismiss", ICON.stop)
      : (active ? btn("pause", "Pause", ICON.pause) : it.status === "paused" ? btn("resume", "Resume", ICON.play) : "") +
        btn("stop", active ? "Stop download" : "Remove from queue", ICON.stop)) + "</span>";
  const li = row("li", `item ${it.status}`, it.thumb, it.title, metaOf(it), right, active ? '<span class="tube"></span>' : "");
  li.dataset.id = it.id;
  if (it.status === "failed") li.querySelector(".meta").title = it.error;
  li.style.setProperty("--p", `${it.progress}%`);
  return li;
}

// The strip on the Download page and the Library tab badge
function renderStatus() {
  const act = items.find((i) => i.status === "active");
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

function renderQueue() {
  if (!items.length) batch = finished = 0;
  queue.replaceChildren(...items.map(rowEl));
  $("#downloads").hidden = !items.length;
  renderStatus();
}

let savedTimer;
listen("dl", ({ payload: ev }) => {
  const it = items.find((i) => i.id === ev.id);
  if (!it) return;
  if (ev.kind === "info") {
    Object.assign(it, { title: ev.info.title ?? it.title, thumb: ev.info.thumbnail ?? it.thumb });
    return renderQueue();
  }
  if (ev.kind === "progress") {
    const p = (it.p = ev.p);
    const total = p.total_bytes ?? p.total_bytes_estimate;
    // shortcut: video+audio downloads report two passes, so the bar refills once; weight the passes if it bothers anyone
    if (total) it.progress = Math.min(100, (p.downloaded_bytes / total) * 100);
    const li = queue.querySelector(`[data-id="${it.id}"]`);
    if (li) {
      li.style.setProperty("--p", `${it.progress}%`);
      li.querySelector(".percent").textContent = `${Math.floor(it.progress)}%`;
      li.querySelector(".meta").innerHTML = metaHtml(metaOf(it));
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
      history.unshift({ title: it.title, thumb: it.thumb, path: ev.path, label: it.label, size: it.size, at: Date.now(), warnings: ev.warnings });
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
  const li = row("li", "item done", h.thumb, h.title, [`${ICON.check} ${esc(h.label ?? "")}`, h.size && mb(h.size), when(h.at), h.warnings?.length && `<span class="warn" title="${esc(h.warnings.join("\n"))}">${h.warnings.length} warning${h.warnings.length > 1 ? "s" : ""}</span>`],
    `<span class="actions">${btn("open", "Open", ICON.play)}${btn("reveal", finder, ICON.folder)}${btn("remove", "Remove from history", ICON.stop)}</span>`);
  li.dataset.i = i;
  li.tabIndex = 0;
  return li;
};

function renderHistory() {
  const q = $("#search").value.trim().toLowerCase();
  const list = $("#history");
  const shown = history.map(histEl).filter((li, i) => !q || history[i].title.toLowerCase().includes(q));
  list.replaceChildren(...shown);
  if (!shown.length) list.innerHTML = `<li class="empty">${q ? "No matches" : "Nothing downloaded yet"}</li>`;
  $("#clear").hidden = $("#search").hidden = !history.length;
  $("#recent-list").replaceChildren(...history.slice(0, 3).map(histEl));
  $("#recent").hidden = !history.length || !pick.hidden;
  $("#hint").hidden = !!history.length || !pick.hidden;
}

// file may have been moved or deleted since; nothing useful to do then
const reveal = (path) => opener.revealItemInDir(path).catch(() => {});
const openFile = (path) => opener.openPath(path).catch(() => {});
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
for (const l of [$("#history"), $("#recent-list")]) for (const t of ["click", "dblclick", "keydown"]) l.addEventListener(t, onHistory);
$("#search").addEventListener("input", renderHistory);
$("#clear").addEventListener("click", () => { history = []; saveHistory(); });

/* Settings */

// Browser cookies: one snapshot of the signed-in browser, used for every fetch and download
const cookieStatus = $("#cookie-status");
const cookieBrowser = $("#cookie-browser");
cookieBrowser.value = store("cookieBrowser") ?? "chrome";
cookieBrowser.addEventListener("change", () => store("cookieBrowser", cookieBrowser.value));
const showCookies = (on, note) => {
  $("#cookie-remove").hidden = !on;
  cookieStatus.textContent = note ?? (on ? "Imported; re-import when sign-in expires" : "Sign-in for YouTube, Instagram, X and other sites");
};
$("#cookie-import").addEventListener("click", () => busy($("#cookie-import"), "Importing…", async () => {
  cookieStatus.textContent = "Reading cookies; allow access if your system asks…";
  try {
    showCookies(true, `Imported ${await invoke("import_cookies", { browser: cookieBrowser.value })}`);
  } catch (e) {
    cookieStatus.innerHTML = errHtml(e);
  }
}));
$("#cookie-remove").addEventListener("click", () => invoke("remove_cookies").then(() => showCookies(false), (e) => (cookieStatus.textContent = String(e))));

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
const useBuiltin = $("#use-builtin");
let ytdlp = {};
async function refreshYtdlp(note) {
  ytdlp = await invoke("ytdlp_info").catch(() => ({}));
  showCookies(ytdlp.cookies);
  $("#ytdlp-ver").textContent = ytdlp.version ? `yt-dlp ${ytdlp.version}` : "yt-dlp not found";
  status.textContent = note ?? (ytdlp.managed ? "Built-in, updates itself" : ytdlp.version ? "System install (pip, Homebrew…); the app can't update it" : "Install it to start downloading");
  $("#check").hidden = !ytdlp.managed;
  useBuiltin.hidden = ytdlp.managed;
  useBuiltin.textContent = ytdlp.version ? "Use built-in yt-dlp" : "Install yt-dlp";
}
async function busy(b, label, work) {
  const text = b.textContent;
  b.disabled = true;
  b.textContent = label;
  try { await work(); } finally { b.disabled = false; b.textContent = text; }
}
async function checkUpdates() {
  status.textContent = "Checking for updates…";
  const note = await invoke("update_ytdlp").catch(String);
  await refreshYtdlp(note);
}
$("#check").addEventListener("click", () => busy($("#check"), "Checking…", checkUpdates));
useBuiltin.addEventListener("click", () => busy(useBuiltin, "Downloading…", async () => {
  status.textContent = "Downloading the standalone yt-dlp…";
  const note = await invoke("install_ytdlp").catch(String);
  await refreshYtdlp(note);
}));

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
    showProxy();
  });
}
showProxy();

// Supported sites: yt-dlp's extractor list, one row per site (youtube:tab etc. fold into youtube)
const sites = $("#sites");
let siteNames = [];
function renderSites() {
  const q = $("#sites-search").value.trim().toLowerCase();
  const shown = siteNames.filter((n) => n.toLowerCase().includes(q));
  $("#sites-count").textContent = shown.length;
  $("#sites-list").replaceChildren(...shown.map((n) => Object.assign(document.createElement("li"), { textContent: n })));
}
$("#sites-btn").addEventListener("click", () => busy($("#sites-btn"), "Loading…", async () => {
  if (!siteNames.length) {
    const list = await invoke("list_sites").catch((e) => { status.textContent = String(e); });
    if (!list) return;
    siteNames = [...new Set(list.map((n) => n.split(":")[0]).filter((n) => n && n !== "generic" && !n.includes("BROKEN")))].sort((a, b) => a.localeCompare(b));
  }
  renderSites();
  sites.showModal();
}));
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
// first launch downloads yt-dlp, ffmpeg and deno; later launches return at once
status.textContent = "Getting yt-dlp, ffmpeg and deno…";
invoke("install_tools").then(() => refreshYtdlp().then(() => ytdlp.managed && checkUpdates()), (e) => refreshYtdlp(`Couldn't download tools: ${e}`));
checkApp(true);
