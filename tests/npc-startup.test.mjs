import{test}from'node:test';import assert from'node:assert/strict';
import fs from'node:fs/promises';import path from'node:path';import os from'node:os';
import{evaluateStartup,waitForStartup,startIsolatedPowerShell,readRunningServer}from'../scripts/npc-startup.mjs';
const expected={childPid:10,startupId:'this-boot',profileHash:'p',catalogHash:'c'};
const health={status:'SAFE_WAITING',startupId:'this-boot',pid:30,profileHash:'p',catalogHash:'c',customAutoSpawns:0};
const snapshot={child:{pid:10,name:'powershell.exe',startMatches:true},process:{pid:30,parent:20,name:'node.exe',engineMatches:true},parent:{pid:20,parent:10,name:'node.exe',serveMatches:true},udp:[{pid:30,address:'127.0.0.1'}],tcp:[{pid:30,address:'127.0.0.1'}]};
test('all health, parent identity and port ownership gates are mandatory',()=>{
 assert.equal(evaluateStartup({health,httpStatus:200,snapshot,expected}).ok,true);
 const failures=[['HEALTH_CONTRACT',v=>v.health.startupId='stale-boot'],['HEALTH_CONTRACT',v=>v.health.status='DIAGNOSTIC_ONLY_PROFILE_INACTIVE'],['HEALTH_CONTRACT',v=>v.health.catalogHash='wrong'],['HEALTH_CONTRACT',v=>v.health.profileHash='wrong'],['HEALTH_CONTRACT',v=>v.health.customAutoSpawns=1],['PROCESS_CREATION',v=>v.snapshot.child=null],['PROCESS_OWNERSHIP',v=>v.snapshot.parent.parent=99],['PROCESS_OWNERSHIP',v=>v.snapshot.parent.serveMatches=false],['PROCESS_OWNERSHIP',v=>v.snapshot.process.engineMatches=false],['UDP_17777',v=>v.snapshot.udp=[]],['TCP_17778',v=>v.snapshot.tcp=[{pid:99,address:'127.0.0.1'}]],['TCP_17778',v=>v.snapshot.tcp.push({pid:99,address:'127.0.0.1'})]];
 for(const[stage,mutate]of failures){const v=structuredClone({health,httpStatus:200,snapshot,expected});mutate(v);assert.equal(evaluateStartup(v).stage,stage);}
});
test('readiness retries are bounded and report last exact failure with diagnostic location',async()=>{
 let time=0,attempts=0,saved;
 await assert.rejects(waitForStartup({expected,root:'root',startScript:'start',serveScript:'serve',logs:'diagnostics',timeoutMs:1000,now:()=>time,sleep:async n=>{time+=n;},poll:async()=>{attempts++;return{health,httpStatus:200,snapshot:{...snapshot,tcp:[]}};},save:async v=>{saved=v;}}),e=>e.message.includes('TCP_17778')&&e.message.includes('diagnostics'));
 assert.equal(attempts,2);assert.equal(saved.last.stage,'TCP_17778');assert(saved.elapsedMs<=1000);
});
test('transient health failure can recover without accepting stale process ancestry',async()=>{
 let time=0,attempts=0;
 const r=await waitForStartup({expected,root:'root',logs:'diagnostics',timeoutMs:2000,now:()=>time,sleep:async n=>{time+=n;},poll:async()=>{if(++attempts===1)throw Object.assign(Error('ECONNREFUSED'),{code:'ECONNREFUSED'});return{health,httpStatus:200,snapshot};},save:async()=>{}});
 assert.equal(r.last.ok,true);assert.equal(r.attempts,2);assert.equal(r.history[0].stage,'HEALTH_HTTP');
});

