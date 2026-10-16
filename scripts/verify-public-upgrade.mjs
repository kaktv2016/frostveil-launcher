// This acceptance test installs genuine production releases. Never run against
// an owner's workstation: registry, shortcuts and app identity require a fresh VM.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
import {build} from 'esbuild';import {extractFile} from '@electron/asar';import {_electron as electron,expect} from '@playwright/test';
assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true','Public installer acceptance runs only on a disposable hosted runner');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
delete process.env.GH_TOKEN;delete process.env.GITHUB_TOKEN;
const output=path.resolve('.local/public-upgrade');await fs.mkdir(output,{recursive:true});
await build({stdin:{contents:`export {productionLauncherUpdateSource,LauncherUpdateTransport,authenticateLauncherUpdate,verifyDownloadedInstaller} from './src/main/update-integrity';export {InstallerSandboxDemo} from './src/main/installer/demo';export {MetadataStore} from './src/main/installer/metadata';`,resolveDir:process.cwd()},outfile:path.join(output,'core.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external'});
const core=createRequire(import.meta.url)(path.join(output,'core.cjs')),transport=core.LauncherUpdateTransport.github();
const execute=promisify(execFile),powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'frostveil-public-upgrade-')),install=path.join(root,'installed'),exe=path.join(install,'Skyrim RP Launcher.exe');
const storage=path.join(process.env.LOCALAPPDATA,'SkyrimRPLauncher');
await assert.rejects(()=>fs.stat(path.join(storage,'settings.json')),{code:'ENOENT'},'Fresh runner must not contain an existing player profile');
const settings=JSON.stringify({directory:path.join(root,'no-game-installed'),channel:'stable'},null,2);await fs.mkdir(storage,{recursive:true});await fs.writeFile(path.join(storage,'settings.json'),settings);
const demo=new core.InstallerSandboxDemo(storage);await demo.run();assert.equal(demo.snapshot().phase,'complete');demo.dispose();
const pointer=JSON.parse(await fs.readFile(path.join(storage,'installer-sandbox-session.json'))),metadata=(await core.MetadataStore.recover(pointer.directory)).grant.metadata;
async function snapshot(){const result={};async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,entry.name);if(entry.isDirectory())await walk(f);else result[path.relative(metadata,f)]=createHash('sha256').update(await fs.readFile(f)).digest('hex');}}await walk(metadata);return result;}
const before=await snapshot();
async function metadataFor(tag){const r=await fetch('https://api.github.com/repos/kaktv2016/frostveil-launcher/releases/tags/'+tag,{credentials:'omit',redirect:'error',headers:{'User-Agent':'Frostveil-Public-Upgrade-Acceptance','Accept':'application/vnd.github+json'}});assert.equal(r.status,200);return r.json();}
const old=await metadataFor('v0.1.6'),oldAsset=old.assets.find(a=>a.name==='frostveil-launcher-update.json');
const oldEnvelope=await transport.json('/releases/assets/'+oldAsset.id,undefined,oldAsset.size,oldAsset.size),oldAuthenticated=core.authenticateLauncherUpdate(oldEnvelope,core.productionLauncherUpdateSource,old,'0.1.5');
assert.equal(oldAuthenticated.manifest.version,'0.1.6');const oldInstaller=oldAuthenticated.manifest.installer;
assert.ok(oldInstaller.size<256*1024*1024);const response=await transport.installer(oldInstaller.assetId);assert.equal(response.status,200);
const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,oldInstaller.size);const oldFile=path.join(root,'SkyrimRPLauncher-0.1.6-x64-local.exe');await fs.writeFile(oldFile,bytes,{flag:'wx'});
await core.verifyDownloadedInstaller(oldFile,oldInstaller.sha512,[],undefined,{envelope:oldEnvelope,source:core.productionLauncherUpdateSource,release:old,installedVersion:'0.1.5'});
async function run(file,args){return new Promise((resolve,reject)=>{const child=spawn(file,args,{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Owned installer exited '+code)));});}
await run(oldFile,['/S','--no-desktop-shortcut','/D='+install]);
assert.equal(JSON.parse(extractFile(path.join(install,'resources/app.asar'),'package.json')).version,'0.1.6');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let app;let oldPid;const checks=[];
async function processes(){const r=await execute(powershell,['-NoProfile','-NonInteractive','-Command',"@(Get-Process -Name 'Skyrim RP Launcher' -ErrorAction SilentlyContinue | ForEach-Object { @{id=$_.Id;path=$_.Path;window=[string]$_.MainWindowHandle} }) | ConvertTo-Json -Compress"],{windowsHide:true});const p=JSON.parse(r.stdout.trim()||'[]');return Array.isArray(p)?p:[p];}
async function ownedProcesses(){const target=(await fs.realpath(exe)).toLowerCase(),result=[];for(const p of await processes()){try{if(typeof p.path==='string'&&(await fs.realpath(p.path)).toLowerCase()===target)result.push(p);}catch{/* Exited process. */}}return result;}
async function until(check,label){const end=Date.now()+120000;for(;;){const value=await check();if(value)return value;if(Date.now()>end)throw Error('Timed out waiting for '+label);await new Promise(r=>setTimeout(r,500));}}
async function closeOwned(p){const r=await execute(powershell,['-NoProfile','-NonInteractive','-Command',"$p=Get-Process -Id ([int]$env:FV_OWNED_PID) -ErrorAction Stop; if($p.Path -ne $env:FV_OWNED_EXE){throw 'Process identity changed'}; [void]$p.CloseMainWindow()"],{windowsHide:true,env:{...process.env,FV_OWNED_PID:String(p.id),FV_OWNED_EXE:p.path}});await until(async()=>!(await ownedProcesses()).some(x=>x.id===p.id),'owned updated app close');}
try{
 app=await electron.launch({executablePath:exe,args:[],env,timeout:30000});oldPid=app.process().pid;const page=await app.firstWindow();
 await page.waitForFunction(async()=>{const s=await window.launcher.status();return s.version==='0.1.6'&&s.launcherUpdate?.availableVersion==='0.1.7'&&s.launcherUpdate?.state==='available';},undefined,{timeout:60000});
 const state=await page.evaluate(()=>window.launcher.status());assert.equal(state.launcherUpdate.publisherTrust,'verified');assert.equal(state.launcherUpdate.canDownload,true);
 await page.evaluate(()=>window.launcher.downloadUpdate());const downloaded=await page.evaluate(()=>window.launcher.status());assert.equal(downloaded.launcherUpdate.verification,'installer-verified');assert.equal(downloaded.launcherUpdate.canInstall,true);checks.push('Actual public0.1.6 application verified and downloaded public0.1.7 through normal production updater');
 try{await page.evaluate(()=>window.launcher.installUpdate());}catch(e){if(!/closed|destroyed/i.test(String(e)))throw e;}
 const restarted=await until(async()=>{const p=(await ownedProcesses()).find(p=>p.id!==oldPid&&p.window!=='0');if(!p)return;const pkg=JSON.parse(extractFile(path.join(install,'resources/app.asar'),'package.json'));return pkg.version==='0.1.7'?p:undefined;},'actual new installed application window');
 assert.equal((await ownedProcesses()).some(p=>p.id===oldPid),false);assert.equal(await fs.readFile(path.join(storage,'settings.json'),'utf8'),settings);assert.deepEqual(await snapshot(),before);checks.push('Default NSIS handoff exited old process, upgraded real installed files and restarted new application window');checks.push('Settings and authenticated ownership/journals/backup bytes preserved exactly');
 await closeOwned(restarted);await app.close().catch(()=>{});app=await electron.launch({executablePath:exe,args:[],env,timeout:30000});const updated=await app.firstWindow();
 await updated.waitForFunction(async()=>(await window.launcher.status()).version==='0.1.7');await updated.getByRole('button',{name:/^Updates/}).click();await expect(updated.getByRole('button',{name:'Download Server Files',exact:true})).toBeEnabled();
 await updated.getByRole('button',{name:'Download Server Files',exact:true}).click();await updated.waitForFunction(async()=>(await window.launcher.status()).productionDownloads?.phase==='complete',undefined,{timeout:60000});
 const pack=(await updated.evaluate(()=>window.launcher.status())).productionDownloads;assert.equal(pack.signature,'AUTHENTICATED');assert.equal(pack.installed,false);assert.ok(pack.files.length>=3&&pack.files.every(f=>f.verified));await assert.rejects(()=>fs.stat(path.join(root,'no-game-installed')),{code:'ENOENT'});checks.push('Actual public0.1.7 UI downloaded signed production pack without a game directory or installation writes');
 await updated.screenshot({path:path.join(output,'public-update-and-download.png'),fullPage:true});
 const result={status:'PASS',verifiedAt:new Date().toISOString(),from:'0.1.6',to:'0.1.7',productionPublicKeysOnly:true,anonymous:true,loopback:false,substituteInstallCallback:false,realGameWrites:false,runner:'disposable github-hosted Windows',checks,pack:{id:pack.packId,version:pack.version,files:pack.files},oldReleaseId:old.id,newReleaseId:(await metadataFor('v0.1.7')).id};
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch(e){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(e),processes:await ownedProcesses().catch(()=>[]),installedVersion:await fs.readFile(path.join(install,'resources/app.asar')).then(()=>JSON.parse(extractFile(path.join(install,'resources/app.asar'),'package.json')).version).catch(()=>null)},null,2));throw e;}
finally{await app?.close().catch(()=>{});for(const p of (await ownedProcesses().catch(()=>[])).filter(p=>p.window!=='0'))await closeOwned(p).catch(()=>{});}
