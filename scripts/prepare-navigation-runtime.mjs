// Reviewable local artifacts only: no network writes, live deployment, or installed-game changes.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {createHash,createPrivateKey,createPublicKey} from 'node:crypto';import {execFileSync} from 'node:child_process';import {crc32} from 'node:zlib';
import {core} from '../.local/player-release/core-loader.mjs';
const root=process.cwd(),out=path.resolve('.local/navigation-runtime-fix'),delivery=path.join(out,'delivery'),pack=path.join(delivery,'modpack'),content=path.join(pack,'reviewed-content');
const assetRoot=path.resolve('../mod-work/frostveil-courier-navigation'),r2='https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev';
const hash=b=>createHash('sha256').update(b).digest('hex'),identity=b=>({size:b.length,sha256:hash(b)}),write=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v,null,2)+'\n');};
await fs.mkdir(content,{recursive:true});
const pinText=await fs.readFile('src/main/graphics-source-pin.ts','utf8'),baseBytes=await fs.readFile('.local/spawn-facing/delivery/source-repair-plan.json');
assert.equal(hash(baseBytes),'62e28b229c5dd6e202e3bc775224cb28eb4e11740415b82ec1599b85c0100353');
const currentPin=JSON.parse(pinText.match(/graphicsSourcePin=(\{[\s\S]*?\}) as const/)[1]);
if(currentPin.sha256!==hash(baseBytes))assert.equal(hash(await fs.readFile(path.join(delivery,'source-repair-plan.json'))),currentPin.sha256,'Unexpected previous source pin');
const baseline=JSON.parse(baseBytes),recipe=structuredClone(baseline);assert.equal(recipe.version,'1.0.12');assert.equal(recipe.files.length,647);
recipe.version='1.0.13';recipe.minimumLauncherVersion='0.1.18';
const names=['Data/FrostveilCourierNavigation.esp','Data/Interface/Frostveil/CourierQuestTint.swf'],stage=path.join(out,'payload-stage');
const navigation=[];
for(const name of names){assert.ok(!recipe.files.some(f=>f.path===name));const bytes=await fs.readFile(path.join(assetRoot,'payload',name));await write(path.join(stage,name),bytes);navigation.push({path:name,...identity(bytes)});}
assert.equal(navigation[0].sha256,'600b551ea9d25eef622d360f2036704d6934f4a2f0aa5519b65a8783c3b90d15');
const archive=path.join(delivery,'Frostveil-navigation-runtime.zip');execFileSync('tar.exe',['-acf',archive,'Data'],{cwd:stage,windowsHide:true});const zipIdentity=identity(await fs.readFile(archive));
for(const file of navigation)recipe.files.push({...file,source:{archiveName:path.basename(archive),archiveSize:zipIdentity.size,archiveSha256:zipIdentity.sha256,downloadUrl:r2+'/sources/'+zipIdentity.sha256+'.zip',member:file.path}});
assert.deepEqual(recipe.files.slice(0,647),baseline.files);assert.equal(recipe.files.length,649);
recipe.navigationFix={regularEsp:true,optionalAlias:true,updateOnlyVm:true,tint:'additive SWF8, gold tracked / green within 200 world units in the destination world/cell',nativeGameplayVerified:false};
const recipeBytes=Buffer.from(JSON.stringify(recipe,null,2)+'\n'),recipePin={...identity(recipeBytes),url:r2+'/frostveil-graphics-source-repair-'+hash(recipeBytes)+'.json'};
await write(path.join(delivery,'source-repair-plan.json'),recipeBytes);await write(path.join(delivery,'source-repair-pin.json'),recipePin);
await write('src/main/graphics-source-pin.ts','// Navigation recipe; keeps all 647 existing client/mod targets unchanged.\nexport const graphicsSourcePin='+JSON.stringify(recipePin,null,2)+' as const;\n');
for(const name of ['package.json','package-lock.json']){const data=JSON.parse(await fs.readFile(name));assert.ok(['0.1.17','0.1.18'].includes(data.version));data.version='0.1.18';if(data.packages?.[''])data.packages[''].version='0.1.18';await write(name,data);}

