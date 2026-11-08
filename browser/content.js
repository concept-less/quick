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

	// Pin look per status, same encoding as the Web UI: fill not hue, one accent for "needs you".
	//   wait = grey (queued), idle = outlined (in flight), "" = solid ink (done), need/fail = accent
	const STATUS_CLASS = {
		pending: "wait", claimed: "idle", dispatched: "idle", starting: "idle", running: "idle",
		idle: "need", needs_input: "need", blocked: "need", done: "", failed: "fail", cancelled: "wait", exited: "fail",
	};
	const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	/** "mod+shift+enter" -> <kbd>⌘</kbd><kbd>⇧</kbd><kbd>↵</kbd> on Mac, Ctrl/Shift/Enter elsewhere. */
	const keys = (combo) =>
		combo
			.split("+")
			.map((k) => {
				const m = { mod: IS_MAC ? "⌘" : "Ctrl", shift: IS_MAC ? "⇧" : "Shift", alt: IS_MAC ? "⌥" : "Alt", enter: IS_MAC ? "↵" : "Enter", esc: "Esc" }[k];
				return `<kbd>${m || k.toUpperCase()}</kbd>`;
			})
			.join("");
	const pageKey = globalThis.__qaPageKey || ((u) => String(u).split("#")[0]);
	// Send-key mode, shared with the popup setting (chrome.storage.local.sendMode):
	//   "enter": Enter sends, Shift+Enter newline   |   "mod": ⌘/Ctrl+Enter sends, Enter newline
	let sendMode = "enter";
	try {
		chrome.storage.local.get({ sendMode: "enter" }).then((v) => (sendMode = v.sendMode === "mod" ? "mod" : "enter"), () => {});
		chrome.storage.onChanged.addListener((ch, area) => {
			if (area === "local" && ch.sendMode) {
				sendMode = ch.sendMode.newValue === "mod" ? "mod" : "enter";
				if (box) renderBoxKeys();
			}
		});
	} catch {}
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
	// Styles live in a CLOSED shadow root: the host page cannot restyle us and we cannot leak into it.
	// Design tokens + primitives (.btn, kbd, .lbl, .field) come from shared/tokens.css via tokens.js.
	root.innerHTML = `<style>${globalThis.__qaTokensCss || ""}
		:host{all:initial}
		*{box-sizing:border-box;font:var(--fs-md)/1.5 var(--sans);letter-spacing:normal;text-transform:none}
		.hl{position:fixed;border:2px solid var(--acc);background:var(--acc-soft);pointer-events:none;transition:all .04s}
		.sel{position:fixed;border:2px solid var(--line-2);outline:1px solid var(--bg);background:color-mix(in srgb,var(--fg) 8%,transparent);pointer-events:none}
		.tag{position:fixed;background:var(--acc);color:var(--acc-fg);font:500 11px/1.5 var(--mono);padding:1px 6px;pointer-events:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
		.region{position:fixed;border:2px dashed var(--acc);background:var(--acc-soft);pointer-events:none}
		.bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:var(--bg);color:var(--fg);border:var(--bw) solid var(--line-2);padding:6px;display:flex;gap:6px;align-items:center;pointer-events:auto;box-shadow:var(--hard);max-width:calc(100vw - 24px)}
		.bar b{display:flex;align-items:center;gap:8px;margin:0 8px 0 4px;font:800 12px/1 var(--sans);letter-spacing:-.01em;text-transform:uppercase;white-space:nowrap}
		.bar .btn{height:28px}
		.bar .btn.on{background:var(--inv-bg);color:var(--inv-fg);border-color:var(--inv-bg)}
		.bar .hint{color:var(--fg-3);font:11px/1.4 var(--mono);margin:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.bar .hint kbd{margin:0 1px}
		.box{position:fixed;width:360px;background:var(--bg);color:var(--fg);border:var(--bw) solid var(--line-2);pointer-events:auto;box-shadow:var(--hard-lg)}
		.box .head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:var(--bw) solid var(--line)}
		.box .meta{flex:1;min-width:0;color:var(--fg-3);font:11px/1.5 var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.box textarea{display:block;width:100%;min-height:96px;resize:vertical;border:0;border-bottom:var(--bw) solid var(--line);background:var(--surface);padding:10px 12px;box-shadow:none}
		.box textarea:focus{box-shadow:none;border-bottom-color:var(--line-2)}
		.box .row{display:flex;gap:6px;align-items:center;padding:8px 8px 8px 12px}
		.box .row .sp{flex:1}
		.box label{color:var(--fg-2);font-size:12px;display:flex;gap:5px;align-items:center;cursor:pointer;white-space:nowrap}
		.box label input{accent-color:var(--fg);margin:0}
		.box .keys{display:flex;align-items:center;gap:6px;padding:0 12px 8px;color:var(--fg-3);font:11px/1.4 var(--mono)}
		.box .keys button{border:0;background:none;color:var(--fg-2);cursor:pointer;font:11px/1.4 var(--mono);text-decoration:underline;text-decoration-color:var(--fg-3);text-underline-offset:2px;padding:0}
		.box .keys button:hover{color:var(--acc)}
		.toast{position:fixed;bottom:18px;right:18px;background:var(--bg);color:var(--fg);border:var(--bw) solid var(--line-2);border-left:4px solid var(--fg);padding:9px 14px;pointer-events:auto;max-width:420px;box-shadow:var(--hard)}
		.toast.err{border-left-color:var(--acc)}
		.toast .sub{color:var(--fg-2);font-size:12px;margin-top:2px}
		.pin{position:absolute;width:20px;height:20px;color:var(--inv-fg);background:var(--inv-bg);font:700 11px/1 var(--mono);display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;border:2px solid var(--bg);box-shadow:2px 2px 0 var(--hard-c)}
		.pin.need,.pin.fail{background:var(--acc);color:var(--acc-fg)}
		.pin.wait{background:var(--fg-3);color:var(--bg)}
		.pin.idle{background:var(--bg);color:var(--fg);border-color:var(--line-2)}
		.pop{position:absolute;width:320px;background:var(--bg);color:var(--fg);border:var(--bw) solid var(--line-2);padding:10px 12px;pointer-events:auto;box-shadow:var(--hard);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto}
		.pop .st{font:600 11px/1.5 var(--mono);letter-spacing:.04em;margin-bottom:6px;color:var(--fg-2)}
		.pop .st.need,.pop .st.fail{color:var(--acc)}
		.pop hr{border:0;border-top:var(--bw) solid var(--line);margin:8px 0}
		.pop .sum{color:var(--fg-2)}
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
			clearInterval(urlTimer);
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
	let boxUrl = "";
	const selBoxes = [];

	const isOurs = (e) => e.composedPath().includes(host);

	function start() {
		if (active) return;
		active = true;
		selected = [];
		regionRect = null;
		bar = el("bar");
		bar.innerHTML = `<b><i class="mk"></i>quick-agent</b><button class="btn" data-m="element" title="元素模式 (E)">元素 <kbd>E</kbd></button><button class="btn" data-m="region" title="框选区域 (R)">框选区域 <kbd>R</kbd></button><span class="hint">点击选择 · ${keys("shift")}+点击多选 · ${keys("enter")} 写评论 · ${keys("esc")} 退出</span><button class="btn icon" data-x title="退出 (Esc)">✕</button>`;
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
			e.stopPropagation();
			stop();
		} else if (e.key === "Enter" && selected.length && !box) {
			e.preventDefault();
			openBox();
		} else if (!box && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "e" || e.key === "r" || e.key === "E" || e.key === "R")) {
			e.preventDefault();
			e.stopPropagation();
			setMode(e.key.toLowerCase() === "r" ? "region" : "element");
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
		boxUrl = location.href; // the comment belongs to the page it was written on, even if an SPA navigates meanwhile
		box.innerHTML = `<div class="head"><i class="mk"></i><span class="meta" title="${escapeHtml(what)}">${escapeHtml(what)}</span></div>
			<textarea class="field" aria-label="评论"></textarea>
			<div class="row"><label><input type="checkbox" checked data-shot> 附带截图</label><span class="sp"></span>
			<button class="btn" data-cancel title="取消 (Esc)">取消</button><button class="btn primary" data-send>发送</button></div>
			<div class="keys"></div>`;
		renderBoxKeys();
		const left = Math.min(Math.max(8, u.x), innerWidth - 372);
		const below = u.y + u.height + 10;
		box.style.left = `${left}px`;
		box.style.top = `${below + 170 < innerHeight ? below : Math.max(8, u.y - 180)}px`;
		const ta = box.querySelector("textarea");
		setTimeout(() => ta.focus(), 0);
		box.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				e.preventDefault();
				// Esc: close the box; Esc again (picker bar) exits picking. With nothing typed, exit right away.
				if (box.querySelector("textarea").value.trim()) closeBox();
				else stop();
				return;
			}
			if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
			const mod = e.metaKey || e.ctrlKey;
			if (mod || (sendMode === "enter" && !e.shiftKey && !e.altKey)) {
				e.preventDefault();
				send();
			}
		});
		box.querySelector(".keys").addEventListener("click", (e) => {
			if (!e.target.closest("[data-mode]")) return;
			sendMode = sendMode === "enter" ? "mod" : "enter";
			try {
				chrome.storage.local.set({ sendMode });
			} catch {}
			renderBoxKeys();
			box.querySelector("textarea").focus();
		});
		box.addEventListener("keyup", (e) => e.stopPropagation());
		box.addEventListener("keypress", (e) => e.stopPropagation());
		box.querySelector("[data-cancel]").onclick = closeBox;
		box.querySelector("[data-send]").onclick = send;
	}
	function renderBoxKeys() {
		if (!box) return;
		const sk = sendMode === "mod" ? keys("mod+enter") : keys("enter");
		const nl = sendMode === "mod" ? keys("enter") : keys("shift+enter");
		box.querySelector(".keys").innerHTML = `${sk} 发送 · ${nl} 换行 · ${keys("esc")} 取消 <span class="sp" style="flex:1"></span><button data-mode title="切换发送键（与插件弹窗设置同步）">改为 ${sendMode === "mod" ? "Enter" : IS_MAC ? "⌘+Enter" : "Ctrl+Enter"} 发送</button>`;
		box.querySelector("textarea").placeholder = `写下你的评论/要求…（${sendMode === "mod" ? (IS_MAC ? "⌘+Enter" : "Ctrl+Enter") : "Enter"} 发送）`;
		box.querySelector("[data-send]").innerHTML = `发送 ${sk}`;
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
			url: boxUrl || location.href,
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
		if (pageKey(payload.url) === pageKey(location.href)) {
			pins.push({ id: res.intake.id, comment, anchor: anchors[0], docAnchor, status: "pending", selector: elements[0]?.selector, region: payload.region });
			renderPins();
		}
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
	// Pins belong to ONE page: pinsKey is the pageKey() they were fetched for. Whenever the page
	// identity changes (navigation, SPA pushState/replaceState, hash route, back/forward, bfcache
	// restore) the pins are dropped immediately and refetched; late poll responses for an old page
	// are discarded.
	let pins = [];
	let pinsKey = pageKey(location.href);
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
		openPop = null;
		if (pinsKey !== pageKey(location.href)) return; // stale: belongs to another page
		pins.forEach((p, i) => {
			const pos = pinPos(p);
			if (!pos) return;
			const st = p.taskStatus || p.status;
			const d = el("pin", pinLayer);
			d.style.left = `${pos.x}px`;
			d.style.top = `${pos.y}px`;
			d.classList.add(...[STATUS_CLASS[st] ?? "wait"].filter(Boolean));
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
				pop.innerHTML = `<div class="st ${STATUS_CLASS[st] ?? ""}">■ ${escapeHtml(STATUS_TEXT[st] || st)}${p.taskId ? ` · 任务 ${escapeHtml(p.taskId)}` : ""}${p.taskTitle ? ` · ${escapeHtml(p.taskTitle)}` : ""}</div><div>${escapeHtml(p.comment)}</div>${p.summary ? `<hr><div class="sum">${escapeHtml(p.summary)}</div>` : ""}`;
				openPop = pop;
			};
		});
	}

	let pollTimer = null;
	let hubDown = false;
	async function poll() {
		if (!alive()) return;
		const url = location.href;
		const key = pageKey(url);
		try {
			const res = await chrome.runtime.sendMessage({ type: "qa-page-comments", url });
			if (pageKey(location.href) !== key) return; // navigated while waiting: this answer is for another page
			hubDown = !res?.ok;
			if (res?.ok) {
				if (pinsKey !== key) pins = [];
				pinsKey = key;
				const known = new Map(pins.map((p) => [p.id, p]));
				// Belt and braces: an older hub may match pages more loosely; keep only this page's comments.
				pins = res.comments.filter((c) => !c.url || pageKey(c.url) === key).map((c) => {
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
	function schedulePoll(now = false, delay = 1500) {
		clearTimeout(pollTimer);
		const tick = async () => {
			if (!alive()) return; // extension reloaded/removed: stop quietly
			if (document.visibilityState === "visible") await poll();
			const busy = pins.some((p) => !["done", "failed", "cancelled"].includes(p.taskStatus || ""));
			// Back off when the hub is not reachable or not configured.
			pollTimer = setTimeout(tick, hubDown ? 60000 : busy ? 5000 : 30000);
		};
		pollTimer = setTimeout(tick, now ? delay : 0);
	}
	window.addEventListener("resize", () => renderPins());

	// Page identity changes. The isolated world cannot see the page's history.pushState calls, so
	// watch every signal we have: Navigation API (SPA routes, Chrome 102+), popstate/hashchange,
	// bfcache restore, and a cheap href check as the safety net.
	let lastKey = pageKey(location.href);
	function checkUrl() {
		const key = pageKey(location.href);
		if (key === lastKey) return;
		lastKey = key;
		pins = [];
		pinsKey = key;
		pinLayer.innerHTML = "";
		openPop = null;
		schedulePoll(true, 150);
	}
	window.addEventListener("popstate", checkUrl);
	window.addEventListener("hashchange", checkUrl);
	window.addEventListener("pageshow", (e) => {
		if (!e.persisted) return;
		lastKey = ""; // restored from bfcache: always refetch
		checkUrl();
	});
	try {
		window.navigation?.addEventListener("navigatesuccess", checkUrl);
		window.navigation?.addEventListener("currententrychange", () => setTimeout(checkUrl, 0));
	} catch {}
	const urlTimer = setInterval(() => (alive() ? checkUrl() : clearInterval(urlTimer)), 500);
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
