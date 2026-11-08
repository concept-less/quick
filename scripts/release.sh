#!/usr/bin/env bash
# scripts/release.sh <patch|minor|major|X.Y.Z> [--dry-run]
# Publication always uses the same trusted main Actions workflow/lock as push.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUMP="" DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    -h|--help) echo 'scripts/release.sh <patch|minor|major|X.Y.Z> [--dry-run]'; exit 0 ;;
    --npm|--no-push|--notes) echo "$1 is no longer supported; use --dry-run for a local preview, or the shared Actions workflow for publication" >&2; exit 2 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) BUMP="$1"; shift ;;
  esac
done
[ -n "$BUMP" ] || { echo 'version/bump required' >&2; exit 2; }
if [ "$DRY" = 0 ]; then
  gh workflow run release.yml -R concept-less/quick --ref main -f "bump=$BUMP"
  echo 'Queued main Release: https://github.com/concept-less/quick/actions/workflows/release.yml'
  exit 0
fi
# A dry-run is an isolated preview of committed HEAD; never bump/tag the caller's tree.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cd "$ROOT"
git archive HEAD | tar -x -C "$STAGE"
VER="$(node --input-type=module -e '
  import {nextVersion} from "./scripts/release-policy.mjs";
  import {execFileSync} from "node:child_process";
  import {readFileSync} from "node:fs";
  console.log(nextVersion([JSON.parse(readFileSync("package.json")).version, ...execFileSync("git",["tag","--list","v*"],{encoding:"utf8"}).trim().split("\n")],process.argv[1]));
' "$BUMP")"
cd "$STAGE"
node --input-type=module - "$VER" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
for(const file of ['package.json','electron/package.json','electron/package-lock.json','browser/manifest.json']) {
  const old=readFileSync(file,'utf8'), data=JSON.parse(old); data.version=process.argv[2];
  if(data.packages?.['']) data.packages[''].version=process.argv[2];
  writeFileSync(file,JSON.stringify(data,null,/^\{\n\t/.test(old)?'\t':2)+'\n');
}
JS
mkdir -p dist/release
npm pack --silent --pack-destination dist/release
bash scripts/pack-extension.sh
cp dist/quick-agent-extension-*.zip dist/release/
(cd dist/release && shasum -a 256 ./*) | sed 's#  \./#  #' > dist/SHA256SUMS
mv dist/SHA256SUMS dist/release/
mkdir -p "$ROOT/dist/release-preview/$VER"
cp dist/release/* "$ROOT/dist/release-preview/$VER/"
echo "Preview: $ROOT/dist/release-preview/$VER (no tests/macOS build, tag, push, Release or install)"
