import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../ui/app.html', import.meta.url), 'utf8');
function renderer() {
  const elements: any[] = [];
  const listeners: Record<string, Function> = {};
  const opened: string[] = [];
  const context = vm.createContext({
    document: { querySelectorAll: () => elements, addEventListener: (name: string, cb: Function) => listeners[name] = cb },
    openTask: (id: string) => opened.push(id),
  });
  const code = html.slice(html.indexOf('function inline(s)'), html.indexOf('/* ---------- state ---------- */'));
  const esc = html.split('\n').find(l => l.startsWith('const esc='));
  vm.runInContext(`${esc}\nconst tasks=new Map();\n${code}\n` +
    html.split('\n').find(l => l.startsWith("document.addEventListener('click',e=>{const t=e.target.closest('.tid')")), context);
  return { context, elements, listeners, opened, run: (s: string) => vm.runInContext(s, context) };
}

test('cached, archived and remote task names are used for historical and new Markdown', () => {
  const r = renderer();
  r.run(`tasks.set('ta001',{title:'修复登录'});tasks.set('ta002',{title:'归档工作',archived:true});tasks.set('ta003',{title:'远端任务',machine:'laptop'});`);
  const result = r.run(`md('**ta001**、ta002 和 ta003')`);
  for (const [id, title] of [['ta001','修复登录'], ['ta002','归档工作'], ['ta003','远端任务']]) {
    assert.ok(result.includes(`data-task="${id}" title="${title}" aria-label="${title}">${title}</button>`));
    assert.ok(!result.includes(`>${id}<`));
  }
  assert.ok(r.run(`md('ta001')`).includes('修复登录'));
});

test('unknown or empty titles use a neutral, accessible, clickable button', () => {
  const r = renderer();
  r.run(`tasks.set('ta001',{title:'  '})`);
  for (const id of ['ta001', 'tffff']) {
    const result = r.run(`md('${id}')`);
    assert.ok(result.includes('type="button"'));
    assert.ok(result.includes('aria-label="查看任务">查看任务</button>'));
    let prevented = false;
    r.listeners.click({ target: { closest: () => ({ dataset: { task: id } }) }, preventDefault: () => prevented = true });
    assert.equal(prevented, true);
    assert.equal(r.opened.at(-1), id);
  }
});

test('titles escape markup and attributes; long Unicode titles retain full hover and accessible name', () => {
  const r = renderer();
  r.run(`tasks.set('ta001',{title:'<img src=x onerror="alert(1)"> & \\'测试'});tasks.set('ta002',{title:'😀'.repeat(40)});`);
  const result = r.run(`md('ta001 ta002')`);
  assert.ok(result.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;测试'));
  assert.ok(!result.includes('<img'));
  assert.ok(result.includes(`title="${'😀'.repeat(40)}"`));
  assert.ok(result.includes(`>${'😀'.repeat(32)}…</button>`));
});

test('Markdown code, URLs, explicit links and non-task text are not rewritten', () => {
  const r = renderer();
  r.run(`tasks.set('ta001',{title:'任务名称'})`);
  const source = '`ta001`\n\n```sh\necho ta001\n```\n\n[ta001](https://example.test/ta001?q=ta001) https://example.test/ta001?q=ta001\n\nfile/ta001 #ta001 ta001.js xta001 ta001-long hello';
  const result = r.run(`md(${JSON.stringify(source)})`);
  assert.equal(result.includes('class="tid"'), false);
  assert.ok(result.includes('<code>ta001</code>'));
  assert.ok(result.includes('echo ta001'));
  assert.ok(result.includes('href="https://example.test/ta001?q=ta001"'));
  assert.equal(r.run(`linkTasks('https://example.test/?id=ta001')`), 'https://example.test/?id=ta001');
});

test('async cache arrival patches existing labels without replacing nodes or fetching', () => {
  const r = renderer();
  const attrs: Record<string,string> = { 'aria-label': '查看任务' };
  let updates = 0;
  const element = { dataset: { task: 'ta001' }, textContent: '查看任务', title: '查看任务', getAttribute: (k: string) => attrs[k], setAttribute: (k: string, v: string) => { updates++; attrs[k]=v; } };
  r.elements.push(element);
  r.run('refreshTaskRefs()');
  assert.equal(updates, 0);
  r.run(`tasks.set('ta001',{title:'加载后名称'});refreshTaskRefs()`);
  assert.equal(element.textContent, '加载后名称');
  assert.equal(element.title, '加载后名称');
  assert.equal(attrs['aria-label'], '加载后名称');
  r.run('refreshTaskRefs()');
  assert.equal(updates, 1);
  r.run(`tasks.set('ta001',{title:'更名后的任务'});refreshTaskRefs()`);
  assert.equal(element.textContent, '更名后的任务');
});
