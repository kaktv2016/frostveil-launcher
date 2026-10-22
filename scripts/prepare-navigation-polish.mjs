// Creates a local, reviewable candidate only. It never uploads, deploys, starts
// the server, or writes to an installed Skyrim directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash,createPrivateKey,createPublicKey} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workspace=path.resolve(root,'..');
const baseline=path.join(root,'.local/navigation-containers-fix/delivery');
const out=path.join(root,'.local/navigation-polish');
const delivery=path.join(out,'delivery');
const targetPath='Data/Interface/Frostveil/CourierQuestTint.swf';
const swfSource=path.join(workspace,'mod-work/frostveil-courier-navigation/payload',targetPath);
const bundleSource=path.join(workspace,'skymp/rp-gamemode/dist/rp-gamemode.cjs');
const r2='https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev';
const hash=b=>createHash('sha256').update(b).digest('hex');
const identity=b=>({size:b.length,sha256:hash(b)});
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,Buffer.isBuffer(v)||typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});};
const verify=async(p,s)=>{const b=await fs.readFile(p);assert.deepEqual(identity(b),{size:s.size,sha256:s.sha256},'Identity mismatch: '+p);return b;};
const api=p=>JSON.parse(execFileSync('gh',['api',p],{encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024}));

export async function core(){await fs.mkdir(out,{recursive:true});const outfile=path.join(out,'workflow-core.cjs');await build({stdin:{contents:"export {productionSource,authenticateRelease} from './src/main/distribution/policy';export {prepareRelease} from './src/main/distribution/prepare';export {productionLauncherUpdateSource,authenticateLauncherUpdate,signLauncherUpdateManifest} from './src/main/update-integrity';export {decodeGraphicsSourcePlan} from './src/main/graphics-source-plan';export {repairGraphicsSources} from './src/main/graphics-source-repair';",resolveDir:root},outfile,bundle:true,platform:'node',format:'cjs',packages:'external'});return createRequire(import.meta.url)(outfile);}

