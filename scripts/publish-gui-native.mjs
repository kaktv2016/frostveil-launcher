// Publishes only the sealed Launcher candidate under the owner's standing authorization.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import assert from 'node:assert/strict';import{createHash,createPrivateKey,createPublicKey}from'node:crypto';import{execFileSync}from'node:child_process';import{load as yaml}from'js-yaml';
import{core as loadCore}from'./prepare-navigation-polish.mjs';
process.chdir(path.resolve(import.meta.dirname,'..'));
const core=await loadCore(),dir=path.resolve('.local/gui-native/delivery');
const hash=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await fs.readFile(p));
const expected=process.argv.find(a=>a.startsWith('--plan-sha256='))?.split('=')[1];assert.match(expected||'',/^[a-f0-9]{64}$/);
const planBytes=await fs.readFile(path.join(dir,'deployment-plan.json'));assert.equal(hash(planBytes),expected);const plan=JSON.parse(planBytes);
const verify=async spec=>{const b=await fs.readFile(spec.path);assert.equal(b.length,spec.size);assert.equal(hash(b),spec.sha256);return b;};
for(const file of plan.files)await verify(file);
for(const operation of plan.operations)await verify(operation);
const installer=plan.files.find(f=>f.name.endsWith('.exe')),latest=yaml((await verify(plan.files.find(f=>f.name==='latest.yml'))).toString());
assert.equal(latest.version,'0.1.24');assert.equal(latest.path,installer.name);
const sha512=createHash('sha512').update(await verify(installer)).digest('base64');assert.equal(latest.sha512,sha512);
assert.equal(plan.automated.fixture.passed,true);assert.equal(plan.automated.nativeGameplay,'PENDING_OWNER_TEST');
if(!process.argv.includes('--apply')){console.log(JSON.stringify({status:'PREFLIGHT_PASS',planSHA256:expected}));process.exit(0);}
const r2=await read(path.join(dir,'r2-verification.json'));assert.equal(r2.anonymousVerification,'PASS');assert.ok(r2.checks.some(c=>c.sha256===plan.client.sha256));assert.ok(r2.checks.some(c=>c.sha256===plan.recipe.sha256));
const backup=await read('.local/production-release/offline-backup-verification.json');assert.equal(backup.driveAbsentVerified,true);assert.equal(backup.recoveryFingerprintAndChallenge,'PASS');
const call=(args,input)=>execFileSync('gh',args,{input,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
const api=p=>JSON.parse(call(['api',p])),mutate=(method,p,data)=>JSON.parse(call(['api','--method',method,p,'--input','-'],JSON.stringify(data)));
assert.equal(api('user').login,'kaktv2016');
const repo='kaktv2016/frostveil-launcher',tag='v0.1.24',statePath=path.join(dir,'publication-state.json');
let state;try{state=await read(statePath);}catch(e){if(e.code!=='ENOENT')throw e;}
let release;
const notes='Adds opt-in native GUI performance diagnostics. Set FROSTVEIL_GUI_PROFILE=1 before starting Launcher to collect CPU paint, upload, lock and frame timings. No performance fix or in-game success is claimed. Corresponding source SHA-256: '+plan.files.find(f=>f.name.endsWith('-source.zip')).sha256+'.';
if(state)release=api('repos/'+repo+'/releases/'+state.id);
else{assert.equal(api('repos/'+repo+'/releases/latest').tag_name,'v0.1.23');release=mutate('POST','repos/'+repo+'/releases',{tag_name:tag,target_commitish:api('repos/'+repo+'/commits/main').sha,name:'Frostveil Launcher 0.1.24 — Native GUI Diagnostics',draft:true,prerelease:false,body:notes});await fs.writeFile(statePath,JSON.stringify({id:release.id,planSHA256:expected}));}
assert.equal(release.tag_name,tag);if(state)assert.equal(state.planSHA256,expected);
async function upload(file){const old=release.assets.find(a=>a.name===file.name);if(old){assert.equal(old.digest,'sha256:'+file.sha256);assert.equal(old.size,file.size);return;}assert.equal(release.draft,true);await verify(file);call(['release','upload',tag,file.path,'--repo',repo]);release=api('repos/'+repo+'/releases/'+release.id);}
for(const file of plan.files)await upload(file);
const source=core.productionLauncherUpdateSource,keyId=Object.keys(source.keys)[0],pin=source.keys[keyId];assert.equal(pin.revoked,false);assert.ok(Date.parse(pin.expiresAt)>Date.now());
const key=createPrivateKey(await fs.readFile(path.join(os.homedir(),'.codex/frostveil-signing/production-candidates-20261016/launcher-update-private.pem')));assert.equal(createPublicKey(key).export({type:'spki',format:'pem'}).toString(),pin.publicKey);
const asset=release.assets.find(a=>a.name===installer.name),updatePath=path.join(dir,'frostveil-launcher-update.json');
let envelope;if(release.assets.some(a=>a.name==='frostveil-launcher-update.json'))envelope=await read(updatePath);
else{envelope=core.signLauncherUpdateManifest({schemaVersion:1,keyId,owner:'kaktv2016',repo:'frostveil-launcher',tag,version:'0.1.24',channel:'stable',minimumLauncherVersion:'0.1.6',publishedAt:new Date().toISOString(),expiresAt:pin.expiresAt,releaseNotes:notes,installer:{assetId:asset.id,assetName:installer.name,size:installer.size,sha256:installer.sha256,sha512}},key);await fs.writeFile(updatePath,JSON.stringify(envelope,null,2)+'\n');}
const updateBytes=await fs.readFile(updatePath),updateFile={path:updatePath,name:path.basename(updatePath),size:updateBytes.length,sha256:hash(updateBytes)};await upload(updateFile);
core.authenticateLauncherUpdate(envelope,source,{...release,draft:false,published_at:release.published_at||new Date().toISOString()},'0.1.23');
if(release.draft)release=mutate('PATCH','repos/'+repo+'/releases/'+release.id,{draft:false,make_latest:'true'});
const response=await fetch('https://api.github.com/repos/'+repo+'/releases/tags/'+tag);assert.equal(response.status,200);const publicRelease=await response.json();assert.equal(publicRelease.id,release.id);core.authenticateLauncherUpdate(envelope,source,publicRelease,'0.1.23');
const checks=[];
for(const spec of [...plan.files,updateFile]){const a=publicRelease.assets.find(a=>a.name===spec.name);assert.ok(a);assert.equal(a.digest,'sha256:'+spec.sha256);const response=await fetch(a.browser_download_url,{signal:AbortSignal.timeout(120000)});assert.equal(response.status,200);let size=0;const h=createHash('sha256');for await(const part of response.body){size+=part.length;assert.ok(size<=spec.size);h.update(part);}assert.equal(size,spec.size);assert.equal(h.digest('hex'),spec.sha256);checks.push({name:spec.name,anonymous:'PASS',sha256:spec.sha256});}
const evidence={planSHA256:expected,anonymousVerification:'PASS',launcherVersion:'0.1.24',launcherURL:publicRelease.html_url,immutable:publicRelease.immutable,checks,gameWrites:0,serverWrites:0};await fs.writeFile(path.join(dir,'publication-verified.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
