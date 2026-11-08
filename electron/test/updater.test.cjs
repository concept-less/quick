// node --test: desktop self-update planning (electron/src/updater.cjs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const u = require("../src/updater.cjs");

const asset = (name) => ({ name, download: `https://example.invalid/${name}` });
const latest = (v, names) => ({ version: v, url: "https://github.com/x/y/releases/tag/v" + v, assets: names.map(asset) });

test("plan: only newer releases with a mac build for this arch", () => {
	const rel = latest("0.5.0", ["quick-agent-0.5.0.tgz", "quick-agent-0.5.0-arm64.dmg", "quick-agent-0.5.0-arm64-mac.zip", "SHA256SUMS"]);
	const p = u.plan(rel, "0.4.0", "arm64");
	assert.equal(p.version, "0.5.0");
	assert.equal(p.zip.name, "quick-agent-0.5.0-arm64-mac.zip");
	assert.equal(p.dmg.name, "quick-agent-0.5.0-arm64.dmg");
	assert.equal(p.sums.name, "SHA256SUMS");
	assert.equal(u.plan(rel, "0.5.0", "arm64"), undefined, "same version");
	assert.equal(u.plan(rel, "0.6.0", "arm64"), undefined, "older release");
	assert.equal(u.plan(rel, "0.4.0", "x64"), undefined, "no x64 build");
	assert.equal(u.plan(latest("0.5.0", ["quick-agent-0.5.0.tgz"]), "0.4.0", "arm64"), undefined, "no desktop assets");
	assert.equal(u.plan(undefined, "0.4.0"), undefined);
});

test("cmp / parseSums / bundlePath", () => {
	assert.equal(u.cmp("0.10.0", "0.9.9"), 1);
	assert.equal(u.cmp("v1.0.0", "1.0.0"), 0);
	const h = "a".repeat(64);
	assert.equal(u.parseSums(`${h}  quick-agent-0.5.0-arm64.dmg\n${"b".repeat(64)} *x.zip\n`).get("quick-agent-0.5.0-arm64.dmg"), h);
	assert.equal(u.bundlePath("/Applications/quick-agent.app/Contents/MacOS/quick-agent"), "/Applications/quick-agent.app");
	assert.equal(u.bundlePath("/usr/bin/electron"), undefined);
});
