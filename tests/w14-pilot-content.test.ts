import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,sign} from 'node:crypto';
import {verifyW14PilotContent} from '../scripts/verify-w14-pilot-intake';
import type {DistributionSource} from '../src/main/distribution/policy';
import {helperPin} from '../src/main/runtime/depot';
import type {RuntimeCohort} from '../src/main/runtime/policy';
import {envelope,fixture,keyId,publicKey,testKey} from './distribution-fixture';
import {W14ContentFolder} from '../src/main/distribution/w14-content-folder';
import {PackageDownloader} from '../src/main/distribution/download';
import {restrictFixtureFeed} from './helpers/restricted-update-folder';
import {ProductionDownloads} from '../src/main/management/downloads';
import {RuntimePreparation} from '../src/main/runtime/service';

const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

async function contentFixture(t:TestContext){
 const f=await fixture(),root=f.grant.directory,now=Date.now();
 t.after(async()=>{
  assert.equal(await fs.realpath(root),root);
  assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));
  await fs.rm(root,{recursive:true,force:true});
 });
 const end=new Date(now+60000).toISOString(),expiry=new Date(now+120000).toISOString();
 const source:DistributionSource={mode:'sandbox-test',packId:f.manifest.packId,channel:'stable',permittedReviews:[],
  keys:{[keyId]:{publicKey,environment:'test',revoked:false,expiresAt:expiry}}};
 const skyrim=f.manifest.files.find(file=>file.path==='Data/Skyrim.esm')!;
 const depots=['489831','489832','489833'].map((id,i)=>({id,manifest:String(i+1).padEnd(19,'0')}));
 const runtime:RuntimeCohort={
  schemaVersion:1,kind:'frostveil-steam-runtime',appId:'489830',language:'english',runtime:'1.6.1170.0',
  createdAt:new Date(now).toISOString(),expiresAt:expiry,depots,
  files:[{path:skyrim.path,size:skyrim.size,sha256:skyrim.sha256,depot:depots[0]!.id}],creations:[],
  managedFiles:f.manifest.files.filter(file=>file.role==='client').map(({path,size,sha256})=>({path:'Data/'+path.slice(5),size,sha256})),
  pluginOrder:[],configuration:{pluginsBase64:'',loadorderBase64:''},
  helper:{version:helperPin.version,size:helperPin.size,sha256:helperPin.sha256},
  acquisition:{verified:true,receiptSha256:sha('historical fixture receipt')}
 };
 f.server.expiresAt=expiry;
 f.metadata.immutable=true;
 const index={classification:'SEALED_CANDIDATE',candidate:{id:'w14-content-fixture',version:'0.2.0',platform:'windows-x64',producerGit:'a'.repeat(40)},
  profile:{steamApp:'489830',language:'english',runtime:'1.6.1170.0',skse:'2.2.6',endpointPort:7777},
  artifacts:{runtime:{signedEnvelopeRef:'runtime.json',sha256:'',publicKeyId:keyId,expiresAtUtc:expiry},
   pack:{signedEnvelopeRef:'pack.json',sha256:'',publicKeyId:keyId,expiresAtUtc:expiry,releaseMetadataRef:'pack-release.json',
    releaseMetadataSha256:'',envelopeAssetId:100,releaseId:1},compatibility:{serverGit:f.server.engineCommit}}};
 async function write(name:string,value:unknown){
  const bytes=Buffer.from(JSON.stringify(value));
  await fs.writeFile(path.join(root,name),bytes);
  return {sha256:sha(bytes),size:bytes.length};
 }
 async function prepare(digestOffset=false){
  const payload=Buffer.from(JSON.stringify(runtime));
  index.artifacts.runtime.sha256=(await write('runtime.json',{
   keyId,payloadBase64:payload.toString('base64'),signatureBase64:sign(null,payload,testKey).toString('base64')
  })).sha256;
  const pack=await write('pack.json',envelope(f.manifest,f.server));
  index.artifacts.pack.sha256=pack.sha256;
  const manifestAsset=f.metadata.assets.find(asset=>asset.id===100)!;
  manifestAsset.size=pack.size;
  manifestAsset.digest='sha256:'+(digestOffset?'0'.repeat(64):pack.sha256);
  index.artifacts.pack.releaseMetadataSha256=(await write('pack-release.json',f.metadata)).sha256;
  return (await write('candidate-index.json',index)).sha256;
 }
 async function run({windowEnd=end,digestOffset=false,useProduction=false}: {windowEnd?:string;digestOffset?:boolean;useProduction?:boolean}={}){
  return verifyW14PilotContent(root,await prepare(digestOffset),windowEnd,useProduction?undefined:source);
 }
 async function folder(protectedAcl=true){
  await prepare();
  const folder=path.join(root,'w14-content'),assets=path.join(folder,'assets');
  await fs.mkdir(folder);
  if(protectedAcl)await restrictFixtureFeed(folder,root);
  await fs.mkdir(assets);
  await Promise.all(['runtime.json','pack-release.json'].map(name=>fs.copyFile(path.join(root,name),path.join(folder,name))));
  await fs.copyFile(path.join(root,'pack.json'),path.join(assets,'100'));
  await Promise.all([...f.payloads].map(([id,bytes])=>fs.writeFile(path.join(assets,String(id)),bytes)));
  return {folder,runtimeSha256:index.artifacts.runtime.sha256,packReleaseSha256:index.artifacts.pack.releaseMetadataSha256,packEnvelopeSha256:index.artifacts.pack.sha256};
 }
 return {f,index,runtime,expiry,run,folder,source};
}

