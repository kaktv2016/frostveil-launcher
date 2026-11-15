import {createHash,createPublicKey,type KeyObject} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import semver from 'semver';
import {contained,noLinks,safeFile} from '../src/main/files';
import {assetName,hash,identifier,object,size,timestamp,version} from '../src/main/modpack/schema';
import {verifyW14UpdateAcl} from '../src/main/windows';
import {
 authenticateLauncherUpdate,LAUNCHER_MANIFEST_ASSET,MAX_INSTALLER_BYTES,signLauncherUpdateManifest,
 verifyDownloadedInstaller,w14PilotLauncherUpdateSource,type LauncherUpdateManifest,type LauncherUpdateSource
} from '../src/main/update-integrity';

async function localDirectory(directory:string){
 if(!path.isAbsolute(directory)||(process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(directory))){
  throw Error('Absolute local directory required');
 }
 const root=path.resolve(directory);
 await noLinks(root);
 const canonical=await fs.realpath(root);
 if(canonical.toLowerCase()!==root.toLowerCase()||!(await fs.stat(canonical)).isDirectory())throw Error('Unsafe local directory');
 return canonical;
}

function releasePlan(raw:unknown){
 const value=object(raw,['version','releaseId','installerAssetId','envelopeAssetId','ref','bytes','sha256','sha512']);
 version(value.version);
 if(semver.prerelease(value.version))throw Error('Expected a W14 x.y.z release version');
 for(const id of [value.releaseId,value.installerAssetId,value.envelopeAssetId]){
  size(id,Number.MAX_SAFE_INTEGER);
  if(id<1)throw Error('Positive W14 release and asset IDs required');
 }
 size(value.bytes,MAX_INSTALLER_BYTES);
 hash(value.sha256);
 if(typeof value.ref!=='string'||value.bytes<2||typeof value.sha512!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(value.sha512)){
  throw Error('Expected installer path, size and hashes');
 }
 const name=path.basename(value.ref);
 assetName(name);
 if(!name.toLowerCase().endsWith('.exe'))throw Error('Expected NSIS installer asset name');
 return {version:value.version as string,releaseId:value.releaseId as number,installerAssetId:value.installerAssetId as number,
  envelopeAssetId:value.envelopeAssetId as number,ref:value.ref,name,bytes:value.bytes as number,sha256:value.sha256 as string,sha512:value.sha512};
}

