import {rollbackRuntimeMetadata} from './runtime-publication-rollback.mjs';
// Fixed owner repository / metadata object. Uses the established Ed25519 updater
// and R2 credentials provider; never uploads Bethesda game payloads.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {createHash,createPrivateKey,createPublicKey} from 'node:crypto';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';import {build} from 'esbuild';import {load as yaml} from 'js-yaml';
const root=path.resolve(import.meta.dirname,'..');process.chdir(root);
const out=path.join(root,'.local/runtime-normalization'),delivery=path.join(out,'delivery'),repo='kaktv2016/frostveil-launcher',version='0.1.27',tag='v'+version;
const hash=b=>createHash('sha256').update(b).digest('hex'),read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const call=args=>execFileSync('gh',args,{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024}),api=p=>JSON.parse(call(['api',p]));
const git=args=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
async function runtimeDigest(){const files=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){assert.equal(e.isSymbolicLink(),false);const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(p);}}await walk('src');await walk('assets');for(const f of ['package.json','package-lock.json','tsconfig.json','vite.config.ts','scripts/build.mjs'])try{await fs.access(f);files.push(f);}catch(e){if(e.code!=='ENOENT')throw e;}const h=createHash('sha256');for(const f of files.sort()){h.update(f.replaceAll('\\','/'));h.update('\0');h.update(await fs.readFile(f));}return h.digest('hex');}
await fs.mkdir(delivery,{recursive:true});
await build({stdin:{contents:"export {productionLauncherUpdateSource,authenticateLauncherUpdate,signLauncherUpdateManifest} from './src/main/update-integrity';export {authenticateRuntimeCohort} from './src/main/runtime/policy';",resolveDir:root},outfile:path.join(out,'publication-core.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external'});
const require=createRequire(import.meta.url),core=require(path.join(out,'publication-core.cjs'));
const gates=await read(path.join(out,'release-gates.json'));assert.equal(gates.passed,true);assert.equal(gates.version,version);assert.ok(gates.tests>=519);assert.equal(await runtimeDigest(),gates.runtimeSourceDigest);
for(const name of ['ui-result.json','pipe-result.json','transaction-result.json','bootstrap-result.json','packaged-verification.json'])assert.equal((await read(path.join(out,name))).passed,true,name);
assert.equal(JSON.parse(await fs.readFile('package.json')).version,version);assert.equal(git(['branch','--show-current']),'dev/steam-runtime-normalization');assert.match(git(['remote','get-url','origin']),/^https:\/\/github.com\/kaktv2016\/frostveil-launcher(?:\.git)?$/);assert.equal(git(['status','--porcelain']),'','Commit reviewed source before preparing publication');
const head=git(['rev-parse','HEAD']),planFile=path.join(delivery,'deployment-plan.json');
async function spec(file){const bytes=await fs.readFile(file);return{path:path.resolve(file),name:path.basename(file),size:bytes.length,sha256:hash(bytes)};}
async function verify(f){const bytes=await fs.readFile(f.path);assert.equal(bytes.length,f.size);assert.equal(hash(bytes),f.sha256);return bytes;}
if(process.argv.includes('--prepare')){
 const source=path.join(delivery,'FrostveilLauncher-'+version+'-source.zip');execFileSync('git',['archive','--format=zip','--prefix=FrostveilLauncher/','--output='+source,head],{windowsHide:true});
 const installer='release/SkyrimRPLauncher-'+version+'-x64-local.exe',files=await Promise.all([installer,'release/latest.yml',installer+'.blockmap','assets/runtime-1170.json',source].map(spec));
 core.authenticateRuntimeCohort(JSON.parse((await verify(files.find(f=>f.name==='runtime-1170.json'))).toString('utf8')));
 const bytes=Buffer.from(JSON.stringify({version,tag,repo,head,branch:'dev/steam-runtime-normalization',runtimeSourceDigest:gates.runtimeSourceDigest,files,gates:{tests:gates.tests,transaction:true,pipe:true,ui:true,packaged:true},rollback:{launcher:'v0.1.26',game:'authenticated Restore; retained original blobs and history'},serverChanges:0,playerInstallationWrites:0},null,2)+'\n');await fs.writeFile(planFile,bytes);console.log(JSON.stringify({prepared:true,planSHA256:hash(bytes),head,files:files.map(f=>({name:f.name,size:f.size,sha256:f.sha256}))}));process.exit(0);
}
const expected=process.argv.find(a=>a.startsWith('--plan-sha256='))?.slice('--plan-sha256='.length);assert.match(expected??'',/^[a-f0-9]{64}$/);
const planBytes=await fs.readFile(planFile);assert.equal(hash(planBytes),expected);const plan=JSON.parse(planBytes);assert.equal(plan.head,head);assert.equal(plan.runtimeSourceDigest,gates.runtimeSourceDigest);
for(const file of plan.files)await verify(file);
if(!process.argv.includes('--apply')){console.log('Plan and release gates verified; no publication performed.');process.exit(0);}
assert.equal(api('user').login,'kaktv2016');
const installer=plan.files.find(f=>f.name.endsWith('.exe')),latest=yaml((await verify(plan.files.find(f=>f.name==='latest.yml'))).toString());assert.equal(latest.version,version);assert.equal(latest.path,installer.name);const sha512=createHash('sha512').update(await verify(installer)).digest('base64');assert.equal(latest.sha512,sha512);
const metadata=plan.files.find(f=>f.name==='runtime-1170.json'),metadataBytes=await verify(metadata);core.authenticateRuntimeCohort(JSON.parse(metadataBytes));
const beforeDir=path.join(out,'publication-before');await fs.mkdir(beforeDir,{recursive:true});const previous=api('repos/'+repo+'/releases/latest');
const stateFile=path.join(delivery,'publication-state.json');let state;try{state=await read(stateFile);}catch(e){if(e.code!=='ENOENT')throw e;}
if(!state){assert.equal(previous.tag_name,'v0.1.26');await fs.writeFile(path.join(beforeDir,'previous-release.json'),JSON.stringify(previous,null,2));}
// Only the signed metadata object is written to R2; all game files stay on Steam.
const credentialSource=await fs.readFile('../scripts/upload-to-r2.mjs','utf8'),setting=name=>{const m=credentialSource.match(new RegExp('const '+name+' = [\'\"]([^\'\"]+)[\'\"]'));assert.ok(m,'Existing R2 credential provider unavailable');return m[1];};
const {S3Client,PutObjectCommand,DeleteObjectCommand}=createRequire(path.resolve('../scripts/package.json'))('@aws-sdk/client-s3');
const client=new S3Client({region:'auto',endpoint:'https://'+setting('accountId')+'.r2.cloudflarestorage.com',credentials:{accessKeyId:setting('accessKeyId'),secretAccessKey:setting('secretAccessKey')}});
const metadataURL='https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/runtime/steam-1170.json';
let hasPrevious=false;for(const name of ['previous-runtime.json','previous-runtime-state.json'])try{await fs.access(path.join(beforeDir,name));hasPrevious=true;}catch(e){if(e.code!=='ENOENT')throw e;}
if(!hasPrevious){const oldResponse=await fetch(metadataURL,{redirect:'error',signal:AbortSignal.timeout(30000)});if(oldResponse.status!==404){assert.equal(oldResponse.status,200);const parts=[];let size=0;for await(const part of oldResponse.body){size+=part.length;assert.ok(size<=4*1024*1024);parts.push(Buffer.from(part));}await fs.writeFile(path.join(beforeDir,'previous-runtime.json'),Buffer.concat(parts),{flag:'wx'});}else await fs.writeFile(path.join(beforeDir,'previous-runtime-state.json'),JSON.stringify({absent:true}),{flag:'wx'});}
let r2Touched=false,promotionAttempted=false;
try{
const mutate=async(method,endpoint,body)=>{const file=path.join(delivery,'api-request.json');await fs.writeFile(file,JSON.stringify(body));return JSON.parse(call(['api','--method',method,endpoint,'--input',file]));};
const notes='Steam Skyrim runtime preparation to 1.6.1170.0, reversible Anniversary/Creation isolation, one-session depot acquisition and original-file Restore. Game files are acquired from the owning Steam account; no game binaries are distributed here. Signed runtime metadata; SKSE/modpack delivery unchanged. Skyrim gameplay acceptance remains pending owner testing.';
let release;if(state){assert.equal(state.planSHA256,expected);release=api('repos/'+repo+'/releases/'+state.id);}else{release=await mutate('POST','repos/'+repo+'/releases',{tag_name:tag,target_commitish:head,name:'Frostveil Launcher 0.1.27 — Steam Runtime Preparation',draft:true,prerelease:false,body:notes});state={id:release.id,planSHA256:expected};await fs.writeFile(stateFile,JSON.stringify(state));}
assert.equal(release.tag_name,tag);
async function upload(f){const old=release.assets.find(a=>a.name===f.name);if(old){assert.equal(old.size,f.size);assert.equal(old.digest,'sha256:'+f.sha256);return;}assert.equal(release.draft,true);await verify(f);call(['release','upload',tag,f.path,'--repo',repo]);release=api('repos/'+repo+'/releases/'+release.id);}
for(const file of plan.files)await upload(file);
const source=core.productionLauncherUpdateSource,keyId=Object.keys(source.keys)[0],pin=source.keys[keyId],key=createPrivateKey(await fs.readFile(path.join(os.homedir(),'.codex/frostveil-signing/production-candidates-20261016/launcher-update-private.pem')));assert.equal(pin.revoked,false);assert.equal(createPublicKey(key).export({type:'spki',format:'pem'}).toString(),pin.publicKey);
const asset=release.assets.find(a=>a.name===installer.name),updatePath=path.join(delivery,'frostveil-launcher-update.json');let envelope;
if(release.assets.some(a=>a.name==='frostveil-launcher-update.json'))envelope=await read(updatePath);
else{envelope=core.signLauncherUpdateManifest({schemaVersion:1,keyId,owner:'kaktv2016',repo:'frostveil-launcher',tag,version,channel:'stable',minimumLauncherVersion:'0.1.6',publishedAt:new Date().toISOString(),expiresAt:pin.expiresAt,releaseNotes:notes,installer:{assetId:asset.id,assetName:installer.name,size:installer.size,sha256:installer.sha256,sha512}},key);await fs.writeFile(updatePath,JSON.stringify(envelope,null,2)+'\n');}
await upload(await spec(updatePath));core.authenticateLauncherUpdate(envelope,source,{...release,draft:false,published_at:release.published_at??new Date().toISOString()},'0.1.26');
// GitHub draft assets and their real-ID signatures are complete before R2 changes.
r2Touched=true;await fs.writeFile(stateFile,JSON.stringify({...state,r2Attempted:true}));
await client.send(new PutObjectCommand({Bucket:setting('bucketName'),Key:'runtime/steam-1170.json',Body:metadataBytes,ContentType:'application/json',CacheControl:'no-cache, max-age=0, must-revalidate'}));
const r2=await fetch(metadataURL,{redirect:'error',signal:AbortSignal.timeout(60000)});assert.equal(r2.status,200);const publishedMetadata=Buffer.from(await r2.arrayBuffer());assert.equal(hash(publishedMetadata),metadata.sha256);core.authenticateRuntimeCohort(JSON.parse(publishedMetadata));
if(release.draft)release=await mutate('PATCH','repos/'+repo+'/releases/'+release.id,{draft:false,make_latest:'false'});
const publicRelease=await (await fetch('https://api.github.com/repos/'+repo+'/releases/tags/'+tag)).json();assert.equal(publicRelease.id,release.id);core.authenticateLauncherUpdate(envelope,source,publicRelease,'0.1.26');
const checks=[];for(const file of [...plan.files,await spec(updatePath)]){const asset=publicRelease.assets.find(a=>a.name===file.name);assert.equal(asset.size,file.size);assert.equal(asset.digest,'sha256:'+file.sha256);const response=await fetch(asset.browser_download_url,{signal:AbortSignal.timeout(180000)});assert.equal(response.status,200);const h=createHash('sha256');let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;assert.ok(bytes<=file.size);h.update(chunk);}assert.equal(bytes,file.size);assert.equal(h.digest('hex'),file.sha256);checks.push({name:file.name,size:bytes,sha256:file.sha256,anonymous:'PASS'});}
promotionAttempted=true;await mutate('PATCH','repos/'+repo+'/releases/'+release.id,{make_latest:'true'});assert.equal(api('repos/'+repo+'/releases/latest').id,release.id);
const result={passed:true,version,url:publicRelease.html_url,head,planSHA256:expected,runtimeMetadataURL:metadataURL,runtimeMetadataSHA256:metadata.sha256,signature:'AUTHENTICATED',installerSHA256:installer.sha256,checks,protectedDataWrites:0,skyrimGameplay:'PENDING_OWNER'};await fs.writeFile(path.join(delivery,'publication-verified.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));

}catch(error){
 let rollback='not-needed';
 try{
  // Never leave an unverified auto-update feed pointing at this attempt.
  if(promotionAttempted){const prior=await read(path.join(beforeDir,'previous-release.json'));if(api('repos/'+repo+'/releases/latest').id===state?.id){const f=path.join(delivery,'rollback-latest.json');await fs.writeFile(f,JSON.stringify({make_latest:'true'}));call(['api','--method','PATCH','repos/'+repo+'/releases/'+prior.id,'--input',f]);assert.equal(api('repos/'+repo+'/releases/latest').id,prior.id);}}
  if(r2Touched){
   let old=null;try{old=await fs.readFile(path.join(beforeDir,'previous-runtime.json'));}catch(e){if(e.code!=='ENOENT')throw e;assert.equal((await read(path.join(beforeDir,'previous-runtime-state.json'))).absent,true);}
   const readCurrent=async()=>{const r=await fetch(metadataURL,{redirect:'error',signal:AbortSignal.timeout(30000)});if(r.status===404)return null;assert.equal(r.status,200);const parts=[];let size=0;for await(const p of r.body){size+=p.length;assert.ok(size<=4*1024*1024);parts.push(Buffer.from(p));}return Buffer.concat(parts);};
   rollback=await rollbackRuntimeMetadata({original:old,ourSHA256:metadata.sha256,readCurrent,
    putOriginal:bytes=>client.send(new PutObjectCommand({Bucket:setting('bucketName'),Key:'runtime/steam-1170.json',Body:bytes,ContentType:'application/json',CacheControl:'no-cache, max-age=0, must-revalidate'})),
    deleteCurrent:()=>client.send(new DeleteObjectCommand({Bucket:setting('bucketName'),Key:'runtime/steam-1170.json'}))});
  }
 }catch(recovery){rollback='blocked: '+(recovery instanceof Error?recovery.message:'unknown');}
 await fs.writeFile(path.join(delivery,'publication-failure.json'),JSON.stringify({published:false,error:error instanceof Error?error.message:'Publication failed',rollback,planSHA256:expected,worldDataChanges:0},null,2));
 throw Error('Publication stopped: '+(error instanceof Error?error.message:'unknown')+'; rollback '+rollback+'. Diagnostics retained in '+delivery);
}
