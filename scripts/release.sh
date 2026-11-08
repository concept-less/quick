#!/usr/bin/env bash
# Maintainer release flow:
#   scripts/release.sh <X.Y.Z | patch | minor | major> [--dry-run] [--npm] [--no-push] [--notes FILE]
#
#  1. checks: on main, clean tree, up to date with origin/main, tag does not exist, npm test passes
#  2. bumps the version in package.json, electron/package.json (+ lock) and browser/manifest.json
#  3. prepends a CHANGELOG.md section generated from the commits since the previous tag
#  4. commits "release vX.Y.Z", tags vX.Y.Z, pushes main + tag
#  5. builds the assets into dist/release/:
#       quick-agent-X.Y.Z.tgz                     (npm pack: what install.sh / quick upgrade install)
#       quick-agent-extension-X.Y.Z-chrome.zip    (browser extension, also -firefox.zip)
#       SHA256SUMS
#  6. gh release create vX.Y.Z with these assets and the changelog section as notes.
#     The "release" GitHub Actions workflow then builds the macOS desktop app on a macos runner and
#     adds quick-agent-X.Y.Z-arm64.dmg / -arm64-mac.zip (and their checksums) to the same release.
#  7. --npm: also npm publish (off by default).
#
# --dry-run builds everything into dist/release/ without committing, tagging, pushing or publishing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUMP="" DRY=0 NPM=0 PUSH=1 NOTES_FILE=""
while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY=1; shift ;;
		--npm) NPM=1; shift ;;
		--no-push) PUSH=0; shift ;;
		--notes) NOTES_FILE="$2"; shift 2 ;;
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
		-*) echo "release.sh: unknown option $1" >&2; exit 2 ;;
		*) BUMP="$1"; shift ;;
	esac
done
[ -n "$BUMP" ] || { sed -n '2,3p' "$0"; exit 2; }
die() { echo "release.sh: $*" >&2; exit 1; }

CUR="$(node -p 'require("./package.json").version')"
VER="$(node -e '
	const [cur, b] = process.argv.slice(1);
	const [x, y, z] = cur.split("-")[0].split(".").map(Number);
	const v = b === "major" ? `${x + 1}.0.0` : b === "minor" ? `${x}.${y + 1}.0` : b === "patch" ? `${x}.${y}.${z + 1}` : b.replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) { console.error(`bad version ${v}`); process.exit(1); }
	console.log(v);
' "$CUR" "$BUMP")"
TAG="v$VER"
PREV_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
echo "release $CUR → $VER (previous tag: ${PREV_TAG:-none})"

if [ "$DRY" = 0 ]; then
	[ "$(git symbolic-ref --short HEAD)" = main ] || die "not on main"
	[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes"
	git fetch -q origin main --tags
	[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not equal to origin/main (pull / push first)"
	git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
	command -v gh >/dev/null || die "gh (GitHub CLI) is required"
	gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
	echo "running npm test …"
	npm test --silent >/dev/null 2>&1 || die "npm test failed (run it to see why)"
fi

# ---------------------------------------------------------------- version bump
bump() {
	node -e '
		const fs = require("fs");
		const [ver, ...files] = process.argv.slice(1);
		for (const f of files) {
			if (!fs.existsSync(f)) continue;
			const j = JSON.parse(fs.readFileSync(f, "utf8"));
			j.version = f.endsWith("manifest.json") ? ver.split("-")[0] : ver; // Chrome: dotted numbers only
			if (j.packages && j.packages[""]) j.packages[""].version = ver;
			const indent = /^\{\n\t/.test(fs.readFileSync(f, "utf8")) ? "\t" : 2;
			fs.writeFileSync(f, JSON.stringify(j, null, indent) + "\n");
		}
	' "$1" package.json electron/package.json electron/package-lock.json browser/manifest.json
}

# ---------------------------------------------------------------- changelog
SECTION="$(mktemp)"
trap 'rm -f "$SECTION"' EXIT
{
	echo "## $TAG — $(date +%Y-%m-%d)"
	echo
	if [ -n "$NOTES_FILE" ]; then cat "$NOTES_FILE"; echo; fi
	RANGE="${PREV_TAG:+$PREV_TAG..}HEAD"
	git log --no-merges --pretty='format:%s' $RANGE | grep -vE '^release v[0-9]' | sed -E 's/^/- /' | cut -c1-300
	echo
	[ -n "$PREV_TAG" ] && echo && echo "Full diff: https://github.com/concept-less/quick/compare/$PREV_TAG...$TAG"
} >"$SECTION"

if [ "$DRY" = 0 ]; then
	bump "$VER"
	{ echo "# Changelog"; echo; cat "$SECTION"; echo; [ -f CHANGELOG.md ] && sed '1{/^# Changelog$/d;}' CHANGELOG.md | sed '1{/^$/d;}'; } >CHANGELOG.md.new
	mv CHANGELOG.md.new CHANGELOG.md
	git add package.json electron/package.json electron/package-lock.json browser/manifest.json CHANGELOG.md
	git commit -qm "release $TAG"
	git tag -a "$TAG" -m "quick-agent $TAG"
fi

# ---------------------------------------------------------------- build assets
OUT="$ROOT/dist/release"
rm -rf "$OUT" && mkdir -p "$OUT"
if [ "$DRY" = 1 ]; then
	# Build from a temporary copy with the bumped version, leave the tree untouched.
	STAGE="$(mktemp -d)"
	git ls-files -z | xargs -0 -I{} cp --parents {} "$STAGE/" 2>/dev/null || rsync -a --exclude .git ./ "$STAGE/"
	(cd "$STAGE" && bump "$VER" && cp "$SECTION" CHANGELOG.md && npm pack --silent --pack-destination "$OUT" >/dev/null && scripts/pack-extension.sh >/dev/null && cp dist/quick-agent-extension-*.zip "$OUT/")
	rm -rf "$STAGE"
else
	npm pack --silent --pack-destination "$OUT" >/dev/null
	rm -f dist/quick-agent-extension-*.zip
	scripts/pack-extension.sh >/dev/null
	cp dist/quick-agent-extension-*.zip "$OUT/"
fi
[ -f "$OUT/quick-agent-$VER.tgz" ] || die "npm pack did not produce quick-agent-$VER.tgz"
(cd "$OUT" && { command -v sha256sum >/dev/null && sha256sum ./* || shasum -a 256 ./*; } | sed 's#  \./#  #' >"$OUT.sums") && mv "$OUT.sums" "$OUT/SHA256SUMS"
echo "assets in $OUT:"
ls -l "$OUT" | tail -n +2

if [ "$DRY" = 1 ]; then
	echo "--- release notes ---"; cat "$SECTION"
	echo "(dry run: nothing committed, tagged, pushed or published)"
	exit 0
fi

# ---------------------------------------------------------------- publish
if [ "$PUSH" = 1 ]; then
	git push -q origin main
	git push -q origin "$TAG"
	gh release create "$TAG" "$OUT"/* --title "quick-agent $TAG" --notes-file "$SECTION" --verify-tag
	echo "release: $(gh release view "$TAG" --json url -q .url)"
	echo "macOS desktop app: built by GitHub Actions (workflow \"release\"); follow with: gh run watch \$(gh run list -w release -L1 --json databaseId -q '.[0].databaseId')"
else
	echo "not pushed (--no-push): git push origin main $TAG && gh release create $TAG $OUT/* --notes-file CHANGELOG-section"
fi
if [ "$NPM" = 1 ]; then npm publish "$OUT/quick-agent-$VER.tgz"; fi
