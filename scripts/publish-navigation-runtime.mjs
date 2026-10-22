// Local preflight by default. All remote mutations require explicit approval of the sealed plan.
import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import assert from'node:assert/strict';import{createHash,createPrivateKey,createPublicKey}from'node:crypto';import{execFileSync}from'node:child_process';import{load as yaml}from'js-yaml';
import{core}from'../.local/player-release/core-loader.mjs';
const delivery=path.resolve('.local/navigation-runtime-fix/delivery'),expected='4a3bd3bce682643cf56302959e0b647f4fd7841bfe94e3640c3d7b41a62cfda5';
const hash=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await fs.readFile(p));
const planBytes=await fs.readFile(path.join(delivery,'deployment-plan.json'));assert.equal(hash(planBytes),expected);const plan=JSON.parse(planBytes);
const verifyFile=async spec=>{const b=await fs.readFile(spec.path);assert.equal(b.length,spec.size);assert.equal(hash(b),spec.sha256);return b;};
for(const spec of [plan.installer,plan.correspondingSource,plan.modpack.correspondingSource,plan.server.bundle])await verifyFile(spec);
const packRoot=path.join(delivery,'modpack'),draftCandidate=core.authenticateRelease(await read(path.join(packRoot,'candidate-envelope.json')),core.productionSource,await read(path.join(packRoot,'preview-release.json')));
assert.equal(draftCandidate.manifest.packVersion,'1.0.6');assert.equal(draftCandidate.manifest.minimumLauncherVersion,'0.1.18');assert.ok(Date.parse(draftCandidate.server.expiresAt)>Date.now()+3600000,'Candidate profile too close to expiry; stop and report');
for(const file of draftCandidate.manifest.files.filter(f=>f.package)){const spec=plan.modpack.assets.find(a=>a.name===file.package.assetName);assert.ok(spec);assert.equal(spec.path,file.path);assert.equal(spec.sha256,file.sha256);assert.equal(spec.size,file.size);await verifyFile({...spec,path:path.join(packRoot,'reviewed-content',spec.name)});}
const latestPath=path.resolve('release/latest.yml'),latest=yaml(await fs.readFile(latestPath,'utf8')),installerBytes=await verifyFile(plan.installer),installerName=path.basename(plan.installer.path),installerSha512=createHash('sha512').update(installerBytes).digest('base64');
assert.equal(latest.version,'0.1.18');assert.equal(latest.path,installerName);assert.equal(latest.sha512,installerSha512);
if(!process.argv.includes('--apply')){console.log(JSON.stringify({status:'READ_ONLY_PREFLIGHT_PASS',planSHA256:expected,modpackPayloads:plan.modpack.assets.length,launcherVersion:'0.1.18',candidateSignature:'LOCAL_ONLY',remoteMutations:0}));process.exit(0);}
assert.ok(process.argv.includes('--approved-plan='+expected),'Exact owner-approved plan hash required');
assert.equal((await read(path.join(delivery,'r2-verification.json'))).planSHA256,expected);assert.equal((await read(path.join(delivery,'r2-verification.json'))).anonymousVerification,'PASS');
const backup=await read('.local/production-release/offline-backup-verification.json');assert.equal(backup.driveAbsentVerified,true);assert.equal(backup.recoveryFingerprintAndChallenge,'PASS');
const call=(args,input)=>execFileSync('gh',args,{input,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe'],maxBuffer:16*1024*1024}),api=p=>JSON.parse(call(['api',p]));
const mutate=(method,p,data)=>JSON.parse(call(['api','--method',method,p,'--input','-'],JSON.stringify(data))),stateFile=path.join(delivery,'publication-state.json');
let state={};try{state=await read(stateFile);}catch(e){if(e.code!=='ENOENT')throw e;}
assert.equal(api('user').login,'kaktv2016');
async function writeState(){await fs.writeFile(stateFile,JSON.stringify(state,null,2)+'\n');}
async function signingKey(source,filename){const keyId=Object.keys(source.keys)[0],pin=source.keys[keyId];assert.equal(pin.revoked,false);assert.ok(Date.parse(pin.expiresAt)>Date.now());const key=createPrivateKey(await fs.readFile(path.join(os.homedir(),'.codex/frostveil-signing/production-candidates-20261016',filename)));assert.equal(createPublicKey(key).export({type:'spki',format:'pem'}).toString(),pin.publicKey);return{key,keyId,pin};}
async function releaseFor(repo,tag,title,notes){
 // GitHub's by-tag endpoint omits drafts. Resume our exact recorded ID first.
 if(state[tag]){const r=api('repos/'+repo+'/releases/'+state[tag]);assert.equal(r.tag_name,tag);return r;}
 let r;try{r=api('repos/'+repo+'/releases/tags/'+tag);}catch(e){if(!String(e.stderr).includes('404'))throw e;}
 if(r){assert.equal(state[tag],r.id,'Existing release is not owned by this publication operation');return r;}
 assert.equal(api('repos/'+repo).private,false);
 r=mutate('POST','repos/'+repo+'/releases',{tag_name:tag,target_commitish:api('repos/'+repo+'/commits/main').sha,name:title,draft:true,prerelease:false,body:notes});state[tag]=r.id;await writeState();return r;
}
async function upload(repo,r,spec){
 const b=await verifyFile(spec),old=r.assets.find(a=>a.name===spec.name);
 if(old){assert.equal(old.size,b.length);assert.equal(old.digest,'sha256:'+spec.sha256);return r;}
 assert.equal(r.draft,true,'Published immutable releases cannot receive uploads');call(['release','upload',r.tag_name,spec.path,'--repo',repo]);r=api('repos/'+repo+'/releases/'+r.id);const a=r.assets.find(a=>a.name===spec.name);assert.equal(a.size,b.length);assert.equal(a.digest,'sha256:'+spec.sha256);return r;
}
async function fileSpec(file,name=path.basename(file)){const b=await fs.readFile(file);return{name,path:file,size:b.length,sha256:hash(b)};}
const packRepo='kaktv2016/frostveil-distribution',packTag='pack-v1.0.6';
let packRelease=await releaseFor(packRepo,packTag,'Frostveil RP Pack 1.0.6 — Courier Navigation Runtime Fix','Corrected optional Quest aliases and additive gold/green Frostveil Map markers. Existing beam and client JS unchanged. Native Map/compass/door routing and administrator flight/speed remain owner gameplay acceptance pending. Launcher 0.1.18 required; payload delivery through Cloudflare R2. No source push, world reset or migration.');
const allowedPackNames=[...plan.modpack.assets.map(a=>a.name),path.basename(plan.modpack.correspondingSource.path),'frostveil-manifest.json'];assert.ok(packRelease.assets.every(a=>allowedPackNames.includes(a.name)));
for(const a of plan.modpack.assets)packRelease=await upload(packRepo,packRelease,{...a,path:path.join(packRoot,'reviewed-content',a.name)});
packRelease=await upload(packRepo,packRelease,{...plan.modpack.correspondingSource,name:path.basename(plan.modpack.correspondingSource.path)});
const manifest=structuredClone(draftCandidate.manifest),server=structuredClone(draftCandidate.server),mapping=await read(path.join(packRoot,'mapping.json'));
for(const file of manifest.files.filter(f=>f.package)){const asset=packRelease.assets.find(a=>a.name===file.package.assetName);assert.ok(asset);file.package.assetId=asset.id;}
const packKey=await signingKey(core.productionSource,'modpack-publisher-private.pem');
const prepared=await core.prepareRelease(manifest,server,path.join(packRoot,'reviewed-content'),mapping,packKey.key,core.productionSource,{...packRelease,draft:false,immutable:true,published_at:packRelease.published_at||new Date().toISOString()});
const envelopePath=path.join(delivery,'frostveil-manifest.json');await fs.writeFile(envelopePath,JSON.stringify(prepared.envelope,null,2)+'\n');packRelease=await upload(packRepo,packRelease,await fileSpec(envelopePath));
if(packRelease.draft)packRelease=mutate('PATCH','repos/'+packRepo+'/releases/'+packRelease.id,{draft:false,make_latest:'true'});packRelease=api('repos/'+packRepo+'/releases/'+packRelease.id);assert.equal(packRelease.immutable,true);core.authenticateRelease(prepared.envelope,core.productionSource,packRelease);

const launcherRepo='kaktv2016/frostveil-launcher',tag='v0.1.18',notes='Frostveil Launcher 0.1.18 adds exact pinned R2 repair of the Courier navigation ESP and additive Map tint, and prevents the legacy graphics verifier from restoring the old ESP. All 647 existing client/mod recipe entries, including client JS 0.1.17, remain unchanged. 221 RP tests, 477 Launcher tests, packaged smoke and disposable repair/rollback/idempotence tests passed. Actual native Map/compass/door and admin movement proof remains pending. Independent Ed25519 updater verification retained. Corresponding source SHA-256: '+plan.correspondingSource.sha256+'.';
let launcherRelease=await releaseFor(launcherRepo,tag,'Frostveil Launcher 0.1.18 — Courier Navigation Delivery',notes);
const launcherFiles=[{...plan.installer,name:installerName},await fileSpec(plan.installer.path+'.blockmap'),await fileSpec(latestPath),{...plan.correspondingSource,name:path.basename(plan.correspondingSource.path)}];
assert.ok(launcherRelease.assets.every(a=>[...launcherFiles.map(f=>f.name),'frostveil-launcher-update.json'].includes(a.name)));
for(const f of launcherFiles)launcherRelease=await upload(launcherRepo,launcherRelease,f);
const updateKey=await signingKey(core.productionLauncherUpdateSource,'launcher-update-private.pem'),installerAsset=launcherRelease.assets.find(a=>a.name===installerName),updatePath=path.join(delivery,'frostveil-launcher-update.json');
let updateEnvelope;
if(launcherRelease.assets.some(a=>a.name==='frostveil-launcher-update.json'))updateEnvelope=await read(updatePath);
else{updateEnvelope=core.signLauncherUpdateManifest({schemaVersion:1,keyId:updateKey.keyId,owner:'kaktv2016',repo:'frostveil-launcher',tag,version:'0.1.18',channel:'stable',minimumLauncherVersion:'0.1.6',publishedAt:new Date().toISOString(),expiresAt:updateKey.pin.expiresAt,releaseNotes:notes,installer:{assetId:installerAsset.id,assetName:installerName,size:plan.installer.size,sha256:plan.installer.sha256,sha512:installerSha512}},updateKey.key);await fs.writeFile(updatePath,JSON.stringify(updateEnvelope,null,2)+'\n');}
launcherRelease=await upload(launcherRepo,launcherRelease,await fileSpec(updatePath));
core.authenticateLauncherUpdate(updateEnvelope,core.productionLauncherUpdateSource,{...launcherRelease,draft:false,published_at:launcherRelease.published_at||new Date().toISOString()},'0.1.17');
if(launcherRelease.draft)launcherRelease=mutate('PATCH','repos/'+launcherRepo+'/releases/'+launcherRelease.id,{draft:false,make_latest:'true'});launcherRelease=api('repos/'+launcherRepo+'/releases/'+launcherRelease.id);core.authenticateLauncherUpdate(updateEnvelope,core.productionLauncherUpdateSource,launcherRelease,'0.1.17');

async function anonymousBytes(url,size,sha256){const response=await fetch(url,{signal:AbortSignal.timeout(120000)});assert.equal(response.status,200);let received=0;const digest=createHash('sha256'),parts=[];for await(const chunk of response.body){received+=chunk.length;assert.ok(received<=size);digest.update(chunk);if(size<2*1024*1024)parts.push(Buffer.from(chunk));}assert.equal(received,size);assert.equal(digest.digest('hex'),sha256);return parts.length?Buffer.concat(parts):null;}
const checks=[];
for(const [repo,release,specs]of [[packRepo,packRelease,[...plan.modpack.assets.map(a=>({...a,path:path.join(packRoot,'reviewed-content',a.name)})),{...plan.modpack.correspondingSource,name:path.basename(plan.modpack.correspondingSource.path)},await fileSpec(envelopePath)]],[launcherRepo,launcherRelease,[...launcherFiles,await fileSpec(updatePath)]]]){
 const publicResponse=await fetch('https://api.github.com/repos/'+repo+'/releases/tags/'+release.tag_name,{signal:AbortSignal.timeout(30000)});assert.equal(publicResponse.status,200);const publicRelease=await publicResponse.json();assert.equal(publicRelease.id,release.id);if(repo===packRepo)assert.equal(publicRelease.immutable,true);
 for(const spec of specs){const a=publicRelease.assets.find(a=>a.name===spec.name);assert.ok(a);const b=await anonymousBytes(a.browser_download_url,spec.size,spec.sha256);if(spec.name==='frostveil-manifest.json')core.authenticateRelease(JSON.parse(b),core.productionSource,publicRelease);if(spec.name==='frostveil-launcher-update.json')core.authenticateLauncherUpdate(JSON.parse(b),core.productionLauncherUpdateSource,publicRelease,'0.1.17');checks.push({repo,tag:release.tag_name,name:spec.name,size:spec.size,sha256:spec.sha256,anonymous:'PASS'});}
}
const evidence={planSHA256:expected,anonymousVerification:'PASS',launcherVersion:'0.1.18',modpackVersion:'1.0.6',launcherImmutable:launcherRelease.immutable,modpackImmutable:packRelease.immutable,launcherURL:launcherRelease.html_url,modpackURL:packRelease.html_url,checks,gameWrites:0,serverWrites:0,sourcePush:false};await fs.writeFile(path.join(delivery,'publication-verified.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({anonymousVerification:'PASS',assets:checks.length,launcher:evidence.launcherURL,modpack:evidence.modpackURL,gameWrites:0,serverWrites:0}));
