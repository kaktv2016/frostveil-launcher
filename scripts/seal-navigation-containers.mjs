// Local artifacts only. Never publishes, deploys or writes to an installed game.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {extractFile} from '@electron/asar';
import {assertProductionTrust} from './production-trust-audit.mjs';
const root=process.cwd(),workspace=path.resolve('..'),out=path.resolve('.local/navigation-containers-fix'),delivery=path.join(out,'delivery'),asset=path.resolve('../mod-work/frostveil-courier-navigation');
const hash=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await fs.readFile(p)),identity=async p=>{const b=await fs.readFile(p);return{path:path.resolve(p),size:b.length,sha256:hash(b)};};
const candidate=await read(path.join(delivery,'candidate-plan.json'));
assert.equal(candidate.navigation.sha256,'9a4a546f9fae714251dde91955b27a3b01cb79cabcbe4e1ab80fff9bcd549930');
assert.equal(await fs.stat(path.join(delivery,'deployment-plan.json')).then(()=>true,()=>false),false,'Never overwrite a sealed approval plan');
const rpLog=path.resolve('../skymp/rp-gamemode/.local/navigation-admin/containers-regression-final.log'),launcherLog=path.join(out,'launcher-regression-final.log');
for(const [file,count]of [[rpLog,251],[launcherLog,480]]){const text=await fs.readFile(file,'utf8');assert.match(text,new RegExp('pass '+count+'\\b'));assert.match(text,/fail 0\b/);assert.match(text,/skipped 0\b/);}
assert.match(await fs.readFile(path.join(out,'packaged-smoke.log'),'utf8'),/smoke PASSED/);
const main=extractFile('release/win-unpacked/resources/app.asar','dist/main.cjs').toString(),trust=assertProductionTrust(main);
assert.equal(JSON.parse(extractFile('release/win-unpacked/resources/app.asar','package.json')).version,'0.1.19');assert.ok(main.includes(candidate.recipe.sha256));assert.ok(main.includes(candidate.preserved.clientJs));
const report=path.resolve('../skymp/docs/rp-development/FROSTVEIL_COURIER_NAVIGATION_ADMIN_REPORT.md');
const navStage=path.join(out,'navigation-source-stage'),launcherStage=path.join(out,'launcher-source-stage');
for(const directory of [navStage,launcherStage])await fs.mkdir(directory,{recursive:false});
for(const name of ['build.cjs','build-ui.cjs','catalogue.json','README.md','ui-build.json','ui'])await fs.cp(path.join(asset,name),path.join(navStage,name),{recursive:true});
await fs.cp(path.join(asset,'tooling'),path.join(navStage,'tooling'),{recursive:true,filter:p=>!path.relative(path.join(asset,'tooling'),p).split(path.sep).some(n=>['.local','bin','obj'].includes(n))});
for(const name of ['FrostveilCourierNavigation.esp','Interface/Frostveil/CourierQuestTint.swf']){const target=path.join(navStage,'payload/Data',name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(asset,'payload/Data',name),target);}
await fs.copyFile('../skymp/skymp5-server/LICENSE',path.join(navStage,'LICENSE-AGPL-3.0'));await fs.copyFile('../research/navigation-color/toolchain/haxe210/haxe-2.10-win/LICENSE.txt',path.join(navStage,'HAXE-STDLIB-LICENSE.txt'));
await fs.copyFile(report,path.join(navStage,path.basename(report)));
for(const name of ['src','tests','scripts','client-ui','package.json','tsconfig.json','tsconfig.type-tests.json','README.md'])await fs.cp('../skymp/rp-gamemode/'+name,path.join(navStage,'rp-gamemode',name),{recursive:true});
const navZip=path.join(delivery,'FrostveilCourierNavigation-source.zip');execFileSync('tar.exe',['-acf',navZip,'.'],{cwd:navStage,windowsHide:true});
for(const name of ['src','tests','scripts','assets','package.json','package-lock.json','THIRD_PARTY_NOTICES.md'])await fs.cp(name,path.join(launcherStage,name),{recursive:true});
await fs.cp(navStage,path.join(launcherStage,'navigation-and-rp-source'),{recursive:true});
await fs.copyFile(report,path.join(launcherStage,path.basename(report)));await fs.mkdir(path.join(launcherStage,'graphics-repair-metadata'));
await fs.copyFile(path.join(delivery,'source-repair-plan.json'),path.join(launcherStage,'graphics-repair-metadata/source-repair-plan.json'));
await fs.mkdir(path.join(launcherStage,'ops'));await fs.copyFile('../scripts/publish-navigation-containers-r2.mjs',path.join(launcherStage,'ops/publish-navigation-containers-r2.mjs'));
const launcherZip=path.join(delivery,'FrostveilLauncher-0.1.19-source.zip');execFileSync('tar.exe',['-acf',launcherZip,'.'],{cwd:launcherStage,windowsHide:true});
const config=await read('../skymp/build/dist/server/server-settings.json'),bundleBytes=await fs.readFile('../skymp/rp-gamemode/dist/rp-gamemode.cjs'),bundlePath=path.join(delivery,'rp-gamemode-'+hash(bundleBytes)+'.cjs');
try{assert.equal((await identity(bundlePath)).sha256,hash(bundleBytes));}catch(error){if(error.code!=='ENOENT')throw error;await fs.writeFile(bundlePath,bundleBytes,{flag:'wx'});}
assert.equal(config.loadOrder.length,6);assert.equal(config.listenHost,'127.0.0.1');assert.equal(config.uiListenHost,'127.0.0.1');assert.equal(config.offlineMode,true);
const before={bundle:await identity(config.gamemodePath),esp:await identity(config.loadOrder[5]),wrapper:await identity('../skymp/build/dist/server/dist_back/skymp5-server.js')};
assert.equal(before.bundle.sha256,'fc6113721fbf1c827d52cf392ace85b51b2053ba5673ea6b554dfb1f44841f08');assert.equal(before.esp.sha256,candidate.baseline.esp.sha256);assert.equal(before.wrapper.sha256,'1e8511088812e379e2237216ef294c7b94877057c1a13f3a18fb655456c1be95');
const operation=await identity('../skymp/rp-gamemode/scripts/deploy-navigation-containers.ps1'),esp=await identity(path.join(delivery,'modpack/reviewed-content/FrostveilCourierNavigation.esp'));
assert.equal(esp.sha256,candidate.navigation.sha256);
const fixtureLog=JSON.parse((await fs.readFile(path.join(out,'verify.log'),'utf8')).trim().split(/\r?\n/).at(-1));assert.equal(fixtureLog.passed,true);assert.equal(fixtureLog.secondPlayWrites,0);
const plan={...candidate,status:'SEALED_LOCAL_CANDIDATE_AWAITING_SINGLE_DEPLOYMENT_APPROVAL',sealedAt:new Date().toISOString(),launcherSourceUpdated:true,packagedInstaller:'NSIS_AND_PACKAGED_SMOKE_VERIFIED',navigation:[esp],installer:await identity('release/SkyrimRPLauncher-0.1.19-x64-local.exe'),correspondingSource:await identity(launcherZip),modpack:{...candidate.modpack,correspondingSource:await identity(navZip)},
 server:{bundle:await identity(bundlePath),before,operation,loadOrder:config.loadOrder,visiblePowerShellRequired:true,sessionGrant:'No automatic grant; current owner session must be explicitly approved'},
 loadOrder:config.loadOrder,operations:[await identity('scripts/publish-navigation-containers.mjs'),await identity('../scripts/publish-navigation-containers-r2.mjs'),operation],report:await identity(report),
 automated:{gamemode:251,launcher:480,typechecks:'PASS',nsisBuild:'PASS',packagedSmoke:'PASS',candidateFixture:fixtureLog,trust,regressionLogs:[await identity(rpLog),await identity(launcherLog)],nativeEsp:{mutagen:await identity(path.join(asset,'tooling/.local/candidate-v2/mutagen-evidence.json')),addon:await identity(path.join(asset,'tooling/.local/candidate-v2/native-evidence.json')),indices:[1,5],nativeClient:'PENDING'}},
 rollback:{worldRestore:false,worldMigration:false,codeConfigEspBackup:true,server:'Terminate failed owned process tree; restore previous gamemode/config/ESP together; preserve all current world/economy and newly saved discovery records.',client:'Launcher atomic backup/recovery. Forward signed release for corrections; never overwrite immutable assets/tags.'},nativeProof:{adminMovement:'OWNER PASS',swfInjection:'HUD/Menu native log PASS',questReferences:'PENDING',mapCompassDoor:'PENDING',goldGreenAppearance:'PENDING',realDiscoveryReconnect:'PENDING'},installedGameWrites:0,liveServerWrites:0,worldWrites:0};
