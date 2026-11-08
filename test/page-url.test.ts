// Page identity for browser comment pins: hub/page-url.ts and the copy in browser/content.js must agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageKey } from "../hub/page-url.ts";

// Pull pageKey (+ its TRACKING regex) out of the content script and evaluate it standalone.
const src = readFileSync(new URL("../browser/content.js", import.meta.url), "utf8");
const tracking = /const TRACKING = (\/.*\/i);/.exec(src)![1]!;
const fn = /function pageKey\(href\) \{[\s\S]*?\n\t\}\n/.exec(src)![0]!;
const contentPageKey = new Function(`const TRACKING = ${tracking};\n${fn}\nreturn pageKey;`)() as (h: string) => string;

const same: [string, string][] = [
	["https://a.com/x#section", "https://a.com/x"],
	["https://a.com/x/", "https://a.com/x"],
	["https://A.com/x", "https://a.com/x"],
	["https://a.com/x?b=2&a=1", "https://a.com/x?a=1&b=2"],
	["https://a.com/x?utm_source=t&id=3&fbclid=z", "https://a.com/x?id=3"],
	["https://a.com/app#/", "https://a.com/app"],
	["https://a.com/app#/users/", "https://a.com/app#/users"],
	["https://a.com/", "https://a.com"],
];
const different: [string, string][] = [
	["https://a.com/x?id=1", "https://a.com/x?id=2"],
	["https://a.com/x", "https://a.com/y"],
	["https://a.com/app#/users", "https://a.com/app#/settings"],
	["https://a.com/app#!/a", "https://a.com/app#!/b"],
	["http://a.com/x", "https://a.com/x"],
	["https://a.com/x", "https://b.com/x"],
];

for (const [name, f] of [["hub", pageKey], ["content.js", contentPageKey]] as const) {
	test(`${name}: same page`, () => {
		for (const [a, b] of same) assert.equal(f(a), f(b), `${a} vs ${b}`);
	});
	test(`${name}: different pages`, () => {
		for (const [a, b] of different) assert.notEqual(f(a), f(b), `${a} vs ${b}`);
	});
}
test("hub and content.js agree", () => {
	for (const u of [...same.flat(), ...different.flat(), "not a url", "https://a.com/p?q=%E4%B8%AD#x"]) assert.equal(contentPageKey(u), pageKey(u), u);
});
