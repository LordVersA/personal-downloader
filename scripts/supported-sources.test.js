import assert from "node:assert/strict";
import { test } from "node:test";
import { supportedSources } from "../src/supported-sources.js";

test("merges site capabilities across tools and extractor variants", () => {
  const sources = supportedSources(["youtube", "youtube:tab", "Instagram", "instagram:user", "generic", "Example (BROKEN)", "vimeo"]);
  const youtube = sources.filter((source) => source.name === "YouTube");
  assert.equal(youtube.length, 1);
  assert.deepEqual(youtube[0].types, ["media", "live"]);
  assert.deepEqual(youtube[0].tools, ["yt-dlp", "streamlink"]);
  assert.deepEqual(sources.find((source) => source.name === "Instagram").tools, ["yt-dlp", "gallery-dl"]);
  assert(!sources.some((source) => /generic|BROKEN/i.test(source.name)));
});

test("keeps galleries, live sites and file inputs available without yt-dlp's catalog", () => {
  const sources = supportedSources([]);
  for (const name of ["Pixiv", "Twitch", "Magnets & torrent files", "Direct file URLs", "HLS / DASH streams"]) {
    assert(sources.some((source) => source.name === name));
  }
});
