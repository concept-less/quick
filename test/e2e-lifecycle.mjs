import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Optional visual harness: QA_CDP_MODULE must point at a trusted Browser/CDP helper.
if (!process.env.QA_CDP_MODULE) throw new Error('Set QA_CDP_MODULE to the CDP Browser helper module and optionally CHROME_PATH');
const { Browser } = await import(process.env.QA_CDP_MODULE);
const run=promisify(execFile), root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const sha='a'.repeat(40), base='b'.repeat(40), next='c'.repeat(40);
const fixture={id:'t1234',title:'支付权限边界检查',brief:'保留现有工作区；审查后集成。',cwd:'/tmp/example/worktree',createdAt:200,updatedAt:300,status:'needs_input',unread:true,ask:{question:'是否批准此 SHA 集成？',options:['批准该 SHA 集成','要求修改'],at:300},lifecycle:{phase:'human_approval',policy:{template:'C',workspace:'worktree',review:'human',reason:'重要权限变更，需要明确人工批准'},workspace:{repo:'/tmp/example',devCwd:'/tmp/example/dev',cwd:'/tmp/example/worktree',branch:'task/t1234',baseBranch:'main',baseSha:base,remote:'origin',initialDirty:[]},head:sha,review:{sha,verdict:'approve',summary:'检查了权限边界、回滚方案与异常分支。\n\n测试：权限拒绝与允许用例均通过。',at:300},release:'等待项目 CI 发布'}};
let task=structuredClone(fixture), posts=[], failure=false;
const older={...fixture,id:'t0001',title:'较早任务',createdAt:100,updatedAt:900,lifecycle:undefined,ask:{question:'继续执行吗？',options:['继续'],at:900}};
const items=()=>[task,older].map(t=>({taskId:t.id,title:t.title,status:t.status,level:'need',mark:'[ASK]',reason:'worker 在等你决定',since:t.updatedAt,updatedAt:t.updatedAt,question:t.ask?.question,options:t.ask?.options,actions:[{id:'reply',label:'回答'},{id:'snooze',label:'稍后'},{id:'ack',label:'知道了'}]}));
const html=readFileSync(root+'/ui/app.html','utf8').replace('/*@tokens*/',readFileSync(root+'/shared/tokens.css','utf8')).replace('<script>','<script>window.EventSource=class {};\n');
const baseline=execFileSync('git',['show','HEAD:ui/app.html'],{cwd:root,encoding:'utf8'}).replace('/*@tokens*/',readFileSync(root+'/shared/tokens.css','utf8')).replace('<script>','<script>window.EventSource=class {};\n');
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://mock').pathname.replace('/api/hub/','/api/');
 let data={};const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;data=raw?JSON.parse(raw):{};posts.push({path,body:data});if(failure)return json({error:'HEAD changed; review again'},409);return json({task});}
 if(path==='/baseline'){res.writeHead(200,{'content-type':'text/html'});return res.end(baseline);}
 if(path==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end(html);}
 if(path.endsWith('.js')){res.writeHead(200,{'content-type':'application/javascript'});return res.end('');}
 if(path==='/api/tasks')return json({tasks:[older,task]});
 if(path.endsWith('/transcript'))return json({available:false,entries:[],status:task.status});
 if(path.startsWith('/api/tasks/'))return json({task:path.includes('t0001')?older:task,events:[]});
 if(path==='/api/attention')return json({items:items(),counts:{need:2,skim:0,snoozed:0,inflight:0,archived:0},focus:{on:false}});
 if(path==='/api/machines')return json({self:'mock',machines:[]});
 if(path==='/api/intake')return json({intake:[]});
 if(path==='/api/projects')return json({projects:[]});
 if(path==='/api/cron')return json({jobs:[]});
 return json({});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port;
