// Durable, no-expiry coordinator. A network partition must stop integration, never steal a lease.
import {mkdir,open,readFile,unlink} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
export function createIntegrationLocks(root:string) {
 const path=(key:string)=>join(root,`${createHash("sha256").update(key).digest("hex")}.json`);
 const valid=(key:string,holder:string)=>{if(!key || key.length>4096 || !/^[\w.-]+\/[\w-]+$/.test(holder))throw new Error("Invalid integration lock identity");};
 // Serialize async read/unlink/acquire so release cannot unlink a successor's lock.
 let queue=Promise.resolve();
 const serialized=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.then(fn,fn);queue=next.then(()=>{},()=>{});return next;};
 return {
  acquire:(key:string,holder:string)=>serialized(async()=>{
   valid(key,holder);await mkdir(root,{recursive:true});
   try { const file=await open(path(key),"wx",0o600);try{await file.writeFile(JSON.stringify({key,holder,at:Date.now()}));await file.sync();}finally{await file.close();}return true; }
   catch(e:any){if(e.code!=="EEXIST")throw e;const saved=JSON.parse(await readFile(path(key),"utf8"));return saved.key===key && saved.holder===holder;}
  }),
  release:(key:string,holder:string)=>serialized(async()=>{
   valid(key,holder);
   let saved:any;try{saved=JSON.parse(await readFile(path(key),"utf8"));}catch(e:any){if(e.code==="ENOENT")return;throw e;}
   if(saved.key!==key || saved.holder!==holder)throw new Error("Integration lock is owned by another task");await unlink(path(key));
  }),
 };
}