async function assertMissingPacket(file:string){
 try{await fs.lstat(file);throw Error('This W14 packet already exists');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

async function stageApprovedInstaller(input:string,stage:string,role:'prior'|'candidate',plan:ReturnType<typeof releasePlan>){
 const source=await safeFile(input,plan.ref);
 const before=await fs.lstat(source,{bigint:true});
 if(before.size!==BigInt(plan.bytes)||before.nlink!==1n||!before.isFile())throw Error('Approved installer size or identity mismatch');
 const handle=await fs.open(source,'r');
 const target=path.join(stage,role+'.exe');
 try{
  const opened=await handle.stat({bigint:true});
  await safeFile(input,plan.ref);
  const current=await fs.lstat(source,{bigint:true});
  if(!opened.isFile()||opened.nlink!==1n||[before,current].some(info=>
    info.dev!==opened.dev||info.ino!==opened.ino||info.size!==opened.size||info.mtimeNs!==opened.mtimeNs||info.ctimeNs!==opened.ctimeNs)){
   throw Error('Approved installer identity changed at open');
  }
  const sha256=createHash('sha256'),sha512=createHash('sha512');
  let total=0,firstBytes=Buffer.alloc(0);
  const measure=new Transform({transform(bytes:Buffer,_encoding,callback){
   total+=bytes.length;
   if(total>plan.bytes){callback(Error('Approved installer exceeded expected size'));return;}
   if(firstBytes.length<2)firstBytes=Buffer.concat([firstBytes,bytes.subarray(0,2-firstBytes.length)]);
   sha256.update(bytes);
   sha512.update(bytes);
   callback(null,bytes);
  }});
  await pipeline(handle.createReadStream({autoClose:false}),measure,createWriteStream(target,{flags:'wx',mode:0o600}));
  if(total!==plan.bytes||sha256.digest('hex')!==plan.sha256||sha512.digest('base64')!==plan.sha512||!firstBytes.equals(Buffer.from('MZ'))){
   throw Error('Approved installer identity or PE header mismatch');
  }
 }finally{await handle.close();}
 return target;
}

export async function prepareW14FolderRelease(
 inputDirectory:string,outputParent:string,rawPlan:Buffer,expectedPlanSha256:string,loadSigner:()=>Promise<KeyObject>,
 source:LauncherUpdateSource=w14PilotLauncherUpdateSource,now:()=>number=Date.now
){
 const planSha256=createHash('sha256').update(rawPlan).digest('hex');
 if(rawPlan.length>65536||!/^([a-f0-9]{64})$/i.test(expectedPlanSha256)||planSha256!==expectedPlanSha256.toLowerCase()){
  throw Error('W14 plan SHA-256 or size mismatch');
 }
 const approved=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawPlan)),
  ['schemaVersion','channel','keyId','publishedAt','expiresAt','prior','candidate']);
 if(approved.schemaVersion!==1||approved.channel!=='w14-pilot'||source.channel!=='w14-pilot')throw Error('Expected a W14 Pilot plan');
 identifier(approved.keyId);
 timestamp(approved.publishedAt);
 timestamp(approved.expiresAt);
 const checkedAt=now(),publishedAt=Date.parse(approved.publishedAt),expiresAt=Date.parse(approved.expiresAt);
 const pin=Object.hasOwn(source.keys,approved.keyId)?source.keys[approved.keyId]:undefined;
 const keyExpiry=Date.parse(pin?.expiresAt??'');
 if(!pin||pin.revoked||pin.environment!==(source.mode==='production'?'production':'test')||!Number.isFinite(keyExpiry)||
    !Number.isFinite(publishedAt)||!Number.isFinite(expiresAt)||publishedAt>checkedAt||expiresAt<=checkedAt||expiresAt>keyExpiry){
  throw Error('Unapproved W14 signing pin or release lifetime');
 }
 const prior=releasePlan(approved.prior),candidate=releasePlan(approved.candidate);
 const assets=[prior.installerAssetId,prior.envelopeAssetId,candidate.installerAssetId,candidate.envelopeAssetId];
 if(!semver.lt(prior.version,candidate.version)||prior.releaseId===candidate.releaseId||new Set(assets).size!==4||
    prior.ref.toLowerCase()===candidate.ref.toLowerCase())throw Error('W14 requires distinct, ordered releases and assets');

 const input=await localDirectory(inputDirectory),parent=await localDirectory(outputParent);
 if(contained(input,parent)||contained(parent,input))throw Error('Input and output require separate directories');
 if(!await verifyW14UpdateAcl(parent,parent,parent))throw Error('Private output folder ACL could not be verified');
 const packet='w14-feed-'+planSha256;
 const final=path.join(parent,packet);
 await assertMissingPacket(final);
 const stage=await fs.mkdtemp(path.join(parent,'.w14-preparing-'));
 const ownedStage=await fs.lstat(stage,{bigint:true});
 let published=false;
 try{
  await fs.mkdir(path.join(stage,'assets'));
  await fs.mkdir(path.join(stage,'releases'));
  const priorFile=await stageApprovedInstaller(input,stage,'prior',prior);
  const candidateFile=await stageApprovedInstaller(input,stage,'candidate',candidate);
  if(now()>=expiresAt)throw Error('W14 release expired while staging installers');
  const privateKey=await loadSigner();
  if(privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ed25519'||
     !createPublicKey(privateKey).equals(createPublicKey(pin.publicKey)))throw Error('W14 signer does not match the existing publisher pin');

  async function writeRelease(planned:ReturnType<typeof releasePlan>,file:string){
   const manifest:LauncherUpdateManifest={schemaVersion:1,keyId:approved.keyId,owner:source.owner,repo:source.repo,
    tag:'v'+planned.version,version:planned.version,channel:'w14-pilot',releaseId:planned.releaseId,
    minimumLauncherVersion:prior.version,publishedAt:approved.publishedAt,expiresAt:approved.expiresAt,releaseNotes:'W14 Pilot '+planned.version,
    installer:{assetId:planned.installerAssetId,assetName:planned.name,size:planned.bytes,sha256:planned.sha256,sha512:planned.sha512}};
   const envelope=signLauncherUpdateManifest(manifest,privateKey);
   const envelopeBytes=Buffer.from(JSON.stringify(envelope)+'\n');
   const envelopeSha256=createHash('sha256').update(envelopeBytes).digest('hex');
   const release={id:planned.releaseId,tag_name:manifest.tag,published_at:manifest.publishedAt,draft:false,prerelease:false,body:'',assets:[
    {id:planned.installerAssetId,name:planned.name,state:'uploaded',size:planned.bytes,digest:'sha256:'+planned.sha256},
    {id:planned.envelopeAssetId,name:LAUNCHER_MANIFEST_ASSET,state:'uploaded',size:envelopeBytes.length,digest:'sha256:'+envelopeSha256}
   ]};
   authenticateLauncherUpdate(envelope,source,release,prior.version,now);
   await verifyDownloadedInstaller(file,planned.sha512,[],undefined,{envelope,source,release,installedVersion:prior.version,now});
   const releaseMetadataRef='releases/'+manifest.tag+'.json';
   const metadataBytes=Buffer.from(JSON.stringify(release,null,2)+'\n');
   await fs.writeFile(path.join(stage,'assets',String(planned.envelopeAssetId)),envelopeBytes,{flag:'wx'});
   await fs.writeFile(path.join(stage,releaseMetadataRef),metadataBytes,{flag:'wx'});
   await fs.rename(file,path.join(stage,'assets',String(planned.installerAssetId)));
   return {version:planned.version,releaseId:planned.releaseId,installerAssetId:planned.installerAssetId,
    envelopeAssetId:planned.envelopeAssetId,installerName:planned.name,installerBytes:planned.bytes,installerSha256:planned.sha256,
    installerSha512:planned.sha512,envelopeSha256,releaseMetadataRef,releaseMetadataSha256:createHash('sha256').update(metadataBytes).digest('hex')};
  }
  const preparedPrior=await writeRelease(prior,priorFile);
  const preparedCandidate=await writeRelease(candidate,candidateFile);
  const result={classification:'OFFLINE_W14_FOLDER_PACKET',qualification:'NOT_RUN',targetReadback:'NOT_RUN',trustMode:source.mode,packet,
   planSha256,keyId:approved.keyId,expiresAt:approved.expiresAt,releases:[preparedPrior,preparedCandidate]};
  await fs.writeFile(path.join(stage,'preparation-receipt.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  await fs.copyFile(path.join(stage,preparedCandidate.releaseMetadataRef),path.join(stage,'latest.json'),fs.constants.COPYFILE_EXCL);
  if((await localDirectory(stage)).toLowerCase()!==stage.toLowerCase())throw Error('W14 staging directory changed');
  for(const directory of [stage,path.join(stage,'assets'),path.join(stage,'releases')]){
   if(!await verifyW14UpdateAcl(parent,stage,directory))throw Error('Private output ACL changed while staging');
  }
  await assertMissingPacket(final);
  await fs.rename(stage,final);
  published=true;
  return result;
 }finally{
  if(!published){
   await noLinks(stage);
   const current=await fs.lstat(stage,{bigint:true});
   const resolved=await fs.realpath(stage);
   if(resolved===stage&&path.dirname(resolved)===parent&&current.isDirectory()&&
      current.dev===ownedStage.dev&&current.ino===ownedStage.ino){
    await fs.rm(resolved,{recursive:true,force:true});
   }
  }
 }
}
