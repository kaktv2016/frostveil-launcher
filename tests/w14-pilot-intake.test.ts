import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {verifyW14PilotIntake} from '../scripts/verify-w14-pilot-intake';
import {
 LAUNCHER_MANIFEST_ASSET,productionLauncherUpdateSource,signLauncherUpdateManifest,
 type LauncherUpdateSource
} from '../src/main/update-integrity';

const now=()=>Date.parse('2026-11-15T00:00:00.000Z');
const windowEnd='2026-11-16T00:00:00.000Z';
const expiresAt='2026-11-17T00:00:00.000Z';
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t:TestContext){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'w14-pilot-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const key=generateKeyPairSync('ed25519');
 const keyId='w14-test-publisher';
 const source:LauncherUpdateSource={...productionLauncherUpdateSource,mode:'disposable-test',keys:{[keyId]:{
  publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString(),environment:'test',revoked:false,expiresAt
 }}};
 async function release(version:string,id:number){
  const assetName=`Frostveil-${version}-x64.exe`;
  const bytes=Buffer.from(`MZ-inert-${version}`);
  const sha256=digest(bytes),sha512=createHash('sha512').update(bytes).digest('base64');
  const publishedAt='2026-11-14T00:00:00.000Z';
  const manifest={schemaVersion:1 as const,keyId,owner:source.owner,repo:source.repo,channel:source.channel,
   tag:`v${version}`,version,minimumLauncherVersion:'0.1.0',publishedAt,expiresAt,releaseNotes:'',
   installer:{assetId:id+1,assetName,size:bytes.length,sha256,sha512}};
  const envelope=Buffer.from(JSON.stringify(signLauncherUpdateManifest(manifest,key.privateKey)));
  const evidence={signedEnvelopeRef:`envelope-${id}.json`,envelopeSha256:digest(envelope),
   releaseMetadataRef:`release-${id}.json`,releaseMetadataSha256:'',releaseId:id,envelopeAssetId:id+2,installerAssetId:id+1};
  const metadata={id,tag_name:manifest.tag,draft:false,prerelease:false,published_at:publishedAt,body:'',assets:[
   {id:id+1,name:assetName,size:bytes.length,state:'uploaded',digest:`sha256:${sha256}`},
   {id:id+2,name:LAUNCHER_MANIFEST_ASSET,size:envelope.length,state:'uploaded',digest:`sha256:${digest(envelope)}`}
  ]};
  async function writeMetadata(){
   const raw=Buffer.from(JSON.stringify(metadata));
   evidence.releaseMetadataSha256=digest(raw);
   await fs.writeFile(path.join(root,evidence.releaseMetadataRef),raw);
  }
  await fs.writeFile(path.join(root,assetName),bytes);
  await fs.writeFile(path.join(root,evidence.signedEnvelopeRef),envelope);
  await writeMetadata();
  return {installer:{ref:assetName,bytes:bytes.length,sha256,sha512},evidence,metadata,writeMetadata};
 }
 const prior=await release('0.1.0',101),current=await release('0.2.0',201);
 const index={classification:'SEALED_CANDIDATE',candidate:{id:'fixture',version:'0.2.0',platform:'windows-x64',producerGit:'a'.repeat(40)},
  rollback:{version:'0.1.0',mode:'isolated-reset-or-reviewed-manual-reinstall'},
  artifacts:{installer:current.installer,updater:current.evidence,rollbackInstaller:prior.installer,rollbackUpdater:prior.evidence}};
 async function run({trust=source,end=windowEnd,pin}: {trust?:LauncherUpdateSource;end?:string;pin?:string}={}){
  const raw=Buffer.from(JSON.stringify(index));
  await fs.writeFile(path.join(root,'candidate-index.json'),raw);
  return verifyW14PilotIntake(root,pin??digest(raw),end,trust,now);
 }
 return {root,prior,current,index,source,run};
}

test('W14 verifies both exact releases but leaves route and qualification unverified',async t=>{
 const f=await fixture(t),result=await f.run();
 assert.equal(result.status,'LOCAL_ED25519_INSTALLER_BINDINGS_MATCH');
 assert.equal(result.qualification,'NOT_RUN');
 assert.equal(result.route,'NOT_VERIFIED');
 assert.equal(result.trustMode,'disposable-test');
 assert.deepEqual(result.releases.map(r=>[r.version,r.releaseId]),[['0.2.0',201],['0.1.0',101]]);
 assert.deepEqual(result.releases.map(r=>r.installerSha256),[f.current.installer.sha256,f.prior.installer.sha256]);
 await assert.rejects(f.run({trust:productionLauncherUpdateSource}),/Unknown launcher update publisher key/);
});

test('W14 rejects changed bytes, including the independently sealed index and prior installer',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.run({pin:'0'.repeat(64)}),/index.*SHA-256/i);
 await fs.appendFile(path.join(f.root,f.prior.installer.ref),'changed');
 await assert.rejects(f.run(),/checksum or size/i);
});

test('W14 rejects claims that disagree with the signed installer or immutable metadata',async t=>{
 const f=await fixture(t);
 f.current.installer.sha512='A'.repeat(86)+'==';
 await assert.rejects(f.run(),/index.*binding/i);
 f.current.installer.sha512=f.prior.installer.sha512;
 await assert.rejects(f.run(),/index.*binding/i);
 f.current.metadata.assets[1]!.digest='sha256:'+'0'.repeat(64);
 await f.current.writeMetadata();
 await assert.rejects(f.run(),/immutable release identities/i);
});

test('W14 rejects modified release readback, mismatched IDs and unsafe paths',async t=>{
 const f=await fixture(t);
 await fs.appendFile(path.join(f.root,f.current.evidence.releaseMetadataRef),' ');
 await assert.rejects(f.run(),/SHA-256 mismatch/);
 await f.current.writeMetadata();
 f.current.evidence.releaseId++;
 await assert.rejects(f.run(),/immutable release identities/i);
 f.current.evidence.releaseId--;
 f.current.evidence.signedEnvelopeRef='../outside.json';
 await assert.rejects(f.run(),/unsafe/i);
});

test('W14 requires validity through the entire window and disallows an updater downgrade',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.run({end:expiresAt}),/expired/i);
 f.index.rollback.version=f.index.candidate.version;
 await assert.rejects(f.run(),/rollback version/i);
 f.index.rollback.version='0.1.0';
 f.index.rollback.mode='automatic-downgrade';
 await assert.rejects(f.run(),/rollback policy/i);
});

test('W14 refuses an otherwise correctly pinned release whose envelope signature was changed',async t=>{
 const f=await fixture(t),file=path.join(f.root,f.current.evidence.signedEnvelopeRef);
 const envelope=JSON.parse(await fs.readFile(file,'utf8'));
 const signature=Buffer.from(envelope.signatureBase64,'base64');
 signature[0]=signature[0]!^1;
 envelope.signatureBase64=signature.toString('base64');
 const raw=Buffer.from(JSON.stringify(envelope));
 f.current.evidence.envelopeSha256=digest(raw);
 f.current.metadata.assets[1]!.digest='sha256:'+digest(raw);
 await fs.writeFile(file,raw);
 await f.current.writeMetadata();
 await assert.rejects(f.run(),/Ed25519 signature verification failed/);
});

test('W14 refuses a key expiring during the window separately from manifest expiry',async t=>{
 const f=await fixture(t),key=f.source.keys['w14-test-publisher']!;
 key.expiresAt='2026-11-15T12:00:00.000Z';
 await assert.rejects(f.run(),/publisher key is expired by the test window/);
});