async function prepare(){
 assert.equal(await fs.stat(delivery).then(()=>true,()=>false),false,'Candidate already exists; never overwrite reviewed artifacts');
 const c=await core(),packRelease=api('repos/kaktv2016/frostveil-distribution/releases/tags/pack-v1.0.7'),launcherRelease=api('repos/kaktv2016/frostveil-launcher/releases/tags/v0.1.19');
 assert.equal(api('repos/kaktv2016/frostveil-distribution/releases/latest').id,packRelease.id);assert.equal(api('repos/kaktv2016/frostveil-launcher/releases/latest').id,launcherRelease.id);
 const authenticated=c.authenticateRelease(await read(path.join(baseline,'frostveil-manifest.json')),c.productionSource,packRelease);
 assert.equal(authenticated.manifest.packVersion,'1.0.7');assert.equal(authenticated.manifest.minimumLauncherVersion,'0.1.19');
 const oldPin=await read(path.join(baseline,'source-repair-pin.json')),oldRecipeBytes=await verify(path.join(baseline,'source-repair-plan.json'),oldPin),recipe=JSON.parse(oldRecipeBytes);
 assert.equal(recipe.version,'1.0.14');assert.equal(recipe.files.length,649);
 const swf=await fs.readFile(swfSource),nextIdentity=identity(swf),target=recipe.files.find(f=>f.path===targetPath);assert.ok(target);const previous={size:target.size,sha256:target.sha256};
 assert.notDeepEqual(nextIdentity,previous);const stage=path.join(out,'payload-stage');await fs.mkdir(path.join(stage,path.dirname(targetPath)),{recursive:true});await fs.writeFile(path.join(stage,targetPath),swf);
 await fs.mkdir(delivery,{recursive:true});const archive=path.join(delivery,'Frostveil-quest-tint.zip');execFileSync('tar.exe',['-acf',archive,'Data'],{cwd:stage,windowsHide:true});const archiveIdentity=identity(await fs.readFile(archive));
 Object.assign(target,nextIdentity,{source:{archiveName:path.basename(archive),archiveSize:archiveIdentity.size,archiveSha256:archiveIdentity.sha256,downloadUrl:r2+'/sources/'+archiveIdentity.sha256+'.zip',member:targetPath},previous:[previous]});
 recipe.version='1.0.15';recipe.minimumLauncherVersion='0.1.20';const recipeBytes=Buffer.from(JSON.stringify(recipe,null,2)+'\n'),pin={...identity(recipeBytes),url:r2+'/frostveil-graphics-source-repair-'+hash(recipeBytes)+'.json'};
 await write(path.join(delivery,'source-repair-plan.json'),recipeBytes);await write(path.join(delivery,'source-repair-pin.json'),pin);
 const manifest=structuredClone(authenticated.manifest),server=structuredClone(authenticated.server),version='1.0.8',tag='pack-v'+version,generatedAt=new Date().toISOString();manifest.packVersion=version;manifest.minimumLauncherVersion='0.1.20';manifest.generatedAt=generatedAt;manifest.serverProfileVersion=version;manifest.distribution.release.tag=tag;server.version=version;server.packVersion=version;server.generatedAt=generatedAt;server.expiresAt=new Date(Date.now()+6*86400000).toISOString();
 const content=path.join(delivery,'modpack/reviewed-content'),mapping={},assets=[];let assetId=2001;
 for(const file of manifest.files.filter(f=>f.package)){const source=file.path===targetPath?swf:await fs.readFile(path.join(baseline,'modpack/reviewed-content',file.package.assetName));if(file.path!==targetPath)assert.deepEqual(identity(source),{size:file.size,sha256:file.sha256});Object.assign(file,identity(source));Object.assign(file.package,identity(source),{tag,packVersion:version,assetId:assetId++});mapping[file.package.assetName]=file.package.assetName;await write(path.join(content,file.package.assetName),source);assets.push({name:file.package.assetName,path:file.path,...identity(source)});}
 assert.deepEqual(manifest.files.filter(f=>f.path!==targetPath).map(f=>({path:f.path,size:f.size,sha256:f.sha256})),authenticated.manifest.files.filter(f=>f.path!==targetPath).map(f=>({path:f.path,size:f.size,sha256:f.sha256})));
 const signingKey=createPrivateKey(await fs.readFile(path.join(os.homedir(),'.codex/frostveil-signing/production-candidates-20261016/modpack-publisher-private.pem'))),fingerprint=hash(createPublicKey(signingKey).export({type:'spki',format:'der'}));assert.equal(fingerprint,'7eded189b364ffc31c5c9730c7b73c0b13424b60576313a0197a6327b5633369');
 const preview={id:90008,tag_name:tag,draft:false,prerelease:false,immutable:true,published_at:generatedAt,body:'LOCAL CANDIDATE ONLY. Placeholder release/asset IDs require a separately approved publication.',assets:assets.map((a,i)=>({id:2001+i,name:a.name,size:a.size,state:'uploaded',digest:'sha256:'+a.sha256}))};
 const prepared=await c.prepareRelease(manifest,server,content,mapping,signingKey,c.productionSource,preview);await write(path.join(delivery,'modpack/candidate-envelope.json'),prepared.envelope);await write(path.join(delivery,'modpack/preview-release.json'),preview);await write(path.join(delivery,'modpack/mapping.json'),mapping);await write(path.join(delivery,'modpack/unsigned-manifest-and-server.json'),{manifest,server});
 const bundle=await fs.readFile(bundleSource),bundleIdentity=identity(bundle),bundleTarget=path.join(delivery,'rp-gamemode-'+bundleIdentity.sha256+'.cjs');await write(bundleTarget,bundle);
 const plan={status:'LOCAL_CANDIDATE_ONLY_NOT_PUBLISHED_INSTALLED_OR_DEPLOYED',launcherVersion:'0.1.20',modpackVersion:version,recipeVersion:'1.0.15',recipeFiles:649,unchangedRecipeTargets:648,changedTarget:targetPath,swf:{path:swfSource,...nextIdentity,previous},recipe:pin,archive:{path:archive,...archiveIdentity,url:r2+'/sources/'+archiveIdentity.sha256+'.zip'},server:{bundle:{path:bundleTarget,...bundleIdentity},liveWrites:0},modpack:{tag,directory:path.join(delivery,'modpack'),assets,publisherFingerprint:fingerprint,placeholderIds:true,publicationAuthorized:false},baseline:{packReleaseId:packRelease.id,launcherReleaseId:launcherRelease.id,recipe:oldPin},launcherSourceUpdated:false,installedGameWrites:0,worldWrites:0,uploads:0,nativeAcceptance:{amberDefault:'PENDING',mapTint:'PENDING',discoveryReconnect:'PENDING'}};
 const bytes=Buffer.from(JSON.stringify(plan,null,2)+'\n');await write(path.join(delivery,'candidate-plan.json'),bytes);await write(path.join(delivery,'candidate-plan.sha256'),hash(bytes)+'\n');console.log(JSON.stringify({status:plan.status,planSHA256:hash(bytes),swf:plan.swf,recipe:pin,bundle:plan.server.bundle}));
}

