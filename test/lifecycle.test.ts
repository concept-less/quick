import {test} from "node:test";
import {createServer} from "node:http";
import {createIntegrationLocks} from "../hub/integration-locks.ts";
import {holderOf} from "../shared/team.ts";
import assert from "node:assert/strict";
import {mkdtemp, mkdir,writeFile,readFile,rm,access} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createLifecycle,helperEnv,type ReviewResult} from "../hub/lifecycle.ts";
import {chooseLifecycle} from "../shared/lifecycle.ts";
import {attentionOf} from "../shared/attention.ts";
import type {Task} from "../shared/types.ts";
const exec=promisify(execFile);
const git=async(cwd:string,...args:string[]) => (await exec("git",["-C",cwd,...args],{env:{...helperEnv(),GIT_CONFIG_NOSYSTEM:"1"}})).stdout.trim();
export async function fixture(t:any, verdicts:ReviewResult[]=[{verdict:"approve",summary:"行为是新增样式；无资金数据权限影响；测试通过；可 revert 回滚"}]) {
 const root=await mkdtemp(join(tmpdir(),"qa-lifecycle-")); t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,"dev"),remote=join(root,"origin.git"); await mkdir(repo);
 await exec("git",["init","--bare",remote],{env:helperEnv()});
 await git(repo,"init","-b","main"); await git(repo,"config","user.name","QA test");await git(repo,"config","user.email","qa@example.test");
 await writeFile(join(repo,"page.txt"),"original\n");await writeFile(join(repo,"other.txt"),"original\n");
 await git(repo,"add","page.txt","other.txt");await git(repo,"commit","-m","base");await git(repo,"remote","add","origin",remote);await git(repo,"push","-u","origin","main");
 const tasks=new Map<string,Task>();const resumes:string[]=[];let reviews=0;let active=false;
 const config={cwd:repo,test:[process.execPath,"-e","process.exit(0)"]};
 const ctl=createLifecycle({tasks,configs:()=>[config],worktreeRoot:join(root,"trees"),patch:(task,p)=>Object.assign(task,p),stop:async()=>{active=false;},workerActive:async()=>active,resume:async(_task,text)=>{resumes.push(text);active=true;},review:async()=>{reviews++;return verdicts.shift() ?? {verdict:"approve",summary:"通过"};}});
 const task=(id="t1234",title="调整布局"):Task=> {const x:Task={id,title,brief:title,cwd:repo,machine:"test",rev:0,status:"starting",createdAt:Date.now(),updatedAt:Date.now(),source:{kind:"api"},attachments:[],unread:false,messages:0};tasks.set(id,x);return x;};
 const commit=async(task:Task,text="new style\n")=>{await writeFile(join(task.cwd,"page.txt"),text);await git(task.cwd,"add","page.txt");await git(task.cwd,"commit","-m","task change");return git(task.cwd,"rev-parse","HEAD");};
 return {root,repo,remote,tasks,ctl,task,commit,resumes,config,get reviews(){return reviews;}};
}
test("human gate attention routes to the authorized reviewer rather than developer",()=>{
 const task={status:"needs_input",requester:"requester",assignee:"developer",reviewer:"reviewer",lifecycle:{phase:"human_approval"}} as Task;
 assert.equal(holderOf(task),"reviewer");
});

