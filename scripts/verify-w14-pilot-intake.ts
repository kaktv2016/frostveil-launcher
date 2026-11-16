import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import semver from 'semver';
import {safeFile} from '../src/main/files';
import {authenticateRelease,productionSource,type DistributionSource} from '../src/main/distribution/policy';
import {assertW14ContentPairing} from '../src/main/distribution/w14-content-compatibility';
import {authenticateRuntimeCohort} from '../src/main/runtime/policy';
import {
 LAUNCHER_MANIFEST_ASSET,authenticateLauncherUpdate,w14PilotLauncherUpdateSource,verifyDownloadedInstaller,
 type LauncherUpdateSource
} from '../src/main/update-integrity';

type RecordData=Record<string,unknown>;

function record(value:unknown):RecordData{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid W14 intake object');
 return value as RecordData;
}
function matches(value:unknown,pattern:RegExp):value is string{
 return typeof value==='string'&&pattern.test(value);
}

async function readPinnedJson(file:string,expected:unknown,maxBytes:number){
 if(!matches(expected,/^[a-f0-9]{64}$/i))throw Error('Missing SHA-256 pin');
 const handle=await fs.open(file,'r');
 let bytes:Buffer;
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>maxBytes)throw Error('Unexpected JSON file size or link count');
  bytes=Buffer.alloc(stat.size);
  let offset=0;
  while(offset<bytes.length){
   const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
   if(!bytesRead)throw Error('Truncated intake JSON');
   offset+=bytesRead;
  }
  if((await handle.stat()).size!==stat.size)throw Error('Intake JSON size changed');
 }finally{
  await handle.close();
 }
 const sha256=createHash('sha256').update(bytes).digest('hex');
 if(sha256!==expected.toLowerCase())throw Error(`${path.basename(file)==='candidate-index.json'?'Candidate index ':''}SHA-256 mismatch`);
 return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown,sha256,bytes:bytes.length};
}

async function openIntake(root:string,indexSha256:string,windowEnd:string,verifiedAt:number){
 if(!path.isAbsolute(root)||process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(root))throw Error('Absolute local intake root required');
 const end=Date.parse(windowEnd);
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(windowEnd)||!Number.isFinite(end)||end<=verifiedAt||
    new Date(end).toISOString()!==(windowEnd.length===20?windowEnd.slice(0,-1)+'.000Z':windowEnd)){
  throw Error('A future UTC test window end is required');
 }
 const usedPaths=new Set<string>();
 async function intakeFile(reference:unknown){
  if(!matches(reference,/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/)||reference.length>240){
   throw Error('Unsafe intake reference');
  }
  const file=await safeFile(root,reference);
  const identity=file.toLowerCase();
  if(usedPaths.has(identity))throw Error('Repeated intake reference');
  usedPaths.add(identity);
  return file;
 }
 const indexFile=await readPinnedJson(await intakeFile('candidate-index.json'),indexSha256,1024*1024);
 const index=record(indexFile.value),candidate=record(index.candidate);
 if(index.classification!=='SEALED_CANDIDATE'||candidate.platform!=='windows-x64'||
    !matches(candidate.id,/^[A-Za-z0-9_-]{1,100}$/)||!matches(candidate.producerGit,/^[a-f0-9]{40}$/)||
    !matches(candidate.version,/^\d+\.\d+\.\d+$/)||!semver.valid(candidate.version))throw Error('Invalid sealed candidate identity');
 return {index,candidate:{id:candidate.id,producerGit:candidate.producerGit,version:candidate.version},
  indexDigest:indexFile.sha256,end,intakeFile,artifacts:record(index.artifacts)};
}

