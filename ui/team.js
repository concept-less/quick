/* quick-agent Web UI: team collaboration (docs/team-collaboration.md).
   Loaded after app.html's main script and uses its globals ($, esc, api, md, ago, toast, tasks, attn, openTask, closeTask, selTask).
   Adds: who you are, the quiet "团队" view (everything open, by whose ball it is), and in task detail the
   people (发起 / 负责 / 验收 / 关注) with hand-over controls and the comment thread. Nothing here interrupts. */
(()=>{
const T={members:[],me:null,root:true,board:null,timer:0};
const nm=id=>!id?'-':id==='agent'?'worker':(T.members.find(m=>m.id===id)?.name||id);
const on=()=>T.members.length>0;
const css=`
.tm-who{font:600 11px/1 var(--mono);letter-spacing:.06em;color:var(--fg-2);padding:0 8px;white-space:nowrap}
#pane-team .scroll{flex:1;overflow:auto}
#teamBtn.on{background:var(--inv-bg);border-color:var(--inv-bg);color:var(--inv-fg)}
.tm-head{display:flex;align-items:center;gap:8px;height:44px;padding:0 var(--s3) 0 var(--s4);border-bottom:var(--bw) solid var(--line-2);font:600 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase}
.tm-head .grow{flex:1}
.tm-head .btn{height:26px;font-size:12px;text-transform:none;letter-spacing:0}
.tm-g{position:sticky;top:0;z-index:1;display:flex;gap:8px;align-items:center;padding:8px var(--s4);background:var(--bg-2);border-bottom:var(--bw) solid var(--line);font:600 10.5px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--fg-2)}
.tm-g.me{color:var(--acc)}
.tm-r{padding:10px var(--s3) 10px var(--s4);border-bottom:var(--bw) solid var(--line);cursor:pointer;font-size:13px}
.tm-r:hover{background:var(--bg-2)}
.tm-r .tsub{color:var(--fg-2);font-size:12px;display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-people{display:grid;grid-template-columns:auto 1fr auto;gap:6px 12px;align-items:center;font-size:12.5px}
.tm-people dt{font:600 10.5px/1 var(--mono);color:var(--fg-3);letter-spacing:.08em;text-transform:uppercase}
.tm-people dd{margin:0}
.tm-people select{height:24px;font:12px var(--mono);border:var(--bw) solid var(--line-2);border-radius:0;background:transparent;color:inherit}
.tm-c{border-left:3px solid var(--line);padding:2px 0 2px 12px;margin:0 0 12px}
.tm-c.agent{border-left-color:var(--fg)}
.tm-c .h{font:600 10.5px/1.4 var(--mono);color:var(--fg-3);letter-spacing:.04em}
.tm-c .md{font-size:13px}
.tm-c .at{color:var(--acc);font-weight:600}
`;
const st=document.createElement('style');st.textContent=css;document.head.append(st);

async function loadTeam(){try{const r=await api('GET','/api/hub/team');T.members=r.members||[];T.me=r.me||null;T.root=!!r.root}catch{T.members=[]}render()}
function render(){
  let who=document.getElementById('tmWho');
  if(!who){who=document.createElement('span');who.id='tmWho';who.className='tm-who hide-m';const hub=document.getElementById('hubChip');hub?.parentNode.insertBefore(who,hub)}
  who.textContent=on()?(T.me?T.me.id+' · '+T.me.role:'root'):'';who.title=on()?'你在团队里的身份；「需要你」只算需要你的事':'';
  let btn=document.getElementById('teamBtn');
  if(!btn){btn=document.createElement('button');btn.id='teamBtn';btn.className='btn';btn.textContent='团队';btn.title='团队视图：所有进行中的事，按「球在谁手里」分组；只是看看，不打扰任何人';document.getElementById('focusBtn')?.after(btn);
    const pane=document.createElement('div');pane.id='pane-team';pane.style.cssText='display:none;flex-direction:column;flex:1;min-height:0';pane.innerHTML='<div class="tm-head">团队 · 球在谁手里<span class="grow"></span><button class="btn" data-x>返回注意力</button></div><div class="scroll" id="tmList"></div>';
    const panes=[...document.querySelectorAll('#side [id^="pane-"]')];panes[panes.length-1]?.after(pane);
    const close=()=>{pane.style.display='none';btn.classList.remove('on')};
    pane.querySelector('[data-x]').onclick=()=>{close();document.querySelector('.tab[data-tab="tasks"]')?.click()};
    document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',close));
    btn.onclick=()=>{if(btn.classList.contains('on')){pane.querySelector('[data-x]').click();return}
      if(typeof showSide==='function')showSide(true);closeTask();document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
      document.querySelectorAll('#side [id^="pane-"]').forEach(x=>{if(x!==pane)x.style.display='none'});pane.style.display='flex';btn.classList.add('on');loadBoard()};}
  btn.style.display=on()?'':'none';
}
function teamVisible(){return document.getElementById('pane-team')?.style.display==='flex'}
async function loadBoard(){if(!on())return;try{T.board=await api('GET','/api/hub/attention?scope=team')}catch(e){T.board={items:[],error:e.message}}renderBoard()}
function renderBoard(){const el=document.getElementById('tmList');if(!el)return;const items=T.board?.items||[];
  if(!items.length){el.innerHTML='<div class="blank"><span class="lbl">团队没有进行中的事</span>'+esc(T.board?.error||'这里只是看看，不会打扰任何人。')+'</div>';return}
  const groups=new Map();for(const i of items){if(!groups.has(i.ball))groups.set(i.ball,[]);groups.get(i.ball).push(i)}
  const label=b=>b==='agent'?'worker 在做':b==='owner'?'无人认领':'球在 '+nm(b);
  const order=[...groups.keys()].sort((a,b)=>(b===T.me?.id)-(a===T.me?.id)||(a==='agent')-(b==='agent')||a.localeCompare(b));
  el.innerHTML=order.map(b=>'<div class="tm-g'+(b===T.me?.id?' me':'')+'">'+esc(label(b))+' <span class="n">'+groups.get(b).length+'</span></div>'+groups.get(b).map(i=>{const p=i.people||{};
    return '<div class="tm-r" data-id="'+esc(i.taskId)+'"><span class="mark">'+esc(i.mark)+'</span> '+esc(i.title)+' <span class="tidm">'+esc(i.taskId)+'</span><span class="tsub">'+esc(i.reason)+' · 发起 '+esc(nm(p.requester))+(p.reviewer?' · 验收 '+esc(nm(p.reviewer)):'')+(p.assignee?' · 负责 '+esc(nm(p.assignee)):'')+'</span></div>'}).join('')).join('');
  el.querySelectorAll('.tm-r').forEach(r=>r.onclick=()=>openTask(r.dataset.id));
}
const opts=(cur,none)=>'<option value="">'+esc(none)+'</option>'+T.members.map(m=>'<option value="'+esc(m.id)+'"'+(m.id===cur?' selected':'')+'>'+esc(m.name+' ('+m.id+')')+'</option>').join('');
const hl=s=>esc(s).replace(/(^|[^\w@.])@([\w-]+|[\u4e00-\u9fff]+)/g,(m,p,id)=>p+'<span class="at">@'+id+'</span>');
// Task detail: called by app.html openTask() after it rendered the detail pane.
window.qaTeamDetail=(d,t,r)=>{if(!on())return;const body=d.querySelector('.dbody');if(!body)return;
  const comments=r.comments||[];const w=(t.watchers||[]);
  const sec=document.createElement('div');sec.className='dsec';
  sec.innerHTML='<h4>人</h4><dl class="tm-people">'+
    '<dt>发起</dt><dd>'+esc(nm(t.requester))+'</dd><dd></dd>'+
    '<dt>负责</dt><dd>'+esc(t.assignee?nm(t.assignee):'worker')+'</dd><dd><select data-f="assignee" title="把任务交给一个人负责（他会收到 worker 的提问和汇报）">'+opts(t.assignee,'worker')+'</select></dd>'+
    '<dt>验收</dt><dd>'+esc(t.reviewer?nm(t.reviewer):'-')+'</dd><dd><select data-f="reviewer" title="请一个人验收、拍板（交回时进他的「需要你」）">'+opts(t.reviewer,'无')+'</select></dd>'+
    '<dt>关注</dt><dd>'+esc(w.map(nm).join('、')||'-')+'</dd><dd><button class="btn" data-w>'+(T.me&&w.includes(T.me.id)?'取消关注':'关注')+'</button></dd></dl>';
  const cs=document.createElement('div');cs.className='dsec send';cs.id='tmCs';
  cs.innerHTML='<h4>评论 '+(comments.length||'')+'</h4>'+comments.map(c=>'<div class="tm-c'+(c.author==='agent'?' agent':'')+'"><div class="h">'+esc(nm(c.author))+' · '+esc(ago(c.ts))+(c.toWorker?' · 已转给 worker':'')+'</div><div class="md">'+hl(c.text).replace(/\n/g,'<br>')+'</div></div>').join('')+
    '<textarea id="tmComment" placeholder="评论：@成员id 点名（进他的「需要你」），@worker 转给 worker，@all 全体；不 @ 就只是留言，不打扰任何人"></textarea><div class="acts"><span class="hintk">⌘/Ctrl+Enter 发送</span><button class="btn primary" data-c>评论</button></div>';
  const anchor=body.querySelector('.dsec.send');body.insertBefore(sec,anchor);body.insertBefore(cs,anchor);
  const assign=async b=>{try{await api('POST','/api/hub/tasks/'+encodeURIComponent(t.id)+'/assign',b);openTask(t.id)}catch(e){toast(e.message,'error')}};
  sec.querySelectorAll('select').forEach(s=>s.onchange=()=>assign({[s.dataset.f]:s.value||null}));
  sec.querySelector('[data-w]').onclick=()=>T.me&&assign(w.includes(T.me.id)?{watchersRemove:[T.me.id]}:{watchersAdd:[T.me.id]});
  const ta=cs.querySelector('#tmComment');const post=async()=>{const text=ta.value.trim();if(!text)return;try{const x=await api('POST','/api/hub/tasks/'+encodeURIComponent(t.id)+'/comments',{text});ta.value='';toast(x.comment.mentions.length?'已评论，点名 '+x.comment.mentions.map(nm).join('、'):'已评论','info',2500);openTask(t.id)}catch(e){toast(e.message,'error')}};
  cs.querySelector('[data-c]').onclick=post;ta.onkeydown=e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();post()}};
};
// Hub events relayed by app.html onHub().
window.qaTeamOnHub=e=>{
  if(e.type==='team')loadTeam();
  else if(e.type==='task'&&teamVisible()){clearTimeout(T.timer);T.timer=setTimeout(loadBoard,500)}
  else if(e.type==='hello'||e.type==='machines'){if(!T.members.length)loadTeam()}
};
loadTeam();
})();