const specs=[plan.installer,plan.correspondingSource,plan.modpack.correspondingSource,plan.server.bundle,...plan.navigation,...plan.operations,plan.archive,{path:path.join(delivery,'source-repair-plan.json'),...plan.recipe},...plan.modpack.assets.map(a=>({...a,path:path.join(delivery,'modpack/reviewed-content',a.name)}))];
for(const spec of specs){const actual=await identity(spec.path);assert.equal(actual.size,spec.size);assert.equal(actual.sha256,spec.sha256);}
const bytes=Buffer.from(JSON.stringify(plan,null,2)+'\n');await fs.writeFile(path.join(delivery,'deployment-plan.json'),bytes,{flag:'wx'});await fs.writeFile(path.join(delivery,'deployment-plan.sha256'),hash(bytes)+'\n',{flag:'wx'});
await fs.writeFile(path.join(delivery,'SHA256SUMS'),specs.map(s=>s.sha256+'  '+path.relative(delivery,s.path).replaceAll('\\','/')).join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({status:plan.status,planSHA256:hash(bytes),installer:plan.installer,esp:plan.navigation[0],bundle:plan.server.bundle,sourceSizes:[plan.correspondingSource.size,plan.modpack.correspondingSource.size],installedGameWrites:0,liveServerWrites:0}));