export async function verifyW14PilotIntake(
 root:string,indexSha256:string,windowEnd:string,
 source:LauncherUpdateSource=w14PilotLauncherUpdateSource,now:()=>number=Date.now
){
 const verifiedAt=now();
 const {index,candidate,indexDigest,end,intakeFile,artifacts}=await openIntake(root,indexSha256,windowEnd,verifiedAt);
 const rollback=record(index.rollback);
 if(rollback.mode!=='isolated-reset-or-reviewed-manual-reinstall')throw Error('Invalid rollback policy');
 if(!matches(rollback.version,/^\d+\.\d+\.\d+$/)||!semver.valid(rollback.version)||!semver.lt(rollback.version,candidate.version)){
  throw Error('Invalid rollback version');
 }

 async function verifyRelease(installer:RecordData,reference:RecordData,version:string,installedVersion:string){
  const envelope=await readPinnedJson(await intakeFile(reference.signedEnvelopeRef),reference.envelopeSha256,512*1024);
  const metadata=await readPinnedJson(await intakeFile(reference.releaseMetadataRef),reference.releaseMetadataSha256,1024*1024);
  const authenticated=authenticateLauncherUpdate(envelope.value,source,metadata.value,installedVersion,()=>verifiedAt);
  const {manifest,release}=authenticated;
  if(Date.parse(manifest.expiresAt)<=end||Date.parse(source.keys[manifest.keyId]?.expiresAt??'')<=end){
   throw Error('Signed metadata or publisher key is expired by the test window end');
  }
  const envelopeAsset=release.assets.find(asset=>asset.name===LAUNCHER_MANIFEST_ASSET);
  const installerAsset=release.assets.find(asset=>asset.id===manifest.installer.assetId);
  if(release.id!==reference.releaseId||manifest.installer.assetId!==reference.installerAssetId||
     !envelopeAsset||envelopeAsset.id!==reference.envelopeAssetId||envelopeAsset.size!==envelope.bytes||
     envelopeAsset.digest!==`sha256:${envelope.sha256}`||installerAsset?.digest!==`sha256:${manifest.installer.sha256}`){
   throw Error('Intake does not match immutable release identities');
  }
  const file=await intakeFile(installer.ref);
  const expected=manifest.installer;
  const indexSha512=matches(installer.sha512,/^[a-f0-9]{128}$/i)?Buffer.from(installer.sha512,'hex').toString('base64'):installer.sha512;
  if(manifest.version!==version||path.basename(file)!==expected.assetName||installer.bytes!==expected.size||
     !matches(installer.sha256,/^[a-f0-9]{64}$/i)||installer.sha256.toLowerCase()!==expected.sha256||indexSha512!==expected.sha512){
   throw Error('Intake index disagrees with signed installer binding');
  }
  await verifyDownloadedInstaller(file,expected.sha512,[],undefined,{
   envelope:authenticated.envelope,source,release,installedVersion,now:()=>verifiedAt
  });
  return {version,releaseId:release.id,installerAssetId:expected.assetId,envelopeAssetId:envelopeAsset.id,
   installerBytes:expected.size,installerSha256:expected.sha256,
   publisherKeyId:manifest.keyId,manifestHash:authenticated.manifestHash,releaseMetadataSha256:metadata.sha256};
 }

 const current=await verifyRelease(record(artifacts.installer),record(artifacts.updater),candidate.version,rollback.version);
 // Authenticate the prior installer as its own release. Preserve the updater's downgrade refusal.
 const prior=await verifyRelease(record(artifacts.rollbackInstaller),record(artifacts.rollbackUpdater),rollback.version,rollback.version);
 if(current.releaseId===prior.releaseId||new Set([current.installerAssetId,current.envelopeAssetId,prior.installerAssetId,prior.envelopeAssetId]).size!==4){
  throw Error('Candidate and rollback must bind distinct release assets');
 }
 return {status:'LOCAL_ED25519_INSTALLER_BINDINGS_MATCH',qualification:'NOT_RUN',route:'NOT_VERIFIED',
  trustMode:source.mode,candidateIndexSha256:indexDigest,candidateId:candidate.id,producerGit:candidate.producerGit,
  verifiedAt:new Date(verifiedAt).toISOString(),testWindowEnd:new Date(end).toISOString(),releases:[current,prior]};
}