test("policy: project force > risk > complexity > explicit small frontend; non-code compatible",()=>{
 assert.equal(chooseLifecycle(undefined,"backend feature").template,"B");
 assert.equal(chooseLifecycle({kind:"code",risk:"low",complexity:"small_frontend"},"布局").template,"A");
 assert.equal(chooseLifecycle({kind:"code",risk:"low",complexity:"small_frontend"},"payment layout").template,"C");
 assert.equal(chooseLifecycle({kind:"code",risk:"low",complexity:"small_frontend"},"布局",{cwd:"/tmp",forceHuman:true}).template,"C");
 assert.equal(chooseLifecycle({kind:"read_only"},"read docs").workspace,"none");
});
test("A dev immediately visible; unrelated dirty stays uncommitted; no review; only integrated becomes done",async t=>{
 const f=await fixture(t);await writeFile(join(f.repo,"other.txt"),"someone else\n");const task=f.task();await f.ctl.prepare(task,{kind:"code",risk:"low",complexity:"small_frontend"});
 assert.equal(task.cwd,f.repo);assert.equal(task.lifecycle!.policy.template,"A");
 const sha=await f.commit(task);assert.equal(await readFile(join(f.repo,"page.txt"),"utf8"),"new style\n");
 await f.ctl.developed(task,"开发完成");assert.equal(task.status,"running");assert.equal(attentionOf(task).level,"inflight");
 await f.ctl.drive(task);assert.equal(task.status,"done");assert.equal(f.reviews,0);assert.equal(await git(f.repo,"rev-parse","origin/main"),sha);
 assert.equal(await readFile(join(f.repo,"other.txt"),"utf8"),"someone else\n");assert.equal(await git(f.repo,"show","origin/main:other.txt"),"original");
});
test("B request changes returns original workspace, new SHA reviewed, only push+cleanup becomes done",async t=>{
 const f=await fixture(t,[{verdict:"changes_requested",summary:"补充边界"},{verdict:"approve",summary:"已修复边界并验证"}]);const task=f.task();await f.ctl.prepare(task,{kind:"code"});const cwd=task.cwd;
 assert.notEqual(cwd,f.repo);const sha1=await f.commit(task);await f.ctl.developed(task,"开发完成");await f.ctl.drive(task);
 assert.equal(task.lifecycle!.phase,"developing");assert.equal(task.cwd,cwd);assert.equal(f.resumes.length,1);assert.notEqual(await git(f.repo,"rev-parse","origin/main"),sha1);
 const sha2=await f.commit(task,"fixed\n");await f.ctl.developed(task,"修复完成");await f.ctl.drive(task);
 assert.equal(task.lifecycle!.review!.sha,sha2);assert.equal(task.status,"done");assert.equal(f.reviews,2);await assert.rejects(access(cwd));assert.equal(await git(f.repo,"rev-parse","HEAD"),sha2);
});
test("C no merge before explicit SHA authorization, stale SHA rejected",async t=>{
 const f=await fixture(t);const task=f.task("t1234","payment change");await f.ctl.prepare(task,{kind:"code"});const base=await git(f.repo,"rev-parse","HEAD");const sha=await f.commit(task);await f.ctl.developed(task,"开发完成");await f.ctl.drive(task);
 assert.equal(task.lifecycle!.phase,"human_approval");assert.equal(task.status,"needs_input");assert.equal(await git(f.repo,"rev-parse","origin/main"),base);
 await assert.rejects(f.ctl.approve(task,base,"owner"));assert.equal(await git(f.repo,"rev-parse","origin/main"),base);
 await f.ctl.approve(task,sha,"owner");for(let i=0;i<1500&&task.status!=="done";i++) await new Promise(r=>setTimeout(r,30));assert.equal(task.status,"done");
});
test("scope: changed critical paths upgrade B to human gate",async t=>{
 const f=await fixture(t);const task=f.task();await f.ctl.prepare(task,{kind:"code"});await writeFile(join(task.cwd,"billing.txt"),"danger\n");await git(task.cwd,"add","billing.txt");await git(task.cwd,"commit","-m","billing");await f.ctl.developed(task,"扩展");await f.ctl.drive(task);assert.equal(task.lifecycle!.policy.template,"C");assert.equal(task.lifecycle!.phase,"human_approval");
});
test("concurrent direct task upgrades to isolated B, first dev directory retained",async t=>{
 const f=await fixture(t);const a=f.task("taaaa"),b=f.task("tbbbb");await Promise.all([f.ctl.prepare(a,{kind:"code",risk:"low",complexity:"small_frontend"}),f.ctl.prepare(b,{kind:"code",risk:"low",complexity:"small_frontend"})]);
 assert.equal([a,b].filter(x=>x.lifecycle!.policy.template==="A").length,1);assert.equal([a,b].filter(x=>x.lifecycle!.policy.template==="B").length,1);
});
test("missing integration tests fail closed and preserve tree; retry picks up config",async t=>{
 const f=await fixture(t);const task=f.task();f.config.test=[];await f.ctl.prepare(task,{kind:"code"});const cwd=task.cwd;await f.commit(task);await f.ctl.developed(task,"done");await f.ctl.drive(task);assert.equal(task.status,"blocked");await access(cwd);f.config.test=[process.execPath,"-e","process.exit(0)"];assert.equal(await f.ctl.retry(task),true);for(let i=0;i<1500&&task.status!=="done";i++) await new Promise(r=>setTimeout(r,30));assert.equal(task.status,"done");
});
test("cancelled tasks keep changes; helper processes never inherit QA task identity",async t=>{
 const f=await fixture(t);const task=f.task();await f.ctl.prepare(task,{kind:"code"});await f.commit(task);task.status="cancelled";await f.ctl.drive(task);await access(task.cwd);const original=process.env.QA_TASK_ID;process.env.QA_TASK_ID="real-worker";try{assert.equal(helperEnv().QA_TASK_ID,undefined);}finally{if(original)process.env.QA_TASK_ID=original;else delete process.env.QA_TASK_ID;}
});
test("non-git and legacy tasks do not get cwd migrations or managed done interception",async t=>{
 const f=await fixture(t);const legacy=f.task();assert.equal(await f.ctl.developed(legacy,"done"),false);legacy.cwd=f.root;await f.ctl.prepare(legacy,{kind:"read_only"});assert.equal(legacy.cwd,f.root);assert.equal(legacy.lifecycle!.policy.workspace,"none");assert.equal(await f.ctl.developed(legacy,"done"),false);
});

