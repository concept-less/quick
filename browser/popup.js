const $ = (id) => document.getElementById(id);
const status = (t, cls = "") => { $("status").textContent = t; $("status").className = cls; };

chrome.storage.local.get({ hubUrl: "http://127.0.0.1:7788", token: "" }).then((s) => {
	$("hubUrl").value = s.hubUrl;
	$("token").value = s.token;
	if (s.token) test();
});

async function test() {
	status("连接中…");
	const r = await chrome.runtime.sendMessage({ type: "qa-health" });
	if (r?.ok) status(`已连接 hub（${r.health.tasks} 个任务）`, "ok");
	else status(r?.error || "连接失败", "err");
}

$("save").onclick = async () => {
	await chrome.storage.local.set({ hubUrl: $("hubUrl").value.trim() || "http://127.0.0.1:7788", token: $("token").value.trim() });
	test();
};
$("pick").onclick = async () => {
	await chrome.runtime.sendMessage({ type: "qa-toggle-active" });
	window.close();
};
$("dash").onclick = () => chrome.runtime.sendMessage({ type: "qa-open-dashboard" });