export async function verifyW14PilotContent(root:string,indexSha256:string,windowEnd:string,source:DistributionSource=productionSource){
 const verifiedAt=Date.now();
 const {index,candidate,indexDigest,end,intakeFile,artifacts}=await openIntake(root,indexSha256,windowEnd,verifiedAt);
 const runtimeRef=record(artifacts.runtime),packRef=record(artifacts.pack);
 const runtimeEnvelope=await readPinnedJson(await intakeFile(runtimeRef.signedEnvelopeRef),runtimeRef.sha256,8*1024*1024);
 const packEnvelope=await readPinnedJson(await intakeFile(packRef.signedEnvelopeRef),packRef.sha256,6*1024*1024);
 const metadata=await readPinnedJson(await intakeFile(packRef.releaseMetadataRef),packRef.releaseMetadataSha256,1024*1024);
 const runtime=authenticateRuntimeCohort(runtimeEnvelope.value,source.keys,{fixture:source.mode==='sandbox-test'});
 const verified=authenticateRelease(packEnvelope.value,source,metadata.value);
 const {manifest,server,packages,release,manifestHash}=verified;
 const profile=record(index.profile),compatibility=record(artifacts.compatibility);
 if(profile.steamApp!==runtime.appId||profile.language!==runtime.language||profile.runtime!==runtime.runtime||
    manifest.requiredSkyrimRuntime!==runtime.runtime||profile.skse!=='2.2.6'||manifest.requiredSKSEVersion!=='0.2.2.6'||
    profile.endpointPort!==7777||compatibility.serverGit!==server.engineCommit||semver.lt(candidate.version,manifest.minimumLauncherVersion)){
  throw Error('Signed content does not bind the sealed profile');
 }
 const runtimeKeyId=record(runtimeEnvelope.value).keyId as string;
 const packKeyId=manifest.signing.keyId;
 if([runtime.createdAt,manifest.generatedAt,server.generatedAt,release.published_at].some(value=>Date.parse(value)>verifiedAt)){
  throw Error('Signed content is not yet valid at the test window start');
 }
 const expiries=[runtime.expiresAt,server.expiresAt,source.keys[runtimeKeyId]?.expiresAt,source.keys[packKeyId]?.expiresAt];
 if(expiries.some(value=>!value||!Number.isFinite(Date.parse(value))||Date.parse(value)<=end)||
    Date.parse(runtime.createdAt)>=Date.parse(runtime.expiresAt))throw Error('Signed content or publisher key expires within the test window');
 if(runtimeRef.publicKeyId!==runtimeKeyId||runtimeRef.expiresAtUtc!==runtime.expiresAt||
    packRef.publicKeyId!==packKeyId||packRef.expiresAtUtc!==server.expiresAt)throw Error('Signed content disagrees with index publisher or expiry');
 const envelopeAsset=release.assets.find(asset=>asset.name==='frostveil-manifest.json');
 const assetsById=new Map(release.assets.map(asset=>[asset.id,asset]));
 if(!release.immutable||release.id!==packRef.releaseId||!envelopeAsset||envelopeAsset.id!==packRef.envelopeAssetId||
    envelopeAsset.size!==packEnvelope.bytes||envelopeAsset.digest!==`sha256:${packEnvelope.sha256}`||
    packages.some(pkg=>assetsById.get(pkg.assetId)?.digest!==`sha256:${pkg.sha256}`))throw Error('Intake does not match immutable pack release assets');
 const commonRequiredFiles=assertW14ContentPairing(runtime,verified);
 return {status:'LOCAL_ED25519_CONTENT_BINDINGS_MATCH',qualification:'NOT_RUN',installedBytes:'NOT_VERIFIED',
  packagePayloadBytes:'NOT_VERIFIED',nativePairing:'NOT_VERIFIED',
  trustMode:source.mode,candidateIndexSha256:indexDigest,candidateId:candidate.id,producerGit:candidate.producerGit,
  checkedAt:new Date(verifiedAt).toISOString(),testWindowEnd:new Date(end).toISOString(),commonRequiredFiles,
  runtime:{envelopeSha256:runtimeEnvelope.sha256,keyId:runtimeKeyId,expiresAt:runtime.expiresAt,depots:runtime.depots,helper:runtime.helper},
  pack:{envelopeSha256:packEnvelope.sha256,keyId:packKeyId,expiresAt:server.expiresAt,releaseId:release.id,
   envelopeAssetId:envelopeAsset.id,releaseMetadataSha256:metadata.sha256,manifestHash,serverEngineCommit:server.engineCommit}};
}
