#!/usr/bin/env bash
# Build store-ready zips of the browser extension (only runtime files, no docs/dotfiles).
#   scripts/pack-extension.sh            -> dist/quick-agent-extension-<ver>-chrome.zip (Chrome Web Store / Edge Add-ons)
#                                           dist/quick-agent-extension-<ver>-firefox.zip (addons.mozilla.org, experimental)
# Validates manifest.json (JSON, required keys, referenced files exist, no remote code patterns).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 - "$ROOT" <<'PY'
import json, os, re, sys, zipfile
root = sys.argv[1]
src = os.path.join(root, "browser")
dist = os.path.join(root, "dist")
os.makedirs(dist, exist_ok=True)

# Only these extensions are shipped; everything else in browser/ (docs, .DS_Store …) is ignored.
SHIP = re.compile(r"\.(js|json|html|css|png)$")
files = sorted(f for f in os.listdir(src) if SHIP.search(f) and not f.startswith("."))

m = json.load(open(os.path.join(src, "manifest.json"), encoding="utf-8"))
err = []
for k in ("manifest_version", "name", "version", "description", "icons", "action", "background"):
    if k not in m: err.append(f"manifest missing {k}")
if m.get("manifest_version") != 3: err.append("manifest_version must be 3")
if not re.fullmatch(r"\d+(\.\d+){0,3}", m.get("version", "")): err.append("bad version")
if len(m.get("description", "")) > 132: err.append(f"description too long ({len(m['description'])} > 132)")
if len(m.get("name", "")) > 75: err.append("name too long (> 75)")
refs = list(m.get("icons", {}).values()) + list(m.get("action", {}).get("default_icon", {}).values())
refs += [m["background"]["service_worker"], m["action"].get("default_popup", "")]
for r in filter(None, refs):
    if r not in files: err.append(f"referenced file missing: {r}")
if "<all_urls>" in json.dumps(m.get("host_permissions", [])) + json.dumps(m.get("permissions", [])):
    err.append("<all_urls> in required permissions")
for f in files:
    if f.endswith((".js", ".html")):
        s = open(os.path.join(src, f), encoding="utf-8").read()
        for pat in (r"\beval\s*\(", r"new\s+Function\s*\(", r"<script[^>]+src=[\"']https?:", r"importScripts\s*\(\s*[\"']https?:"):
            if re.search(pat, s): err.append(f"{f}: remote/dynamic code pattern {pat}")
for f in files:
    if f.endswith(".html"):
        s = open(os.path.join(src, f), encoding="utf-8").read()
        if re.search(r"<script>(?!\s*</script>)", s): err.append(f"{f}: inline <script> is blocked by MV3 CSP")
if err:
    print("manifest/package check FAILED:\n  " + "\n  ".join(err)); sys.exit(1)

ver = m["version"]
def write(path, manifest):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            if f == "manifest.json":
                z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            else:
                z.write(os.path.join(src, f), f)
    print(f"  {os.path.relpath(path, root)}  ({os.path.getsize(path)//1024} KB)")

print(f"quick-agent extension v{ver}: {', '.join(files)}")
write(os.path.join(dist, f"quick-agent-extension-{ver}-chrome.zip"), m)

# Firefox (MV3): background must be an event page, needs a gecko id; host permissions
# are user-granted at install/runtime there.
ff = json.loads(json.dumps(m))
ff["background"] = {"scripts": [m["background"]["service_worker"]]}
ff.pop("minimum_chrome_version", None)
ff["browser_specific_settings"] = {"gecko": {"id": "quick-agent@concept-less.github.io", "strict_min_version": "128.0",
    "data_collection_permissions": {"required": ["none"]}}}
write(os.path.join(dist, f"quick-agent-extension-{ver}-firefox.zip"), ff)
PY
