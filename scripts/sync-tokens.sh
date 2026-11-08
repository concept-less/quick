#!/usr/bin/env bash
# Copy the shared design tokens (shared/tokens.css, the single source) into the browser extension,
# which may only ship files from browser/:
#   browser/tokens.css  — <link>ed by popup.html
#   browser/tokens.js   — injected before content.js; exposes the CSS for the in-page shadow DOM
#   scripts/sync-tokens.sh          write the copies
#   scripts/sync-tokens.sh --check  exit 1 if the copies are stale
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 - "$ROOT" "${1:-}" <<'PY'
import json, os, sys
root, mode = sys.argv[1], sys.argv[2]
css = open(os.path.join(root, "shared", "tokens.css"), encoding="utf-8").read()
head = "/* GENERATED from shared/tokens.css by scripts/sync-tokens.sh — do not edit */\n"
out = {
    "browser/tokens.css": head + css,
    "browser/tokens.js": head + "globalThis.__qaTokensCss = " + json.dumps(css, ensure_ascii=False) + ";\n",
}
stale = []
for rel, body in out.items():
    p = os.path.join(root, rel)
    cur = open(p, encoding="utf-8").read() if os.path.exists(p) else None
    if cur == body: continue
    if mode == "--check": stale.append(rel)
    else:
        open(p, "w", encoding="utf-8").write(body)
        print(f"  wrote {rel}")
if stale:
    print("design tokens out of date (run scripts/sync-tokens.sh): " + ", ".join(stale)); sys.exit(1)
PY