test("PR chain: CI waiting, strict CI, lost merge response and verified cleanup",async t=>{
 const f=await fixture(t);const task=f.task();let pr:any;let ci="pending",creates=0,merges=0;
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,"http://127.0.0.1");let body="";for await(const c of req)body+=c;
  const reply=(data:any,status=200)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(data));};
  if(url.pathname.endsWith("required_status_checks"))return reply({strict:true,contexts:["test"],checks:[]});
  if(url.pathname.endsWith("/pulls") && req.method==="GET")return reply(pr && !pr.merged ? [pr] : []);
  if(url.pathname.endsWith("/pulls") && req.method==="POST") {creates++;const input=JSON.parse(body);const sha=await git(f.repo,"rev-parse",task.lifecycle!.workspace!.branch);pr={number:3,html_url:"https://github.com/acme/test/pull/3",state:"open",merged:false,head:{sha,ref:input.head,label:`acme:${input.head}`,repo:{full_name:"acme/test"}},base:{ref:"main",repo:{full_name:"acme/test"}},draft:false,mergeable:true,mergeable_state:"clean"};return reply(pr,201);}
  if(url.pathname.endsWith("/pulls/3"))return reply(pr);
  if(url.pathname.endsWith("/status"))return reply({sha:pr.head.sha,state:ci,total_count:1,statuses:[{context:"test",state:ci}]});
  if(url.pathname.endsWith("/check-runs"))return reply({total_count:0,check_runs:[]});
  if(url.pathname.endsWith("/pulls/3/merge")) {merges++;assert.equal(JSON.parse(body).sha,pr.head.sha);await git(f.remote,"update-ref","refs/heads/main",pr.head.sha);pr.merged=true;pr.state="closed";pr.merge_commit_sha=pr.head.sha;return res.destroy();}
  return reply({},404);
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
 Object.assign(f.config,{integration:"pr",githubRepo:"acme/test",githubApi:`http://127.0.0.1:${(server.address() as any).port}`,baseBranch:"main"});
 await f.ctl.prepare(task,{kind:"code"});const cwd=task.cwd;const sha=await f.commit(task);await f.ctl.developed(task,"done");await f.ctl.drive(task);
 assert.equal(task.lifecycle!.phase,"ci");assert.equal(task.status,"running");assert.equal(creates,1);assert.equal(merges,0);
 await f.ctl.drive(task);assert.equal(task.lifecycle!.phase,"ci");assert.equal(creates,1);assert.equal(merges,0);ci="success";await f.ctl.drive(task);
 assert.equal(task.status,"done");assert.equal(merges,1);assert.equal(await git(f.repo,"rev-parse","HEAD"),sha);await assert.rejects(access(cwd));
});