test('native exit diagnostics stop retries and identify the failed stage',async()=>{let saved;await assert.rejects(waitForStartup({expected,root:'root',logs:'diagnostics',poll:async()=>{throw Error('refused');},failure:async()=>({ok:false,stage:'ENGINE_PROCESS',expected:'running',observed:{exitCode:1,diagnosticDirectory:'startup-logs'}}),save:async r=>{saved=r;}}),/ENGINE_PROCESS/);assert.equal(saved.attempts,1);assert.equal(saved.last.observed.exitCode,1);});
test('terminal engine record published during process inventory wins over a stale process-creation diagnosis',async()=>{let reads=0,saved;await assert.rejects(waitForStartup({expected,root:'root',logs:'diagnostics',poll:async()=>{throw Error('refused');},failure:async()=>++reads===1?null:{ok:false,stage:'PLUGIN_IDENTITY',observed:{exitCode:1}},checkChild:async()=>null,save:async r=>{saved=r;}}),/PLUGIN_IDENTITY/);assert.equal(saved.attempts,1);assert.equal(reads,2);assert.equal(saved.last.observed.exitCode,1);});
test('real retained supervisor files identify the last native startup stage',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'g241d-readiness-'));let saved;
 try{await assert.rejects(waitForStartup({expected,root:'root',logs:path.join(root,'readiness.json'),poll:async()=>{const folder=path.join(root,'startup-'+Date.now()+'-20');await fs.mkdir(folder);await fs.writeFile(path.join(folder,'stages.jsonl'),JSON.stringify({stage:'ENGINE_PROCESS',state:'EXIT_FAILED',pid:20})+'\n');await fs.writeFile(path.join(folder,'exit.json'),JSON.stringify({code:1,lastStage:{stage:'RESOURCE_CATALOG',state:'FAILED'}}));throw Error('refused');},save:async r=>{saved=r;}}),/RESOURCE_CATALOG/);assert.equal(saved.attempts,1);assert.equal(saved.last.observed.exitCode,1);
 }finally{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('g241d-readiness-'));await fs.rm(root,{recursive:true});}
});
test('real Windows owner launch executes the script in a separate PowerShell console without detached Node spawn',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'g241d-outer-launch-'));
 try{const marker=path.join(root,'executed.txt'),script=path.join(root,'script with spaces.ps1');await fs.writeFile(script,`[IO.File]::WriteAllText('${marker.replaceAll("'","''")}',$env:FROSTVEIL_G241D_STARTUP_ID)\nexit 7\n`);
  const child=await startIsolatedPowerShell({root,startScript:script,startupId:'sentinel-test',logs:path.join(root,'launch.json')});assert(Number.isSafeInteger(child.pid)&&child.pid>0);
  const deadline=Date.now()+6000;while(Date.now()<deadline){try{if(await fs.readFile(marker,'utf8')==='sentinel-test')break;}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.equal(await fs.readFile(marker,'utf8'),'sentinel-test');const log=JSON.parse(await fs.readFile(path.join(root,'launch.json'),'utf8'));assert.equal(log.stage,'POWERSHELL_CREATED');assert.equal(log.pid,child.pid);
 }finally{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('g241d-outer-launch-'));await fs.rm(root,{recursive:true,maxRetries:5,retryDelay:100});}
});
test('a PowerShell that exits before executing the script fails at process creation without waiting sixty seconds',async()=>{
 let saved;await assert.rejects(waitForStartup({expected,root:'root',startScript:'start',logs:'diagnostics',poll:async()=>{throw Error('ECONNREFUSED');},checkChild:async()=>null,save:async r=>{saved=r;}}),/PROCESS_CREATION/);assert.equal(saved.attempts,1);assert.equal(saved.last.observed.childPid,10);
});
test('rejoin selects only a successful receipt matching the private server boot identity',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'g241d-rejoin-'));
 try{const audit=path.join(root,'audit');await fs.mkdir(audit);await fs.writeFile(path.join(root,'g241d-status.json'),JSON.stringify(health));
  await fs.writeFile(path.join(audit,'readiness-100-10.json'),JSON.stringify({expected,last:{ok:true,stage:'READY'},startedAt:new Date().toISOString()}));
  await fs.writeFile(path.join(audit,'readiness-200-99.json'),JSON.stringify({expected:{...expected,childPid:99,startupId:'stale'},last:{ok:true,stage:'READY'}}));
  const r=await readRunningServer({root,audit,profileHash:'p',catalogHash:'c'});assert.equal(r.childPid,10);assert.equal(r.startupId,health.startupId);
  await fs.writeFile(path.join(audit,'readiness-100-10.json'),JSON.stringify({expected,last:{ok:false,stage:'HEALTH_HTTP'}}));await assert.rejects(readRunningServer({root,audit,profileHash:'p',catalogHash:'c'}),/verified startup receipt/);
  await fs.writeFile(path.join(root,'g241d-status.json'),JSON.stringify({...health,profileHash:'foreign'}));await assert.rejects(readRunningServer({root,audit,profileHash:'p',catalogHash:'c'}),/identity/);
 }finally{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('g241d-rejoin-'));await fs.rm(root,{recursive:true});}
});