const published=JSON.parse(await fs.readFile('.local/navigation-admin-release/modpack-published.json'));
const fresh=JSON.parse(execFileSync('gh',['api','repos/kaktv2016/frostveil-distribution/releases/latest'],{encoding:'utf8',windowsHide:true}));
assert.equal(fresh.id,published.id);assert.equal(fresh.tag_name,'pack-v1.0.5');assert.equal(fresh.immutable,true);
const old=core.authenticateRelease(JSON.parse(await fs.readFile('.local/navigation-admin-release/modpack/frostveil-manifest.json')),core.productionSource,fresh);
const manifest=structuredClone(old.manifest),server=structuredClone(old.server),version='1.0.6',tag='pack-v'+version,assets=[],mapping={};
manifest.packVersion=version;manifest.minimumLauncherVersion='0.1.18';manifest.generatedAt=new Date().toISOString();manifest.distribution.release.tag=tag;manifest.serverProfileVersion=version;
server.version=version;server.packVersion=version;server.generatedAt=manifest.generatedAt;server.expiresAt=new Date(Date.now()+6*86400000).toISOString();
const component='frostveil-courier-navigation',tint=navigation[1];assert.equal(manifest.components.filter(c=>c.id===component).length,1);
manifest.files.push({path:tint.path,size:tint.size,sha256:tint.sha256,componentId:component,role:'client',required:true,ownership:'custom-rp',permission:'Original Frostveil additive Scaleform tint helper; no replacement of vanilla/SkyUI menus.',distribution:'allowed',version:'1.0.0.0',package:{owner:'kaktv2016',repo:'frostveil-distribution',tag,assetId:1,assetName:'CourierQuestTint.swf',size:tint.size,sha256:tint.sha256,componentId:component,packVersion:version,rights:{kind:'owned',evidence:'Original Haxe source and build script in FrostveilCourierNavigation-source.zip, Haxe stdlib license included.',scope:'redistribution',reviewer:'frostveil-owner'}}});
let id=1001;
for(const file of manifest.files.filter(f=>f.package)){
 const update=navigation.find(n=>n.path===file.path);const bytes=update?await fs.readFile(path.join(stage,file.path)):await fs.readFile(path.join('.local/production-candidates/modpack-pack-v1.0.5/reviewed-content',file.package.assetName));
 if(!update)assert.equal(hash(bytes),file.sha256);
 Object.assign(file,identity(bytes));Object.assign(file.package,identity(bytes),{tag,packVersion:version,assetId:id++});mapping[file.package.assetName]=file.package.assetName;
 await write(path.join(content,file.package.assetName),bytes);assets.push({name:file.package.assetName,path:file.path,...identity(bytes)});
}
const plugin=manifest.requiredPlugins.find(p=>p.filename==='FrostveilCourierNavigation.esp');assert.equal(plugin.order,5);plugin.sha256=navigation[0].sha256;
const serverPlugin=server.plugins.find(p=>p.filename===plugin.filename);Object.assign(serverPlugin,plugin,{size:navigation[0].size,crc32:crc32(await fs.readFile(path.join(stage,navigation[0].path)))|0});
assert.deepEqual(manifest.files.filter(f=>f.distribution==='external-only'),old.manifest.files.filter(f=>f.distribution==='external-only'));
for(const oldFile of old.manifest.files.filter(f=>/amber|column/.test(f.path)))assert.equal(manifest.files.find(f=>f.path===oldFile.path).sha256,oldFile.sha256);
const signingKey=createPrivateKey(await fs.readFile(path.join(os.homedir(),'.codex/frostveil-signing/production-candidates-20261016/modpack-publisher-private.pem')));
const fingerprint=hash(createPublicKey(signingKey).export({type:'spki',format:'der'}));assert.equal(fingerprint,'7eded189b364ffc31c5c9730c7b73c0b13424b60576313a0197a6327b5633369');
const preview={id:90001,tag_name:tag,draft:false,prerelease:false,immutable:true,published_at:manifest.generatedAt,body:'LOCAL CANDIDATE ONLY; placeholder GitHub IDs, rebind and re-sign after approved upload.',assets:assets.map((a,i)=>({id:1001+i,name:a.name,size:a.size,state:'uploaded',digest:'sha256:'+a.sha256}))};
const prepared=await core.prepareRelease(manifest,server,content,mapping,signingKey,core.productionSource,preview);
for(const [name,data]of Object.entries({'unsigned-manifest-and-server.json':{manifest,server},'mapping.json':mapping,'candidate-envelope.json':prepared.envelope,'preview-release.json':preview}))await write(path.join(pack,name),data);
const serverBytes=await fs.readFile('../skymp/rp-gamemode/dist/rp-gamemode.cjs'),bundle='rp-gamemode-'+hash(serverBytes)+'.cjs';await write(path.join(delivery,bundle),serverBytes);
const liveConfig=JSON.parse(await fs.readFile('../skymp/build/dist/server/server-settings.json'));
assert.equal(liveConfig.listenHost,'127.0.0.1');assert.equal(liveConfig.offlineMode,true);assert.equal(liveConfig.loadOrder.length,6);
const liveWrapper=identity(await fs.readFile('../skymp/build/dist/server/dist_back/skymp5-server.js'));
assert.equal(liveWrapper.sha256,'1e8511088812e379e2237216ef294c7b94877057c1a13f3a18fb655456c1be95');
const activeBundle=identity(await fs.readFile(liveConfig.gamemodePath)),activeEsp=identity(await fs.readFile(liveConfig.loadOrder[5]));
const plan={status:'CANDIDATE_NOT_PUBLISHED_OR_DEPLOYED',launcherVersion:'0.1.18',modpackVersion:version,recipeVersion:recipe.version,recipeFiles:649,unchangedRecipeTargets:647,navigation,recipe:recipePin,archive:{path:archive,...zipIdentity,url:recipe.files[648].source.downloadUrl},modpack:{directory:pack,tag,assets,publisherFingerprint:fingerprint,placeholderIds:true},server:{bundle:{path:path.join(delivery,bundle),...identity(serverBytes)},before:{bundle:activeBundle,esp:activeEsp,wrapper:liveWrapper},wrapperUnchanged:true,loadOrderUnchanged:true,visiblePowerShellRequired:true,localAdminAccount:'owner',sessionGrant:'OS operator must explicitly bind the current owner session; profile/name/connection alone never grants admin'},rollback:{worldRestore:false,worldMigration:false,codeConfigBackup:true,client:'Preserve atomic source-repair originals; immutable releases and version ledger require a forward fix, never overwrite an existing tag.',server:'Restore backed-up gamemodePath and ESP together; keep current world/economy files.'},nativeClientProof:'PENDING: real Map, compass, door handoff, gold/green, TCL on/off and speed/reset',installedGameWrites:0,liveServerWrites:0,worldWrites:0,serverRestarts:0};
await write(path.join(delivery,'deployment-plan.json'),plan);await write(path.join(delivery,'deployment-plan.sha256'),hash(Buffer.from(JSON.stringify(plan,null,2)+'\n'))+'\n');
console.log(JSON.stringify({status:plan.status,launcher:plan.launcherVersion,recipe:recipePin,targets:649,unchanged:647,navigation,bundle:identity(serverBytes),candidateSignature:'VERIFIED against placeholder release ONLY'}));