class RuntimePolicyProbe extends RuntimePreparation {
 read(signal:AbortSignal){return this.loadPolicy(signal);}
}

test('W14 protected folder binds signed runtime, pack, and verified redistribution bytes',async t=>{
 const f=await contentFixture(t),pin=await f.folder();
 const local=new W14ContentFolder(pin,f.source);
 await assert.rejects(local.transport.request('/releases/assets/101'),/not authorized/i);
 assert.equal((await local.runtime(new AbortController().signal)).runtime,'1.6.1170.0');
 const release=await local.resolve('stable');
 assert.equal(release.tag_name,f.f.metadata.tag_name);
 assert.equal((await local.envelope(release)).keyId,keyId);
 await assert.rejects(local.resolve('beta'),/W14.*channel/i);
 await assert.rejects(local.transport.request('/releases/assets/999'),/not authorized/i);
 const packageRef=f.f.manifest.files.find(file=>file.package)!.package!;
 const partial=await local.transport.request('/releases/assets/'+packageRef.assetId,undefined,{
  Range:'bytes=1-','If-Range':'"'+packageRef.sha256+'"'
 });
 assert.equal(partial.status,206);
 assert.deepEqual(Buffer.from(await partial.arrayBuffer()),f.f.payloads.get(packageRef.assetId)!.subarray(1));
 await fs.unlink(path.join(f.f.grant.payloads,packageRef.sha256+'.bin'));
 const target=await new PackageDownloader(f.f.grant,local.transport).acquire(packageRef);
 assert.deepEqual(await fs.readFile(target),f.f.payloads.get(packageRef.assetId));
 await assert.rejects(new W14ContentFolder(pin).runtime(new AbortController().signal),/Untrusted runtime publisher/i);
});

test('W14 runtime and Whole Play pack admission keep their pinned source when metadata vanishes',async t=>{
 const f=await contentFixture(t),pin=await f.folder();
 const local=new W14ContentFolder(pin,f.source,'0.2.0');
 const root=f.f.grant.directory,signal=new AbortController().signal;
 const runtime=new RuntimePolicyProbe(root,path.join(root,'unused-public-fallback.json'),undefined,s=>local.runtime(s));
 const downloads=new ProductionDownloads(path.join(root,'launcher-storage'),'0.2.0',f.source,()=>local);
 const attempted:string[]=[];
 t.mock.method(globalThis,'fetch',async (url:unknown)=>{
  attempted.push(String(url));
  throw Error('Unexpected public request');
 });
 assert.equal((await runtime.read(signal)).runtime,'1.6.1170.0');
 const admission=await downloads.wholePlayAdmission(signal);
 assert.equal(admission.packagedTargets.size,f.f.payloads.size);
 await fs.unlink(path.join(pin.folder,'runtime.json'));
 await assert.rejects(runtime.read(signal),/pinned W14 content file is missing/);
 await assert.rejects(downloads.wholePlayAdmission(signal),/pinned W14 content file is missing/);
 assert.deepEqual(attempted,[]);
});

