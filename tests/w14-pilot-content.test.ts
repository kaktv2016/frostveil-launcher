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
 async function run({windowEnd=end,digestOffset=false,useProduction=false}: {windowEnd?:string;digestOffset?:boolean;useProduction?:boolean}={}){
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
  const {sha256}=await write('candidate-index.json',index);
  return verifyW14PilotContent(root,sha256,windowEnd,useProduction?undefined:source);
 }
 return {f,index,runtime,expiry,run};
}

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
