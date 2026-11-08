const $ = (id) => document.getElementById(id);
const DEFAULT_HUB = "http://127.0.0.1:7788";
const AUTO_ORIGINS = ["http://*/*", "https://*/*"];

function status(text, cls = "") {
	$("status").textContent = text;
	$("status").className = cls;
	$("dot").className = `dot ${cls}`;
}

async function send(msg) {
	try {
		return await chrome.runtime.sendMessage(msg);
	} catch (e) {
		return { ok: false, error: String(e?.message || e) };
	}
}

async function test() {
	status("连接中…");
	const r = await send({ type: "qa-health" });
	if (r?.ok) {
		const mid = typeof r.health.machine === "string" ? r.health.machine : r.health.machine?.id;
		const m = mid ? ` · ${mid}` : "";
		status(`已连接 hub（${r.health.tasks} 个任务${m}）`, "ok");
	} else {
		status(r?.error || "连接失败", "err");
		$("settings").open = true;
	}
}

async function showShortcut() {
	const cmds = await chrome.commands.getAll();
	const c = cmds.find((x) => x.name === "toggle-picker");
	const keys = c?.shortcut;
	$("shortcut").innerHTML = "";
	if (!keys) {
		$("shortcut").textContent = "未设置";
		return;
	}
	// "⌘⇧E" on mac comes as a single string of symbols; "Ctrl+Shift+E" elsewhere.
	const plus = keys.includes("+");
	const parts = plus ? keys.split("+") : [...keys];
	parts.forEach((k, i) => {
		if (i && plus) $("shortcut").append("+");
		const kbd = document.createElement("kbd");
		kbd.textContent = k;
		$("shortcut").append(kbd);
	});
}

async function init() {
	const s = await chrome.storage.local.get({ hubUrl: DEFAULT_HUB, token: "" });
	$("hubUrl").value = s.hubUrl;
	$("token").value = s.token;
	$("auto").checked = await chrome.permissions.contains({ origins: AUTO_ORIGINS });
	showShortcut();
	if (s.token) test();
	else {
		status("还没配置：填写 Hub 地址和 Token 后点「保存并测试」", "err");
		$("settings").open = true;
	}
}

$("save").onclick = async () => {
	let hubUrl = $("hubUrl").value.trim() || DEFAULT_HUB;
	if (!/^https?:\/\//i.test(hubUrl)) hubUrl = `http://${hubUrl}`;
	$("hubUrl").value = hubUrl;
	await chrome.storage.local.set({ hubUrl, token: $("token").value.trim() });
	test();
};
$("pick").onclick = async () => {
	$("pickErr").style.display = "none";
	const r = await send({ type: "qa-toggle-active" });
	if (r?.ok) return window.close();
	$("pickErr").textContent = r?.error || "无法在此页面运行";
	$("pickErr").style.display = "block";
};
$("dash").onclick = () => send({ type: "qa-open-dashboard" });
$("shortcuts").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
$("auto").onchange = async (e) => {
	// permissions.request must run directly in the click handler (user gesture).
	// The background also listens to permissions.onAdded/onRemoved, so this works even if the
	// popup closes while Chrome shows the permission prompt.
	if (e.target.checked) e.target.checked = await chrome.permissions.request({ origins: AUTO_ORIGINS });
	else await chrome.permissions.remove({ origins: AUTO_ORIGINS });
	await send({ type: "qa-auto-sync" });
};

init();