test('W14 content refuses a hardlinked manifest and PackageDownloader rejects altered local bytes',async t=>{
 const f=await contentFixture(t),pin=await f.folder(),local=new W14ContentFolder(pin,f.source);
 const packageRef=f.f.manifest.files.find(file=>file.package)!.package!;
 await local.resolve('stable');
 await fs.unlink(path.join(f.f.grant.payloads,packageRef.sha256+'.bin'));
 const file=path.join(pin.folder,'assets',String(packageRef.assetId));
 await fs.writeFile(file,Buffer.alloc(packageRef.size,0x20));
 await assert.rejects(new PackageDownloader(f.f.grant,local.transport,{attempts:1}).acquire(packageRef),/Final SHA256 mismatch/);
 await fs.link(path.join(pin.folder,'assets','100'),path.join(pin.folder,'duplicate-manifest'));
 await assert.rejects(local.resolve('stable'),/unsafe or invalid file/i);
});

test('W14 requires a protected Windows ACL on the actual content root',async t=>{
 const f=await contentFixture(t),pin=await f.folder(false);
 await assert.rejects(new W14ContentFolder(pin,f.source).resolve('stable'),/folder permissions failed verification/);
});

test('W14 protected folder rejects absent pins, content drift and individually signed conflicts',async t=>{
 const f=await contentFixture(t);
 f.runtime.files[0]!.sha256='0'.repeat(64);
 const pin=await f.folder();
 const local=new W14ContentFolder(pin,f.source);
 await assert.rejects(local.runtime(new AbortController().signal),/signed runtime and pack file/i);
 await assert.rejects(local.resolve('stable'),/signed runtime and pack file/i);
 await fs.appendFile(path.join(pin.folder,'runtime.json'),' ');
 await assert.rejects(local.resolve('stable'),/content.*digest/i);
 await assert.rejects(new W14ContentFolder(undefined).resolve('stable'),/content.*pin/i);
});

test('W14 binds fresh signed runtime and pack metadata to one candidate without attesting installed bytes or server',async t=>{
 const f=await contentFixture(t),result=await f.run();
 assert.equal(result.status,'LOCAL_ED25519_CONTENT_BINDINGS_MATCH');
 assert.equal(result.qualification,'NOT_RUN');
 assert.equal(result.nativePairing,'NOT_VERIFIED');
 assert.equal(result.installedBytes,'NOT_VERIFIED');
 assert.equal(result.packagePayloadBytes,'NOT_VERIFIED');
 assert.equal(result.trustMode,'sandbox-test');
 assert.equal(result.pack.serverEngineCommit,f.f.server.engineCommit);
 assert.equal(result.runtime.depots.length,3);
 await assert.rejects(f.run({useProduction:true}),/Untrusted runtime publisher/);
});

test('W14 rejects signed runtime helper drift and a runtime/pack shared-file conflict',async t=>{
 const f=await contentFixture(t);
 f.runtime.helper.size++;
 await assert.rejects(f.run(),/signed helper/i);
 f.runtime.helper.size--;
 f.runtime.files[0]!.sha256='0'.repeat(64);
 await assert.rejects(f.run(),/signed runtime and pack file/i);
});

test('W14 requires independently bound pack assets, exact profile, and a valid complete window',async t=>{
 const f=await contentFixture(t);
 await assert.rejects(f.run({digestOffset:true}),/immutable pack/i);
 f.f.metadata.immutable=false;
 await assert.rejects(f.run(),/immutable pack/i);
 f.f.metadata.immutable=true;
 await assert.rejects(f.run({windowEnd:f.expiry}),/test window/i);
 f.index.artifacts.compatibility.serverGit='0'.repeat(40);
 await assert.rejects(f.run(),/sealed profile/i);
 f.index.artifacts.compatibility.serverGit=f.f.server.engineCommit;
 f.index.profile.endpointPort=17777;
 await assert.rejects(f.run(),/sealed profile/i);
});

test('W14 rejects missing native inventory and a required shared plugin absent from declared runtime order',async t=>{
 const f=await contentFixture(t);
 const [first,...remaining]=f.runtime.managedFiles;
 f.runtime.managedFiles=remaining;
 await assert.rejects(f.run(),/required native client inventory/i);
 f.runtime.managedFiles=[first!,...remaining];
 f.runtime.files[0]!.path='SkyrimSE.exe';
 await assert.rejects(f.run(),/server plugin order/i);
});

test('W14 rejects signed content with a generation time after verification starts',async t=>{
 const f=await contentFixture(t);
 f.runtime.createdAt=new Date(Date.now()+30000).toISOString();
 await assert.rejects(f.run(),/not yet valid/i);
});
