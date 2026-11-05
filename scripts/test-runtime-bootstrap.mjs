// Builds the normal 7777 player profile from owned, verified Steam staging.
// Never starts Skyrim and never writes into an installed Steam library.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {build} from 'esbuild';
const out=path.resolve('.local/runtime-normalization'),source=path.resolve(process.argv[2]??'');
if(process.argv.length!==3)throw Error('Usage: node scripts/test-runtime-bootstrap.mjs <verified-owned-steam-staging>');
const receipt=JSON.parse(await fs.readFile(path.join(out,'acquisition-receipt.json'),'utf8'));assert.equal(receipt.runtime,'1.6.1170.0');assert.equal(receipt.depots.length,3);
await build({entryPoints:['src/main/files.ts','src/main/windows.ts','src/main/graphics-source-plan.ts','src/main/graphics-source-repair.ts','src/main/management/graphics-pack.ts','src/main/management/downloads.ts','src/main/installation.ts','src/main/client-repair.ts'],outdir:path.join(out,'bootstrap-harness'),bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},packages:'external'});
const require=createRequire(import.meta.url),load=n=>require(path.join(out,'bootstrap-harness',n+'.cjs')),{safeFile,hashFile,noLinks}=load('files'),{fileVersion}=load('windows'),{loadGraphicsSourcePlan}=load('graphics-source-plan'),{repairGraphicsSources}=load('graphics-source-repair'),{GraphicsPackService}=load('management/graphics-pack'),{ProductionDownloads}=load('management/downloads'),{scanInstallation}=load('installation'),{clientRequirementForScan,nativeRequirementForScan}=load('client-repair');
const fixtureRoot=await fs.mkdtemp('D:/FrostveilRuntimeBootstrap-'),game=path.join(fixtureRoot,'game'),storage=path.join(fixtureRoot,'storage'),order=path.join(fixtureRoot,'order'),user=path.join(fixtureRoot,'user');
await fs.writeFile(path.join(fixtureRoot,'fixture.json'),JSON.stringify({type:'frostveil-runtime-bootstrap',createdAt:new Date().toISOString()}));
await fs.writeFile(path.join(out,'bootstrap-pointer.json'),JSON.stringify({fixtureRoot,game,storage,order,user},null,2));for(const dir of [game,storage,order,user])await fs.mkdir(dir,{recursive:true});
const started=Date.now(),oldUser=process.env.USERPROFILE;let downloads;
try{
 process.env.USERPROFILE=user;
 for(const f of receipt.files){const owned=await safeFile(source,f.depot+'/'+f.path);assert.deepEqual(await hashFile(owned,8*1024**3),{size:f.size,sha256:f.sha256});const target=path.join(game,...f.path.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(owned,target);}
 const creations=receipt.files.filter(f=>/^Data\/(cc.+|_ResourcePack)\.(esm|esl)$/i.test(f.path)).map(f=>path.basename(f.path));await fs.writeFile(path.join(game,'Skyrim.ccc'),creations.join('\r\n')+'\r\n');
 const plan=await loadGraphicsSourcePlan(storage);assert.equal(plan.files.length,649);
 for(const f of plan.files)await assert.rejects(fs.stat(path.join(game,f.path)));
 const graphics=new GraphicsPackService(storage),historical=JSON.parse(await fs.readFile('.local/fresh-install-audit/graphics-manifest.json','utf8')),manifest=await graphics.fetchManifest();
 for(const key of ['sha256','size','integrityPatchSha256','integrityPatchSize'])assert.equal(manifest[key],historical[key],'Reviewed graphics archive identity changed');
 graphics.setSourceRepairTargets(plan.files.map(f=>f.path).filter(p=>/^Data\/(meshes\/|textures\/|[^/]+\.ini$)/i.test(p)));
 let last='';graphics.subscribe(s=>{const status=s.phase==='downloading'?s.phase+' '+Math.floor(s.bytes/104857600)*100+'MB':s.message;if(last!==status){last=status;console.log(status);}});
 await graphics.verifyAndEnforceForPlay(game,order);
 await repairGraphicsSources(game,storage,async()=>false,plan,{sourceDirectories:[],progress:(phase,bytes)=>{const s=phase+' '+Math.floor((bytes??0)/104857600)*100+'MB';if(s!==last){last=s;console.log(s);}}});
 const version=JSON.parse(await fs.readFile('package.json','utf8')).version;downloads=new ProductionDownloads(storage,version);
 await downloads.prepareForPlay(game,order);assert.equal(downloads.snapshot().installed,true);
 let profile=await downloads.baselineProfile();profile.files=await Promise.all(profile.files.map(async f=>nativeRequirementForScan(await clientRequirementForScan(f,game),game)));
 assert.equal((await scanInstallation(game,profile,fileVersion)).ready,true);
 const managedFiles=[],official=new Set(receipt.files.map(f=>f.path.toLowerCase()));
 async function inventory(folder,prefix=''){await noLinks(folder);for(const e of await fs.readdir(folder,{withFileTypes:true})){const rel=prefix+e.name;if(e.isSymbolicLink())throw Error('Redirected fixture member');if(e.isDirectory()){await inventory(path.join(folder,e.name),rel+'/');continue;}if(rel==='Skyrim.ccc'||official.has(rel.toLowerCase()))continue;managedFiles.push({path:rel,...await hashFile(await safeFile(game,rel),8*1024**3)});}}
 await inventory(game);
 for(const f of plan.files)assert.deepEqual(await hashFile(await safeFile(game,f.path)),{size:f.size,sha256:f.sha256});
 const plugins=await fs.readFile(path.join(order,'plugins.txt'),'utf8'),loadorder=await fs.readFile(path.join(order,'loadorder.txt'),'utf8');
 const result={passed:true,fixtureRoot,game,storage,order,version,recipeVersion:plan.version,managedFiles,creations,pluginOrder:plugins.replace(/^\uFEFF/,'').split(/\r?\n/).filter(l=>l.startsWith('*')).map(l=>l.slice(1)),configuration:{pluginsBase64:Buffer.from(plugins).toString('base64'),loadorderBase64:Buffer.from(loadorder).toString('base64')},finalScanReady:true,installedGameWrites:0,skyrimLaunched:false,elapsedSeconds:(Date.now()-started)/1000};
 await fs.writeFile(path.join(out,'bootstrap-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,managedFiles:managedFiles.length,elapsedSeconds:result.elapsedSeconds,fixtureRoot}));
}finally{downloads?.dispose();if(oldUser===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=oldUser;}
