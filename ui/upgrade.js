// quick-agent Web UI: version + upgrade control in the header (loaded by app.html as /upgrade.js).
//
// Low-interruption by design: a small mono version label in the header; when a newer release can be
// installed it becomes an outlined "升级 vX" button. No dialogs, no toasts. Clicking opens a panel
// with every machine of the mesh (running / installed / latest version, release notes) and
// per-machine 升级 / 回滚 buttons with live progress: 检查 → 下载 → 校验 → 切换 → 重启.
// After this machine restarts its hub + Web UI server the page reconnects and reloads itself.
(() => {
	"use strict";
	const STEPS = [
		["check", "检查"],
		["download", "下载"],
		["verify", "校验"],
		["switch", "切换"],
		["restart", "重启"],
	];
	const KIND = { release: "Release 安装", dev: "开发模式（git 副本），不自动更新", "npm-pi": "pi npm 包", "npm-global": "npm 全局安装", unmanaged: "未托管的副本" };
	const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	const cmp = (a, b) => {
		const p = (v) => String(v || "0").replace(/^v/, "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
		const x = p(a), y = p(b);
		for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
		return 0;
	};
	async function get(path, init) {
		const r = await fetch(path, { cache: "no-store", ...init, headers: init?.body ? { "content-type": "application/json" } : {} });
		const t = await r.text();
		let d;
		try { d = t ? JSON.parse(t) : {}; } catch { d = { error: t }; }
		if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
		return d;
	}

	const css = `
#qaVer{font:500 11px/1 var(--mono,monospace);height:26px;padding:0 8px;letter-spacing:.04em}
#qaVer.up{border-color:var(--acc);color:var(--acc)}
#qaVer.up:hover{background:var(--acc);color:var(--acc-fg)}
#qaUpd{position:fixed;top:52px;right:12px;width:min(520px,calc(100vw - 24px));max-height:calc(100vh - 72px);overflow:auto;z-index:60;background:var(--surface,#fff);border:1px solid var(--line-2,#000);box-shadow:var(--hard,4px 4px 0 #000);display:none}
#qaUpd.open{display:block}
#qaUpd .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line-2,#000)}
#qaUpd .hd .t{font:600 10.5px/1 var(--mono,monospace);letter-spacing:.1em;text-transform:uppercase}
#qaUpd .hd .s{flex:1;font:11px var(--mono,monospace);color:var(--fg-3,#888);text-align:right}
#qaUpd .m{padding:10px 12px;border-bottom:1px solid var(--line,#ddd)}
#qaUpd .m:last-child{border-bottom:0}
#qaUpd .r{display:flex;align-items:center;gap:8px}
#qaUpd .id{font:600 12.5px var(--mono,monospace)}
#qaUpd .v{flex:1;font:11.5px var(--mono,monospace);color:var(--fg-2,#555)}
#qaUpd .v b{color:var(--fg,#000);font-weight:600}
#qaUpd .sub{font:11px/1.5 var(--mono,monospace);color:var(--fg-3,#888);margin-top:4px;word-break:break-all}
#qaUpd .err{color:var(--acc,#e61919)}
#qaUpd .steps{display:flex;gap:0;margin-top:8px;font:11px var(--mono,monospace)}
#qaUpd .steps span{flex:1;padding:4px 6px;border:1px solid var(--line,#ddd);margin-right:-1px;color:var(--fg-3,#888)}
#qaUpd .steps span.ok{color:var(--fg,#000);border-color:var(--line-2,#000)}
#qaUpd .steps span.on{background:var(--inv-bg,#000);color:var(--inv-fg,#fff);border-color:var(--inv-bg,#000)}
#qaUpd .steps span.bad{background:var(--acc,#e61919);color:var(--acc-fg,#fff);border-color:var(--acc,#e61919)}
#qaUpd details{margin-top:8px}
#qaUpd summary{cursor:pointer;font:600 10.5px/1.6 var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase;color:var(--fg-2,#555)}
#qaUpd pre{white-space:pre-wrap;margin:6px 0 0;padding:8px;border:1px solid var(--line,#ddd);background:var(--bg,#f4f4f0);font:11.5px/1.55 var(--mono,monospace);max-height:260px;overflow:auto}
#qaUpd .btn{height:26px;padding:0 10px;font-size:12px}
`;

	let data = { self: "", machines: [] };
	let panel, btn;
	let busyMachine = ""; // machine whose job we follow
	let pollTimer;
	let uiPid0;
	let lastError = "";

	function mount() {
		const header = document.querySelector("header");
		if (!header || document.getElementById("qaVer")) return false;
		const st = document.createElement("style");
		st.textContent = css;
		document.head.appendChild(st);
		btn = document.createElement("button");
		btn.id = "qaVer";
		btn.className = "btn";
		btn.type = "button";
		btn.title = "版本与升级";
		btn.textContent = "v…";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			toggle();
		});
		const anchor = header.querySelector("#hubChip") || header.querySelector(".grow")?.nextSibling || null;
		header.insertBefore(btn, anchor);
		panel = document.createElement("div");
		panel.id = "qaUpd";
		panel.addEventListener("click", (e) => {
			e.stopPropagation();
			const b = e.target.closest("button[data-act]");
			if (b) act(b.dataset.act, b.dataset.m);
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

	const selfRow = () => data.machines.find((m) => m.self) || data.machines.find((m) => m.machine === data.self);

	function renderButton() {
		const s = selfRow();
		const up = data.machines.filter((m) => m.canInstall);
		const job = data.machines.find((m) => m.job && !["done", "error"].includes(m.job.step));
		btn.classList.toggle("up", up.length > 0 || !!job);
		if (job) btn.textContent = `升级中 ${STEPS.find((x) => x[0] === job.job.step)?.[1] ?? ""}`;
		else if (s?.canInstall) btn.textContent = `升级 v${s.latest.version}`;
		else if (up.length) btn.textContent = `v${s?.running ?? "?"} · ${up.length} 台可升级`;
		else btn.textContent = s?.running ? `v${s.running}` : "v?";
		btn.title = s?.available && !s.canInstall ? `v${s.latest?.version} 可用：${s.blocker}` : "版本与升级";
	}

	function stepsHtml(job) {
		if (!job) return "";
		const idx = STEPS.findIndex((x) => x[0] === job.step);
		const failedAt = job.step === "error" ? (job.failedStep ? STEPS.findIndex((x) => x[0] === job.failedStep) : -1) : -2;
		return `<div class="steps">${STEPS.map(([k, label], i) => {
			let cls = "";
			if (job.step === "done") cls = "ok";
			else if (job.step === "error") cls = i === failedAt ? "bad" : "";
			else if (i < idx) cls = "ok";
			else if (i === idx) cls = "on";
			const pct = k === "download" && job.step === "download" && job.total ? ` ${Math.round((job.received / job.total) * 100)}%` : "";
			return `<span class="${cls}">${label}${pct}</span>`;
		}).join("")}</div>${job.step === "error" ? `<div class="sub err">失败：${esc(job.error)}</div>` : job.message ? `<div class="sub">${esc(job.message)}</div>` : ""}`;
	}

	function machineHtml(m) {
		const job = m.job && Date.now() - (m.job.endedAt || Date.now()) < 10 * 60_000 ? m.job : undefined;
		const active = job && !["done", "error"].includes(job.step);
		let state = "";
		if (m.error) state = `<div class="sub err">${esc(m.error)}</div>`;
		else if (m.available && m.blocker) state = `<div class="sub">v${esc(m.latest.version)} 可用：${esc(m.blocker)}</div>`;
		else if (m.restartPending) state = `<div class="sub">已安装 ${esc(m.installed)}，等待重启</div>`;
		const buttons = [];
		if (!m.error && !active) {
			if (m.canInstall) buttons.push(`<button class="btn primary" data-act="install" data-m="${esc(m.machine)}">升级到 v${esc(m.latest.version)}</button>`);
			if (m.kind === "release" && m.previous) buttons.push(`<button class="btn" data-act="rollback" data-m="${esc(m.machine)}" title="切回 ${esc(m.previous)}">回滚 ${esc(m.previous)}</button>`);
		}
		const latest = m.latest ? `最新 <b>${esc(m.latest.version)}</b>` : m.error ? "" : `最新 ?`;
		const notes = m.latest?.notes && (m.available || m.self) ? `<details${m.available && m.self ? " open" : ""}><summary>更新说明 ${esc(m.latest.tag || m.latest.version)}</summary><pre>${esc(m.latest.notes)}</pre>${m.latest.url ? `<div class="sub"><a href="${esc(m.latest.url)}" target="_blank" rel="noopener">Release 页面</a></div>` : ""}</details>` : "";
		return `<div class="m">
<div class="r"><span class="id">${esc(m.machine)}${m.self ? " · 本机" : ""}</span><span class="v">运行 <b>${esc(m.running ?? "?")}</b>${m.installed && m.installed !== m.running ? ` · 已装 ${esc(m.installed)}` : ""} · ${latest}</span>${buttons.join("")}</div>
${m.kind ? `<div class="sub">${esc(KIND[m.kind] || m.kind)}${m.checkedAt ? ` · 检查于 ${new Date(m.checkedAt).toLocaleTimeString()}` : ""}${m.error && !m.kind ? "" : ""}</div>` : ""}
${state}${job ? stepsHtml(job) : ""}${notes}</div>`;
	}

	function desktopHtml() {
		const d = window.quickDesktop;
		if (!d || !d.appVersion) return "";
		const s = selfRow();
		const newer = s?.latest && cmp(s.latest.version, d.appVersion) > 0;
		return `<div class="m"><div class="r"><span class="id">桌面客户端</span><span class="v">运行 <b>${esc(d.appVersion)}</b>${s?.latest ? ` · 最新 <b>${esc(s.latest.version)}</b>` : ""}</span>${newer && d.updateApp ? `<button class="btn" data-act="desktop">更新客户端</button>` : ""}</div><div class="sub">从 Release 下载 macOS 安装包并替换应用</div></div>`;
	}

	function render() {
		renderButton();
		if (!panel.classList.contains("open")) return;
		const s = selfRow();
		panel.innerHTML = `<div class="hd"><span class="t">版本</span><span class="s">${lastError ? `<span class="err">${esc(lastError)}</span>` : s?.checkedAt ? "" : "加载中…"}</span><button class="btn" data-act="refresh">检查更新</button></div>${data.machines.map(machineHtml).join("")}${desktopHtml()}`;
	}

	async function refresh(force) {
		try {
			data = await get(`/api/hub/update?all=1${force ? "&refresh=1" : ""}`);
			lastError = "";
		} catch (e) {
			lastError = e.message;
		}
		render();
		const job = data.machines.find((m) => m.job && !["done", "error"].includes(m.job.step));
		if (job && !pollTimer) follow(job.machine);
	}

	async function act(a, machine) {
		if (a === "refresh") return refresh(true);
		if (a === "desktop") return window.quickDesktop?.updateApp?.();
		try {
			const st = await get("/api/hub/update", { method: "POST", body: JSON.stringify({ machine, action: a }) });
			const i = data.machines.findIndex((m) => m.machine === machine);
			if (i >= 0) data.machines[i] = { ...data.machines[i], ...st };
			render();
			follow(machine);
		} catch (e) {
			lastError = e.message;
			render();
		}
	}

	/** Poll a machine's job; when this machine restarts, wait for the new Web UI server and reload. */
	function follow(machine) {
		busyMachine = machine;
		clearTimeout(pollTimer);
		let target = "";
		let lastStep = "";
		const tick = async () => {
			const isSelf = machine === data.self;
			try {
				const st = await get(`/api/hub/update?machine=${encodeURIComponent(machine)}`);
				const i = data.machines.findIndex((m) => m.machine === machine);
				if (st.job) {
					if (st.job.step !== "error") lastStep = st.job.step;
					else st.job.failedStep = lastStep;
					if (st.job.to) target = st.job.to;
				}
				if (i >= 0) data.machines[i] = { ...data.machines[i], ...st };
				render();
				const step = st.job?.step;
				if (step === "done" && isSelf && target && st.running === target) {
					// New hub is up; reload once the Web UI server runs the new version too.
					const h = await fetch("/health", { cache: "no-store" }).then((r) => r.json()).catch(() => undefined);
					if (h?.version === target) return location.reload();
				} else if (!step || step === "error" || step === "done") {
					pollTimer = undefined;
					busyMachine = "";
					return void refresh(false);
				}
			} catch {
				// Hub / Web UI server restarting.
				const i = data.machines.findIndex((m) => m.machine === machine);
				if (i >= 0 && data.machines[i].job) {
					data.machines[i].job = { ...data.machines[i].job, step: "restart" };
					render();
				}
				if (isSelf) {
					const h = await fetch("/health", { cache: "no-store" }).then((r) => r.json()).catch(() => undefined);
					if (h && uiPid0 && h.pid !== uiPid0 && (!target || h.version === target)) return location.reload();
				}
			}
			pollTimer = setTimeout(tick, 500);
		};
		pollTimer = setTimeout(tick, 400);
	}

	function start() {
		if (!mount()) return;
		fetch("/health", { cache: "no-store" }).then((r) => r.json()).then((h) => (uiPid0 = h.pid)).catch(() => {});
		void refresh(false);
		setInterval(() => !busyMachine && refresh(false), 5 * 60_000);
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})();
