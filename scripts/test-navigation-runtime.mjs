// Disposable candidate fixture. Installed game/server paths are hash-read only.
import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{createRequire}from'node:module';import{build}from'esbuild';
import{core}from'../.local/player-release/core-loader.mjs';
const out=path.resolve('.local/navigation-runtime-fix'),delivery=path.join(out,'delivery'),harness=path.join(out,'fixture-harness');
await build({entryPoints:['src/main/graphics-source-repair.ts','src/main/graphics-source-plan.ts','src/main/management/graphics-pack.ts','src/main/navigation-repair-targets.ts'],outdir:harness,bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'}});
const require=createRequire(import.meta.url),load=n=>require(path.join(harness,n+'.cjs'));
const{repairGraphicsSources}=load('graphics-source-repair'),{decodeGraphicsSourcePlan}=load('graphics-source-plan'),{GraphicsPackService}=load('management/graphics-pack');
const hash=b=>createHash('sha256').update(b).digest('hex'),observe=async file=>{try{const bytes=await fs.readFile(file);return{size:bytes.length,sha256:hash(bytes)};}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const pin=JSON.parse(await fs.readFile(path.join(delivery,'source-repair-pin.json'))),plan=decodeGraphicsSourcePlan(await fs.readFile(path.join(delivery,'source-repair-plan.json')),pin),previous=JSON.parse(await fs.readFile('.local/spawn-facing/delivery/source-repair-plan.json'));
assert.equal(plan.files.length,649);assert.deepEqual(plan.files.slice(0,647),previous.files);
const changed=plan.files.slice(647),names=changed.map(f=>f.path);assert.deepEqual(names,['Data/FrostveilCourierNavigation.esp','Data/Interface/Frostveil/CourierQuestTint.swf']);
const pack=path.join(delivery,'modpack'),authenticated=core.authenticateRelease(JSON.parse(await fs.readFile(path.join(pack,'candidate-envelope.json'))),core.productionSource,JSON.parse(await fs.readFile(path.join(pack,'preview-release.json'))));
assert.equal(authenticated.manifest.minimumLauncherVersion,'0.1.18');assert.equal(authenticated.manifest.packVersion,'1.0.6');
for(const entry of changed)assert.equal(authenticated.manifest.files.find(f=>f.path===entry.path).sha256,entry.sha256);
const client=plan.files.find(f=>f.path==='Data/Platform/Plugins/skymp5-client.js');assert.equal(client.sha256,'01264ed1a000ec8bbc75bfaa8f7548b687169fd144ac5e4d22d9c540fc7b0290');
const installed='C:/Program Files (x86)/Steam/steamapps/common/Skyrim Special Edition',protectedPaths=[...names.map(p=>path.join(installed,p)),path.join(installed,client.path),'../skymp/build/dist/server/server-settings.json','../skymp/build/dist/server/dist_back/skymp5-server.js'];
const before=await Promise.all(protectedPaths.map(observe));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-navigation-')),game=path.join(root,'game'),storage=path.join(root,'storage'),oldEsp=await fs.readFile('.local/production-candidates/modpack-pack-v1.0.5/reviewed-content/FrostveilCourierNavigation.esp');
try{
 await fs.mkdir(path.join(game,'Data'),{recursive:true});await fs.writeFile(path.join(game,names[0]),oldEsp);
 const subset={...plan,files:changed},options={sourceDirectories:[delivery]};
 await assert.rejects(repairGraphicsSources(game,storage,async()=>true,subset,options),/running/i);assert.deepEqual(await observe(path.join(game,names[0])),{size:oldEsp.length,sha256:hash(oldEsp)});
 await assert.rejects(repairGraphicsSources(game,storage,async()=>false,subset,{...options,progress:phase=>{if(phase==='applied')throw Error('fixture-interrupt');}}),/fixture-interrupt/);
 assert.deepEqual(await fs.readFile(path.join(game,names[0])),oldEsp);assert.equal(await observe(path.join(game,names[1])),null);
 const result=await repairGraphicsSources(game,storage,async()=>false,subset,options);assert.equal(result.changed,2);assert.deepEqual(await fs.readFile(path.join(result.backupDirectory,'before/0')),oldEsp);
 for(const entry of changed)assert.deepEqual(await observe(path.join(game,entry.path)),{size:entry.size,sha256:entry.sha256});
 const times=await Promise.all(names.map(n=>fs.stat(path.join(game,n)).then(s=>s.mtimeMs)));
 assert.equal((await repairGraphicsSources(game,storage,async()=>false,subset,{sourceDirectories:[]})).changed,0);assert.deepEqual(await Promise.all(names.map(n=>fs.stat(path.join(game,n)).then(s=>s.mtimeMs))),times);
 const legacy=new GraphicsPackService(storage);legacy.setSourceRepairTargets(names);
 assert.deepEqual(await legacy.verifyIntegrityFiles(game,{integrityFiles:{[names[0]]:{size:oldEsp.length,sha256:hash(oldEsp)}}}),{valid:true,mismatched:[]});
 const report={passed:true,candidateSignature:'VERIFIED against LOCAL placeholder release only',recipeTargets:649,unchangedRecipeTargets:647,changedTargets:2,oldEspBackupVerified:true,interruptedApplyRollback:true,runningGameRefused:true,secondPlayWrites:0,legacyEspNotReintroduced:true,clientJsRetained:'0.1.17',installedGameWrites:0,serverWrites:0,nativeGameplay:'PENDING'};
 assert.deepEqual(await Promise.all(protectedPaths.map(observe)),before);await fs.writeFile(path.join(out,'candidate-fixture-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});}
