// Single-page dashboard served by the hub at "/". Token is read from ?token= and kept in localStorage.
export function dashboardHtml(): string {
	return /* html */ `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>quick-agent</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e6e6;--dim:#8a93a6;--acc:#7aa2f7;--ok:#9ece6a;--warn:#e0af68;--err:#f7768e}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0}#conn{font-size:12px;color:var(--dim)}
main{display:grid;grid-template-columns:minmax(320px,420px) 1fr;height:calc(100vh - 50px)}
#list{overflow:auto;border-right:1px solid var(--line)}#detail{overflow:auto;padding:16px 20px}
.task{padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer}.task:hover,.task.sel{background:var(--card)}
.row{display:flex;gap:8px;align-items:center}.row>.sub{min-width:0;flex:1}.row>.sub:last-child{flex:0 0 auto}.title{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.id{font-family:ui-monospace,monospace;color:var(--dim);font-size:12px}.sub{color:var(--dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st{font-size:11px;padding:1px 6px;border-radius:8px;border:1px solid var(--line)}
.st.running,.st.starting{color:var(--acc)}.st.done{color:var(--ok)}.st.needs_input,.st.idle,.st.blocked{color:var(--warn)}.st.failed,.st.exited,.st.cancelled{color:var(--err)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--warn);display:inline-block}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card);padding:10px;border-radius:6px;border:1px solid var(--line)}
.ev{font-size:12px;border-left:2px solid var(--line);padding:2px 8px;margin:4px 0}.ev .k{color:var(--acc)}
textarea{width:100%;min-height:70px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px}
button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 12px;cursor:pointer}button:hover{border-color:var(--acc)}
code{font-family:ui-monospace,monospace;background:var(--card);padding:1px 4px;border-radius:4px}
h3{margin:18px 0 6px;font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
#tokenbox{padding:40px;max-width:520px}input{width:100%;padding:8px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px}
</style></head><body>
<header><h1>⚡ quick-agent</h1><span id="conn">connecting…</span><span style="flex:1"></span><span id="counts" class="sub"></span><a href="/extension.zip" style="color:var(--acc);font-size:12px">下载浏览器插件</a></header>
<main id="app"><div id="list"></div><div id="detail"><p class="sub">选择左侧任务查看详情</p></div></main>
<script>
const qs=new URLSearchParams(location.search);
if(qs.get('token')){localStorage.qaToken=qs.get('token');history.replaceState(null,'',location.pathname+location.hash)}
const token=localStorage.qaToken;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
if(!token){document.getElementById('app').outerHTML='<div id="tokenbox"><p>请输入 hub token（见 <code>~/.quick-agent/config.json</code> 或运行 <code>qa token</code>）</p><input id="tk"><p><button onclick="localStorage.qaToken=document.getElementById(\\'tk\\').value;location.reload()">保存</button></p></div>'}
const api=(m,p,b)=>fetch(p,{method:m,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
let tasks=new Map(),sel=null;
const ago=t=>{const s=(Date.now()-t)/1000;return s<60?Math.floor(s)+'s':s<3600?Math.floor(s/60)+'m':s<86400?Math.floor(s/3600)+'h':Math.floor(s/86400)+'d'};
function renderList(){
  const arr=[...tasks.values()].sort((a,b)=>b.updatedAt-a.updatedAt);
  $('#list').innerHTML=arr.map(t=>'<div class="task'+(t.id===sel?' sel':'')+'" data-id="'+t.id+'"><div class="row">'+(t.unread?'<span class="dot"></span>':'')+'<span class="title">'+esc(t.title)+'</span><span class="st '+t.status+'">'+t.status+'</span></div><div class="row"><span class="id">'+t.id+'</span><span class="sub">'+esc(((t.status==='running'||t.status==='starting')?t.activity:t.summary)||t.cwd)+'</span><span class="sub" style="margin-left:auto">'+ago(t.updatedAt)+'</span></div></div>').join('')||'<p class="sub" style="padding:16px">暂无任务</p>';
  document.querySelectorAll('.task').forEach(el=>el.onclick=()=>select(el.dataset.id));
  const act=arr.filter(t=>t.status==='running'||t.status==='starting').length,att=arr.filter(t=>t.unread).length;
  $('#counts').textContent=act+' 运行中 · '+att+' 待处理 · '+arr.length+' 总计';
}
async function select(id){sel=id;renderList();const {task:t,events}=await api('GET','/api/tasks/'+id+'?events=80');if(!t)return;
  $('#detail').innerHTML='<div class="row"><h2 style="margin:0;flex:1">'+esc(t.title)+'</h2><span class="st '+t.status+'">'+t.status+'</span></div>'+
  '<p class="sub">'+t.id+' · '+esc(t.cwd)+' · 来源 '+t.source.kind+(t.source.url?' · <a style="color:var(--acc)" href="'+esc(t.source.url)+'" target="_blank">'+esc(t.source.url)+'</a>':'')+'</p>'+
  '<p class="sub">接管: <code>tmux attach -t '+esc((t.tmuxTarget||'').split(':')[0])+' \\\\; select-window -t '+esc(t.tmuxTarget||'')+'</code>'+(t.sessionFile?' · 会话 <code>'+esc(t.sessionFile)+'</code>':'')+'</p>'+
  '<div class="row"><button onclick="act(\\'ack\\')">标记已读</button><button onclick="act(\\'cancel\\')">中止</button><button onclick="act(\\'close\\')">关闭窗口</button></div>'+
  (t.summary?'<h3>最新汇报</h3><pre>'+esc(t.summary)+'</pre>':'')+
  '<h3>实时终端</h3><pre id="screen" style="max-height:420px;overflow:auto;font:12px/1.35 ui-monospace,monospace">…</pre>'+
  '<h3>追加指令</h3><textarea id="msg" placeholder="发给负责这个任务的 worker（Ctrl+Enter 发送）"></textarea><p><button onclick="sendMsg()">发送</button></p>'+
  '<h3>任务简报</h3><pre>'+esc(t.brief)+'</pre>'+
  '<h3>事件</h3>'+events.slice().reverse().map(e=>'<div class="ev"><span class="sub">'+new Date(e.ts).toLocaleTimeString()+'</span> <span class="k">'+e.kind+(e.status?' → '+e.status:'')+'</span> '+esc((e.text||'').slice(0,400))+'</div>').join('');
  $('#msg').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))sendMsg()};
  history.replaceState(null,'','#'+id);pollScreen();
  if(t.unread)api('POST','/api/tasks/'+id+'/ack');
}
let screenTimer=null;
async function pollScreen(){clearTimeout(screenTimer);const id=sel;const r=await api('GET','/api/tasks/'+id+'/screen');if(id!==sel)return;const el=$('#screen');if(!el)return;
  const atBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-8;el.textContent=r.alive?(r.text||'(空)'):'(worker 窗口已关闭)';if(atBottom)el.scrollTop=el.scrollHeight;
  if(r.alive)screenTimer=setTimeout(pollScreen,1500)}
async function act(a){if(a==='close'&&!confirm('关闭 worker 的 tmux 窗口？'))return;await api('POST','/api/tasks/'+sel+'/'+a,{});select(sel)}
async function sendMsg(){const text=$('#msg').value.trim();if(!text)return;await api('POST','/api/tasks/'+sel+'/message',{text});select(sel)}
async function boot(){if(!token)return;const r=await api('GET','/api/tasks');if(r.error){$('#conn').textContent=r.error;return}
  tasks=new Map(r.tasks.map(t=>[t.id,t]));renderList();
  const es=new EventSource('/api/events?role=dashboard&token='+encodeURIComponent(token));
  es.onopen=()=>$('#conn').textContent='● live';es.onerror=()=>$('#conn').textContent='○ reconnecting…';
  es.onmessage=m=>{const e=JSON.parse(m.data);if(e.type==='task'){tasks.set(e.task.id,e.task);renderList();if(e.task.id===sel&&e.event)select(sel)}};
  setInterval(renderList,30000);
  const h=location.hash.slice(1);if(h&&tasks.has(h))select(h)}
boot();
</script></body></html>`;
}
