#!/usr/bin/env bash
# Downloads the tools the app bundles (yt-dlp, ffmpeg, ffprobe, deno) into src-tauri/resources/bin for one Rust target.
set -euo pipefail
target=${1:?usage: fetch-bins.sh <rust target triple>}
out=src-tauri/resources/bin
tmp=$(mktemp -d)
mkdir -p "$out"
get() { curl -fsSL --retry 3 -o "$2" "$1"; }
ytdlp=https://github.com/yt-dlp/yt-dlp/releases/latest/download
ffbuilds=https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest

case "$target" in
  aarch64-apple-darwin | x86_64-apple-darwin)
    arch=$([ "$target" = aarch64-apple-darwin ] && echo arm64 || echo amd64)
    get "$ytdlp/yt-dlp_macos" "$out/yt-dlp"
    for t in ffmpeg ffprobe; do
      get "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$arch/snapshot/$t.zip" "$tmp/$t.zip"
      unzip -o -q "$tmp/$t.zip" -d "$out"
    done
    ;;
  x86_64-pc-windows-msvc)
    get "$ytdlp/yt-dlp.exe" "$out/yt-dlp.exe"
    get "$ffbuilds/ffmpeg-master-latest-win64-gpl.zip" "$tmp/ff.zip"
    unzip -o -q -j "$tmp/ff.zip" '*/bin/ffmpeg.exe' '*/bin/ffprobe.exe' -d "$out"
    ;;
  x86_64-unknown-linux-gnu)
    get "$ytdlp/yt-dlp_linux" "$out/yt-dlp"
    get "$ffbuilds/ffmpeg-master-latest-linux64-gpl.tar.xz" "$tmp/ff.tar.xz"
    tar -xJf "$tmp/ff.tar.xz" -C "$tmp"
    cp "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe "$out"
    ;;
  *) echo "unsupported target: $target" >&2; exit 1 ;;
esac

get "https://github.com/denoland/deno/releases/latest/download/deno-$target.zip" "$tmp/deno.zip"
unzip -o -q "$tmp/deno.zip" -d "$out"
chmod +x "$out"/*
ls -la "$out"
