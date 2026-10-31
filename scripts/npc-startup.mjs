// Local isolated server readiness only. Never activates a client or starts Skyrim.
import fs from'node:fs/promises';import path from'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';
const exec=promisify(execFile);
export async function readRunningServer({root,audit,profileHash,catalogHash}){
 const read=async(file,max)=>{const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>max)throw Error('Unsafe startup receipt');return JSON.parse(await fs.readFile(file,'utf8'));};
 const health=await read(path.join(root,'g241d-status.json'),8192);
 if(health.status!=='SAFE_WAITING'||health.profileHash!==profileHash||health.catalogHash!==catalogHash||!health.startupId||!Number.isSafeInteger(health.pid)||health.pid<=0||health.customAutoSpawns!==0)throw Error('Running development server identity does not match the sealed handoff');
 const names=(await fs.readdir(audit)).filter(n=>/^readiness-\d+-\d+\.json$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])).slice(0,200);
 for(const name of names){const receipt=await read(path.join(audit,name),256*1024),expected=receipt.expected;if(receipt.last?.ok!==true||receipt.last?.stage!=='READY'||expected?.startupId!==health.startupId||expected.profileHash!==profileHash||expected.catalogHash!==catalogHash)continue;
  if(!Number.isSafeInteger(expected.childPid)||expected.childPid<=0||Number(name.split('-')[2].slice(0,-5))!==expected.childPid)throw Error('Invalid verified startup receipt');
  return{...expected,launchedAt:expected.launchedAt??receipt.startedAt};
 }
 throw Error('No verified startup receipt for this development server; stop only its console and use activate-and-play');
}
export async function startIsolatedPowerShell({root,startScript,startupId,logs}){
 const shell=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const report={stage:'POWERSHELL_CREATE',at:new Date().toISOString(),root,startScript};await fs.mkdir(path.dirname(logs),{recursive:true});await fs.writeFile(logs,JSON.stringify(report,null,2));
 // Node's detached CREATE_NEW_CONSOLE path can exit PowerShell 5.1 before -File
 // executes. Use the same Windows Start-Process mechanism as local deployments.
 const command=`$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:FV_NPC_SHELL -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$env:FV_NPC_START_SCRIPT+'"')) -WorkingDirectory $env:FV_NPC_ROOT -WindowStyle Normal -PassThru; @{pid=[int]$p.Id} | ConvertTo-Json -Compress`;
 try{const{stdout,stderr}=await exec(shell,['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,FV_NPC_SHELL:shell,FV_NPC_START_SCRIPT:startScript,FV_NPC_ROOT:root,FROSTVEIL_G241D_STARTUP_ID:startupId},windowsHide:true,timeout:15000,maxBuffer:65536});
  await fs.writeFile(logs+'.stdout.log',stdout);await fs.writeFile(logs+'.stderr.log',stderr);const child=JSON.parse(stdout.trim());if(!Number.isSafeInteger(child.pid)||child.pid<=0)throw Error('Start-Process did not return a valid PID');
  await fs.writeFile(logs,JSON.stringify({...report,stage:'POWERSHELL_CREATED',pid:child.pid},null,2));return {...child,launchedAt:report.at};
 }catch(error){await fs.writeFile(logs+'.stdout.log',error.stdout??'');await fs.writeFile(logs+'.stderr.log',error.stderr??error.stack??String(error));await fs.writeFile(logs,JSON.stringify({...report,stage:'PROCESS_CREATION_FAILED',code:error.code??error.name},null,2));throw Error(`Isolated startup failed at PROCESS_CREATION. Diagnostics: ${logs}`,{cause:error});}
}
async function inspectChild({expected,startScript,signal}){
 const shell=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const{stdout}=await exec(shell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:FV_NPC_CHILD_PID);if($p){@{pid=[int]$p.ProcessId;name=$p.Name;startMatches=$p.CommandLine.Contains($env:FV_NPC_START_SCRIPT)}|ConvertTo-Json -Compress}else{'null'}"],{env:{...process.env,FV_NPC_CHILD_PID:String(expected.childPid),FV_NPC_START_SCRIPT:startScript},windowsHide:true,timeout:5000,signal,maxBuffer:65536});return JSON.parse(stdout.trim());
}
export function evaluateStartup({health,httpStatus,snapshot,expected}){
 const fail=(stage,wanted,observed)=>({ok:false,stage,expected:wanted,observed});
 if(httpStatus!==200||!health||health.status!=='SAFE_WAITING'||!expected.startupId||health.startupId!==expected.startupId||health.catalogHash!==expected.catalogHash||health.profileHash!==expected.profileHash||!Number.isSafeInteger(health.pid)||health.pid<=0||health.customAutoSpawns!==0)return fail('HEALTH_CONTRACT','HTTP 200; SAFE_WAITING; matching startup/profile/catalog; live PID; zero auto-spawns',{httpStatus,status:health?.status,pid:health?.pid,catalogHash:health?.catalogHash,profileHash:health?.profileHash,customAutoSpawns:health?.customAutoSpawns,startupId:health?.startupId});
 const{child,process:p,parent,udp,tcp}=snapshot??{};
 if(!child||child.pid!==expected.childPid||child.name?.toLowerCase()!=='powershell.exe'||child.startMatches!==true)return fail('PROCESS_CREATION','owned PowerShell startup process',child??null);
 if(!p||p.pid!==health.pid||p.name?.toLowerCase()!=='node.exe'||p.engineMatches!==true||!parent||parent.pid!==p.parent||parent.parent!==child.pid||parent.name?.toLowerCase()!=='node.exe'||parent.serveMatches!==true)return fail('PROCESS_OWNERSHIP','owned PowerShell → sealed Node supervisor → exact Node engine',{process:p??null,parent:parent??null});
 for(const[stage,rows]of[['UDP_17777',udp],['TCP_17778',tcp]])if(!rows?.length||rows.some(r=>r.pid!==p.pid||r.address!=='127.0.0.1'))return fail(stage,'only the verified engine owns the loopback listener',rows??[]);
 return{ok:true,stage:'READY',expected:'all startup gates passed',observed:{pid:p.pid,supervisorPid:parent.pid,childPid:child.pid,udp,tcp}};
}
export async function inspectProcess({pid,expected,root,startScript,serveScript,signal}){
 const powershell=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const command=`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:FV_NPC_SERVER_PID); $a=if($p){Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId)}; $c=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:FV_NPC_CHILD_PID); $u=@(Get-NetUDPEndpoint -LocalPort 17777 -ErrorAction SilentlyContinue | ForEach-Object {@{pid=[int]$_.OwningProcess;address=$_.LocalAddress}}); $t=@(Get-NetTCPConnection -LocalPort 17778 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {@{pid=[int]$_.OwningProcess;address=$_.LocalAddress}}); @{child=$(if($c){@{pid=[int]$c.ProcessId;name=$c.Name;startMatches=$c.CommandLine.Contains($env:FV_NPC_START_SCRIPT)}}else{$null});process=$(if($p){@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;name=$p.Name;engineMatches=$p.CommandLine.Contains($env:FV_NPC_ENGINE)}}else{$null});parent=$(if($a){@{pid=[int]$a.ProcessId;parent=[int]$a.ParentProcessId;name=$a.Name;serveMatches=$a.CommandLine.Contains($env:FV_NPC_SERVE_SCRIPT)}}else{$null});udp=$u;tcp=$t} | ConvertTo-Json -Depth 5 -Compress`;
 const{stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,FV_NPC_SERVER_PID:String(pid),FV_NPC_CHILD_PID:String(expected.childPid),FV_NPC_ENGINE:path.join(root,'dist_back/skymp5-server.js'),FV_NPC_START_SCRIPT:startScript,FV_NPC_SERVE_SCRIPT:serveScript},windowsHide:true,timeout:15000,signal,maxBuffer:65536});
 return JSON.parse(stdout.trim());
}
async function serverFailure(logs,since){
 try{const directory=path.dirname(logs),names=(await fs.readdir(directory)).filter(n=>/^startup-\d+-\d+$/.test(n)&&Number(n.split('-')[1])>=since).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]));
  for(const name of names){const folder=path.join(directory,name),file=path.join(folder,'stages.jsonl');if((await fs.stat(file)).size>65536)continue;const lines=(await fs.readFile(file,'utf8')).trim().split('\n'),last=JSON.parse(lines.at(-1));if(!['FAILED','EXIT_FAILED'].includes(last.state))continue;let exit;try{exit=JSON.parse(await fs.readFile(path.join(folder,'exit.json'),'utf8'));}catch{}return{ok:false,stage:exit?.lastStage?.stage??last.stage,expected:'sealed isolated runtime remains running and becomes ready',observed:{state:last.state,pid:last.pid,exitCode:exit?.code,diagnosticDirectory:folder}};}
 }catch{}return null;
}
export async function waitForStartup({expected,root,startScript,serveScript,logs,rejoin=false,timeoutMs=60000,now=()=>performance.now(),sleep=n=>new Promise(r=>setTimeout(r,n)),poll,save,failure,checkChild}){
 const started=now(),report={startedAt:new Date().toISOString(),expected:{...expected,udp:17777,tcp:17778},logs,attempts:0,history:[]};
 const persist=save??(async value=>{await fs.mkdir(path.dirname(logs),{recursive:true});await fs.writeFile(logs,JSON.stringify(value,null,2));});
 while(now()-started<timeoutMs){
  report.attempts++;const remaining=timeoutMs-(now()-started);
  try{
   let observed;
   if(poll)observed=await poll();else{
    const response=await fetch('http://127.0.0.1:17778/g241d-health.json',{signal:AbortSignal.timeout(Math.max(1,Math.min(1000,Math.floor(remaining)))),redirect:'error',cache:'no-store'});
    const text=await response.text();if(text.length>8192)throw Object.assign(Error('Health response exceeds 8192 bytes'),{code:'HEALTH_SIZE'});
    const health=JSON.parse(text),preflight=evaluateStartup({health,httpStatus:response.status,expected});
    const snapshot=preflight.stage==='PROCESS_CREATION'?await inspectProcess({pid:health.pid,expected,root,startScript,serveScript,signal:AbortSignal.timeout(Math.max(1,Math.floor(timeoutMs-(now()-started))))}):undefined;
    observed={health,httpStatus:response.status,snapshot};
   }
   report.last=evaluateStartup({...observed,expected});
  }catch(error){report.last={ok:false,stage:'HEALTH_HTTP',expected:'readable bounded JSON health response and process inventory',observed:{code:error.code??error.cause?.code??error.name}};}
  let fatal=report.last.ok?null:await(failure?failure():serverFailure(logs,Date.parse(expected.launchedAt??report.startedAt)));if(fatal)report.last=fatal;
  if(!fatal&&!report.last.ok&&(!poll||checkChild)){try{const child=await(checkChild?checkChild():inspectChild({expected,startScript,signal:AbortSignal.timeout(Math.max(1,Math.floor(timeoutMs-(now()-started))))}));if(!child||child.pid!==expected.childPid||child.name?.toLowerCase()!=='powershell.exe'||!child.startMatches){
   // The engine/supervisor can write its terminal record while CIM is reading
   // the outer process. Re-read it before labelling an actual native exit as
   // failure to create PowerShell. All successful readiness gates are unchanged.
   fatal=report.last=await(failure?failure():serverFailure(logs,Date.parse(expected.launchedAt??report.startedAt)))??{ok:false,stage:rejoin?'SERVER_NOT_RUNNING':'PROCESS_CREATION',expected:rejoin?'previously verified isolated console is still running; start the isolated server before play':'owned PowerShell remains alive and executes the sealed startup script',observed:{childPid:expected.childPid,process:child??null}};
  }}catch(error){report.last={ok:false,stage:'PROCESS_INVENTORY',expected:'readable startup process inventory',observed:{code:error.code??error.name}};}}
  report.elapsedMs=Math.round(now()-started);report.history.push({atMs:report.elapsedMs,...report.last});await persist(report);
  if(report.last.ok&&now()-started<=timeoutMs)return report;
  if(fatal)break;
  await sleep(Math.max(0,Math.min(500,timeoutMs-(now()-started))));
 }
 report.elapsedMs=Math.round(now()-started);await persist(report);
 throw Error(`Isolated startup failed at ${report.last?.stage??'PROCESS_CREATION'} after ${report.elapsedMs}ms. Expected: ${JSON.stringify(report.last?.expected)}. Observed: ${JSON.stringify(report.last?.observed)}. Diagnostics: ${logs}; server stdout/stderr: ${path.dirname(logs)}/startup-*/. No game launched.`);
}
