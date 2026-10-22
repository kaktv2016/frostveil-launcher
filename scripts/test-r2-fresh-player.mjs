// Disposable fresh-install integration. Never launches Skyrim or writes its real folder/profile.
import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import assert from'node:assert/strict';import{createRequire}from'node:module';import{build}from'esbuild';
const out=path.resolve('.local/r2-delivery');await fs.mkdir(out,{recursive:true});
await build({entryPoints:['src/main/graphics-source-repair.ts','src/main/management/graphics-pack.ts','src/main/management/downloads.ts','src/main/files.ts','src/main/installation.ts','src/main/windows.ts','src/main/client-repair.ts'],outdir:path.join(out,'fresh-harness'),bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},packages:'external'});
const require=createRequire(import.meta.url),load=n=>require(path.join(out,'fresh-harness',n+'.cjs'));
const{repairGraphicsSources}=load('graphics-source-repair'),{GraphicsPackService}=load('management/graphics-pack'),{ProductionDownloads}=load('management/downloads'),{hashFile}=load('files'),{scanInstallation}=load('installation'),{fileVersion}=load('windows'),{repairClientForPlay,clientRequirementForScan}=load('client-repair');
const plan=JSON.parse(await fs.readFile('../mod-dist/graphics-repair-109/source-repair-plan.json'));
const real='C:/Program Files (x86)/Steam/steamapps/common/Skyrim Special Edition',before=[];
for(const f of plan.files){try{before.push({path:f.path,...await hashFile(path.join(real,f.path))});}catch(e){if(e.code!=='ENOENT')throw e;before.push({path:f.path,absent:true});}}
const root=process.env.FROSTVEIL_FRESH_FIXTURE??await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-fresh-r2-')),game=path.join(root,'game'),storage=path.join(root,'storage'),order=path.join(root,'order'),profile=path.join(root,'user');
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
const oldProfile=process.env.USERPROFILE,started=Date.now();let downloads,passed=false;
try{
 process.env.USERPROFILE=profile;await fs.mkdir(path.join(game,'Data'),{recursive:true});await fs.mkdir(path.join(profile,'Documents/My Games/Skyrim Special Edition'),{recursive:true});
 const freeContent=['ccBGSSSE001-Fish.esm','ccQDRSSE001-SurvivalMode.esl','ccBGSSSE037-Curios.esl','ccBGSSSE025-AdvDSGS.esm','_ResourcePack.esl'];
 const native=['SkyrimSE.exe','Data/Skyrim.esm','Data/Update.esm','Data/Dawnguard.esm','Data/HearthFires.esm','Data/Dragonborn.esm',...freeContent.map(n=>'Data/'+n),...new Set(plan.files.map(f=>f.source.installedArchive).filter(Boolean))];
 // Steam 1.6.1170 includes the four free Creations plus the resource pack.
 for(const name of native)await fs.copyFile(path.join(real,name),path.join(game,name));
 await fs.writeFile(path.join(game,'Skyrim.ccc'),freeContent.join('\r\n')+'\r\n');
 if(!process.env.FROSTVEIL_FRESH_FIXTURE)for(const f of plan.files)await assert.rejects(fs.access(path.join(game,f.path)));
 const graphics=new GraphicsPackService(storage);graphics.setSourceRepairTargets(plan.files.map(f=>f.path).filter(p=>/^Data\/(meshes\/|textures\/|[^/]+\.ini$)/i.test(p)));
 let last='';graphics.subscribe(s=>{const text=s.phase==='downloading'?`${s.phase} ${Math.floor(s.bytes/104857600)*100} MB / ${Math.round(s.totalBytes/1048576)} MB`:s.message;if(text!==last){last=text;console.log(text);}});
 await graphics.verifyAndEnforceForPlay(game,order);
 console.log('Base graphics installed in disposable vanilla fixture');
 let phase='';const result=await repairGraphicsSources(game,storage,async()=>false,plan,{sourceDirectories:[],progress:(p,n,total)=>{const text=p.startsWith('downloading ')?p+' '+Math.floor(n/10485760)*10+' MB':p+' '+Math.floor((n??0)/100)*100;if(text!==phase){phase=text;console.log(text);}}});
 for(const f of plan.files){const h=await hashFile(path.join(game,f.path));assert.equal(h.sha256,f.sha256,f.path);assert.equal(h.size,f.size,f.path);}
 assert.equal((await repairGraphicsSources(game,storage,async()=>false,plan,{sourceDirectories:[]})).changed,0);
 await repairClientForPlay(game,storage,async()=>false);
 downloads=new ProductionDownloads(storage,'0.1.14');await downloads.prepareForPlay(game,order);assert.equal(downloads.snapshot().installed,true);
 const runtime=await downloads.baselineProfile();runtime.files=await Promise.all(runtime.files.map(f=>clientRequirementForScan(f,game)));
 const scan=await scanInstallation(game,runtime,fileVersion);assert.equal(scan.ready,true,scan.errors.join('\n'));
 await graphics.verifyAndEnforceForPlay(game,order);
 assert.equal((await repairGraphicsSources(game,storage,async()=>false,plan,{sourceDirectories:[]})).changed,0,'Second complete Play should not reapply old graphics bytes');
 await downloads.prepareForPlay(game,order);
 const manifest=await graphics.fetchManifest(),active=await fs.readFile(path.join(order,'plugins.txt'),'utf8');for(const name of manifest.activePlugins){await fs.access(path.join(game,'Data',name));assert.ok(active.toLowerCase().includes('*'+name.toLowerCase()),name);}
 for(const f of before){if(f.absent)await assert.rejects(fs.access(path.join(real,f.path)));else assert.deepEqual(await hashFile(path.join(real,f.path)),{size:f.size,sha256:f.sha256},'Real player file changed '+f.path);}
 const report={passed:true,files:plan.files.length,sourceDirectories:[],sourceArchivesPreloaded:0,baseGraphicsInstalled:true,allActiveGraphicsPluginsPresent:true,bootstrapFiles:plan.bootstrap.files,signedServerPackInstalled:downloads.snapshot().installed,finalScanReady:scan.ready,secondPlayChanged:0,installedGameUnchanged:true,installedGameWrites:0,serverChanges:0,elapsedSeconds:(Date.now()-started)/1000};
 await fs.writeFile(path.join(out,'fresh-player-fixture-result.json'),JSON.stringify(report,null,2));passed=true;console.log(JSON.stringify(report));
}finally{downloads?.dispose();if(oldProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=oldProfile;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));if(passed)await fs.rm(root,{recursive:true,force:true});else{await fs.writeFile(path.join(out,'fresh-fixture-pointer.json'),JSON.stringify({root}));console.log('Disposable fixture retained for diagnosis: '+root);}}
