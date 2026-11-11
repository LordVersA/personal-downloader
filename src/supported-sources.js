const GALLERIES = [
  ["Instagram", "instagram.com"], ["Pixiv", "pixiv.net"], ["Flickr", "flickr.com"], ["500px", "500px.com"],
  ["DeviantArt", "deviantart.com"], ["Imgur", "imgur.com"], ["Tumblr", "tumblr.com"],
  ["ArtStation", "artstation.com"], ["MangaDex", "mangadex.org"], ["Danbooru", "danbooru.donmai.us"],
  ["Gelbooru", "gelbooru.com"], ["Safebooru", "safebooru.org"], ["Newgrounds", "newgrounds.com"], ["Unsplash", "unsplash.com"],
];
const NAMES = { youtube: "YouTube", soundcloud: "SoundCloud", tiktok: "TikTok", vimeo: "Vimeo", twitter: "X / Twitter", facebook: "Facebook", twitch: "Twitch", reddit: "Reddit", spotify: "Spotify" };

export function supportedSources(extractors) {
  const sources = new Map();
  const add = (key, name, detail, type, tool) => {
    key = key.toLowerCase();
    const source = sources.get(key) ?? { name, detail, types: [], tools: [] };
    if (!source.types.includes(type)) source.types.push(type);
    if (!source.tools.includes(tool)) source.tools.push(tool);
    if (detail) Object.assign(source, { name, detail });
    sources.set(key, source);
  };
  for (const extractor of extractors) {
    if (/BROKEN/i.test(extractor)) continue;
    const key = extractor.split(":")[0].trim().toLowerCase();
    if (key && key !== "generic") add(key, NAMES[key] ?? extractor.split(":")[0], "", "media", "yt-dlp");
  }
  for (const [name, domain] of GALLERIES) add(name, name, domain, "images", "gallery-dl");
  for (const [key, name, domain] of [["youtube", "YouTube", "youtube.com"], ["twitch", "Twitch", "twitch.tv"], ["kick", "Kick", "kick.com"]]) add(key, name, domain, "live", "streamlink");
  add("direct-files", "Direct file URLs", "Download a file from its direct link", "files", "aria2c");
  add("torrents", "Magnets & torrent files", "Magnet links, .torrent URLs and local .torrent files", "files", "aria2c");
  add("manifests", "HLS / DASH streams", "Unencrypted .m3u8 and .mpd links", "files", "N_m3u8DL-RE");
  return [...sources.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
}
