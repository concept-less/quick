// `quick projects …` and the project-grouped `quick ls`.
import type { HubClient } from "../shared/hub-client.ts";
import { LEVEL_LABEL, type AttentionItem } from "../shared/attention.ts";
import { compareProjects, findProject, groupByProject, resolveProject, UNSORTED_LABEL, type Project } from "../shared/projects.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function die(msg: string): never {
	console.error(`quick: ${msg}`);
	process.exit(1);
}

const UNSORTED_KEYS = new Set(["none", "unsorted", UNSORTED_LABEL, ""]);

type Line = (i: AttentionItem) => string;

/** Counts of open (not archived) attention items per project: need / inflight / total. */
function countsOf(items: AttentionItem[]) {
	const open = items.filter((i) => i.level !== "archived");
	const n = open.filter((i) => i.level === "need").length;
	const r = open.filter((i) => i.level === "inflight").length;
	return [n ? `需要你 ${n}` : "", r ? `运行 ${r}` : "", `${open.length} 件`].filter(Boolean).join(" · ");
}

/** Project groups of attention items: groups needing you first, then with running tasks; unsorted after projects on ties. */
function groupItems(projects: Project[], items: AttentionItem[]) {
	const groups = groupByProject(projects, items);
	const rank = (g: { id: string; tasks: AttentionItem[] }) => [g.tasks.some((i) => i.level === "need") ? 0 : 1, g.tasks.some((i) => i.level === "inflight") ? 0 : 1, g.id ? 0 : 1];
	return groups.sort((a, b) => {
		const x = rank(a);
		const y = rank(b);
		return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
	});
}

/**
 * `quick attention` / `quick ls`: the attention queue with projects as the second dimension.
 * grouped: level sections, project sub-headers inside a level; flat: one line per task with a [project] tag;
 * byProject: project sections in attention order; project: only one project ("none" = unsorted).
 */
export async function printAttention(hub: HubClient, items: AttentionItem[], line: Line, o: { grouped: boolean; project?: string; byProject?: boolean }) {
	const { projects } = await hub.projects().catch(() => ({ projects: [] as Project[] }));
	const pid = (i: AttentionItem) => resolveProject(projects, i.project)?.id ?? "";
	if (o.project !== undefined) {
		const want = UNSORTED_KEYS.has(o.project.trim()) ? "" : (findProject(projects, o.project)?.id ?? die(`no such project: ${o.project} (quick projects)`));
		items = items.filter((i) => pid(i) === want);
		if (!items.length) return console.log("这个项目里没有任务");
	}
	const name = (id: string) => (id ? (resolveProject(projects, id)?.name ?? id) : UNSORTED_LABEL);
	const tag = (i: AttentionItem) => (o.project !== undefined ? "" : dim(`[${name(pid(i))}] `));
	const out: string[] = [];
	if (o.byProject) {
		for (const g of groupItems(projects, items.map((i) => ({ ...i, project: pid(i) || undefined })))) {
			out.push(`\n${bold(g.name)}  ${dim(countsOf(g.tasks))}`);
			for (const i of g.tasks) out.push(`  ${LEVEL_LABEL[i.level].padEnd(4, "　")} ${line(i)}`);
		}
	} else if (o.grouped) {
		const q = (x: AttentionItem, pad: string) => (x.question ? [`${pad}${dim(`问题: ${x.question}${x.options?.length ? `  选项: ${x.options.join(" / ")}` : ""}`)}`] : []);
		for (const level of [...new Set(items.map((i) => i.level))]) {
			out.push(`\n${LEVEL_LABEL[level]}`);
			const inLevel = items.filter((x) => x.level === level);
			if (o.project !== undefined || new Set(inLevel.map(pid)).size < 2) {
				for (const x of inLevel) out.push(`  ${line(x)}`, ...q(x, "             "));
				continue;
			}
			for (const g of groupItems(projects, inLevel.map((x) => ({ ...x, project: pid(x) || undefined })))) {
				out.push(`  ${dim(`· ${g.name}`)}`);
				for (const x of g.tasks) out.push(`    ${line(x)}`, ...q(x, "               "));
			}
		}
	} else {
		for (const i of items) out.push(`${LEVEL_LABEL[i.level].padEnd(4, "　")} ${tag(i)}${line(i)}`);
	}
	console.log(out.join("\n"));
}

function flagAll(args: string[], name: string): string[] {
	const out: string[] = [];
	for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
		out.push(args[i + 1] ?? die(`${name} needs a value`));
		args.splice(i, 2);
	}
	return out;
}

/** Attention items with their project resolved through merge aliases. */
async function attentionItems(hub: HubClient): Promise<AttentionItem[]> {
	const [{ projects }, q] = await Promise.all([hub.projects(), hub.attention(0)]);
	return q.items.map((i) => ({ ...i, project: resolveProject(projects, i.project)?.id }));
}

const RULE_KIND: Record<string, "urls" | "paths" | "remotes" | "keywords"> = { url: "urls", path: "paths", remote: "remotes", keyword: "keywords", urls: "urls", paths: "paths", remotes: "remotes", keywords: "keywords" };

