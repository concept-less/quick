// Dispatch scheduling: resources + priority (shared/schedule.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyResourceEdits,
	candidateMachines,
	DEFAULT_PRIORITY,
	detectResources,
	hasResource,
	mergeResources,
	normalizeRequires,
	pickMachine,
	pickMachineForCwd,
	platformTags,
	priorityOf,
	resourcesOf,
	ScheduleError,
	type MachineResourceView,
} from "../shared/schedule.ts";

const cloud: MachineResourceView = { id: "cloud", self: true, online: true, platform: "linux", resources: ["linux", "docker", "claude"], priority: 10 };
const mac: MachineResourceView = { id: "mac-laptop", online: true, platform: "darwin", resources: ["macos", "gui", "browser:chrome-gui", "codex", "claude"], priority: 50 };
const mesh = [cloud, mac];

test("default dispatch goes to the best-priority online machine", () => {
	assert.equal(pickMachine(mesh, {}).id, "cloud");
	// even when the front agent runs on the mac (self) — priority wins over self
	assert.equal(pickMachine([{ ...cloud, self: false }, { ...mac, self: true }], {}).id, "cloud");
});

test("required resources select the machine that has them", () => {
	assert.equal(pickMachine(mesh, { requires: ["browser:chrome-gui"] }).id, "mac-laptop");
	assert.equal(pickMachine(mesh, { requires: ["browser"] }).id, "mac-laptop"); // prefix match
	assert.equal(pickMachine(mesh, { requires: ["macos", "codex"] }).id, "mac-laptop");
	assert.equal(pickMachine(mesh, { requires: ["claude"] }).id, "cloud"); // both have it → priority
	assert.equal(pickMachine(mesh, { requires: ["docker"] }).id, "cloud");
});

test("unsatisfiable requirements give a clear error", () => {
	assert.throws(() => pickMachine(mesh, { requires: ["gpu"] }), (e: Error) => e instanceof ScheduleError && /gpu/.test(e.message) && /cloud lacks gpu/.test(e.message));
	assert.throws(
		() => pickMachine([cloud, { ...mac, online: false }], { requires: ["browser:chrome-gui"] }),
		(e: Error) => /offline machines that would fit: mac-laptop/.test(e.message),
	);
});

test("explicit machine is validated", () => {
	assert.equal(pickMachine(mesh, { machine: "mac-laptop" }).id, "mac-laptop");
	assert.throws(() => pickMachine(mesh, { machine: "cloud", requires: ["browser:chrome-gui"] }), /cloud lacks required resources: browser:chrome-gui/);
	assert.throws(() => pickMachine([cloud, { ...mac, online: false }], { machine: "mac-laptop" }), /offline/);
	assert.throws(() => pickMachine(mesh, { machine: "nope" }), /unknown/);
});

test("old hubs without resources/priority: platform tags, default priority, self wins ties", () => {
	const a = { id: "a", self: true, online: true, platform: "linux" };
	const b = { id: "b", online: true, platform: "darwin" };
	assert.equal(priorityOf(a), DEFAULT_PRIORITY);
	assert.deepEqual(resourcesOf(b), platformTags("darwin"));
	assert.equal(pickMachine([b, a], {}).id, "a");
	assert.equal(pickMachine([a, b], { requires: ["macos"] }).id, "b");
	// equal priority, neither is self: fewer active tasks, then id
	assert.equal(pickMachine([{ id: "y", online: true, activeTasks: 3 }, { id: "z", online: true, activeTasks: 1 }], {}).id, "z");
	assert.equal(pickMachine([{ id: "y", online: true }, { id: "x", online: true }], {}).id, "x");
});

test("offline machines are skipped", () => {
	assert.equal(pickMachine([{ ...cloud, online: false }, mac], {}).id, "mac-laptop");
	assert.deepEqual(
		candidateMachines(mesh, { requires: ["claude"] }).map((m) => m.id),
		["cloud", "mac-laptop"],
	);
});

test("cwd follows the machine: first candidate where the path exists", async () => {
	const paths: Record<string, string[]> = { cloud: ["/home/simon/quick-agent"], "mac-laptop": ["/Users/tianyu/quick-agent"] };
	const exists = async (m: MachineResourceView, cwd: string) => paths[m.id]!.includes(cwd);
	assert.equal((await pickMachineForCwd(mesh, { cwd: "/home/simon/quick-agent" }, exists)).id, "cloud");
	assert.equal((await pickMachineForCwd(mesh, { cwd: "/Users/tianyu/quick-agent" }, exists)).id, "mac-laptop");
	assert.equal((await pickMachineForCwd(mesh, {}, exists)).id, "cloud");
	await assert.rejects(pickMachineForCwd(mesh, { cwd: "/Users/tianyu/quick-agent", requires: ["docker"] }, exists), /does not exist on any candidate machine \(cloud\)/);
	// remote check failing (e.g. RPC error) counts as "does not exist"
	assert.equal((await pickMachineForCwd(mesh, { cwd: "/Users/tianyu/quick-agent" }, async (m) => (m.id === "cloud" ? Promise.reject(new Error("x")) : true))).id, "mac-laptop");
	// explicit machine: no existence probing here (the target hub validates cwd itself)
	assert.equal((await pickMachineForCwd(mesh, { machine: "cloud", cwd: "/x" }, async () => false)).id, "cloud");
});

test("resource tags: matching, merging, editing, normalising", () => {
	assert.ok(hasResource(["browser:chrome-gui"], "browser"));
	assert.ok(hasResource(["browser:chrome-gui"], "browser:chrome"));
	assert.ok(hasResource(["Codex"], "codex"));
	assert.ok(!hasResource(["browser:chrome-headless"], "browser:chrome-gui"));
	assert.ok(!hasResource(["codexx"], "codex"));
	assert.deepEqual(mergeResources(["linux", "docker"], ["gpu", "-docker"]), ["linux", "gpu"]);
	assert.deepEqual(mergeResources(["linux", "docker"], ["-*", "macos"]), ["macos"]);
	assert.deepEqual(mergeResources(["linux"], undefined), ["linux"]);
	assert.deepEqual(applyResourceEdits(["a", "-b"], ["b"], ["c"]), ["a", "b", "-c"]);
	assert.equal(applyResourceEdits(undefined, [], []), undefined);
	assert.deepEqual(normalizeRequires("a, b,,a"), ["a", "b"]);
	assert.deepEqual(normalizeRequires(undefined), []);
});

test("detectResources reports OS and GUI", () => {
	assert.ok(detectResources({ PATH: "" }, "darwin").includes("macos"));
	assert.ok(detectResources({ PATH: "" }, "darwin").includes("gui"));
	const linux = detectResources({ PATH: "" }, "linux");
	assert.ok(linux.includes("linux") && !linux.includes("gui"));
	assert.ok(detectResources({ PATH: "", DISPLAY: ":0" }, "linux").includes("gui"));
});
