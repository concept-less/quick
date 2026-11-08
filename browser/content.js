// quick-agent browser extension — content script (isolated world).
// Element picking (hover + click, Shift+click for multiple), region selection (drag),
// comment box, and status pins for comments already sent from this page.
// All UI lives in a closed shadow root: page CSS cannot reach it and ours cannot leak out.
// Design tokens come from tokens.js (generated from shared/tokens.css, same as the Web UI).
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
	const cleanups = [];
	const on = (target, type, fn, opts) => {
		target.addEventListener(type, fn, opts);
		cleanups.push(() => target.removeEventListener(type, fn, opts));
	};

	const STATUS_TEXT = {
		pending: "等待前台", claimed: "前台处理中", dispatched: "已派单", starting: "启动中", running: "进行中",
		idle: "等你查看", needs_input: "需要你回复", blocked: "受阻", done: "已完成", failed: "失败", cancelled: "已取消", exited: "已退出", dismissed: "已忽略",
	};
	const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	const MOD = IS_MAC ? "⌘" : "Ctrl";

	// ------------------------------------------------------------ page identity
	// Must match hub/page-url.ts (pageKey): comments belong to a page, not to a scroll anchor.
	// - drop plain #fragments, keep hash routes (#/…, #!…)
	// - drop a trailing slash, tracking params (utm_*, fbclid, …) and sort the query
	const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|spm)$/i;
	function pageKey(href) {
		let u;
		try {
			u = new URL(href);
		} catch {
			return String(href || "").split("#")[0];
		}
		const route = /^#!?\//.test(u.hash) && !/^#!?\/?$/.test(u.hash) ? u.hash.replace(/\/+$/, "") : "";
		const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		const q = params.length ? `?${new URLSearchParams(params)}` : "";
		const path = u.pathname.replace(/\/+$/, "") || "/";
		return `${u.protocol}//${u.host.toLowerCase()}${path}${q}${route}`;
	}

	// ------------------------------------------------------------ shadow UI host
	const host = document.createElement("qa-agent-root");
	// 0x0 fixed box at the viewport origin; every child is position:fixed in viewport coordinates.
	host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;";
	const root = host.attachShadow({ mode: "closed" });
	root.innerHTML = `<style>${globalThis.__qaTokensCss || ""}
		:host{all:initial}
		*{box-sizing:border-box;font:13px/1.5 var(--sans);color:inherit;letter-spacing:0;text-transform:none;margin:0}
		kbd{font:500 10.5px/1 var(--mono);border:1px solid var(--line);border-bottom-width:2px;padding:1px 4px;color:var(--fg);background:var(--surface)}
		button{font:inherit;cursor:pointer;border-radius:0}
		:focus{outline:none}:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
		.hl{position:fixed;border:2px solid var(--acc);background:var(--acc-soft);pointer-events:none}
		.sel{position:fixed;border:2px solid var(--fg);outline:1px solid var(--bg);background:color-mix(in srgb,var(--fg) 8%,transparent);pointer-events:none}
		.tag{position:fixed;background:var(--acc);color:var(--acc-fg);font:500 11px/1.5 var(--mono);padding:1px 6px;pointer-events:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
		.region{position:fixed;border:2px dashed var(--acc);background:var(--acc-soft);pointer-events:none}
		.bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:var(--bg);color:var(--fg);border:1px solid var(--line-2);display:flex;align-items:stretch;height:36px;pointer-events:auto;box-shadow:var(--hard);max-width:calc(100vw - 24px)}
		.bar b{display:flex;align-items:center;gap:8px;padding:0 12px;border-right:1px solid var(--line-2);font:800 12px/1 var(--sans);letter-spacing:-.01em;text-transform:uppercase;white-space:nowrap}
		.bar b::before{content:"";width:10px;height:10px;background:var(--acc)}
		.bar button{background:transparent;color:var(--fg-2);border:0;border-right:1px solid var(--line);padding:0 12px;white-space:nowrap;transition:background var(--t),color var(--t)}
		.bar button:hover{color:var(--fg);background:var(--bg-2)}
		.bar button.on{background:var(--inv-bg);color:var(--inv-fg)}
		.bar button[data-x]{border-right:0;border-left:1px solid var(--line);font-family:var(--mono)}
		.bar .hint{color:var(--fg-3);font:11px/36px var(--mono);padding:0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.bar .hint kbd{margin:0 2px}
		.box{position:fixed;width:min(380px,calc(100vw - 16px));background:var(--bg);color:var(--fg);border:1px solid var(--line-2);pointer-events:auto;box-shadow:var(--hard)}
		.box .meta{color:var(--fg-3);font:11px/1.5 var(--mono);padding:8px 12px;border-bottom:1px solid var(--line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.box .meta b{font:600 10.5px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--fg);margin-right:8px}
		.box textarea{display:block;width:100%;min-height:96px;max-height:40vh;resize:vertical;background:var(--surface);color:var(--fg);border:0;padding:10px 12px;outline:none;font:14px/1.6 var(--sans)}
		.box textarea::placeholder{color:var(--fg-3)}
		.box .row{display:flex;gap:0;align-items:stretch;border-top:1px solid var(--line-2);height:36px}
		.box .row .sp{flex:1}
		.box button{background:transparent;color:var(--fg);border:0;border-left:1px solid var(--line);padding:0 14px;transition:background var(--t),color var(--t)}
		.box button:hover{background:var(--bg-2)}
		.box button.primary{background:var(--inv-bg);color:var(--inv-fg);font-weight:600;border-left-color:var(--inv-bg)}
		.box button.primary:hover{background:var(--acc);color:var(--acc-fg)}
		.box button.primary:disabled{opacity:.6;cursor:default}
		.box label{color:var(--fg-2);font-size:12px;display:flex;gap:6px;align-items:center;padding:0 12px;cursor:pointer}
		.box label input{accent-color:var(--fg);margin:0}
		.box .keys{display:flex;align-items:center;gap:4px;padding:0 12px;border-top:1px solid var(--line);height:28px;color:var(--fg-3);font:10.5px/1 var(--mono)}
		.box .keys button{border:0;padding:0;margin-left:auto;color:var(--fg-3);background:none;font:10.5px/1 var(--mono);text-decoration:underline;text-underline-offset:2px}
		.box .keys button:hover{color:var(--acc);background:none}
		.toast{position:fixed;bottom:18px;right:18px;background:var(--bg);color:var(--fg);border:1px solid var(--line-2);border-left:4px solid var(--fg);padding:9px 14px;pointer-events:auto;max-width:min(420px,calc(100vw - 36px));box-shadow:var(--hard);cursor:pointer}
		.toast.err{border-left-color:var(--acc)}
		.toast .sub{color:var(--fg-2);font-size:12px;margin-top:2px}
		.pin{position:fixed;left:0;top:0;width:22px;height:22px;font:700 11px/1 var(--mono);display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;border:2px solid var(--line-2);background:var(--bg);color:var(--fg);box-shadow:2px 2px 0 var(--hard-c);will-change:transform}
		.pin[hidden],.pop[hidden]{display:none}
		.pin.done,.pin.dispatched{background:var(--inv-bg);color:var(--inv-fg);border-color:var(--inv-bg)}
		.pin.needs_input,.pin.idle,.pin.blocked{border-color:var(--acc);color:var(--acc)}
		.pin.failed,.pin.exited{background:var(--acc);border-color:var(--acc);color:var(--acc-fg)}
		.pin.cancelled,.pin.dismissed{border-style:dashed;color:var(--fg-3)}
		.pin.running::after,.pin.starting::after,.pin.claimed::after{content:"";position:absolute;right:-5px;top:-5px;width:7px;height:7px;background:var(--acc);animation:blink 1.2s steps(2,start) infinite}
		.pin.open{outline:2px solid var(--acc);outline-offset:1px}
		@keyframes blink{to{visibility:hidden}}
		.pop{position:fixed;left:0;top:0;width:min(320px,calc(100vw - 16px));background:var(--bg);color:var(--fg);border:1px solid var(--line-2);pointer-events:auto;box-shadow:var(--hard);max-height:300px;overflow:auto}
		.pop .h{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--line);font:11px/1.4 var(--mono);color:var(--fg-2);flex-wrap:wrap}
		.pop .c{padding:9px 12px;white-space:pre-wrap;word-break:break-word}
		.pop .s{padding:8px 12px;border-top:1px solid var(--line);color:var(--fg-2);font-size:12px;white-space:pre-wrap;word-break:break-word}
		.st{display:inline-flex;align-items:center;gap:5px;font:600 10.5px/1 var(--mono);letter-spacing:.06em;padding:0 6px;height:19px;border:1px solid var(--line);color:var(--fg-2);white-space:nowrap}
		.st::before{content:"";width:6px;height:6px;background:currentColor}
		.st.running,.st.starting,.st.claimed{color:var(--fg);border-color:var(--fg)}
		.st.done,.st.dispatched{background:var(--inv-bg);border-color:var(--inv-bg);color:var(--inv-fg)}
		.st.needs_input,.st.idle,.st.blocked,.st.pending{border-color:var(--acc);color:var(--acc)}
		.st.failed,.st.exited{background:var(--acc);border-color:var(--acc);color:var(--acc-fg)}
		.st.cancelled,.st.dismissed{color:var(--fg-3);border-style:dashed;text-decoration:line-through}
		.fade{opacity:0!important;transition:opacity .15s ease-out!important;pointer-events:none!important}
		@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
	</style><div class="pins"></div><div class="layer"></div>`;
	const layer = root.querySelector(".layer");
	const pinLayer = root.querySelector(".pins");
	document.documentElement.appendChild(host);

	const el = (cls, parent = layer, tag = "div") => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		parent.appendChild(n);
		return n;
	};
	const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	const isOurs = (e) => e.composedPath().includes(host);

	// ------------------------------------------------------------ settings (chrome.storage, set in the popup)
	let sendKey = "enter"; // "enter": Enter sends, Shift+Enter newline · "mod": ⌘/Ctrl+Enter sends, Enter newline
	const sendKeyHint = () =>
		sendKey === "mod" ? `<kbd>${MOD}</kbd><kbd>Enter</kbd> 发送 · <kbd>Enter</kbd> 换行` : `<kbd>Enter</kbd> 发送 · <kbd>⇧</kbd><kbd>Enter</kbd> 换行`;
	const sendKeyPlaceholder = () =>
		`写下你的评论/要求…（${sendKey === "mod" ? `${MOD}+Enter 发送，Enter 换行` : "Enter 发送，Shift+Enter 换行"}）`;
	try {
		chrome.storage.local.get({ sendKey: "enter" }).then((s) => {
			sendKey = s.sendKey === "mod" ? "mod" : "enter";
			refreshBoxKeys();
		}, () => {});
		const onStore = (ch, area) => {
			if (area === "local" && ch.sendKey) {
				sendKey = ch.sendKey.newValue === "mod" ? "mod" : "enter";
				refreshBoxKeys();
			}
		};
		chrome.storage.onChanged.addListener(onStore);
		cleanups.push(() => chrome.storage.onChanged.removeListener(onStore));
	} catch {}

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
	let boxPage = null; // { url, title } captured when the comment box opened
	const selBoxes = [];

	const kbdHtml = (keys) => keys.map((k) => `<kbd>${k}</kbd>`).join("");
	function start() {
		if (active) return;
		active = true;
		selected = [];
		regionRect = null;
		closePop();
		bar = el("bar");
		bar.innerHTML = `<b>quick-agent</b><button data-m="element" title="点击选择元素">元素</button><button data-m="region" title="拖出一个矩形">框选区域</button><span class="hint">点击 · ${kbdHtml(["⇧"])}+点击多选 · ${kbdHtml(["Enter"])} 写评论 · ${kbdHtml(["Esc"])} 退出</span><button data-x title="退出 (Esc)">✕</button>`;
		bar.addEventListener("click", (e) => {
			const m = e.target.closest("button")?.dataset.m;
			if (m) setMode(m);
			if (e.target.closest("[data-x]")) stop();
			else if (m) snapDraft();
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
	}
	function stop(keepDraft = false) {
		if (!active) return;
		active = false;
		if (!keepDraft) dropDraft(); // cancelled or sent: this page's draft is done
		document.documentElement.style.cursor = "";
		dragStart = null;
		regionBox = null;
		hovered = null;
		document.removeEventListener("mousemove", onMove, true);
		document.removeEventListener("mousedown", onDown, true);
		document.removeEventListener("mouseup", onUp, true);
		document.removeEventListener("click", onClick, true);
		document.removeEventListener("keydown", onKey, true);
		layer.querySelectorAll(".bar,.hl,.tag,.sel,.region,.box").forEach((n) => n.remove());
		selBoxes.length = 0;
		box = null;
		boxPage = null;
		selected = [];
		regionRect = null;
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
		drawHover();
	}
	function drawHover() {
		if (!hovered || !hl || box || mode !== "element") return;
		const r = hovered.getBoundingClientRect();
		hl.style.display = tag.style.display = "block";
		place(hl, r);
		tag.textContent = cssPath(hovered);
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
		else snapDraft();
	}
	function onKey(e) {
		if (isOurs(e)) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			// Esc peels one layer: an in-progress drag, then the selection, then the picker itself.
			if (dragStart) {
				dragStart = null;
				regionRect = null;
				regionBox?.remove();
				regionBox = null;
			} else if (selected.length && !box) {
				selected = [];
				redrawSelection();
				snapDraft();
			} else stop();
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
	function refreshBoxKeys() {
		if (!box) return;
		box.querySelector("textarea").placeholder = sendKeyPlaceholder();
		box.querySelector(".keys span").innerHTML = sendKeyHint();
	}
	function openBox() {
		hl.style.display = tag.style.display = "none";
		redrawSelection();
		const u = unionRect();
		boxPage = { url: location.href, title: document.title };
		box = el("box");
		const what = mode === "region" ? `区域 ${Math.round(regionRect.width)}×${Math.round(regionRect.height)}，含 ${selected.length} 个元素` : selected.map((n) => cssPath(n)).join(" , ");
		box.innerHTML = `<div class="meta" title="${escapeHtml(what)}"><b>评论</b>${escapeHtml(what)}</div>
			<textarea></textarea>
			<div class="keys"><span></span><button data-toggle title="切换发送键（弹窗里也可以改）">切换</button></div>
			<div class="row"><label><input type="checkbox" checked data-shot> 附带截图</label><span class="sp"></span>
			<button data-cancel title="Esc">取消</button><button class="primary" data-send>发送</button></div>`;
		refreshBoxKeys();
		const bw = Math.min(380, innerWidth - 16);
		const left = Math.min(Math.max(8, u.x), innerWidth - bw - 8);
		const below = u.y + u.height + 10;
		box.style.left = `${left}px`;
		box.style.top = `${below + 220 < innerHeight ? below : Math.max(8, Math.min(u.y - 230, innerHeight - 240))}px`;
		const ta = box.querySelector("textarea");
		setTimeout(() => ta.focus(), 0);
		box.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				e.preventDefault();
				return closeBox();
			}
			if (e.key !== "Enter" || e.isComposing || e.keyCode === 229 || e.target !== ta) return;
			const mod = e.metaKey || e.ctrlKey;
			if (sendKey === "mod" ? mod : !e.shiftKey && !e.altKey) {
				e.preventDefault();
				send();
			} else if (sendKey === "enter" && mod) {
				e.preventDefault();
				send(); // ⌘/Ctrl+Enter always sends
			}
		});
		box.addEventListener("keyup", (e) => e.stopPropagation());
		box.addEventListener("keypress", (e) => e.stopPropagation());
		ta.addEventListener("input", () => snapDraft(true));
		box.querySelector("[data-shot]").addEventListener("change", () => snapDraft());
		box.querySelector("[data-cancel]").onclick = closeBox;
		box.querySelector("[data-send]").onclick = send;
		box.querySelector("[data-toggle]").onclick = () => {
			sendKey = sendKey === "enter" ? "mod" : "enter";
			refreshBoxKeys();
			chrome.storage.local.set({ sendKey }).catch(() => {});
			ta.focus();
		};
		snapDraft();
	}
	function closeBox() {
		box?.remove();
		box = null;
		boxPage = null;
		selected = [];
		regionRect = null;
		regionBox?.remove();
		regionBox = null;
		redrawSelection();
		snapDraft(); // empty selection → this page's draft is dropped
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
	const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

	/** Stable anchor for a pin: an element (selector) + relative offset inside it, plus a document-coordinate fallback. */
	function makeAnchor() {
		const u = unionRect();
		const corner = mode === "region" && regionRect ? { x: regionRect.x + regionRect.width, y: regionRect.y } : { x: u.x + u.width, y: u.y };
		let n = null;
		if (mode === "element") n = selected[0];
		else {
			// smallest common ancestor of the selected elements that contains the region's corner
			n = selected[0] || null;
			for (const o of selected.slice(1)) while (n && !n.contains(o)) n = n.parentElement;
			while (n && n !== document.documentElement) {
				const r = n.getBoundingClientRect();
				if (corner.x >= r.left - 1 && corner.x <= r.right + 1 && corner.y >= r.top - 1 && corner.y <= r.bottom + 1) break;
				n = n.parentElement;
			}
			if (n === document.documentElement || n === document.body) n = null;
		}
		const doc = { x: Math.round(corner.x + scrollX), y: Math.round(corner.y + scrollY) };
		if (!n) return { anchor: { doc }, el: null };
		const r = n.getBoundingClientRect();
		const fx = r.width ? (corner.x - r.left) / r.width : 1;
		const fy = r.height ? (corner.y - r.top) / r.height : 0;
		return { anchor: { selector: cssPath(n), fx: +fx.toFixed(4), fy: +fy.toFixed(4), doc }, el: n };
	}

	async function send() {
		const ta = box.querySelector("textarea");
		const comment = ta.value.trim();
		if (!comment) return ta.focus();
		const sendBtn = box.querySelector("[data-send]");
		if (sendBtn.disabled) return;
		sendBtn.disabled = true;
		sendBtn.textContent = "发送中…";
		const withScreenshot = box.querySelector("[data-shot]").checked;
		const elements = selected.map(describe);
		const focus = { ...unionRect(), viewportWidth: innerWidth };
		const boxes = mode === "region" && regionRect ? [regionRect] : elements.map((e) => e.rect);
		const { anchor, el: anchorEl } = makeAnchor();
		const page = boxPage || { url: location.href, title: document.title };
		const payload = {
			comment,
			url: page.url,
			title: page.title,
			mode,
			elements,
			region: mode === "region" && regionRect ? { x: Math.round(regionRect.x), y: Math.round(regionRect.y), width: Math.round(regionRect.width), height: Math.round(regionRect.height) } : undefined,
			anchor,
			viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
			consoleErrors: await consoleErrors(),
			userAgent: navigator.userAgent,
		};
		// Hide our UI so it is not in the screenshot.
		host.style.visibility = "hidden";
		await raf2();
		let res;
		try {
			res = await chrome.runtime.sendMessage({ type: "qa-submit", payload, boxes, focus, withScreenshot });
		} catch (e) {
			res = { ok: false, error: String(e?.message || e) };
		}
		host.style.visibility = "";
		if (!res?.ok) {
			if (box) {
				sendBtn.disabled = false;
				sendBtn.textContent = "发送";
			}
			const hint = !alive() ? "插件已更新或重新加载，请刷新页面后重试（评论内容已保留在输入框）。" : "点击工具栏的 quick-agent 图标可检查连接。评论内容已保留，修好后再点发送。";
			return toast(`发送失败：${res?.error ?? "unknown"}`, true, hint);
		}
		stop();
		toast(`已发送给前台 agent（${res.intake.id}）`);
		if (pageKey(page.url) === curKey) {
			pins.push({ id: res.intake.id, comment, status: "pending", anchor, el: anchorEl });
			renderPins();
		}
		schedulePoll(true);
	}

	function toast(text, err = false, sub = "") {
		layer.querySelectorAll(".toast").forEach((n) => n.remove());
		const t = el(`toast${err ? " err" : ""}`);
		t.textContent = text;
		if (sub) el("sub", t).textContent = sub;
		t.onclick = () => t.remove();
		setTimeout(() => t.remove(), err ? 8000 : 3000);
	}

	// ------------------------------------------------------------ in-progress comment drafts, per page
	// A selection / half-written comment belongs to the page it was made on (pageKey). When the URL
	// changes it fades out and is parked in chrome.storage.local (≤30 pages, 24h); coming back to that
	// page restores the selection and the text. Sending or cancelling drops it. Selectors are captured
	// while the elements are still in the DOM (snapDraft on every change), not at navigation time.
	const DRAFTS = "qaDrafts", DRAFT_TTL = 24 * 3600e3, DRAFT_MAX = 30;
	let draftSnap = null; // { key, draft|null } — latest state of the current page's draft
	let draftTimer = 0;
	let draftQueue = Promise.resolve();
	async function readDrafts() {
		try {
			const d = (await chrome.storage.local.get({ [DRAFTS]: {} }))[DRAFTS] || {};
			const now = Date.now();
			for (const k of Object.keys(d)) if (!d[k] || now - (d[k].ts || 0) > DRAFT_TTL) delete d[k];
			return d;
		} catch {
			return {};
		}
	}
	function writeDraft(key, draft) {
		draftQueue = draftQueue
			.then(async () => {
				const d = await readDrafts();
				if (draft) d[key] = { ...draft, ts: Date.now() };
				else if (!(key in d)) return;
				else delete d[key];
				for (const k of Object.keys(d).sort((a, b) => d[b].ts - d[a].ts).slice(DRAFT_MAX)) delete d[k];
				await chrome.storage.local.set({ [DRAFTS]: d });
			})
			.catch(() => {});
		return draftQueue;
	}
	function captureDraft() {
		if (!active) return null;
		const ta = box?.querySelector("textarea");
		const region = mode === "region" && regionRect ? { x: regionRect.x + scrollX, y: regionRect.y + scrollY, width: regionRect.width, height: regionRect.height } : null;
		if (!selected.length && !region && !ta?.value) return null;
		return {
			mode,
			selectors: selected.filter((n) => n.isConnected).map(cssPath),
			region,
			text: ta?.value || "",
			open: !!box,
			shot: box ? box.querySelector("[data-shot]").checked : true,
		};
	}
	/** Record the current page's draft (debounced write for typing; navigation flushes immediately). */
	function snapDraft(debounce = false) {
		draftSnap = { key: curKey, draft: captureDraft() };
		clearTimeout(draftTimer);
		if (debounce) draftTimer = setTimeout(flushDraft, 300);
		else flushDraft();
	}
	function flushDraft() {
		clearTimeout(draftTimer);
		if (!draftSnap) return;
		const { key, draft } = draftSnap;
		draftSnap = null;
		writeDraft(key, draft);
	}
	function dropDraft() {
		clearTimeout(draftTimer);
		draftSnap = null;
		writeDraft(curKey, null);
	}
	/** Fade out the picker's page-bound marks (selection, hover, region, comment box) and reset them. */
	function clearSelectionUi() {
		const nodes = layer.querySelectorAll(".hl,.tag,.sel,.region,.box");
		nodes.forEach((n) => n.classList.add("fade"));
		setTimeout(() => nodes.forEach((n) => (n.classList.contains("hl") || n.classList.contains("tag") ? n.classList.remove("fade") : n.remove())), 160);
		if (hl) hl.style.display = tag.style.display = "none";
		selBoxes.length = 0;
		box = null;
		boxPage = null;
		selected = [];
		regionRect = null;
		regionBox = null;
		dragStart = null;
		hovered = null;
	}
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	/** Bring back this page's parked draft (if any). SPA routes may render late: retry the selectors for ~2s. */
	async function restoreDraft() {
		const key = curKey, gen = navGen;
		const d = (await readDrafts())[key];
		if (!d || key !== curKey || gen !== navGen) return false;
		let found = [];
		for (let i = 0; i < 10; i++) {
			found = [...new Set((d.selectors || []).map(safeQuery).filter(Boolean))];
			if (found.length === (d.selectors || []).length) break;
			await sleep(200);
			if (key !== curKey || gen !== navGen) return false;
		}
		if (active && (box || selected.length)) return false; // the user already started something new here
		if (!active) start();
		setMode(d.mode === "region" ? "region" : "element");
		selected = found;
		if (d.mode === "region" && d.region) {
			regionRect = { x: d.region.x - scrollX, y: d.region.y - scrollY, width: d.region.width, height: d.region.height };
			regionBox = el("region");
			place(regionBox, regionRect);
		}
		redrawSelection();
		if (d.open || d.text) {
			openBox();
			const ta = box.querySelector("textarea");
			ta.value = d.text || "";
			box.querySelector("[data-shot]").checked = d.shot !== false;
			ta.setSelectionRange(ta.value.length, ta.value.length);
		}
		const missing = (d.selectors || []).length - found.length;
		toast("已恢复本页未发送的评论草稿", missing > 0, missing > 0 ? `有 ${missing} 个选中的元素在页面上找不到了（页面可能已变化），请检查后再发送。` : "");
		snapDraft();
		return true;
	}

	// ------------------------------------------------------------ pins for sent comments
	// Pins are bound to the current page (curKey). They are position:fixed and re-measured from the
	// anchor element's getBoundingClientRect on every scroll (any container), resize, layout or DOM
	// change (rAF-throttled), so they stay on their component through window scroll, inner scroll
	// containers and sticky headers, and hide when the component is clipped, covered or gone.
	let curKey = pageKey(location.href);
	let navGen = 0;
	let pins = [];
	let openPop = null; // { id, node }
	function safeQuery(s) {
		try {
			return document.querySelector(s);
		} catch {
			return null;
		}
	}
	function resolveEl(p) {
		if (p.el?.isConnected) return p.el;
		p.el = null;
		const sel = p.anchor?.selector || p.selector;
		if (sel) p.el = safeQuery(sel);
		return p.el;
	}
	const OVERFLOW_CLIP = /(auto|scroll|hidden|clip|overlay)/;
	function clippedOut(n, x, y) {
		for (let a = n.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
			const cs = getComputedStyle(a);
			if (cs.position === "fixed") break; // a fixed ancestor is not clipped by anything above it
			if (!OVERFLOW_CLIP.test(cs.overflow + cs.overflowX + cs.overflowY)) continue;
			const r = a.getBoundingClientRect();
			if (x < r.left - 1 || x > r.right + 1 || y < r.top - 1 || y > r.bottom + 1) return true;
		}
		return false;
	}
	function covered(n, x, y) {
		if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false; // off-screen: nothing to test
		const hit = document.elementsFromPoint(x, y).find((h) => h !== host);
		return !!hit && hit !== n && !n.contains(hit) && !hit.contains(n);
	}
	/** Viewport position of a pin's anchor point, or null when it should not be shown. */
	function pinPoint(p) {
		const n = resolveEl(p);
		if (n) {
			const r = n.getBoundingClientRect();
			if (!r.width && !r.height) return null; // display:none / detached
			const fx = p.anchor?.fx ?? 1, fy = p.anchor?.fy ?? 0;
			const x = r.left + fx * r.width, y = r.top + fy * r.height;
			// probe a point just inside the element for clipping / occlusion tests
			if (x < -4 || y < -4 || x > innerWidth + 4 || y > innerHeight + 4) return null; // scrolled out of view
			const px = Math.min(Math.max(x, r.left + 2), r.right - 2), py = Math.min(Math.max(y, r.top + 2), r.bottom - 2);
			if (clippedOut(n, px, py) || covered(n, px, py)) return null;
			return { x, y };
		}
		const d = p.anchor?.doc || p.doc;
		if (d) return { x: d.x - scrollX, y: d.y - scrollY };
		return null;
	}
	function renderPins() {
		pinLayer.querySelectorAll(".pin").forEach((n) => n.remove());
		pins.forEach((p, i) => {
			const st = p.taskStatus || p.status;
			const d = el(`pin ${st}`, pinLayer);
			d.dataset.id = p.id;
			d.textContent = String(i + 1);
			d.title = `${STATUS_TEXT[st] || st}: ${p.comment}`;
			d.onclick = (e) => {
				e.stopPropagation();
				if (openPop?.id === p.id) return closePop();
				showPop(p);
			};
			p.node = d;
		});
		if (openPop) {
			const p = pins.find((x) => x.id === openPop.id);
			if (p) showPop(p);
			else closePop();
		}
		reposition();
	}
	function showPop(p) {
		closePop();
		const st = p.taskStatus || p.status;
		const pop = el("pop", pinLayer);
		pop.innerHTML = `<div class="h"><span class="st ${escapeHtml(st)}">${escapeHtml(STATUS_TEXT[st] || st)}</span>${p.taskId ? `<span>任务 ${escapeHtml(p.taskId)}</span>` : `<span>${escapeHtml(p.id)}</span>`}${p.taskTitle ? `<span>${escapeHtml(p.taskTitle)}</span>` : ""}</div><div class="c">${escapeHtml(p.comment)}</div>${p.summary ? `<div class="s">${escapeHtml(p.summary)}</div>` : ""}`;
		pop.addEventListener("click", (e) => e.stopPropagation());
		openPop = { id: p.id, node: pop };
		p.node?.classList.add("open");
		reposition();
	}
	function closePop() {
		if (!openPop) return;
		openPop.node.remove();
		pinLayer.querySelector(".pin.open")?.classList.remove("open");
		openPop = null;
	}
	function reposition() {
		for (const p of pins) {
			if (!p.node) continue;
			const pt = pinPoint(p);
			p.visible = !!pt;
			if (!pt) {
				p.node.hidden = true;
				continue;
			}
			p.node.hidden = false;
			const x = Math.min(Math.max(pt.x - 11, 2), innerWidth - 26);
			const y = Math.max(pt.y - 11, 2);
			p.pos = { x, y };
			p.node.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
		}
		if (openPop) {
			const p = pins.find((x) => x.id === openPop.id);
			const pop = openPop.node;
			if (!p?.visible) pop.hidden = true;
			else {
				pop.hidden = false;
				const w = pop.offsetWidth, h = pop.offsetHeight;
				let x = p.pos.x + 28;
				if (x + w > innerWidth - 8) x = Math.max(8, p.pos.x - w - 6);
				const y = Math.min(Math.max(8, p.pos.y), innerHeight - h - 8);
				pop.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
			}
		}
		if (active) {
			redrawSelection();
			drawHover();
		}
	}
	let rafId = 0;
	const scheduleReposition = () => {
		if (rafId || (!pins.length && !active)) return;
		rafId = requestAnimationFrame(() => {
			rafId = 0;
			reposition();
		});
	};
	on(window, "scroll", scheduleReposition, { capture: true, passive: true }); // capture: inner scroll containers too
	on(window, "resize", scheduleReposition, { passive: true });
	on(window.visualViewport || window, "resize", scheduleReposition, { passive: true });
	const ro = new ResizeObserver(scheduleReposition);
	ro.observe(document.documentElement);
	if (document.body) ro.observe(document.body);
	const mo = new MutationObserver((recs) => {
		if (recs.every((r) => r.target === host || host.contains(r.target))) return;
		scheduleReposition();
	});
	mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
	// CSS transitions/animations do not trigger any of the above: a slow safety net while pins exist.
	const tickTimer = setInterval(() => pins.length && document.visibilityState === "visible" && scheduleReposition(), 1000);
	cleanups.push(() => {
		ro.disconnect();
		mo.disconnect();
		clearInterval(tickTimer);
		cancelAnimationFrame(rafId);
	});
	on(document, "click", (e) => {
		if (openPop && !active && !isOurs(e)) closePop();
	});
	on(document, "keydown", (e) => {
		if (e.key === "Escape" && openPop && !active) closePop();
	});

	// ------------------------------------------------------------ navigation: pins follow the URL
	// SPA routers (pushState/replaceState via console-hook.js, Navigation API), back/forward
	// (popstate), hash routes and bfcache restores all re-bind the pins to the new page at once.
	function onNav(force = false) {
		const k = pageKey(location.href);
		if (!force && k === curKey) return;
		if (k !== curKey) {
			// Leave the old page: park its draft, fade its selection / comment box out (picker stays on).
			if (draftSnap?.key === curKey) flushDraft();
			if (active) clearSelectionUi();
		}
		curKey = k;
		navGen++;
		closePop();
		restoreDraft();
		pins = [];
		renderPins();
		schedulePoll(false);
	}
	const navSoon = () => setTimeout(() => onNav(), 0); // after the router has updated location
	on(window, "popstate", navSoon);
	on(window, "hashchange", navSoon);
	on(window, "qa:locationchange", navSoon);
	on(window, "pagehide", () => flushDraft());
	on(window, "pageshow", (e) => {
		if (e.persisted) onNav(true); // restored from bfcache: the page's comments may have changed
	});
	if (window.navigation?.addEventListener) on(window.navigation, "navigatesuccess", navSoon);
	let lastHref = location.href;
	const hrefTimer = setInterval(() => location.href !== lastHref && ((lastHref = location.href), onNav()), 500);
	cleanups.push(() => clearInterval(hrefTimer));

	let pollTimer = null;
	let hubDown = false;
	async function poll() {
		if (!alive()) return;
		const gen = navGen, key = curKey;
		try {
			const res = await chrome.runtime.sendMessage({ type: "qa-page-comments", url: location.href });
			if (gen !== navGen || key !== curKey) return; // the page changed while we were waiting: stale
			hubDown = !res?.ok;
			if (res?.ok) {
				const known = new Map(pins.map((p) => [p.id, p]));
				pins = res.comments.map((c) => {
					const old = known.get(c.id) || {};
					return {
						id: c.id, comment: c.comment, status: c.status, taskId: c.taskId, taskStatus: c.taskStatus,
						taskTitle: c.taskTitle, summary: c.summary, el: old.el,
						anchor: old.anchor || c.anchor || legacyAnchor(c),
					};
				});
				renderPins();
			}
		} catch {}
	}
	/** Comments saved before anchors existed: first element's top-right, or the region converted to document coords. */
	function legacyAnchor(c) {
		const sx = c.viewport?.scrollX ?? 0, sy = c.viewport?.scrollY ?? 0;
		const doc = c.region ? { x: c.region.x + c.region.width + sx, y: c.region.y + sy } : undefined;
		if (c.mode === "region" && doc) return { doc };
		const sel = c.elements?.[0]?.selector;
		if (sel) return { selector: sel, fx: 1, fy: 0, doc };
		return doc ? { doc } : undefined;
	}
	function schedulePoll(soon = false) {
		clearTimeout(pollTimer);
		const tick = async () => {
			if (!alive()) return teardown(); // extension reloaded/removed: stop quietly
			if (document.visibilityState === "visible") await poll();
			const busy = pins.some((p) => !["done", "failed", "cancelled"].includes(p.taskStatus || ""));
			// Back off when the hub is not reachable or not configured.
			pollTimer = setTimeout(tick, hubDown ? 60000 : busy ? 5000 : 30000);
		};
		pollTimer = setTimeout(tick, soon ? 1500 : 0);
	}
	on(document, "visibilitychange", () => document.visibilityState === "visible" && schedulePoll(false));

	// ------------------------------------------------------------ wiring
	function teardown() {
		try {
			flushDraft();
			stop(true);
		} catch {}
		clearTimeout(pollTimer);
		for (const c of cleanups.splice(0)) {
			try {
				c();
			} catch {}
		}
		host.remove();
	}
	window.__qaContent = { alive, teardown };
	const onMsg = (msg, sender, sendResponse) => {
		if (sender.id !== chrome.runtime.id) return;
		if (msg?.type === "qa-ping") sendResponse({ ok: true, active });
		else if (msg?.type === "qa-toggle") {
			onNav(); // URL changed without us noticing yet → start from the new page, never with old selections
			if (active) stop();
			else {
				start();
				restoreDraft();
			}
			sendResponse({ ok: true, active });
		}
	};
	chrome.runtime.onMessage.addListener(onMsg);
	cleanups.push(() => chrome.runtime.onMessage.removeListener(onMsg));
	schedulePoll();
	restoreDraft(); // a full page load back to a page with a parked draft
})();
