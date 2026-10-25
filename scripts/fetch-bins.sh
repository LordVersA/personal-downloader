#!/usr/bin/env bash
# Downloads the tools the app bundles (yt-dlp, ffmpeg, ffprobe, deno) into src-tauri/resources/bin for one Rust target.
# Always the latest upstream builds; every file is checked against the SHA-256 its upstream publishes.
set -euo pipefail
target=${1:?usage: fetch-bins.sh <rust target triple>}
out=src-tauri/resources/bin
tmp=$(mktemp -d)
mkdir -p "$out"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# fetch <url> <dest> <expected sha256>: download, and fail the build on a missing or mismatched hash
fetch() {
  curl -fsSL --retry 3 --retry-all-errors -o "$2" "$1"
  [ -n "$3" ] && [ "$(sha "$2")" = "$3" ] || { echo "checksum mismatch: $1" >&2; exit 1; }
}
# sum_of <SUMS text> <file name>
sum_of() { awk -v f="$2" '$2 == f || $2 == "*" f { print $1 }' <<<"$1"; }

ytdlp=https://github.com/yt-dlp/yt-dlp/releases/latest/download
ytdlp_sums=$(curl -fsSL "$ytdlp/SHA2-256SUMS")
ffbuilds=https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest

case "$target" in
  aarch64-apple-darwin | x86_64-apple-darwin)
    arch=$([ "$target" = aarch64-apple-darwin ] && echo arm64 || echo amd64)
    fetch "$ytdlp/yt-dlp_macos" "$out/yt-dlp" "$(sum_of "$ytdlp_sums" yt-dlp_macos)"
    for t in ffmpeg ffprobe; do
      # the "latest" link redirects to a versioned file whose .sha256 sits next to it
      url=$(curl -fsSIL --retry 3 --retry-all-errors -o /dev/null -w '%{url_effective}' "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$arch/snapshot/$t.zip")
      fetch "$url" "$tmp/$t.zip" "$(curl -fsSL "$url.sha256" | cut -d' ' -f1)"
      unzip -o -q "$tmp/$t.zip" -d "$out"
    done
    ;;
  x86_64-pc-windows-msvc)
    ff_sums=$(curl -fsSL "$ffbuilds/checksums.sha256")
    fetch "$ytdlp/yt-dlp.exe" "$out/yt-dlp.exe" "$(sum_of "$ytdlp_sums" yt-dlp.exe)"
    fetch "$ffbuilds/ffmpeg-master-latest-win64-gpl.zip" "$tmp/ff.zip" "$(sum_of "$ff_sums" ffmpeg-master-latest-win64-gpl.zip)"
    unzip -o -q -j "$tmp/ff.zip" '*/bin/ffmpeg.exe' '*/bin/ffprobe.exe' -d "$out"
    ;;
  x86_64-unknown-linux-gnu)
    ff_sums=$(curl -fsSL "$ffbuilds/checksums.sha256")
    fetch "$ytdlp/yt-dlp_linux" "$out/yt-dlp" "$(sum_of "$ytdlp_sums" yt-dlp_linux)"
    fetch "$ffbuilds/ffmpeg-master-latest-linux64-gpl.tar.xz" "$tmp/ff.tar.xz" "$(sum_of "$ff_sums" ffmpeg-master-latest-linux64-gpl.tar.xz)"
    tar -xJf "$tmp/ff.tar.xz" -C "$tmp"
    cp "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe "$out"
    ;;
  *) echo "unsupported target: $target" >&2; exit 1 ;;
esac

deno=https://github.com/denoland/deno/releases/latest/download/deno-$target.zip
fetch "$deno" "$tmp/deno.zip" "$(curl -fsSL "$deno.sha256sum" | cut -d' ' -f1)"
unzip -o -q "$tmp/deno.zip" -d "$out"
chmod +x "$out"/*
ls -la "$out"
