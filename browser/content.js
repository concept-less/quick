// quick-agent browser extension — content script (isolated world).
// Element picking (hover + click, Shift+click for multiple), region selection (drag),
// comment box, and status pins for comments already sent from this page.
(() => {
	// Guard against double injection (auto content script + on-demand injection). After the
	// extension is reloaded an old copy can be left orphaned with a dead runtime: replace it.
	const prev = window.__qaContent;
	if (prev && prev.alive()) return;
	if (prev) prev.teardown();
	const alive = () => {
		try {
			return !!chrome.runtime?.id;
		} catch {
			return false;
		}
	};

	const STATUS_COLOR = {
		pending: "#8a93a6", claimed: "#7aa2f7", dispatched: "#7aa2f7",
		starting: "#7aa2f7", running: "#7aa2f7", idle: "#e0af68", needs_input: "#e0af68", blocked: "#e0af68",
		done: "#9ece6a", failed: "#f7768e", cancelled: "#8a93a6", exited: "#f7768e",
	};
	const STATUS_TEXT = {
		pending: "等待前台", claimed: "前台处理中", dispatched: "已派单", starting: "启动中", running: "进行中",
		idle: "等你查看", needs_input: "需要你回复", blocked: "受阻", done: "已完成", failed: "失败", cancelled: "已取消", exited: "已退出",
	};

	// ------------------------------------------------------------ shadow UI host
	const host = document.createElement("qa-agent-root");
	// Absolute 0x0 box at the document origin: fixed children overlay the viewport,
	// absolute children (pins) use document coordinates.
	host.style.cssText = "all:initial;position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;";
	const root = host.attachShadow({ mode: "closed" });
	root.innerHTML = `<style>
		:host{all:initial}
		*{box-sizing:border-box;font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
		.hl{position:fixed;border:2px solid #ff2d55;background:rgba(255,45,85,.08);pointer-events:none;border-radius:3px;transition:all .04s}
		.sel{position:fixed;border:2px solid #7aa2f7;background:rgba(122,162,247,.12);pointer-events:none;border-radius:3px}
		.tag{position:fixed;background:#ff2d55;color:#fff;font-size:11px;padding:1px 6px;border-radius:3px;pointer-events:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
		.region{position:fixed;border:2px dashed #ff2d55;background:rgba(255,45,85,.06);pointer-events:none}
		.bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#171a21;color:#e6e6e6;border:1px solid #2f3542;border-radius:10px;padding:6px 8px;display:flex;gap:6px;align-items:center;pointer-events:auto;box-shadow:0 8px 30px rgba(0,0,0,.35)}
		.bar b{color:#7aa2f7;margin:0 6px 0 4px}
		.bar button,.box button{background:#232837;color:#e6e6e6;border:1px solid #2f3542;border-radius:6px;padding:4px 10px;cursor:pointer}
		.bar button.on{border-color:#7aa2f7;color:#7aa2f7}
		.bar .hint{color:#8a93a6;font-size:12px;margin:0 4px}
		.box{position:fixed;width:360px;background:#171a21;color:#e6e6e6;border:1px solid #2f3542;border-radius:10px;padding:10px;pointer-events:auto;box-shadow:0 12px 40px rgba(0,0,0,.4)}
		.box textarea{width:100%;min-height:90px;resize:vertical;background:#0f1115;color:#e6e6e6;border:1px solid #2f3542;border-radius:6px;padding:8px;outline:none}
		.box textarea:focus{border-color:#7aa2f7}
		.box .meta{color:#8a93a6;font-size:12px;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.box .row{display:flex;gap:8px;align-items:center;margin-top:8px}
		.box .row .sp{flex:1}
		.box button.primary{background:#7aa2f7;color:#0f1115;border-color:#7aa2f7;font-weight:600}
		.box label{color:#8a93a6;font-size:12px;display:flex;gap:4px;align-items:center}
		.toast{position:fixed;bottom:18px;right:18px;background:#171a21;color:#e6e6e6;border:1px solid #2f3542;border-radius:8px;padding:8px 12px;pointer-events:auto;max-width:420px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
		.toast.err{border-color:#f7768e}
		.toast .sub{color:#8a93a6;font-size:12px;margin-top:2px}
		.pin{position:absolute;width:20px;height:20px;border-radius:50%;color:#0f1115;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;border:2px solid #0f1115;box-shadow:0 2px 6px rgba(0,0,0,.4)}
		.pop{position:absolute;width:320px;background:#171a21;color:#e6e6e6;border:1px solid #2f3542;border-radius:8px;padding:8px 10px;pointer-events:auto;box-shadow:0 8px 30px rgba(0,0,0,.4);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto}
		.pop .st{font-size:12px;margin-bottom:4px}
		.pins{position:absolute;left:0;top:0;width:0;height:0}
	</style><div class="layer"></div><div class="pins"></div>`;
	const layer = root.querySelector(".layer");
	const pinLayer = root.querySelector(".pins");
	document.documentElement.appendChild(host);
	window.__qaContent = {
		alive,
		teardown: () => {
			try {
				stop();
			} catch {}
			clearTimeout(pollTimer);
			host.remove();
		},
	};

	const el = (cls, parent = layer, tag = "div") => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		parent.appendChild(n);
		return n;
	};
	const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

	// ------------------------------------------------------------ selectors
	function cssPath(node) {
		if (!(node instanceof Element)) return "";
		const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
		for (const attr of ["data-testid", "data-test", "data-qa", "data-cy"]) {
			const v = node.getAttribute(attr);
			if (v) {
				const sel = `[${attr}="${v.replace(/"/g, '\\"')}"]`;
				if (document.querySelectorAll(sel).length === 1) return sel;
			}
		}
		if (node.id && document.querySelectorAll(`#${esc(node.id)}`).length === 1) return `#${esc(node.id)}`;
		const parts = [];
		let cur = node;
		while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
			let part = cur.tagName.toLowerCase();
			if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) {
				parts.unshift(`#${esc(cur.id)}`);
				break;
			}
			const cls = [...cur.classList].filter((c) => !/^(is-|has-|hover|active|focus)/.test(c) && c.length < 40).slice(0, 2);
			if (cls.length) part += cls.map((c) => `.${esc(c)}`).join("");
			const parent = cur.parentElement;
			if (parent) {
				const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
				if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
			}
			parts.unshift(part);
			const sel = parts.join(" > ");
			try {
				if (document.querySelectorAll(sel).length === 1) return sel;
			} catch {}
			cur = cur.parentElement;
		}
		return parts.join(" > ");
	}
	function xPath(node) {
		const segs = [];
		for (let n = node; n && n.nodeType === 1; n = n.parentNode) {
			let i = 1;
			for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
			segs.unshift(`${n.tagName.toLowerCase()}[${i}]`);
		}
		return `/${segs.join("/")}`;
	}
	function describe(node) {
		const r = node.getBoundingClientRect();
		const attributes = {};
		for (const a of node.attributes) if (a.name !== "style" && a.value.length < 200) attributes[a.name] = a.value;
		let html = node.outerHTML || "";
		if (html.length > 3000) html = `${html.slice(0, 3000)}…`;
		return {
			selector: cssPath(node),
			xpath: xPath(node),
			tag: node.tagName.toLowerCase(),
			text: (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 500),
			html,
			rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
			attributes,
		};
	}

	// ------------------------------------------------------------ picker state
	let active = false;
	let mode = "element"; // or "region"
	let hovered = null;
	let selected = [];
	let dragStart = null;
	let regionRect = null;
	let bar, hl, tag, regionBox, box;
	const selBoxes = [];

	const isOurs = (e) => e.composedPath().includes(host);

	function start() {
		if (active) return;
		active = true;
		selected = [];
		regionRect = null;
		bar = el("bar");
		bar.innerHTML = `<b>⚡ quick-agent</b><button data-m="element">元素</button><button data-m="region">框选区域</button><span class="hint">点击选择 · Shift+点击多选 · Enter 写评论 · Esc 退出</span><button data-x>✕</button>`;
		bar.addEventListener("click", (e) => {
			const m = e.target.closest("button")?.dataset.m;
			if (m) setMode(m);
			if (e.target.closest("[data-x]")) stop();
		});
		hl = el("hl");
		tag = el("tag");
		hl.style.display = tag.style.display = "none";
		setMode(mode);
		document.addEventListener("mousemove", onMove, true);
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("mouseup", onUp, true);
		document.addEventListener("click", onClick, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("scroll", redrawSelection, true);
	}
	function stop() {
		if (!active) return;
		active = false;
		document.documentElement.style.cursor = "";
		dragStart = null;
		regionBox = null;
		hovered = null;
		document.removeEventListener("mousemove", onMove, true);
		document.removeEventListener("mousedown", onDown, true);
		document.removeEventListener("mouseup", onUp, true);
		document.removeEventListener("click", onClick, true);
		document.removeEventListener("keydown", onKey, true);
		window.removeEventListener("scroll", redrawSelection, true);
		layer.querySelectorAll(".bar,.hl,.tag,.sel,.region,.box").forEach((n) => n.remove());
		selBoxes.length = 0;
		box = null;
	}
	function setMode(m) {
		mode = m;
		bar.querySelectorAll("button[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
		document.documentElement.style.cursor = m === "region" ? "crosshair" : "";
		hl.style.display = tag.style.display = "none";
	}
	function place(node, r) {
		node.style.left = `${r.x}px`;
		node.style.top = `${r.y}px`;
		node.style.width = `${r.width}px`;
		node.style.height = `${r.height}px`;
	}
	function redrawSelection() {
		selBoxes.forEach((b) => b.remove());
		selBoxes.length = 0;
		if (mode === "region") return; // the dashed region already shows the selection
		for (const n of selected) {
			const b = el("sel");
			place(b, n.getBoundingClientRect());
			selBoxes.push(b);
		}
	}
	function targetAt(e) {
		host.style.display = "none";
		const t = document.elementFromPoint(e.clientX, e.clientY);
		host.style.display = "";
		return t;
	}

	function onMove(e) {
		if (box || isOurs(e)) return;
		if (mode === "region") {
			if (dragStart) {
				regionRect = {
					x: Math.min(dragStart.x, e.clientX), y: Math.min(dragStart.y, e.clientY),
					width: Math.abs(e.clientX - dragStart.x), height: Math.abs(e.clientY - dragStart.y),
				};
				place(regionBox, regionRect);
			}
			return;
		}
		const t = targetAt(e);
		if (!t || t === hovered) return;
		hovered = t;
		const r = t.getBoundingClientRect();
		hl.style.display = tag.style.display = "block";
		place(hl, r);
		tag.textContent = cssPath(t);
		tag.style.left = `${Math.max(0, r.x)}px`;
		tag.style.top = `${r.y > 22 ? r.y - 20 : r.bottom + 2}px`;
	}
	function onDown(e) {
		if (box || isOurs(e)) return;
		e.preventDefault();
		e.stopPropagation();
		if (mode === "region") {
			dragStart = { x: e.clientX, y: e.clientY };
			regionBox?.remove();
			regionBox = el("region");
			place(regionBox, { x: e.clientX, y: e.clientY, width: 0, height: 0 });
		}
	}
	function onUp(e) {
		if (box || isOurs(e)) return;
		e.preventDefault();
		e.stopPropagation();
		if (mode === "region" && dragStart) {
			dragStart = null;
			if (!regionRect || regionRect.width < 6 || regionRect.height < 6) return;
			selected = elementsInRegion(regionRect);
			openBox();
		}
	}
	function onClick(e) {
		if (isOurs(e)) return;
		e.preventDefault();
		e.stopPropagation();
		if (box || mode !== "element") return;
		const t = targetAt(e);
		if (!t) return;
		const i = selected.indexOf(t);
		if (i >= 0) selected.splice(i, 1);
		else selected.push(t);
		redrawSelection();
		if (!e.shiftKey && selected.length) openBox();
	}
	function onKey(e) {
		if (isOurs(e)) return;
		if (e.key === "Escape") {
			e.preventDefault();
			stop();
		} else if (e.key === "Enter" && selected.length && !box) {
			e.preventDefault();
			openBox();
		}
	}
	function contentRect(n) {
		// Block elements span the full row; measure their contents instead when they hold text directly.
		const b = n.getBoundingClientRect();
		if ([...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) {
			const range = document.createRange();
			range.selectNodeContents(n);
			const r = range.getBoundingClientRect();
			if (r.width && r.height) return r;
		}
		return b;
	}
	function elementsInRegion(r) {
		const inside = [];
		const all = document.body.querySelectorAll("*");
		for (const n of all) {
			if (n === host) continue;
			const b = contentRect(n);
			if (!b.width || !b.height) continue;
			if (b.left >= r.x - 2 && b.top >= r.y - 2 && b.right <= r.x + r.width + 2 && b.bottom <= r.y + r.height + 2) inside.push(n);
		}
		// Keep outermost elements only.
		let top = inside.filter((n) => !inside.some((o) => o !== n && o.contains(n)));
		if (!top.length) {
			host.style.display = "none";
			const c = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			host.style.display = "";
			if (c) top = [c];
		}
		return top.slice(0, 12);
	}

	// ------------------------------------------------------------ comment box
	function unionRect() {
		const rects = selected.map((n) => n.getBoundingClientRect());
		if (regionRect && mode === "region") rects.push(regionRect);
		if (!rects.length) return { x: 0, y: 0, width: innerWidth, height: innerHeight };
		const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
		const x2 = Math.max(...rects.map((r) => r.x + r.width)), y2 = Math.max(...rects.map((r) => r.y + r.height));
		return { x, y, width: x2 - x, height: y2 - y };
	}
	function openBox() {
		hl.style.display = tag.style.display = "none";
		redrawSelection();
		const u = unionRect();
		box = el("box");
		const what = mode === "region" ? `区域 ${Math.round(regionRect.width)}×${Math.round(regionRect.height)}，含 ${selected.length} 个元素` : selected.map((n) => cssPath(n)).join(" , ");
		box.innerHTML = `<div class="meta" title="${escapeHtml(what)}">${escapeHtml(what)}</div>
			<textarea placeholder="写下你的评论/要求…（Ctrl/⌘+Enter 发送）"></textarea>
			<div class="row"><label><input type="checkbox" checked data-shot> 附带截图</label><span class="sp"></span>
			<button data-cancel>取消</button><button class="primary" data-send>发送</button></div>`;
		const left = Math.min(Math.max(8, u.x), innerWidth - 372);
		const below = u.y + u.height + 10;
		box.style.left = `${left}px`;
		box.style.top = `${below + 170 < innerHeight ? below : Math.max(8, u.y - 180)}px`;
		const ta = box.querySelector("textarea");
		setTimeout(() => ta.focus(), 0);
		box.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
			if (e.key === "Escape") closeBox();
		});
		box.addEventListener("keyup", (e) => e.stopPropagation());
		box.addEventListener("keypress", (e) => e.stopPropagation());
		box.querySelector("[data-cancel]").onclick = closeBox;
		box.querySelector("[data-send]").onclick = send;
	}
	function closeBox() {
		box?.remove();
		box = null;
		selected = [];
		regionRect = null;
		regionBox?.remove();
		regionBox = null;
		redrawSelection();
	}
	function consoleErrors() {
		return new Promise((resolve) => {
			const t = setTimeout(() => resolve([]), 150);
			const h = (e) => {
				if (e.source === window && e.data?.__qa === "errors") {
					clearTimeout(t);
					window.removeEventListener("message", h);
					resolve(e.data.errors || []);
				}
			};
			window.addEventListener("message", h);
			window.postMessage({ __qa: "get-errors" }, "*");
		});
	}
	const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

	async function send() {
		const comment = box.querySelector("textarea").value.trim();
		if (!comment) return box.querySelector("textarea").focus();
		const withScreenshot = box.querySelector("[data-shot]").checked;
		const elements = selected.map(describe);
		const focus = { ...unionRect(), viewportWidth: innerWidth };
		const boxes = mode === "region" && regionRect ? [regionRect] : elements.map((e) => e.rect);
		const payload = {
			comment,
			url: location.href,
			title: document.title,
			mode,
			elements,
			region: mode === "region" && regionRect ? { x: Math.round(regionRect.x), y: Math.round(regionRect.y), width: Math.round(regionRect.width), height: Math.round(regionRect.height) } : undefined,
			viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
			consoleErrors: await consoleErrors(),
			userAgent: navigator.userAgent,
		};
		const anchors = selected.slice();
		const docAnchor = { x: focus.x + scrollX, y: focus.y + scrollY };
		// Hide our UI so it is not in the screenshot.
		host.style.visibility = "hidden";
		await raf();
		let res;
		try {
			res = await chrome.runtime.sendMessage({ type: "qa-submit", payload, boxes, focus, withScreenshot });
		} catch (e) {
			res = { ok: false, error: String(e?.message || e) };
		}
		host.style.visibility = "";
		if (!res?.ok) {
			const hint = !alive() ? "插件已更新或重新加载，请刷新页面后重试（评论内容已保留在输入框）。" : "点击工具栏的 quick-agent 图标可检查连接。评论内容已保留，修好后再点发送。";
			return toast(`发送失败：${res?.error ?? "unknown"}`, true, hint);
		}
		stop();
		toast(`已发送给前台 agent（${res.intake.id}）`);
		pins.push({ id: res.intake.id, comment, anchor: anchors[0], docAnchor, status: "pending", selector: elements[0]?.selector, region: payload.region });
		renderPins();
		schedulePoll(true);
	}

	function toast(text, err = false, sub = "") {
		layer.querySelectorAll(".toast").forEach((n) => n.remove());
		const t = el(`toast${err ? " err" : ""}`);
		t.textContent = text;
		if (sub) el("sub", t).textContent = sub;
		setTimeout(() => t.remove(), err ? 8000 : 3000);
	}

	// ------------------------------------------------------------ pins for sent comments
	let pins = [];
	let openPop = null;
	function pinPos(p) {
		const n = p.anchor && p.anchor.isConnected ? p.anchor : p.selector ? safeQuery(p.selector) : null;
		if (n) {
			const r = n.getBoundingClientRect();
			if (r.width || r.height) return { x: r.right + scrollX - 10, y: r.top + scrollY - 10 };
		}
		if (p.docAnchor) return { x: p.docAnchor.x - 10, y: p.docAnchor.y - 10 };
		return null;
	}
	function safeQuery(s) {
		try {
			return document.querySelector(s);
		} catch {
			return null;
		}
	}
	function renderPins() {
		pinLayer.innerHTML = "";
		pins.forEach((p, i) => {
			const pos = pinPos(p);
			if (!pos) return;
			const st = p.taskStatus || p.status;
			const d = el("pin", pinLayer);
			d.style.left = `${pos.x}px`;
			d.style.top = `${pos.y}px`;
			d.style.background = STATUS_COLOR[st] || "#8a93a6";
			d.textContent = String(i + 1);
			d.title = `${STATUS_TEXT[st] || st}: ${p.comment}`;
			d.onclick = (e) => {
				e.stopPropagation();
				if (openPop) openPop.remove();
				if (openPop?.dataset.id === p.id) return (openPop = null);
				const pop = el("pop", pinLayer);
				pop.dataset.id = p.id;
				pop.style.left = `${Math.min(pos.x + 24, scrollX + innerWidth - 340)}px`;
				pop.style.top = `${pos.y}px`;
				pop.innerHTML = `<div class="st" style="color:${STATUS_COLOR[st] || "#8a93a6"}">● ${escapeHtml(STATUS_TEXT[st] || st)}${p.taskId ? ` · 任务 ${escapeHtml(p.taskId)}` : ""}${p.taskTitle ? ` · ${escapeHtml(p.taskTitle)}` : ""}</div><div>${escapeHtml(p.comment)}</div>${p.summary ? `<hr style="border-color:#2f3542"><div style="color:#c0c6d4">${escapeHtml(p.summary)}</div>` : ""}`;
				openPop = pop;
			};
		});
	}

	let pollTimer = null;
	let hubDown = false;
	async function poll() {
		if (!alive()) return;
		try {
			const res = await chrome.runtime.sendMessage({ type: "qa-page-comments", url: location.href });
			hubDown = !res?.ok;
			if (res?.ok) {
				const known = new Map(pins.map((p) => [p.id, p]));
				pins = res.comments.map((c) => {
					const old = known.get(c.id) || {};
					return {
						...old, id: c.id, comment: c.comment, status: c.status, taskId: c.taskId, taskStatus: c.taskStatus,
						taskTitle: c.taskTitle, summary: c.summary, selector: old.selector || c.elements?.[0]?.selector,
						docAnchor: old.docAnchor || (c.region ? { x: c.region.x + 0, y: c.region.y + 0 } : undefined),
					};
				});
				renderPins();
			}
		} catch {}
	}
	function schedulePoll(now = false) {
		clearTimeout(pollTimer);
		const tick = async () => {
			if (!alive()) return; // extension reloaded/removed: stop quietly
			if (document.visibilityState === "visible") await poll();
			const busy = pins.some((p) => !["done", "failed", "cancelled"].includes(p.taskStatus || ""));
			// Back off when the hub is not reachable or not configured.
			pollTimer = setTimeout(tick, hubDown ? 60000 : busy ? 5000 : 30000);
		};
		pollTimer = setTimeout(tick, now ? 1500 : 0);
	}
	window.addEventListener("resize", () => renderPins());
	document.addEventListener("click", () => {
		if (openPop && !active) {
			openPop.remove();
			openPop = null;
		}
	});

	// ------------------------------------------------------------ wiring
	chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
		if (sender.id !== chrome.runtime.id) return;
		if (msg?.type === "qa-ping") sendResponse({ ok: true, active });
		else if (msg?.type === "qa-toggle") {
			active ? stop() : start();
			sendResponse({ ok: true, active });
		}
	});
	schedulePoll();
})();