function describe(p: Project, items: AttentionItem[]): string {
	const mine = items.filter((i) => i.project === p.id);
	const lines = [`${bold(p.name)}${p.id !== p.name ? dim(` (${p.id})`) : ""}  ${dim(countsOf(mine))}`];
	if (p.remotes.length) lines.push(dim(`  git:    ${p.remotes.join(", ")}`));
	if (p.dirs.length) lines.push(dim(`  目录:   ${p.dirs.map((d) => `${d.machine}:${d.path}`).join(", ")}`));
	if (p.paths.length) lines.push(dim(`  路径:   ${p.paths.join(", ")}`));
	if (p.urls.length) lines.push(dim(`  页面:   ${p.urls.join(", ")}`));
	if (p.keywords.length) lines.push(dim(`  关键词: ${p.keywords.join(", ")}`));
	if (p.members?.length) lines.push(dim(`  成员:   ${p.members.join(", ")}`));
	if (p.notes) lines.push(dim(`  备注:   ${p.notes}`));
	return lines.join("\n");
}

export async function projectsCmd(hub: HubClient, args: string[]) {
	const [sub = "ls", ...rest] = args;
	switch (sub) {
		case "ls":
		case "list": {
			const [{ projects }, items] = await Promise.all([hub.projects(), attentionItems(hub)]);
			const live = projects.filter((p) => !p.mergedInto);
			// Stable order (manual order, then creation), the same as the Web UI's 项目 view.
			live.sort(compareProjects);
			for (const p of live) console.log(describe(p, items));
			const none = items.filter((i) => !i.project || !live.some((p) => p.id === i.project));
			console.log(`${bold(UNSORTED_LABEL)}  ${dim(countsOf(none))}`);
			const merged = projects.filter((p) => p.mergedInto);
			if (merged.length) console.log(dim(`已合并: ${merged.map((p) => `${p.id} → ${p.mergedInto}`).join(", ")}`));
			return;
		}
		case "show": {
			const key = rest[0] ?? die("usage: quick projects show <项目>");
			const [{ projects }, items] = await Promise.all([hub.projects(), attentionItems(hub)]);
			const p = findProject(projects, key) ?? die(`no such project: ${key}`);
			return console.log(describe(p, items));
		}
		case "rename": {
			const [key, ...name] = rest;
			if (!key || !name.length) die("usage: quick projects rename <项目> <新名字>");
			const p = await hub.renameProject(key, name.join(" "));
			return console.log(`renamed ${p.id} → ${p.name}`);
		}
		case "merge": {
			const [from, into] = rest;
			if (!from || !into) die("usage: quick projects merge <项目> <并入项目>");
			const p = await hub.mergeProject(from, into);
			return console.log(`merged ${from} into ${p.name} (${p.id})`);
		}
		case "move":
		case "set": {
			const [task, ...project] = rest;
			if (!task || !project.length) die("usage: quick projects move <任务> <项目|none>");
			const key = project.join(" ");
			const t = await hub.setTaskProject(task, UNSORTED_KEYS.has(key) ? "" : key);
			return console.log(`${t.id} → ${t.project ?? UNSORTED_LABEL}`);
		}
		case "create":
		case "add": {
			const a = [...rest];
			const body = { urls: flagAll(a, "--url"), paths: flagAll(a, "--path"), remotes: flagAll(a, "--remote"), keywords: flagAll(a, "--keyword") };
			const name = a.join(" ").trim() || die("usage: quick projects create <名字> [--url U] [--path P] [--remote R] [--keyword K]");
			const p = await hub.createProject({ name, ...body });
			return console.log(`created ${p.name} (${p.id})`);
		}
		case "rule": {
			const [key, op, kind, ...value] = rest;
			const k = RULE_KIND[kind ?? ""];
			if (!key || !["add", "rm", "remove"].includes(op ?? "") || !k || !value.length) die("usage: quick projects rule <项目> add|rm url|path|remote|keyword <值>");
			const v = value.join(" ");
			const p = await hub.projectRules(key, op === "add" ? { add: { [k]: [v] } } : { remove: { [k]: [v] } });
			return console.log(describe(p, await attentionItems(hub)));
		}
		case "order": {
			if (!rest.length) die("usage: quick projects order <项目> [<项目> …]   (按这个顺序排在最前，其余保持原顺序)");
			const all = (await hub.projects()).projects;
			const ids = rest.map((k) => findProject(all, k)?.id ?? die(`no such project: ${k}`));
			const projects = await hub.orderProjects(ids);
			return console.log(projects.filter((p) => !p.mergedInto).sort(compareProjects).map((p) => p.name).join(" > "));
		}
		case "backfill": {
			const r = await hub.backfillProjects(rest.includes("--all"));
			return console.log(`checked ${r.checked} task(s), changed ${r.changed} (on this machine; other machines classify their own tasks)`);
		}
		default:
			die(`unknown subcommand: projects ${sub} (quick help)`);
	}
}