const home=mkdtempSync('/tmp/tb711-cli-');
let browser;
try{
 const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('QA_')));
 const env={...cleanEnv,QA_HOME:home,QA_HUB_URL:url,QA_TOKEN:'mock-only',QA_NO_UPDATE:'1',QA_UPDATE:'off',NODE_NO_WARNINGS:'1'};
 const cli=async(args,code=0)=>{try{const r=await run(process.execPath,[root+'/cli/quick.ts',...args],{env,timeout:10000});assert.equal(code,0);return r.stdout;}catch(e){if(code===0)throw e;assert.equal(e.code,code);return e.stderr;}};
 for(const args of [['approve','t1234'],['approve','t1234','--sha'],['approve','t1234','--sha','abc'],['approve','t1234','--sha',sha,'extra'],['approve','t1234','--sha',sha,'--sha',sha],['changes','t1234'],['changes','t1234','   ']])await cli(args,1);
 assert.equal(posts.length,0);
 await cli(['approve','t1234','--sha',sha]);assert.deepEqual(posts.pop(),{path:'/api/tasks/t1234/approve',body:{sha}});
 await cli(['approve','t1234','--sha','d'.repeat(64)]);assert.equal(posts.pop().body.sha.length,64);
 await cli(['changes','t1234','请修复','权限边界']);assert.deepEqual(posts.pop(),{path:'/api/tasks/t1234/changes',body:{text:'请修复 权限边界'}});
 await cli(['approve','remote/task','--sha',sha]);assert.equal(posts.pop().path,'/api/tasks/remote%2Ftask/approve');
 failure=true;assert.match(await cli(['approve','t1234','--sha',sha],1),/HEAD changed/);failure=false;posts=[];
 const detail=await cli(['show','t1234']);for(const s of ['human_approval','模板 C','workspace=worktree','review=human',fixture.lifecycle.policy.reason,sha,base+'..'+sha,'quick approve t1234 --sha','quick changes t1234','Release'])assert.ok(detail.includes(s),s);
 assert.ok(!detail.includes('选项:'));assert.equal(posts.length,0);
 const legacy=await cli(['show','t0001']);assert.ok(!legacy.includes('── 生命周期 ──'));assert.ok(legacy.includes('选项: 继续'));
 await cli(['send','t1234','批准']);assert.deepEqual(posts.pop(),{path:'/api/tasks/t1234/message',body:{text:'批准'}});
 console.log('CLI: validation, exact 40/64 SHA payloads, changes, URL encoding, conflict errors, detail and legacy compatibility passed');
 // CHROME_PATH, when set, is supplied by the caller; never choose a real browser profile.
 browser=await Browser.launch({extraArgs:['--no-sandbox']});const page=await browser.newPage();
 await page.goto(url,{settleMs:100});await page.eval('loadHub()');
 await page.eval('_renderTasks()');
 assert.deepEqual(await page.eval("[...document.querySelectorAll('.titem')].map(e=>e.dataset.id)"),['t1234','t0001']);
 await page.eval("for(const i of attn.values()){i.since=1e15-i.since;i.updatedAt=1e15-i.updatedAt}tasks.get('t0001').updatedAt=1e16;_renderTasks()");
 assert.deepEqual(await page.eval("[...document.querySelectorAll('.titem')].map(e=>e.dataset.id)"),['t1234','t0001']);
 assert.equal(await page.eval("document.querySelector('.titem[data-id=t1234] [data-opt]')===null"),true);
 // Compact project cards intentionally omit inline answer buttons; legacy answers remain in detail.
 await page.eval("openTask('t1234')");
 const content=await page.eval("document.querySelector('#detail').textContent");for(const s of ['human_approval','模板','worktree','human','diff 范围',sha,base,fixture.lifecycle.review.summary.split('\n')[0],'等待项目 CI 发布'])assert.ok(content.includes(s),s);
 assert.equal(await page.eval("!document.querySelector('#tmsg')&&!document.querySelector('#detail [data-opt]')"),true);
 await page.eval("act('t1234','answer','批准')");assert.equal(posts.length,0);
 await page.eval("document.querySelector('[data-lifecycle=changes]').onclick()");assert.equal(posts.length,0);assert.match(await page.eval("document.querySelector('[data-lifecycle-error]').textContent"),/填写修改意见/);
 await page.eval("document.querySelector('#tchanges').value='修复权限边界';document.querySelector('[data-lifecycle=changes]').onclick()");assert.deepEqual(posts.pop(),{path:'/api/tasks/t1234/changes',body:{text:'修复权限边界'}});
 await page.eval("document.querySelector('[data-lifecycle=approve]').onclick()");assert.deepEqual(posts.pop(),{path:'/api/tasks/t1234/approve',body:{sha}});
 failure=true;await page.eval("document.querySelector('#tchanges').value='保留未发送意见';document.querySelector('[data-lifecycle=changes]').onclick()");failure=false;posts=[];
 assert.equal(await page.eval("document.querySelector('#tchanges').value"),'保留未发送意见');assert.match(await page.eval("document.querySelector('[data-lifecycle-error]').textContent"),/HEAD changed/);
 await page.eval(`tasks.set('t1234',{...tasks.get('t1234'),lifecycle:{...tasks.get('t1234').lifecycle,head:'${next}',review:{...tasks.get('t1234').lifecycle.review,sha:'${next}'}}});document.querySelector('[data-lifecycle=approve]').onclick()`);
 assert.equal(posts.length,0);assert.match(await page.eval("document.querySelector('[data-lifecycle-error]').textContent"),/已变化/);
 for(const phase of ['preparing','developing','quiescing','reviewing','changes_requested','integrating','cleanup','complete','blocked']){
  task=structuredClone(fixture);task.lifecycle.phase=phase;task.lifecycle.error=phase==='blocked'?'冲突：保留全部改动':undefined;
  await page.eval("openTask('t1234')");assert.equal(await page.eval("document.querySelector('[data-lifecycle=approve]')===null"),true);
  if(phase==='blocked')assert.ok((await page.eval("document.querySelector('.lifecycle').textContent")).includes('冲突：保留全部改动'));
 }
 task=structuredClone(fixture);task.lifecycle.review.sha=next;await page.eval("openTask('t1234')");assert.equal(await page.eval("document.querySelector('[data-lifecycle=approve]').disabled"),true);
 task=structuredClone(fixture);delete task.lifecycle.head;await page.eval("openTask('t1234')");assert.equal(await page.eval("document.querySelector('[data-lifecycle=approve]').disabled"),true);
 await page.eval("openTask('t0001')");assert.equal(await page.eval("!!document.querySelector('#tmsg')&&!!document.querySelector('#detail [data-opt]')&&!document.querySelector('.lifecycle')"),true);
 task=structuredClone(fixture);await page.eval("document.querySelector('#toasts').replaceChildren()");
 for(const width of [1440,768,390]){
  await page.setViewport({width,height:width===768?1024:900});await page.eval("openTask('t1234')");
  const overflow=await page.eval("({page:document.documentElement.scrollWidth>innerWidth,detail:document.querySelector('.dbody').scrollWidth>document.querySelector('.dbody').clientWidth})");console.log('viewport',width,overflow);assert.equal(overflow.detail,false);if(overflow.page)console.log(await page.eval("[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>innerWidth+1}).slice(0,12).map(e=>({tag:e.tagName,id:e.id,cls:e.className,right:e.getBoundingClientRect().right}))"));
  await page.screenshot({path:'/tmp/tb711-lifecycle-'+width+'.png',format:'png'});
  await page.eval("document.querySelector('[data-lifecycle=approve]').scrollIntoView({block:'center'})");
  await page.screenshot({path:'/tmp/tb711-lifecycle-actions-'+width+'.png',format:'png'});
 }
 assert.deepEqual(page.consoleErrors,[]);
 // The legacy mobile task-search overflow is tested independently of lifecycle detail.
 console.log('UI: stable creation ordering, legacy answers, lifecycle rendering, exact-SHA approval, stale-head guard, conflicts, change drafts, and 1440/768/390 no-overflow checks passed');
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});}
