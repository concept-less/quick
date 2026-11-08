// Installed outside checkout as ops/notify.mjs. Failure only; never installs or reloads.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
const id = process.argv[2];
if (!/^\d+$/.test(id ?? '')) throw new Error('invalid Actions run id');
const base = '/home/simon/.local/share/quick-release-runner/ops';
const file = `${base}/notified/${id}`;
if (existsSync(file)) process.exit(0);
const cfg = JSON.parse(readFileSync('/home/simon/.quick-agent/config.json', 'utf8'));
const url = `https://github.com/concept-less/quick/actions/runs/${id}`;
const origin = `http://127.0.0.1:${cfg.port || 7788}`;
const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` };
// Existing hub API, compatible with old installations: dispatch a failure-report-only
// worker. It turns the failure into a normal blocked attention card, no CI secrets.
const tasks = await fetch(`${origin}/api/tasks`, { headers }).then(r => r.json());
if (!tasks.tasks?.some(t => t.source?.kind === 'release' && t.source?.url === url)) {
  const r = await fetch(`${origin}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({
    title: '自动 Release 失败，需要检查', cwd: '/home/simon/qa-wt',
    source: { kind: 'release', url },
    brief: `自动发布流水线失败或取消：${url}。这是一条运维失败通知，不要修改代码、重试、安装或重启任何服务。请立即用 qa_report(status="blocked") 汇报：Release 未完成，草稿不会被 updater 检测，已安装版本未变；请维护者查看 Action 日志并重跑同一个 run。`
  }) });
  if (!r.ok) throw new Error(`attention dispatch HTTP ${r.status}`);
}
mkdirSync(`${base}/notified`, { recursive: true }); writeFileSync(file, url + '\n');
console.log(`Failure routed to attention: ${url}`);
