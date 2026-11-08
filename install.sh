#!/usr/bin/env bash
# quick-agent installer: installs a GitHub Release into ~/.quick-agent/app/<version>, points
# ~/.quick-agent/app/current at it (previous version kept for `quick upgrade --rollback`),
# links `quick` into ~/.local/bin and registers the pi extension. A git checkout you develop in is
# left untouched (it simply stops being the one that pi / `quick` use).
#
#   curl -fsSL https://raw.githubusercontent.com/concept-less/quick/main/install.sh | bash
#   bash install.sh [--version 0.4.0] [--tarball quick-agent-0.4.0.tgz [--sums SHA256SUMS]]
#                   [--no-pi] [--no-link] [--no-restart]
#
# Env: QA_HOME (~/.quick-agent), QA_APP_DIR ($QA_HOME/app), QA_BIN_DIR (~/.local/bin),
#      QA_GITHUB_REPO (concept-less/quick), QA_GITHUB_API (https://api.github.com), GITHUB_TOKEN.
set -euo pipefail

REPO="${QA_GITHUB_REPO:-concept-less/quick}"
API="${QA_GITHUB_API:-https://api.github.com}"
QA_HOME="${QA_HOME:-$HOME/.quick-agent}"
APP="${QA_APP_DIR:-$QA_HOME/app}"
BIN_DIR="${QA_BIN_DIR:-$HOME/.local/bin}"
VERSION="" TARBALL="" SUMS="" DO_PI=1 DO_LINK=1 DO_RESTART=1

while [ $# -gt 0 ]; do
	case "$1" in
		--version) VERSION="${2#v}"; shift 2 ;;
		--tarball) TARBALL="$2"; shift 2 ;;
		--sums) SUMS="$2"; shift 2 ;;
		--no-pi) DO_PI=0; shift ;;
		--no-link) DO_LINK=0; shift ;;
		--no-restart) DO_RESTART=0; shift ;;
		-h|--help) sed -n '2,13p' "$0"; exit 0 ;;
		*) echo "install.sh: unknown option $1" >&2; exit 2 ;;
	esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "需要 Node.js >= 22.18（https://nodejs.org）"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' || die "Node.js $(node -v) 太旧，需要 >= 22.18"
command -v tar >/dev/null || die "需要 tar"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
fetch() { # url out [accept]   (${a[@]+…}: empty arrays under set -u on macOS bash 3.2)
	local auth=()
	if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ] && [[ "$1" == "$API"* ]]; then auth=(-H "Authorization: Bearer ${GITHUB_TOKEN:-$GH_TOKEN}"); fi
	curl -fsSL --retry 2 ${auth[@]+"${auth[@]}"} -H "Accept: ${3:-application/octet-stream}" -o "$2" "$1"
}

mkdir -p "$APP"
TMP="$(mktemp -d "$APP/.tmp-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- download + verify
if [ -n "$TARBALL" ]; then
	cp "$TARBALL" "$TMP/" && NAME="$(basename "$TARBALL")"
	[ -n "$SUMS" ] && cp "$SUMS" "$TMP/SHA256SUMS"
