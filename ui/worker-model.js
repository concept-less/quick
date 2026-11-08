// quick-agent Web UI: worker default model (loaded by app.html as /worker-model.js).
//
// Separate from the front chat model (#modelSel): this is config.json workerModel of each machine, used by
// workers spawned or resumed after the change. A mono header button "WORKER <model>" opens a panel with
// every machine of the mesh: effective model, where it comes from (workerModel / inherited model),
// a model picker built from that machine's own `pi --list-models`, 保存 / 恢复继承 and 应用到所有机器.
// Every save is validated and persisted by the target hub; success and failure are shown per machine.
(() => {
	"use strict";
	const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
	const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	async function get(path, init) {
		const r = await fetch(path, { cache: "no-store", ...init, headers: init?.body ? { "content-type": "application/json" } : {} });
		const t = await r.text();
		let d;
		try { d = t ? JSON.parse(t) : {}; } catch { d = { error: t }; }
		if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { data: d });
		return d;
	}
	const toast = (msg, level) => (typeof window.toast === "function" ? window.toast(msg, level, level === "error" ? 9000 : 5000) : undefined);
	const short = (spec) => String(spec || "?").split("/").slice(1).join("/") || String(spec || "?");
	const split = (spec) => {
		const s = String(spec || "");
		const c = s.lastIndexOf(":");
		return c > 0 && LEVELS.includes(s.slice(c + 1)) ? { base: s.slice(0, c), level: s.slice(c + 1) } : { base: s, level: "" };
	};

	const css = `
#qaWm{font:500 11px/1 var(--mono,monospace);height:26px;padding:0 8px;letter-spacing:.04em;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#qaWm b{font-weight:700;letter-spacing:.1em;margin-right:6px}
#qaWm.bad{border-color:var(--acc);color:var(--acc)}
#qaWmP{position:fixed;top:52px;right:12px;width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 72px);overflow:auto;z-index:61;background:var(--surface,#fff);border:1px solid var(--line-2,#000);box-shadow:var(--hard,4px 4px 0 #000);display:none}
#qaWmP.open{display:block}
#qaWmP{text-align:left}
#qaFrontLbl{font:600 10.5px/1 var(--mono,monospace);letter-spacing:.1em;color:var(--fg-3,#888);margin-right:-4px}
#qaWmP .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line-2,#000)}
#qaWmP .hd .t{font:600 10.5px/1 var(--mono,monospace);letter-spacing:.1em;text-transform:uppercase}
#qaWmP .hd .s{flex:1}
#qaWmP .wnote{padding:8px 12px;border-bottom:1px solid var(--line,#ddd);font:11px/1.55 var(--mono,monospace);color:var(--fg-2,#555)}
#qaWmP .m{padding:10px 12px;border-bottom:1px solid var(--line,#ddd)}
#qaWmP .r{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
#qaWmP .id{font:600 12.5px var(--mono,monospace)}
#qaWmP .v{flex:1;font:11.5px var(--mono,monospace);color:var(--fg-2,#555);word-break:break-all}
#qaWmP .v b{color:var(--fg,#000);font-weight:600}
#qaWmP .sub{font:11px/1.5 var(--mono,monospace);color:var(--fg-3,#888);margin-top:4px;word-break:break-all}
#qaWmP .err{color:var(--acc,#e61919)}
#qaWmP .okm{color:var(--fg,#000)}
#qaWmP .ed{display:flex;gap:6px;margin-top:8px}
#qaWmP select{height:26px;border:1px solid var(--line-2,#000);border-radius:0;background:var(--bg,#fff);color:inherit;font:12px var(--mono,monospace);min-width:0}
#qaWmP select.mdl{flex:1}
#qaWmP input.flt{height:26px;width:120px;border:1px solid var(--line-2,#000);border-radius:0;background:var(--bg,#fff);color:inherit;font:12px var(--mono,monospace);padding:0 6px;min-width:0}
#qaWmP .btn{height:26px;padding:0 10px;font-size:12px;white-space:nowrap}
#qaWmP .ft{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid var(--line-2,#000);font:11px var(--mono,monospace);color:var(--fg-3,#888)}
#qaWmP .ft .grow{flex:1}
`;

	let data = { self: "", canEdit: false, machines: [] };
	let panel, btn;
	let loading = false;
	let lastError = "";
	const msgs = {}; // machine -> { ok, text }
	const busy = new Set();
	const draft = {}; // machine -> { base, level }
	const filters = {}; // machine -> search text of its model picker

	function mount() {
		const header = document.querySelector("header");
		if (!header || document.getElementById("qaWm")) return false;
		const st = document.createElement("style");
		st.textContent = css;
		document.head.appendChild(st);
		btn = document.createElement("button");
		btn.id = "qaWm";
		btn.className = "btn hide-m";
		btn.type = "button";
		btn.title = "worker 默认模型（与前台对话模型分开）";
		btn.innerHTML = "<b>WORKER</b>…";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			toggle();
		});
		const front = header.querySelector("#modelSel");
		if (front) {
			front.title = "前台对话模型（只影响这里的对话，不影响 worker）";
			const lbl = document.createElement("span");
			lbl.id = "qaFrontLbl";
			lbl.className = "hide-m";
			lbl.textContent = "前台";
			header.insertBefore(lbl, front);
		}
		header.insertBefore(btn, document.getElementById("qaFrontLbl") || front || header.querySelector("#keysBtn") || null);
		panel = document.createElement("div");
		panel.id = "qaWmP";
		panel.addEventListener("click", (e) => {
			e.stopPropagation();
			const b = e.target.closest("button[data-act]");
			if (b && !b.disabled) void act(b.dataset.act, b.dataset.m);
		});
		panel.addEventListener("change", (e) => {
			const sel = e.target.closest("select[data-m]");
			if (!sel) return;
			const m = sel.dataset.m;
			const row = panel.querySelector(`.m[data-m="${CSS.escape(m)}"]`);
			draft[m] = { base: row.querySelector("select.mdl").value, level: row.querySelector("select.lvl")?.value || "" };
			render();
		});
		panel.addEventListener("input", (e) => {
			const f = e.target.closest("input.flt[data-m]");
			if (!f) return;
			filters[f.dataset.m] = f.value;
			applyFilter(f.dataset.m);
		});
		document.body.appendChild(panel);
		document.addEventListener("click", () => panel.classList.remove("open"));
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && panel.classList.contains("open")) {
				panel.classList.remove("open");
				e.stopPropagation();
			}
		}, true);
		return true;
	}

	function toggle() {
		panel.classList.toggle("open");
		if (panel.classList.contains("open")) {
			render();
			void refresh(false);
		}
	}

	const selfRow = () => data.machines.find((m) => m.self);

	function renderButton() {
		const s = selfRow();
		if (!s) {
			btn.innerHTML = `<b>WORKER</b>${lastError ? "?" : "…"}`;
			btn.classList.toggle("bad", !!lastError);
			return;
		}
		const bad = s.error || s.effectiveKnown === false;
		btn.classList.toggle("bad", !!bad);
		btn.innerHTML = `<b>WORKER</b>${esc(short(s.effective))}`;
		btn.title = s.error ? `worker 默认模型：${s.error}` : `worker 默认模型（${s.machine}）：${s.effective}${s.source === "model" ? "，继承 model" : ""}${s.effectiveKnown === false ? "；这台机器的 pi 里找不到它" : ""}。与前台对话模型分开。`;
	}

	/** Selected spec for a machine row ("" = clear / inherit). */
	function chosen(m) {
		const d = draft[m.machine];
		const cur = split(m.workerModel || "");
		const base = d ? d.base : cur.base;
		const level = d ? d.level : cur.level;
		return base ? (level ? `${base}:${level}` : base) : "";
	}

	const provSummary = (models) => {
		const n = {};
		for (const x of models) n[x.provider] = (n[x.provider] || 0) + 1;
		return Object.entries(n).map(([p, c]) => `${p} ${c}`).join(" · ");
	};
	const metaText = (x) => [x.context && `${x.context} 上下文`, x.maxOut && `${x.maxOut} 输出`, x.thinking ? "可思考" : "不思考", x.images ? "图片" : ""].filter(Boolean).join(" · ");

	/** Hide picker options that do not match the machine's search text (the selected one stays visible). */
	function applyFilter(machine) {
		const row = panel.querySelector(`.m[data-m="${CSS.escape(machine)}"]`);
		const sel = row?.querySelector("select.mdl");
		if (!sel) return;
		const q = String(filters[machine] || "").trim().toLowerCase();
		let shown = 0;
		for (const o of sel.querySelectorAll("option")) {
			const hit = !q || !o.value || o.selected || o.value.toLowerCase().includes(q);
			o.hidden = !hit;
			if (hit && o.value) shown++;
		}
		for (const g of sel.querySelectorAll("optgroup")) g.hidden = ![...g.querySelectorAll("option")].some((o) => !o.hidden);
		const f = row.querySelector("input.flt");
		if (f) f.title = q ? `匹配 ${shown} 个` : "";
	}

	function machineHtml(m) {
		const msg = msgs[m.machine];
		const msgHtml = msg ? `<div class="sub ${msg.ok ? "okm" : "err"}">${esc(msg.text)}</div>` : "";
		if (m.error) return `<div class="m" data-m="${esc(m.machine)}"><div class="r"><span class="id">${esc(m.machine)}${m.self ? " · 本机" : ""}</span></div><div class="sub err">${esc(m.error)}</div>${msgHtml}</div>`;
		const src = m.source === "workerModel" ? "workerModel 设置" : `未设置 workerModel，继承 model`;
		const known = m.effectiveKnown === false ? `<div class="sub err">这台机器的 pi 里找不到 ${esc(m.effective)}，新 worker 可能启动失败</div>` : "";
		const when = m.listedAt ? new Date(m.listedAt).toLocaleTimeString() : "";
		const list = m.listError
			? `<div class="sub err">${m.stale ? `刷新模型列表失败，下面是 ${esc(when)} 的上次列表：` : "无法列出模型："}${esc(m.listError)}</div>`
			: m.listWarnings?.length ? `<div class="sub">pi 提示：${esc(m.listWarnings.join(" / "))}</div>` : "";
		let editor = "";
		if (data.canEdit && m.models?.length) {
			const sel = chosen(m);
			const { base, level } = split(sel);
			const byProv = {};
			for (const x of m.models) (byProv[x.provider] ??= []).push(x);
			const hasBase = !base || m.models.some((x) => `${x.provider}/${x.id}` === base);
			const opts = `<option value=""${base ? "" : " selected"}>继承 model（${esc(m.model)}）</option>` +
				(hasBase ? "" : `<option value="${esc(base)}" selected>${esc(base)}（不在列表）</option>`) +
				Object.entries(byProv).map(([p, xs]) => `<optgroup label="${esc(`${p} · ${xs.length}`)}">${xs.map((x) => { const v = `${x.provider}/${x.id}`; return `<option value="${esc(v)}" title="${esc(metaText(x))}"${v === base ? " selected" : ""}>${esc(v)}</option>`; }).join("")}</optgroup>`).join("");
			const meta = m.models.find((x) => `${x.provider}/${x.id}` === base);
			const lvl = meta?.thinking ? `<select class="lvl" data-m="${esc(m.machine)}" title="思考级别"><option value="">思考 默认</option>${LEVELS.map((l) => `<option value="${l}"${l === level ? " selected" : ""}>思考 ${l}</option>`).join("")}</select>` : "";
			const dirty = sel !== (m.workerModel || "");
			const b = busy.has(m.machine);
			editor = `<div class="ed"><input class="flt" type="search" data-m="${esc(m.machine)}" placeholder="搜索 ${m.models.length} 个" aria-label="${esc(m.machine)} 搜索模型" value="${esc(filters[m.machine] || "")}"><select class="mdl" data-m="${esc(m.machine)}" aria-label="${esc(m.machine)} worker 模型">${opts}</select>${lvl}<button class="btn primary" data-act="save" data-m="${esc(m.machine)}"${dirty && !b ? "" : " disabled"}>${b ? "保存中…" : "保存"}</button></div>`;
		}
		return `<div class="m" data-m="${esc(m.machine)}">
<div class="r"><span class="id">${esc(m.machine)}${m.self ? " · 本机" : ""}</span><span class="v">生效 <b>${esc(m.effective)}</b></span></div>
<div class="sub">${esc(src)}${m.frontModel ? ` · 前台 frontModel ${esc(m.frontModel)}` : ""}${m.models ? ` · ${m.models.length} 个可用模型${m.models.length ? `（${esc(provSummary(m.models))}）` : ""}` : ""}</div>${known}${list}${editor}${msgHtml}</div>`;
	}

	function render() {
		renderButton();
		if (!panel.classList.contains("open")) return;
		const s = selfRow();
		const others = data.machines.filter((m) => !m.self && !m.error);
		const spec = s && !s.error ? chosen(s) : "";
		const anyBusy = busy.size > 0;
		const foot = data.canEdit && s && !s.error && others.length
			? `<div class="ft"><span class="grow">把本机这一行的选择（${esc(spec || `继承 model`)}）写到所有 ${data.machines.length} 台机器，每台按自己的模型列表校验</span><button class="btn" data-act="all"${anyBusy ? " disabled" : ""}>应用到所有机器</button></div>`
			: "";
		const focused = document.activeElement?.matches?.("#qaWmP input.flt") ? document.activeElement.dataset.m : "";
		panel.innerHTML = `<div class="hd"><span class="t">Worker 默认模型</span><span class="s">${lastError ? `<span class="err">${esc(lastError)}</span>` : loading ? "加载中…" : ""}</span><button class="btn" data-act="refresh"${loading ? " disabled" : ""}>刷新列表</button></div>
<div class="wnote">新派发和之后恢复的 worker 用这里的模型；运行中的 worker 不会被打断。前台对话模型是另一个设置，不受影响。${data.canEdit ? "" : " 只读：需要 owner 权限才能修改。"}</div>${data.machines.map(machineHtml).join("")}${foot}`;
		for (const m of Object.keys(filters)) applyFilter(m);
		if (focused) {
			const f = panel.querySelector(`input.flt[data-m="${CSS.escape(focused)}"]`);
			f?.focus();
			f?.setSelectionRange(f.value.length, f.value.length);
		}
	}

	async function refresh(force) {
		loading = true;
		render();
		try {
			data = await get(`/api/hub/worker-model?all=1${force ? "&refresh=1" : ""}`);
			lastError = "";
		} catch (e) {
			lastError = e.message;
		}
		loading = false;
		render();
	}

	function applyResults(results) {
		for (const r of results) {
			if (r.ok) {
				const i = data.machines.findIndex((m) => m.machine === r.machine);
				const keepModels = i >= 0 ? data.machines[i].models : undefined;
				const next = { ...r.info, machine: r.machine, self: r.machine === data.self, models: r.info.models?.length ? r.info.models : keepModels };
				if (i >= 0) data.machines[i] = next;
				delete draft[r.machine];
				msgs[r.machine] = { ok: true, text: `已保存：${r.info.workerModel ? r.info.workerModel : `清除 workerModel，继承 ${r.info.model}`}。之后新建/恢复的 worker 生效` };
			} else msgs[r.machine] = { ok: false, text: `保存失败，未改动：${r.error}` };
		}
	}

	async function save(machines, spec) {
		for (const m of machines) busy.add(m);
		render();
		try {
			const r = await get("/api/hub/worker-model", { method: "POST", body: JSON.stringify(machines.length === 1 ? { machine: machines[0], model: spec || null } : { machines, model: spec || null }) });
			applyResults(r.results || []);
			const bad = (r.results || []).filter((x) => !x.ok);
			if (bad.length) toast(`worker 模型：${bad.length} 台保存失败：${r.error}`, "error");
			else toast(`worker 默认模型已保存（${machines.join(", ")}）：${spec || "继承 model"}`, "info");
		} catch (e) {
			const results = e.data?.results;
			if (results) applyResults(results);
			else for (const m of machines) msgs[m] = { ok: false, text: `保存失败，未改动：${e.message}` };
			toast(`worker 模型保存失败：${e.message}`, "error");
		}
		for (const m of machines) busy.delete(m);
		render();
	}

	async function act(a, machine) {
		if (a === "refresh") {
			// Same pi config on this machine: refresh the front chat model list too (app.html loadModels).
			if (typeof window.loadModels === "function") void window.loadModels(true);
			return refresh(true);
		}
		if (a === "save") {
			const m = data.machines.find((x) => x.machine === machine);
			if (m) return save([machine], chosen(m));
		}
		if (a === "all") {
			const s = selfRow();
			if (s) return save(data.machines.filter((m) => !m.error).map((m) => m.machine), chosen(s));
		}
	}

	function start() {
		if (!mount()) return;
		void refresh(false);
		setInterval(() => !busy.size && !panel.classList.contains("open") && refresh(false), 5 * 60_000);
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})();