test("coordinator lease: cross-client serialization, owner-idempotency and restart recovery without expiry",async t=>{
 const f=await fixture(t),dir=join(f.root,"locks");const a=createIntegrationLocks(dir),b=createIntegrationLocks(dir);
 assert.equal(await a.acquire("repo/main","cloud/taaaa"),true);assert.equal(await b.acquire("repo/main","mac/tbbbb"),false);
 assert.equal(await createIntegrationLocks(dir).acquire("repo/main","cloud/taaaa"),true);
 await assert.rejects(b.release("repo/main","mac/tbbbb"));await a.release("repo/main","cloud/taaaa");assert.equal(await b.acquire("repo/main","mac/tbbbb"),true);await b.release("repo/main","mac/tbbbb");
 const results=await Promise.all([a.acquire("repo/main","cloud/tcccc"),b.acquire("repo/main","mac/tdddd")]);assert.equal(results.filter(Boolean).length,1);
});

test("dirty dev after B push retains worktree until safe sync; retry only cleanup",async t=>{
 const f=await fixture(t);const task=f.task();await f.ctl.prepare(task,{kind:"code"});const cwd=task.cwd;const sha=await f.commit(task);await writeFile(join(f.repo,"other.txt"),"foreign\n");await f.ctl.developed(task,"done");await f.ctl.drive(task);
 assert.equal(task.status,"blocked");assert.equal(task.lifecycle!.retryPhase,"cleanup");assert.equal(await git(f.repo,"rev-parse","origin/main"),sha);await access(cwd);
 await assert.rejects(f.ctl.requestChanges(task,"restart development"),/先重试/);
 await writeFile(join(f.repo,"other.txt"),"original\n");await f.ctl.retry(task);for(let i=0;i<1500&&task.status!=="done";i++)await new Promise(r=>setTimeout(r,30));assert.equal(task.status,"done");assert.equal(f.reviews,1);await assert.rejects(access(cwd));
});

test("completed task follow-up allocates new iteration instead of removed cwd",async t=>{
 const f=await fixture(t);const task=f.task();await f.ctl.prepare(task,{kind:"code"});const first=task.cwd;await f.commit(task);await f.ctl.developed(task,"done");await f.ctl.drive(task);assert.equal(task.status,"done");task.sessionFile="/tmp/obsolete-session";await f.ctl.reopen(task);assert.equal(task.sessionFile,undefined);assert.notEqual(task.cwd,first);await access(task.cwd);assert.equal(task.lifecycle!.phase,"developing");assert.equal(task.lifecycle!.review,undefined);
});

test("review snapshot ignores replacement refs",async t=>{
 const f=await fixture(t);const task=f.task();await f.ctl.prepare(task,{kind:"code"});const sha=await f.commit(task);await git(f.repo,"replace",sha,task.lifecycle!.workspace!.baseSha);await f.ctl.developed(task,"done");await f.ctl.drive(task);assert.equal(task.status,"done");assert.equal(f.reviews,1);assert.equal(await git(f.repo,"--no-replace-objects","show","HEAD:page.txt"),"new style");
});