else
	command -v curl >/dev/null || die "需要 curl"
	if [ -n "$VERSION" ]; then URL="$API/repos/$REPO/releases/tags/v$VERSION"; else URL="$API/repos/$REPO/releases/latest"; fi
	fetch "$URL" "$TMP/release.json" application/vnd.github+json || die "读取 Release 失败：$URL"
	read -r NAME TGZ_URL SUMS_URL < <(node -e '
		const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		const v = String(r.tag_name).replace(/^v/, "");
		const t = r.assets.find((a) => a.name === `quick-agent-${v}.tgz`) || r.assets.find((a) => /^quick-agent-.*\.tgz$/.test(a.name));
		const s = r.assets.find((a) => a.name === "SHA256SUMS");
		if (!t) { console.error(`release ${r.tag_name} has no quick-agent-*.tgz`); process.exit(1); }
		console.log(t.name, t.browser_download_url, s ? s.browser_download_url : "-");
	' "$TMP/release.json")
	say "下载 $NAME …"
	fetch "$TGZ_URL" "$TMP/$NAME"
	[ "$SUMS_URL" != "-" ] && fetch "$SUMS_URL" "$TMP/SHA256SUMS"
fi
if [ -f "$TMP/SHA256SUMS" ]; then
	EXPECTED="$(awk -v n="$NAME" '{f=$2; sub(/^\*/,"",f)} f==n {print $1}' "$TMP/SHA256SUMS")"
	[ -n "$EXPECTED" ] || die "SHA256SUMS 里没有 $NAME"
	ACTUAL="$(sha256 "$TMP/$NAME")"
	[ "$EXPECTED" = "$ACTUAL" ] || die "校验失败：$NAME 的 sha256 是 ${ACTUAL}，应为 $EXPECTED"
	say "校验通过（sha256 ${ACTUAL:0:12}…）"
elif [ -z "$TARBALL" ]; then
	die "Release 没有 SHA256SUMS，拒绝安装"
else
	say "（本地安装包，未提供 --sums，跳过校验）"
fi

# ---------------------------------------------------------------- unpack + switch
mkdir "$TMP/x"
tar -xzf "$TMP/$NAME" -C "$TMP/x"
PKG="$TMP/x/package"
[ -f "$PKG/package.json" ] || die "安装包里没有 package/package.json"
VER="$(node -p 'require(process.argv[1]).name + " " + require(process.argv[1]).version' "$PKG/package.json")"
[ "${VER%% *}" = "quick-agent" ] || die "安装包不是 quick-agent（${VER%% *}）"
VER="${VER#* }"
CUR="$(readlink "$APP/current" 2>/dev/null || true)"
if [ "$CUR" = "$VER" ] && [ -f "$APP/$VER/package.json" ]; then
	say "quick-agent $VER 已经是当前版本"
else
	rm -rf "${APP:?}/$VER"
	mv "$PKG" "$APP/$VER"
	# Atomic switch: new symlink + rename over the old one; the old target becomes `previous`.
	node -e '
		const fs = require("fs"), p = require("path");
		const [app, ver] = process.argv.slice(1);
		const set = (name, target) => { const t = p.join(app, `.${name}-${process.pid}`); fs.rmSync(t, { force: true }); fs.symlinkSync(target, t); fs.renameSync(t, p.join(app, name)); };
		let old; try { old = fs.readlinkSync(p.join(app, "current")); } catch {}
		set("current", ver);
		if (old && old !== ver) set("previous", old);
	' "$APP" "$VER"
	say "已安装 quick-agent $VER → $APP/current${CUR:+（上一个版本 ${CUR}，可 quick upgrade --rollback）}"
fi
chmod +x "$APP/current/bin/quick" 2>/dev/null || true

# ---------------------------------------------------------------- quick on PATH
if [ "$DO_LINK" = 1 ]; then
	mkdir -p "$BIN_DIR"
	OLD_LINK="$(readlink "$BIN_DIR/quick" 2>/dev/null || true)"
	ln -sfn "$APP/current/bin/quick" "$BIN_DIR/quick"
	say "quick → $BIN_DIR/quick${OLD_LINK:+（原来指向 ${OLD_LINK}）}"
	case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "注意：$BIN_DIR 不在 PATH 里，请加到 shell 配置：export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
	FIRST="$(command -v quick 2>/dev/null || true)"
	[ -n "$FIRST" ] && [ "$FIRST" != "$BIN_DIR/quick" ] && say "注意：PATH 里先找到的是 ${FIRST}，不是 $BIN_DIR/quick"
fi

# ---------------------------------------------------------------- pi extension
if [ "$DO_PI" = 1 ] && command -v pi >/dev/null; then
	PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
	# Other quick-agent copies registered in pi (e.g. a git checkout) would load twice: unregister them.
	if [ -f "$PI_DIR/settings.json" ]; then
		node -e '
			const fs = require("fs"), p = require("path");
			const [dir, cur] = process.argv.slice(1);
			const s = JSON.parse(fs.readFileSync(p.join(dir, "settings.json"), "utf8"));
			for (const e of s.packages || []) {
				const src = typeof e === "string" ? e : e && e.source;
				if (!src || /^(npm|git|https?):/.test(src)) continue;
				const abs = p.resolve(dir, src.replace(/^~(?=\/)/, require("os").homedir()));
				try { if (JSON.parse(fs.readFileSync(p.join(abs, "package.json"), "utf8")).name === "quick-agent" && p.resolve(abs) !== p.resolve(cur)) console.log(src); } catch {}
			}
		' "$PI_DIR" "$APP/current" | while read -r OTHER; do
			say "pi: 移除另一份 quick-agent（${OTHER}，目录本身保留）"
			(cd "$PI_DIR" && pi remove "$OTHER" >/dev/null 2>&1) || say "  pi remove $OTHER 失败，请手动执行"
		done
	fi
	pi install "$APP/current" >/dev/null && say "pi: 已加载 $APP/current（升级后前台 pi 空闲时自动 /reload）"
elif [ "$DO_PI" = 1 ]; then
	say "没有找到 pi：装好 pi 后运行 pi install $APP/current"
fi

# ---------------------------------------------------------------- restart hub + web ui on the new version
if [ "$DO_RESTART" = 1 ]; then
	PORT="$(node -e 'try{const c=require(process.argv[1]);console.log(process.env.QA_PORT||c.port||7788)}catch{console.log(process.env.QA_PORT||7788)}' "$QA_HOME/config.json")"
	if curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
		say "重启 hub 和 Web UI 服务（worker 不受影响）…"
		"$APP/current/bin/quick" hub reload >/dev/null || say "hub reload 失败，见 $QA_HOME/hub.log"
	fi
fi
say "完成：quick-agent ${VER}。以后用 quick upgrade 升级（或在 Web UI 顶栏点「升级」）。"
