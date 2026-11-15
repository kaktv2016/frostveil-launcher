import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test,{type TestContext} from 'node:test';
import {prepareW14FolderRelease} from '../scripts/prepare-w14-folder-release';
import {FolderLauncherUpdateTransport} from '../src/main/update-folder';
import {authenticateLauncherUpdate,w14PilotLauncherUpdateSource,type LauncherUpdateSource} from '../src/main/update-integrity';
import {NsisEngine} from '../src/main/updater-engine';
import {restrictFixtureFeed} from './helpers/restricted-update-folder';

const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t:TestContext){
 const temp=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'w14-release-test-'));
 t.after(async()=>{
  assert.equal(path.dirname(await fs.realpath(root)),temp);
  await fs.rm(root,{recursive:true,force:true});
 });
 const input=path.join(root,'input'),output=path.join(root,'output');
 await Promise.all([fs.mkdir(input),fs.mkdir(output)]);
 await restrictFixtureFeed(output,root);
 const now=Date.now(),publishedAt=new Date(now-1000).toISOString(),expiresAt=new Date(now+60000).toISOString();
 const key=generateKeyPairSync('ed25519'),keyId='w14-release-fixture';
 const source:LauncherUpdateSource={...w14PilotLauncherUpdateSource,mode:'disposable-test',keys:{[keyId]:{
  publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString(),environment:'test',revoked:false,expiresAt
 }}};
 async function installer(version:string,releaseId:number){
  const ref=`Frostveil-W14-${version}.exe`,bytes=Buffer.from(`MZ inert ${version}`);
  await fs.writeFile(path.join(input,ref),bytes);
  return {version,releaseId,installerAssetId:releaseId+1,envelopeAssetId:releaseId+2,ref,bytes:bytes.length,sha256:sha(bytes),
   sha512:createHash('sha512').update(bytes).digest('base64')};
 }
 const prior=await installer('0.1.0',101),candidate=await installer('0.2.0',201);
 const plan={schemaVersion:1,channel:'w14-pilot',keyId,publishedAt,expiresAt,prior,candidate};
 let signingCalls=0;
 async function run({digest,keyOverride}: {digest?:string;keyOverride?:typeof key.privateKey}={}){
  const raw=Buffer.from(JSON.stringify(plan));
  return prepareW14FolderRelease(input,output,raw,digest??sha(raw),async()=>{
   signingCalls++;
   return keyOverride??key.privateKey;
  },source,()=>now);
 }
 return {input,output,source,plan,run,calls:()=>signingCalls};
}

test('W14 assembles an offline pair with distinct immutable IDs and verifies both releases',async t=>{
 const f=await fixture(t),summary=await f.run();
 assert.equal(summary.qualification,'NOT_RUN');
 assert.equal(summary.trustMode,'disposable-test');
 assert.equal(f.calls(),1);
 const root=path.join(f.output,summary.packet),parse=async(ref:string)=>JSON.parse(await fs.readFile(path.join(root,ref),'utf8'));
 const latest=await parse('latest.json');
 assert.equal(latest.tag_name,'v0.2.0');
 await restrictFixtureFeed(root,f.output);
 const transport=new FolderLauncherUpdateTransport(root);
 assert.deepEqual(await transport.json('/releases/latest'),latest);
 const engine=new NsisEngine([],{source:f.source,transport,storageDir:path.join(path.dirname(f.input),'launcher'),
  installedVersion:f.plan.prior.version});
 assert.equal((await engine.check()).version,f.plan.candidate.version);
 await engine.download();
 assert.equal(sha(await fs.readFile(engine.getVerifiedFilePath()!)),f.plan.candidate.sha256);
 for(const planned of [f.plan.prior,f.plan.candidate]){
  const release=await parse(`releases/v${planned.version}.json`);
  const update=authenticateLauncherUpdate(await parse(`assets/${planned.envelopeAssetId}`),f.source,release,'0.1.0');
  assert.equal(update.manifest.releaseId,planned.releaseId);
  assert.equal(sha(await fs.readFile(path.join(root,`assets/${planned.installerAssetId}`))),planned.sha256);
 }
 await assert.rejects(f.run(),/already exists|EEXIST/i);
 assert.equal(f.calls(),1);
});

test('W14 refuses a mismatched plan hash or changed installer before loading a signing key',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.run({digest:'0'.repeat(64)}),/plan SHA-256/i);
 await fs.appendFile(path.join(f.input,f.plan.candidate.ref),'mutation');
 await assert.rejects(f.run(),/installer.*size|installer.*identity/i);
 await fs.writeFile(path.join(f.input,f.plan.candidate.ref),Buffer.alloc(f.plan.candidate.bytes,0x20));
 await assert.rejects(f.run(),/installer.*identity/i);
 assert.equal(f.calls(),0);
});

test('W14 refuses the wrong signer and leaves no latest pointer',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.run({keyOverride:generateKeyPairSync('ed25519').privateKey}),/signer.*pin/i);
 assert.deepEqual(await fs.readdir(f.output),[]);
 assert.equal((await f.run()).qualification,'NOT_RUN');
});

test('Concurrent W14 preparations leave one complete packet with no scratch output',async t=>{
 const f=await fixture(t);
 const results=await Promise.allSettled([f.run(),f.run()]);
 const successful=results.filter(result=>result.status==='fulfilled');
 assert.equal(successful.length,1);
 assert.deepEqual(await fs.readdir(f.output),[successful[0]!.value.packet]);
});
