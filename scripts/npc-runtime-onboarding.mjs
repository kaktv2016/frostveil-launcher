// Deliberate owner operation only. No browser endpoint, asset installation,
// public release, Skyrim launch or production process control.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),hash=b=>createHash('sha256').update(b).digest('hex');
export async function withRuntimeLease(root,action){
 const file=path.join(root,'runtime-activation.lock');let handle;try{handle=await fs.open(file,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('Another runtime operation is active or interrupted; use explicit runtime-recover after it exits');throw error;}
 const own=await handle.stat();try{await handle.writeFile(JSON.stringify({pid:process.pid,scope:'g246-runtime-activation',createdAt:new Date().toISOString()}));await handle.sync();return await action();}finally{await handle.close();const current=await fs.lstat(file);if(current.isSymbolicLink()||current.nlink!==1||current.ino!==own.ino||current.dev!==own.dev)throw Error('Runtime lease changed; retained for review');await fs.unlink(file);}
}
export function completedActivationEvidence(receipt,value){
 const expected=value?.expected,last=value?.readiness?.last,bound=value?.readiness?.expected;return !!(expected&&bound&&last?.ok===true&&last.stage==='READY'&&expected.startupId===bound.startupId&&expected.childPid===bound.childPid&&last.observed?.childPid===expected.childPid&&expected.profileHash===receipt.profileHash&&expected.catalogHash===receipt.catalogHash&&Date.parse(expected.launchedAt)>=Date.parse(receipt.createdAt));
}
export async function recoverPriorProfile(core,grant,policy,wasActive){const previous=await core.NpcDevelopmentProfile.open(grant,policy,core.gameRunning);await previous.revert(async()=>true);if(wasActive)await previous.ensureActive(async()=>true);}
export function verifyOwnedStartupReceipt(value,{root,startScript,notBefore}){
 const at=Date.parse(value?.at);if(value?.stage!=='POWERSHELL_CREATED'||value.root!==root||value.startScript!==startScript||!Number.isSafeInteger(value.pid)||value.pid<=0||!Number.isFinite(at)||at<notBefore||at>Date.now()+5000)throw Error('Startup receipt does not identify this activation attempt');return value.pid;
}
async function stopOwnFailedStartup(core,repo,root,startScript,notBefore){
 if(await core.gameRunning())throw Error('Skyrim is active; preserve startup/profile recovery without terminating its server');
 const file=path.join(repo,'build/rp-audit/g244/powershell-start.json');await core.noLinks(file);const st=await fs.lstat(file);if(!st.isFile()||st.nlink!==1||st.size>8192)throw Error('Unsafe startup receipt');const value=JSON.parse(await fs.readFile(file,'utf8'));
 // A failed attempt before Start-Process has no fresh receipt and owns no tree.
 if(Date.parse(value.at)<notBefore)return;
 const pid=verifyOwnedStartupReceipt(value,{root,startScript,notBefore}),shell=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 execFileSync(shell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:FV_RUNTIME_PID);if($p){if($p.Name -ne 'powershell.exe' -or !$p.CommandLine.Contains($env:FV_RUNTIME_SCRIPT) -or ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() -lt [long]$env:FV_RUNTIME_NOT_BEFORE){throw 'Failed startup process identity changed'};& taskkill.exe /PID $p.ProcessId /T /F | Out-Null;if($LASTEXITCODE -ne 0){throw 'Owned isolated cleanup failed'}}"],{windowsHide:true,timeout:15000,env:{...process.env,FV_RUNTIME_PID:String(pid),FV_RUNTIME_SCRIPT:startScript,FV_RUNTIME_NOT_BEFORE:String(notBefore)}});
}
export async function activateRuntime(options){if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Deliberate local owner terminal required');const root=options.handoff.isolatedRoot;require(path.join(options.repo,'rp-gamemode/scripts/g241-dev.cjs')).guard(root);require(path.join(options.repo,'rp-gamemode/research/g244/deployment.cjs')).idle(root);return withRuntimeLease(root,()=>activateRuntimeLocked(options));}
async function activateRuntimeLocked({core,grant,profile,handoff,serverConfig,repo,game}){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Deliberate local owner terminal required');
 const root=handoff.isolatedRoot,guard=require(path.join(repo,'rp-gamemode/scripts/g241-dev.cjs')).guard(root);if(guard.root!==root)throw Error('Isolated root identity changed');
 const idle=()=>require(path.join(repo,'rp-gamemode/research/g244/deployment.cjs')).idle(root);idle();
 for(const artifact of handoff.artifacts)if(hash(await fs.readFile(path.join(root,artifact.path)))!==artifact.sha256)throw Error('Runtime seal changed before onboarding');
 const audit=path.join(repo,'build/rp-audit/g246');await fs.mkdir(audit,{recursive:true});const log=path.join(audit,'activation-preflight.log');
 try{const output=execFileSync(process.execPath,[path.join(repo,'rp-gamemode/scripts/g246-preflight.cjs'),root],{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});await fs.writeFile(log,output);}catch(error){await fs.writeFile(log,String(error.stdout??'')+String(error.stderr??'')+String(error));throw Error('Native/catalog preflight failed; no profile changed. Diagnostics: '+log);}
 const next=JSON.parse(await fs.readFile(path.join(audit,'activation-preflight.json'),'utf8'));if(next.config.game!==game||JSON.stringify(next.config.policy.runtime)!==JSON.stringify(core.npcDevelopmentPolicy.runtime))throw Error('Unapproved runtime/installation expansion');next.config.metadataRoot=grant.metadata;
 for(const old of core.npcDevelopmentPolicy.assets){const got=next.config.policy.assets.find(a=>a.path===old.path);if(!got||got.sha256!==old.sha256||got.size!==old.size)throw Error('Existing approved NPC source would change');}
 for(const f of next.config.policy.assets){const actual=await core.hashFile(await core.safeFile(game,f.path),64*1024*1024);if(actual.sha256!==f.sha256||actual.size!==f.size)throw Error('Owned client asset missing/different: '+f.path+'. Prepare it through the reviewed development delivery workflow; no files copied.');}
 const digest=core.planDigest({planId:next.planId,policy:next.config.policy,serverOrder:next.settings.loadOrder}),rl=createInterface({input:process.stdin,output:process.stdout});
 let answer;try{console.log('LOCAL DEVELOPMENT CATALOG ACTIVATION\nTemplates: '+next.templates.map(t=>t.id).join(', ')+'\nPlugins: '+next.settings.loadOrder.map(f=>path.basename(f)).join(', ')+'\nChanges only the reviewed isolated server configuration and the two authenticated Launcher profile targets. No asset copy or actor spawn.\nPlan SHA256: '+digest);answer=await rl.question('Type CONFIRM to activate this development plan: ');}finally{rl.close();}if(answer!=='CONFIRM')throw Error('Runtime activation declined');idle();
 const previousActive=(await profile.status()).active,newProfile=await core.NpcDevelopmentProfile.open(grant,next.config.policy,core.gameRunning),handoffPath=path.join(repo,'build/rp-audit/g241d/owner-handoff.json');
 const {prepareConfiguration,applyPreparedConfiguration,rollbackConfiguration,writeReceipt}=require(path.join(repo,'rp-gamemode/scripts/g246-activation.cjs'));let receipt,startAttempt,profileTransitionStarted=false;
 try{
  const h={...handoff,profileHash:next.config.profileHash,catalogHash:next.catalogHash,serverConfigDigest:hash(Buffer.from(JSON.stringify({...next.config,metadataRoot:null})))};
  receipt=prepareConfiguration(audit,[{file:path.join(root,'server-settings.json'),bytes:Buffer.from(JSON.stringify(next.settings,null,2))},{file:path.join(root,'g241d-config.json'),bytes:Buffer.from(JSON.stringify(next.config,null,2))},{file:handoffPath,bytes:Buffer.from(JSON.stringify(h,null,2))}],{profileBeforeActive:previousActive,profileHash:next.config.profileHash,catalogHash:next.catalogHash});
  // Existing authenticated recovery preserves conflicting owner edits. The
  // single confirmation above covers this exact transition and its rollback.
  profileTransitionStarted=true;if(previousActive)await profile.revert(async()=>true);const plan=await newProfile.prepare();await newProfile.activate(plan,async()=>true);idle();
  applyPreparedConfiguration(receipt,()=>{});
  // The established verifier checks ancestry, UDP/TCP ownership, runtime seal
  // and actual health. Do not claim completion merely from config writes.
  const startupLog=path.join(audit,'activation-startup.log');startAttempt=Date.now();try{const output=execFileSync(process.execPath,[path.join(repo,'rp-gamemode/research/g244/start-verified.mjs')],{encoding:'utf8',windowsHide:true,timeout:75000,maxBuffer:4*1024*1024});await fs.writeFile(startupLog,output);}catch(error){await fs.writeFile(startupLog,String(error.stdout??'')+String(error.stderr??'')+String(error));throw Error('Runtime startup verification failed; diagnostics: '+startupLog);}
  receipt.phase='startup-verified';writeReceipt(receipt);console.log('Verified isolated runtime started. Use the existing play and grant commands, then /npc identity. No Skyrim launched. Rendering and a genuine new NPC remain owner verification.');
 }catch(error){
  // Stop only the exact fresh tree this operation created. An identity mismatch
  // or active Skyrim blocks rollback and retains all recovery evidence.
  try{if(startAttempt)await stopOwnFailedStartup(core,repo,root,handoff.startScript,startAttempt);idle();if(receipt)rollbackConfiguration(receipt);if(profileTransitionStarted)await recoverPriorProfile(core,grant,serverConfig.policy,previousActive);if(receipt){receipt.phase='rolled-back';writeReceipt(receipt);}}catch(recovery){throw new AggregateError([error,recovery],'Activation stopped; preserve configuration/profile recovery evidence. Server must be confirmed stopped before recovery.');}throw error;
 }
}
async function inspectOperatorLease(core,root,preserve=false){
 const file=path.join(root,'runtime-activation.lock');let st;try{st=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return false;throw error;}await core.noLinks(file);if(!st.isFile()||st.nlink!==1||st.size>8192)throw Error('Unsafe runtime operator lease');const bytes=await fs.readFile(file),value=JSON.parse(bytes.toString('utf8'));if(value.scope!=='g246-runtime-activation'||!Number.isSafeInteger(value.pid)||value.pid<=0)throw Error('Unknown runtime lease; preserve for operator review');
 const shell=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),alive=execFileSync(shell,['-NoProfile','-NonInteractive','-Command',"[bool](Get-Process -Id ([int]$env:FV_RUNTIME_LEASE_PID) -ErrorAction SilentlyContinue)|ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:5000,env:{...process.env,FV_RUNTIME_LEASE_PID:String(value.pid)}}).trim();if(alive!=='false')throw Error('Runtime operator process is still alive; recovery refused');
 if(preserve){const current=await fs.lstat(file);if(current.ino!==st.ino||current.dev!==st.dev||!(await fs.readFile(file)).equals(bytes))throw Error('Runtime lease changed during recovery');await fs.rename(file,path.join(root,'runtime-activation-lock-before-'+Date.now()+'-'+process.pid+'.json'));}return true;
}
export async function recoverRuntime({core,repo,grant}){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Deliberate owner terminal recovery required');
 const audit=path.join(repo,'build/rp-audit/g246'),handoff=path.join(repo,'build/rp-audit/g241d/owner-handoff.json'),h=JSON.parse(await fs.readFile(handoff,'utf8')),root=await fs.realpath(h.isolatedRoot);
 if(path.dirname(root)!==path.join(repo,'build/rp-audit/g241')||!/^dev-[A-Za-z0-9]+$/.test(path.basename(root)))throw Error('Unapproved recovery root');require(path.join(repo,'rp-gamemode/scripts/g241-dev.cjs')).guard(root);const idle=()=>require(path.join(repo,'rp-gamemode/research/g244/deployment.cjs')).idle(root);idle();
 const staleLease=await inspectOperatorLease(core,root),names=(await fs.readdir(audit)).filter(n=>/^runtime-activation-[A-Za-z0-9]+$/.test(n));if(names.length>64)throw Error('Recovery history capacity: inspect retained local evidence');const pending=[];
 for(const name of names){const file=path.join(audit,name,'receipt.json');await core.noLinks(file);const st=await fs.lstat(file);if(st.size>4*1024*1024||st.nlink!==1)throw Error('Invalid recovery receipt');const receipt=JSON.parse(await fs.readFile(file,'utf8'));if(['prepared','applying','verified','profile-recovery-required'].includes(receipt.phase))pending.push(receipt);}
 if(!pending.length&&!staleLease){console.log('No interrupted runtime transaction. For a profile-only interruption use the existing revert command.');return;}if(pending.length>1)throw Error('Multiple interrupted transactions; preserve evidence for operator review');
 const rl=createInterface({input:process.stdin,output:process.stdout});let answer;try{console.log('Recover the interrupted isolated runtime operation and its previous authenticated profile. Preserve all world/NPC/player/economy data. A completed verified startup will be retained, not rolled back.');answer=await rl.question('Type RECOVER: ');}finally{rl.close();}if(answer!=='RECOVER')throw Error('Recovery declined');idle();await inspectOperatorLease(core,root,true);
 await withRuntimeLease(root,async()=>{
  if(!pending.length){console.log('Stale operator lease preserved and released; no profile or server configuration changed.');return;}
  const receipt=JSON.parse(await fs.readFile(path.join(pending[0].directory,'receipt.json'),'utf8'));if(['startup-verified','rolled-back'].includes(receipt.phase)){console.log('Runtime transaction already terminal; no configuration changed.');return;}
  const {validateRecoveryReceipt,rollbackConfiguration,assertRecoveryCatalog,writeReceipt}=require(path.join(repo,'rp-gamemode/scripts/g246-activation.cjs'));validateRecoveryReceipt(receipt,{audit,root,handoff});
  let verification;try{verification=JSON.parse(await fs.readFile(path.join(repo,'build/rp-audit/g244/startup-verification.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const after=await Promise.all(receipt.files.map(async f=>hash(await fs.readFile(f.file))===f.after));if(after.every(Boolean)&&completedActivationEvidence(receipt,verification)){receipt.phase='startup-verified';writeReceipt(receipt);console.log('Matching successful startup already recorded; activation retained, no rollback or profile change.');return;}
  await core.noLinks(receipt.files[1].backup);const bytes=await fs.readFile(receipt.files[1].backup);if(hash(bytes)!==receipt.files[1].before||typeof receipt.profileBeforeActive!=='boolean')throw Error('Recovery backup/context changed');const previous=JSON.parse(bytes.toString('utf8'));assertRecoveryCatalog(root,previous);
  idle();rollbackConfiguration(receipt);await recoverPriorProfile(core,grant,previous.policy,receipt.profileBeforeActive);receipt.phase='rolled-back';writeReceipt(receipt);console.log('Previous server configuration and authenticated profile recovered; all data retained. No server or Skyrim launched.');
 });
}