async function updateSource(expected){const bytes=await fs.readFile(path.join(delivery,'candidate-plan.json')),plan=JSON.parse(bytes);assert.equal(expected,hash(bytes),'Candidate hash approval mismatch');assert.equal(plan.launcherVersion,'0.1.20');
 const pin=await read(path.join(delivery,'source-repair-pin.json'));await verify(path.join(delivery,'source-repair-plan.json'),pin);const pinFile=path.join(root,'src/main/graphics-source-pin.ts'),pinText=await fs.readFile(pinFile,'utf8');assert.ok(pinText.includes(plan.baseline.recipe.sha256));
 for(const file of ['src/main/graphics-source-plan.ts','src/main/graphics-source-repair.ts']){const p=path.join(root,file),text=await fs.readFile(p,'utf8');assert.ok(text.includes("'1.0.14'")&&!text.includes("'1.0.15'"));await fs.writeFile(p,text.replace("'1.0.14']","'1.0.14','1.0.15']"));}
 const pkg=await read(path.join(root,'package.json')),lock=await read(path.join(root,'package-lock.json'));assert.equal(pkg.version,'0.1.19');pkg.version='0.1.20';lock.version='0.1.20';lock.packages[''].version='0.1.20';await fs.writeFile(path.join(root,'package.json'),JSON.stringify(pkg,null,2)+'\n');await fs.writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');await fs.writeFile(pinFile,'// Courier objective tint recipe; the other 648 repair targets are unchanged.\nexport const graphicsSourcePin='+JSON.stringify(pin,null,2)+' as const;\n');
 plan.launcherSourceUpdated=true;const next=Buffer.from(JSON.stringify(plan,null,2)+'\n');await fs.writeFile(path.join(delivery,'candidate-plan.json'),next);await fs.writeFile(path.join(delivery,'candidate-plan.sha256'),hash(next)+'\n');console.log(JSON.stringify({status:'LOCAL_LAUNCHER_SOURCE_UPDATED',planSHA256:hash(next),launcherVersion:'0.1.20',recipe:pin}));}

async function verifyCandidate(){const c=await core(),plan=await read(path.join(delivery,'candidate-plan.json')),pin=await read(path.join(delivery,'source-repair-pin.json')),recipeBytes=await verify(path.join(delivery,'source-repair-plan.json'),pin),recipe=c.decodeGraphicsSourcePlan(recipeBytes,pin);assert.equal(recipe.version,'1.0.15');assert.equal(recipe.files.length,649);
 const changed=recipe.files.filter(f=>f.path===targetPath);assert.equal(changed.length,1);assert.deepEqual({size:changed[0].size,sha256:changed[0].sha256},{size:plan.swf.size,sha256:plan.swf.sha256});assert.deepEqual(changed[0].previous,[plan.swf.previous]);
 c.authenticateRelease(await read(path.join(delivery,'modpack/candidate-envelope.json')),c.productionSource,await read(path.join(delivery,'modpack/preview-release.json')));
 for(const asset of plan.modpack.assets)await verify(path.join(delivery,'modpack/reviewed-content',asset.name),asset);
 const fixture=await fs.mkdtemp(path.join(out,'repair-fixture-')),game=path.join(fixture,'game'),storage=path.join(fixture,'storage'),installed=path.join(game,targetPath);await fs.mkdir(path.dirname(installed),{recursive:true});await fs.writeFile(installed,await verify(path.join(baseline,'modpack/reviewed-content/CourierQuestTint.swf'),plan.swf.previous));
 const subset={...recipe,files:changed},options={sourceDirectories:[delivery]};await assert.rejects(c.repairGraphicsSources(game,storage,async()=>true,subset,options),/running/i);assert.deepEqual(identity(await fs.readFile(installed)),plan.swf.previous);
 const repaired=await c.repairGraphicsSources(game,storage,async()=>false,subset,options);assert.equal(repaired.changed,1);assert.deepEqual(identity(await fs.readFile(installed)),{size:plan.swf.size,sha256:plan.swf.sha256});const second=await c.repairGraphicsSources(game,storage,async()=>false,subset,options);assert.equal(second.changed,0);
 console.log(JSON.stringify({status:'LOCAL_CANDIDATE_VERIFIED',fixture,targets:649,changedTargets:1,runningGameRefused:true,rollbackBackup:true,secondPlayWrites:0,installedGameWrites:0,uploads:0}));}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const args=process.argv.slice(2);process.chdir(root);if(args[0]==='--prepare')await prepare();else if(args[0]==='--update-source')await updateSource(args[1]);else if(args[0]==='--verify')await verifyCandidate();else throw Error('Use --prepare, --verify, or --update-source <candidate SHA-256>');}
