#!/usr/bin/env bash
# Release notes for <tag>: commit subjects since the previous tag, grouped by conventional-commit type.
set -euo pipefail
tag=${1:?usage: changelog.sh <tag> [repo]}
repo=${2:-}
prev=$(git describe --tags --abbrev=0 "$tag^" 2>/dev/null || true)
log=$(git log "${prev:+$prev..}$tag" --no-merges --pretty='%s|%h')

# section <title> <type regex>: matching subjects as "- subject (hash)", type prefix stripped
section() {
  local lines
  lines=$(grep -E "^($2)(\([^)]*\))?!?: " <<<"$log" | sed -E 's/^[a-z]+(\([^)]*\))?!?: //; s/\|([0-9a-f]+)$/ (\1)/; s/^/- /' || true)
  if [ -n "$lines" ]; then printf '### %s\n%s\n\n' "$1" "$lines"; fi
}
section "Features" "feat"
section "Fixes" "fix"
section "Performance" "perf"
section "Other changes" "refactor|style|docs|build|ci|chore|test"
other=$(grep -vE '^[a-z]+(\([^)]*\))?!?: ' <<<"$log" | sed -E 's/\|([0-9a-f]+)$/ (\1)/; s/^/- /' || true)
if [ -n "$other" ]; then printf '### Changes\n%s\n\n' "$other"; fi
if [ -n "$prev" ] && [ -n "$repo" ]; then echo "**Full changelog:** https://github.com/$repo/compare/$prev...$tag"; fi
