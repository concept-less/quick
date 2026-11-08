#!/usr/bin/env node
// Propagate shared sources into the surfaces that cannot import them at runtime:
//   shared/tokens.css  -> browser/tokens.css   (popup.html <link>s it)
//                      -> browser/tokens.js    (content.js injects the string into its closed shadow DOM)
//                      -> ui/app.html          (block between /* @qa-tokens:begin */ and /* @qa-tokens:end */)
//   shared/page-url.mjs -> browser/page-url.js  (pageKey() for content.js; the hub imports the original)
// The browser extension must ship self-contained files, so its copies are generated, not imported.
//
//   node scripts/sync-shared.mjs            write all copies
//   node scripts/sync-shared.mjs --browser  write the browser/ copies only (used by pack-extension.sh)
//   node scripts/sync-shared.mjs --check    exit 1 if any copy is stale (used by tests)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const browserOnly = args.includes("--browser");
const src = readFileSync(join(root, "shared/tokens.css"), "utf8").trim();
const banner = "/* GENERATED from shared/tokens.css by scripts/sync-shared.mjs. Do not edit. */";
const pageUrl = readFileSync(join(root, "shared/page-url.mjs"), "utf8").trim();

const targets = [
	{ file: "browser/tokens.css", render: () => `${banner}\n${src}\n` },
	{
		file: "browser/tokens.js",
		render: () => `${banner}\n// Loaded before content.js (same isolated world); content.js puts this into its shadow root.\nglobalThis.__qaTokensCss = ${JSON.stringify(src)};\n`,
	},
	{
		file: "browser/page-url.js",
		render: () =>
			`// GENERATED from shared/page-url.mjs by scripts/sync-shared.mjs. Do not edit.\n// Loaded before content.js (same isolated world).\n(() => {\n${pageUrl.replace(/^export function /m, "function ")}\nglobalThis.__qaPageKey = pageKey;\n})();\n`,
	},
];
if (!browserOnly)
	targets.push({
		file: "ui/app.html",
		render: (cur) => {
			const re = /\/\* @qa-tokens:begin \*\/[\s\S]*?\/\* @qa-tokens:end \*\//;
			if (!re.test(cur)) throw new Error("ui/app.html: missing /* @qa-tokens:begin */ … /* @qa-tokens:end */ block");
			return cur.replace(re, () => `/* @qa-tokens:begin */\n${banner}\n${src}\n/* @qa-tokens:end */`);
		},
	});

let stale = [];
for (const t of targets) {
	const path = join(root, t.file);
	const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
	const next = t.render(cur);
	if (cur === next) continue;
	stale.push(t.file);
	if (!check) writeFileSync(path, next);
}
if (check && stale.length) {
	console.error(`design tokens out of sync: ${stale.join(", ")}\nrun: node scripts/sync-shared.mjs`);
	process.exit(1);
}
if (!check) console.log(stale.length ? `synced: ${stale.join(", ")}` : "shared copies up to date");
