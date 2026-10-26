import{waitForStartup}from'./npc-startup.mjs';
// Dedicated local owner CLI, not a public updater/unsigned remote package route.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import{createHash,randomUUID}from'node:crypto';import{createInterface}from'node:readline/promises';import{execFileSync,spawn}from'node:child_process';import{build}from'esbuild';
const launcher=path.resolve(import.meta.dirname,'..'),repo=path.resolve(launcher,'../skymp'),home=path.join(launcher,'.local/npc-development');
const command=process.argv[2]??'prepare';if(process.argv.length>3||!['prepare','status','revert','activate','activate-and-play','grant'].includes(command))throw Error('Usage: node scripts/npc-development.mjs prepare|status|activate|activate-and-play|grant|revert');
for(const dir of [launcher,path.join(launcher,'.local'),home]){try{if((await fs.lstat(dir)).isSymbolicLink())throw Error('Redirected local development directory');}catch(e){if(e.code!=='ENOENT')throw e;}}
await fs.mkdir(home,{recursive:true});const file=path.join(home,'core.cjs');
const exports=[['NpcDevelopmentProfile','management/npc-development.ts'],['npcDevelopmentPolicy','management/npc-development-policy.ts'],['registerRealTarget','installer/managed-target.ts'],['fileVersion,gameRunning,startSkse','windows.ts'],['planDigest','management/authorization.ts'],['GameLauncher','launch.ts'],['hashFile,safeFile,noLinks,safeDirectory','files.ts']];
await build({stdin:{contents:exports.map(([names,f])=>`export {${names}} from ${JSON.stringify(path.join(launcher,'src/main',f))};`).join('\n'),resolveDir:launcher},outfile:file,bundle:true,platform:'node',format:'cjs',packages:'external',logLevel:'silent'});
const {createRequire}=await import('node:module'),core=createRequire(import.meta.url)(file),policy=core.npcDevelopmentPolicy;
const game='C:/Program Files (x86)/Steam/steamapps/common/Skyrim Special Edition',config=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData/Local'),'Skyrim Special Edition');
for(const f of policy.runtime){const actual=await core.hashFile(await core.safeFile(game,f.path),64*1024*1024);if(actual.sha256!==f.sha256||actual.size!==f.size)throw Error('Pinned development runtime differs: '+f.path);}
if(await core.fileVersion(path.join(game,'SkyrimSE.exe'))!=='1.6.1170.0')throw Error('This development profile requires the verified 1.6.1170 runtime');
await core.safeDirectory(path.join(home,'storage'));const grant=await core.registerRealTarget(game,config,path.join(home,'storage'),{ready:true,runtime:'1.6.1170.0'}),profile=await core.NpcDevelopmentProfile.open(grant,policy,core.gameRunning);
// Recovery of these two configuration files must not depend on server artifacts
// still existing or on the five authoring assets remaining unchanged.
if(command==='revert'){await profile.revert(confirm);console.log('Development profile reverted; owned source assets preserved.');process.exit(0);}
const handoff=JSON.parse(await fs.readFile(path.join(repo,'build/rp-audit/g241d/owner-handoff.json'),'utf8'));
if(handoff.profileHash!==core.planDigest(policy)||handoff.catalogHash!==policy.catalogHash)throw Error('Stale server/Launcher development policy');
const root=await fs.realpath(handoff.isolatedRoot),parent=path.join(repo,'build/rp-audit/g241');if(path.dirname(root)!==parent||!/^dev-[A-Za-z0-9]+$/.test(path.basename(root)))throw Error('Unapproved isolated server root');await core.noLinks(root);
const serverConfigFile=path.join(root,'g241d-config.json'),serverConfig=JSON.parse(await fs.readFile(serverConfigFile,'utf8'));
if(serverConfig.profileHash!==core.planDigest(policy)||serverConfig.game!==game||serverConfig.clientConfig.toLowerCase()!==config.toLowerCase())throw Error('Development handoff selects a different installation');
const sealHash=bytes=>createHash('sha256').update(bytes).digest('hex');
if(sealHash(Buffer.from(JSON.stringify({...serverConfig,metadataRoot:null})))!==handoff.serverConfigDigest)throw Error('Server development configuration changed');
for(const artifact of handoff.artifacts??[]){if(!/^[A-Za-z0-9/._-]+$/.test(artifact.path)||artifact.path.split('/').includes('..')||sealHash(await fs.readFile(path.join(root,artifact.path)))!==artifact.sha256)throw Error('Sealed server artifact changed');}if(handoff.artifacts?.length!==12)throw Error('Missing server artifact seal');
if(serverConfig.metadataRoot!==grant.metadata){serverConfig.metadataRoot=grant.metadata;await fs.writeFile(serverConfigFile,JSON.stringify(serverConfig,null,2));}
async function confirm(digest){if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Deliberate owner terminal confirmation required; no --yes or noninteractive override');const rl=createInterface({input:process.stdin,output:process.stdout});try{console.log((command==='revert'?'LOCAL DEVELOPMENT REVERT: restore only the two unchanged configuration targets from the authenticated backup.':'LOCAL DEVELOPMENT ONLY: references five pinned owned files; activates FrostveilNPCTest.esp and selects localhost:17777. Startup failures roll back these configuration changes while the game is closed. No public release or asset copy.')+'\nPlan SHA256: '+digest);return(await rl.question('Type CONFIRM to proceed: ')).trim()==='CONFIRM';}finally{rl.close();}}
if(command==='prepare'){const plan=await profile.prepare();console.log(JSON.stringify({state:'PENDING_OWNER_ACTION',source:plan.source,planSHA256:plan.digest,profileHash:core.planDigest(policy),targets:['plugins.txt','skymp5-client-settings.txt'],installedFilesChanged:false}));}
else if(command==='status')console.log(JSON.stringify(await profile.status()));
else if(command==='grant'){
 if(!(await profile.status()).active||!await core.gameRunning())throw Error('Connect the verified local Skyrim client first');
 const directory=path.join(root,'admin'),inventoryFile=path.join(directory,'sessions.json');await core.noLinks(inventoryFile);const st=await fs.lstat(inventoryFile);if(st.size>65536||st.nlink!==1)throw Error('Unsafe local operator inventory');const inventory=JSON.parse(await fs.readFile(inventoryFile,'utf8'));
 if(inventory.sessions?.length!==1||!inventory.accounts?.includes('owner'))throw Error('Exactly one observed server session required; enter server and use /npc help first');const target=inventory.sessions[0];
 const expected=createHash('sha256').update(JSON.stringify({boot:inventory.boot,actorId:target.actorId,profileId:target.profileId,nonce:target.nonce})).digest('hex');
 if(!process.stdin.isTTY)throw Error('Deliberate local operator confirmation required');const rl=createInterface({input:process.stdin,output:process.stdout});let answer;try{answer=await rl.question(`Grant isolated owner for 30 minutes to current actor ${target.actorId.toString(16)}, profile ${target.profileId}? Type GRANT: `);}finally{rl.close();}if(answer!=='GRANT')throw Error('Operator grant declined');
 const adminTool=path.join(repo,'rp-gamemode/scripts/admin-local.cjs');if(sealHash(await fs.readFile(adminTool))!==handoff.adminToolSHA256)throw Error('Local authority tool changed; prepare a new handoff');
 console.log(execFileSync(process.execPath,[adminTool,directory,'grant',target.actorId.toString(16),'owner',expected],{encoding:'utf8',windowsHide:true}).trim());
}
else if(command==='revert'){await profile.revert(confirm);console.log('Development profile reverted; owned source assets preserved. Stop only the isolated server before returning to normal Play.');}
else{
 const plan=await profile.prepare();await profile.activate(plan,confirm);const status=await profile.status();if(!status.active)throw Error('Development profile activation not verified');console.log(JSON.stringify(status));
 if(command==='activate-and-play'){
  let child;try{
  const hash=async f=>createHash('sha256').update(await fs.readFile(f)).digest('hex');
  if(await hash(handoff.startScript)!==handoff.startScriptSHA256||await hash(handoff.serveScript)!==handoff.serveScriptSHA256)throw Error('Startup artifact changed; prepare server again');
  const powershell=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const occupied=execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',"[bool]((Get-NetUDPEndpoint -LocalPort 17777 -ErrorAction SilentlyContinue) -or (Get-NetTCPConnection -LocalPort 17778 -State Listen -ErrorAction SilentlyContinue)) | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true}).trim();if(occupied!=='false')throw Error('Development ports occupied; refusing to restart or replace any process');
  const startupId=randomUUID();
  child=spawn(powershell,['-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',handoff.startScript],{cwd:root,windowsHide:false,detached:true,stdio:'ignore',env:{...process.env,FROSTVEIL_G241D_STARTUP_ID:startupId}});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  await waitForStartup({expected:{childPid:child.pid,startupId,profileHash:core.planDigest(policy),catalogHash:policy.catalogHash},root,startScript:handoff.startScript,serveScript:handoff.serveScript,logs:path.join(repo,'build/rp-audit/g241d','readiness-'+Date.now()+'-'+child.pid+'.json')});
  const player=new core.GameLauncher(core.gameRunning,core.startSkse);await player.play(async()=>{if(!(await profile.status()).active)throw Error('Development profile no longer active before launch');for(const f of policy.runtime){const actual=await core.hashFile(await core.safeFile(game,f.path),64*1024*1024);if(actual.sha256!==f.sha256)throw Error('Runtime changed before launch');}return{directory:game,ready:true,runtime:'1.6.1170.0',skseLoader:'2.2.6',skseRuntime:'2.2.6',nativeLauncherAvailable:true,files:[],errors:[],scannedAt:new Date().toISOString()};});console.log('Started verified isolated server and SKSE. Obtain local dev admin then /npc identity; fixtures remain blocked until proof and mapper arm.');
  }catch(error){
   const powershell=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
   if(!await core.gameRunning()){
    // Stop only this freshly-created PowerShell tree after checking its command.
    if(child?.pid)execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',"$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:FV_NPC_CHILD_PID); if($p){if($p.Name -ne 'powershell.exe' -or !$p.CommandLine.Contains($env:FV_NPC_START_SCRIPT)){throw 'Startup process identity changed'}; & taskkill.exe /PID $p.ProcessId /T /F | Out-Null; if($LASTEXITCODE -ne 0){throw 'Isolated process cleanup failed'}}"],{env:{...process.env,FV_NPC_CHILD_PID:String(child.pid),FV_NPC_START_SCRIPT:handoff.startScript},windowsHide:true,stdio:'ignore'});
    await profile.revert(async()=>true);console.error('Isolated startup failed; exact local configuration was reverted. Diagnostic logs retained.');
   }else console.error('Game is active; no configuration rollback or process termination attempted. Close Skyrim and use revert.');
   throw error;
  }
 }
}
