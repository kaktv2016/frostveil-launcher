import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,createPublicKey,sign,verify,randomUUID,type KeyObject} from 'node:crypto';
import semver from 'semver';
import {authenticode} from './windows';
import {contained,noLinks,safeDirectory,safeFile} from './files';
import {fileIdentity} from './installer/sandbox';
import {durableWrite} from './installer/metadata';
import {canonicalBytes} from './distribution/policy';
import {object,identifier,version,timestamp,hash,size,assetName} from './modpack/schema';
import type {SignedManifestEnvelope} from '../shared/contracts';

export const LAUNCHER_UPDATE_REPOSITORY='kaktv2016/frostveil-launcher';
export const LAUNCHER_UPDATE_API='https://api.github.com/repos/'+LAUNCHER_UPDATE_REPOSITORY;
export const LAUNCHER_MANIFEST_ASSET='frostveil-launcher-update.json';
export const MAX_INSTALLER_BYTES=300*1024*1024;

export interface LauncherUpdateKey {
 publicKey:string;
 environment:'production'|'test';
 revoked:boolean;
 expiresAt?:string;
}

export interface LauncherUpdateSource {
 mode:'production'|'disposable-test';
 owner:'kaktv2016';
 repo:'frostveil-launcher';
 channel:'stable';
 keys:Readonly<Record<string,LauncherUpdateKey>>;
}

// Owner-approved production identity; offline recovery verified before activation.
export const productionLauncherUpdateSource:LauncherUpdateSource={
 mode:'production',
 owner:'kaktv2016',
 repo:'frostveil-launcher',
 channel:'stable',
 keys:{'frostveil-launcher-update-20261016':{
  publicKey:"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAefA1Vf7n7EuJNWgpa4wl4OyjCPKCpi5KKTZ5QfXSV4M=\n-----END PUBLIC KEY-----\n",
  environment:'production',revoked:false,expiresAt:'2027-10-16T00:00:00.000Z'
 }}
};

export interface LauncherUpdateManifest {
 schemaVersion:1;
 keyId:string;
 owner:'kaktv2016';
 repo:'frostveil-launcher';
 tag:string;
 version:string;
 channel:'stable';
 minimumLauncherVersion:string;
 publishedAt:string;
 expiresAt:string;
 releaseNotes:string;
 installer:{
  assetId:number;
  assetName:string;
  size:number;
  sha512:string;
  sha256:string;
 };
}

export interface LauncherReleaseAsset {
 id:number;
 name:string;
 size:number;
 state:'uploaded';
 digest:string|null;
}

export interface LauncherReleaseMetadata {
 id:number;
 tag_name:string;
 draft:boolean;
 prerelease:boolean;
 published_at:string;
 body:string;
 assets:LauncherReleaseAsset[];
}

export interface Ed25519InstallerBinding {
 envelope:SignedManifestEnvelope;
 source:LauncherUpdateSource;
 release:unknown;
 installedVersion:string;
 expectedIdentity?:string;
 expectedMtimeMs?:number;
 now?:()=>number;
}

export interface LauncherUpdateTestProfile {
 schemaVersion:1;
 repository:'kaktv2016/frostveil-launcher';
 loopbackOrigin:string;
 installDirectory:string;
 keyId:string;
 publicKey:string;
 fingerprint:string;
 expiresAt:string;
 revoked:false;
}

function updateError(message:string,code:string):Error{
 return Object.assign(Error(message),{code});
}

export function hasActiveLauncherUpdateKey(source:LauncherUpdateSource=productionLauncherUpdateSource,now:()=>number=Date.now):boolean{
 const expectedEnv=source.mode==='production'?'production':'test';
 return Object.values(source.keys).some(k=>k.environment===expectedEnv&&!k.revoked&&typeof k.expiresAt==='string'&&Number.isFinite(Date.parse(k.expiresAt))&&Date.parse(k.expiresAt)>now());
}

export function activeLauncherUpdateKeyId(source:LauncherUpdateSource=productionLauncherUpdateSource,now:()=>number=Date.now):string|undefined{
 const expectedEnv=source.mode==='production'?'production':'test';
 return Object.entries(source.keys).find(([,k])=>k.environment===expectedEnv&&!k.revoked&&typeof k.expiresAt==='string'&&Number.isFinite(Date.parse(k.expiresAt))&&Date.parse(k.expiresAt)>now())?.[0];
}

export function validateLauncherUpdateManifest(raw:unknown):LauncherUpdateManifest{
 const m=object(raw,['schemaVersion','keyId','owner','repo','tag','version','channel','minimumLauncherVersion','publishedAt','expiresAt','releaseNotes','installer']);
 if(m.schemaVersion!==1||m.owner!=='kaktv2016'||m.repo!=='frostveil-launcher'||m.channel!=='stable')throw updateError('Invalid launcher update manifest scope','ERR_UPDATER_INVALID_MANIFEST');
 identifier(m.keyId);
 version(m.version);
 version(m.minimumLauncherVersion);
 if(semver.prerelease(m.version)||semver.prerelease(m.minimumLauncherVersion)||m.tag!=='v'+m.version)throw updateError('Invalid launcher update version or tag binding','ERR_UPDATER_INVALID_MANIFEST');
 timestamp(m.publishedAt);
 timestamp(m.expiresAt);
 if(Date.parse(m.expiresAt)<=Date.parse(m.publishedAt))throw updateError('Invalid launcher update manifest lifetime','ERR_UPDATER_INVALID_MANIFEST');
 if(typeof m.releaseNotes!=='string'||m.releaseNotes.length>16384||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(m.releaseNotes))throw updateError('Invalid launcher update release notes','ERR_UPDATER_INVALID_MANIFEST');
 const inst=object(m.installer,['assetId','assetName','size','sha512','sha256']);
 size(inst.assetId,Number.MAX_SAFE_INTEGER);
 if(inst.assetId<1)throw updateError('Invalid installer asset ID','ERR_UPDATER_INVALID_MANIFEST');
 assetName(inst.assetName);
 if(!inst.assetName.toLowerCase().endsWith('.exe'))throw updateError('Installer asset must be a Windows .exe','ERR_UPDATER_INVALID_MANIFEST');
 size(inst.size,MAX_INSTALLER_BYTES);
 if(inst.size<2)throw updateError('Invalid installer size','ERR_UPDATER_INVALID_MANIFEST');
 if(typeof inst.sha512!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(inst.sha512))throw updateError('Invalid installer SHA-512','ERR_UPDATER_INVALID_MANIFEST');
 hash(inst.sha256);
 return structuredClone(m) as LauncherUpdateManifest;
}

export function signLauncherUpdateManifest(rawManifest:LauncherUpdateManifest,privateKey:KeyObject):SignedManifestEnvelope{
 const manifest=validateLauncherUpdateManifest(rawManifest);
 if(privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ed25519')throw Error('Ed25519 private key required');
 const payloadBytes=canonicalBytes(manifest);
 return{
  keyId:manifest.keyId,
  payloadBase64:payloadBytes.toString('base64'),
  signatureBase64:sign(null,payloadBytes,privateKey).toString('base64')
 };
}

export function parseLauncherRelease(raw:unknown,now:()=>number=Date.now):LauncherReleaseMetadata{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw updateError('Invalid launcher release metadata','ERR_UPDATER_INVALID_RELEASE');
 const r=raw as Record<string,unknown>;
 size(r.id,Number.MAX_SAFE_INTEGER);
 if((r.id as number)<1||typeof r.tag_name!=='string'||!/^v[0-9A-Za-z.+-]{1,100}$/.test(r.tag_name)||typeof r.draft!=='boolean'||typeof r.prerelease!=='boolean'||typeof r.published_at!=='string'||!Number.isFinite(Date.parse(r.published_at))||Date.parse(r.published_at)>now()+300000||typeof r.body!=='string'||r.body.length>65536||!Array.isArray(r.assets)||r.assets.length>64)throw updateError('Invalid launcher release metadata','ERR_UPDATER_INVALID_RELEASE');
 const names=new Set<string>(),ids=new Set<number>(),assets:LauncherReleaseAsset[]=[];
 for(const item of r.assets){
  if(!item||typeof item!=='object'||Array.isArray(item))throw updateError('Invalid launcher release asset','ERR_UPDATER_INVALID_RELEASE');
  const a=item as Record<string,unknown>;
  assetName(a.name);
  size(a.id,Number.MAX_SAFE_INTEGER);
  size(a.size,MAX_INSTALLER_BYTES);
  if((a.id as number)<1||names.has(a.name.toLowerCase())||ids.has(a.id as number)||a.state!=='uploaded'||a.digest!==null&&a.digest!==undefined&&!/^sha256:[a-f0-9]{64}$/.test(String(a.digest)))throw updateError('Conflicting or invalid launcher release assets','ERR_UPDATER_INVALID_RELEASE');
  names.add(a.name.toLowerCase());
  ids.add(a.id as number);
  assets.push({id:a.id as number,name:a.name,size:a.size as number,state:'uploaded',digest:(a.digest as string|null|undefined)??null});
 }
 return{id:r.id as number,tag_name:r.tag_name,draft:r.draft,prerelease:r.prerelease,published_at:r.published_at,body:r.body,assets};
}

export function authenticateLauncherUpdate(envelope:unknown,source:LauncherUpdateSource,rawRelease:unknown,installedVersion:string,now:()=>number=Date.now){
 version(installedVersion);
 if(source.owner!=='kaktv2016'||source.repo!=='frostveil-launcher'||source.channel!=='stable')throw updateError('Untrusted launcher update source configuration','ERR_UPDATER_INVALID_SOURCE');
 let e:Record<string,any>;
 try{
  e=object(envelope,['keyId','payloadBase64','signatureBase64']);
  identifier(e.keyId);
 }catch{
  throw updateError('Malformed or unsigned launcher update manifest envelope','ERR_UPDATER_UNSIGNED_METADATA');
 }
 if(typeof e.payloadBase64!=='string'||!e.payloadBase64||e.payloadBase64.length>262144||!/^[A-Za-z0-9+/]+={0,2}$/.test(e.payloadBase64)||typeof e.signatureBase64!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(e.signatureBase64))throw updateError('Malformed launcher update signature envelope','ERR_UPDATER_INVALID_SIGNATURE');
 const keyRecord=source.keys[e.keyId];
 if(!keyRecord)throw updateError('Unknown launcher update publisher key','ERR_UPDATER_UNKNOWN_PUBLISHER');
 if(keyRecord.revoked)throw updateError('Revoked launcher update publisher key','ERR_UPDATER_REVOKED_KEY');
 if(!keyRecord.expiresAt||!Number.isFinite(Date.parse(keyRecord.expiresAt))||Date.parse(keyRecord.expiresAt)<=now())throw updateError('Expired launcher update publisher key','ERR_UPDATER_EXPIRED_KEY');
 if(source.mode==='production'&&keyRecord.environment!=='production'||source.mode==='disposable-test'&&keyRecord.environment!=='test')throw updateError('Launcher update publisher environment mismatch','ERR_UPDATER_INVALID_SIGNATURE');
 const publicKey=createPublicKey(keyRecord.publicKey);
 if(publicKey.asymmetricKeyType!=='ed25519')throw updateError('Ed25519 public key required','ERR_UPDATER_INVALID_SIGNATURE');
 const payloadBytes=Buffer.from(e.payloadBase64,'base64');
 const signatureBytes=Buffer.from(e.signatureBase64,'base64');
 if(signatureBytes.length!==64||!verify(null,payloadBytes,publicKey,signatureBytes))throw updateError('Launcher update Ed25519 signature verification failed','ERR_UPDATER_INVALID_SIGNATURE');
 let parsed:unknown;
 try{parsed=JSON.parse(payloadBytes.toString('utf8'));}catch{throw updateError('Signed launcher update payload is not valid JSON','ERR_UPDATER_INVALID_MANIFEST');}
 const manifest=validateLauncherUpdateManifest(parsed);
 if(manifest.keyId!==e.keyId||manifest.owner!==source.owner||manifest.repo!==source.repo||manifest.channel!==source.channel)throw updateError('Signed launcher update manifest identity mismatch','ERR_UPDATER_INVALID_MANIFEST');
 if(Date.parse(manifest.publishedAt)>now()+300000||Date.parse(manifest.expiresAt)<=now())throw updateError('Signed launcher update manifest is expired or not yet valid','ERR_UPDATER_EXPIRED_KEY');
 const release=parseLauncherRelease(rawRelease,now);
 if(release.draft||release.prerelease||release.tag_name!==manifest.tag)throw updateError('GitHub release tag/channel does not match signed launcher manifest','ERR_UPDATER_WRONG_RELEASE');
 const manifestAsset=release.assets.find(a=>a.name===LAUNCHER_MANIFEST_ASSET);
 if(!manifestAsset)throw updateError('Signed launcher update manifest asset missing from release','ERR_UPDATER_UNSIGNED_METADATA');
 const installerAsset=release.assets.find(a=>a.id===manifest.installer.assetId);
 if(!installerAsset||installerAsset.name!==manifest.installer.assetName||installerAsset.size!==manifest.installer.size||installerAsset.digest!==null&&installerAsset.digest!=='sha256:'+manifest.installer.sha256)throw updateError('GitHub release installer asset does not match signed launcher manifest','ERR_UPDATER_WRONG_RELEASE');
 if(semver.lt(manifest.version,installedVersion))throw updateError('Launcher update downgrade rejected','ERR_UPDATER_DOWNGRADE');
 if(semver.lt(installedVersion,manifest.minimumLauncherVersion))throw updateError('Installed launcher is older than minimumLauncherVersion; manual bootstrap update required','ERR_UPDATER_MINIMUM_VERSION');
 const manifestHash=createHash('sha256').update(payloadBytes).digest('hex');
 return{
  manifest,
  release,
  envelope:structuredClone(e) as SignedManifestEnvelope,
  manifestHash
 };
}

export type AuthenticatedLauncherUpdate=ReturnType<typeof authenticateLauncherUpdate>;

export interface LauncherVersionRecord {
 channel:'stable';
 version:string;
 manifestHash:string;
 sha512:string;
 sha256:string;
 size:number;
}

export class LauncherUpdateLedger {
 constructor(private readonly root:string){}
 private async read():Promise<LauncherVersionRecord|null>{
  try{
   const file=await safeFile(this.root,'launcher-update-history.json');
   const stat=await fs.stat(file);
   if(stat.nlink!==1||stat.size>16384)throw updateError('Unsafe launcher update version ledger','ERR_UPDATER_LEDGER_INVALID');
   const raw=object(JSON.parse(await fs.readFile(file,'utf8')),['channel','version','manifestHash','sha512','sha256','size']);
   if(raw.channel!=='stable')throw Error('Invalid channel');
   version(raw.version);
   hash(raw.manifestHash);
   hash(raw.sha256);
   size(raw.size,MAX_INSTALLER_BYTES);
   if(typeof raw.sha512!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(raw.sha512))throw Error('Invalid sha512');
   return raw as LauncherVersionRecord;
  }catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
   throw error;
  }
 }
 async check(update:AuthenticatedLauncherUpdate):Promise<void>{
  const current=await this.read();
  if(!current)return;
  if(semver.lt(update.manifest.version,current.version))throw updateError('Launcher update downgrade rejected by version ledger','ERR_UPDATER_DOWNGRADE');
  if(update.manifest.version===current.version&&(update.manifestHash!==current.manifestHash||update.manifest.installer.sha512!==current.sha512||update.manifest.installer.sha256!==current.sha256||update.manifest.installer.size!==current.size))throw updateError('Same-version launcher update payload mutation rejected','ERR_UPDATER_SAME_VERSION_MUTATION');
 }
 async accept(update:AuthenticatedLauncherUpdate):Promise<void>{
  await this.check(update);
  await safeDirectory(this.root);
  const record:LauncherVersionRecord={
   channel:'stable',
   version:update.manifest.version,
   manifestHash:update.manifestHash,
   sha512:update.manifest.installer.sha512,
   sha256:update.manifest.installer.sha256,
   size:update.manifest.installer.size
  };
  await durableWrite(path.join(this.root,'launcher-update-history.json'),Buffer.from(JSON.stringify(record,null,2)));
 }
}

export class LauncherUpdateTransport {
 private constructor(readonly base:string,readonly testOnly:boolean,private readonly timeoutMs:number,private readonly installerTimeoutMs:number){
  for(const timeout of [timeoutMs,installerTimeoutMs])if(!Number.isSafeInteger(timeout)||timeout<=0||timeout>30*60*1000)throw Error('Invalid bounded update transport timeout');
 }
 static github(timeoutMs=15000,installerTimeoutMs=30*60*1000){
  return new LauncherUpdateTransport(LAUNCHER_UPDATE_API,false,timeoutMs,installerTimeoutMs);
 }
 static loopback(origin:string,mode:LauncherUpdateSource['mode'],timeoutMs=15000,installerTimeoutMs=30*60*1000){
  const u=new URL(origin);
  if(mode!=='disposable-test'||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw updateError('Loopback launcher update transport is disposable-test only','ERR_UPDATER_INVALID_SOURCE');
  return new LauncherUpdateTransport(u.origin+'/repos/'+LAUNCHER_UPDATE_REPOSITORY,true,timeoutMs,installerTimeoutMs);
 }
 private allowed(url:URL,initial=false){
  const base=new URL(this.base);
  if(url.username||url.password||url.hash)throw updateError('Unauthorized credential or fragment in launcher update URL','ERR_UPDATER_UNAPPROVED_REDIRECT');
  if(url.origin===base.origin&&url.pathname.startsWith(base.pathname+'/releases/')&&!url.search&&!/%|\\/.test(url.pathname))return;
  if(!initial&&!this.testOnly&&url.protocol==='https:'&&!url.port&&['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname)&&/^\/github-production-release-asset\/\d+\/[a-f0-9-]{36}$/.test(url.pathname))return;
  throw updateError('Unapproved launcher update redirect or source host','ERR_UPDATER_UNAPPROVED_REDIRECT');
 }
 async request(suffix:string,signal?:AbortSignal,headers:Record<string,string>={}){
  return this.transfer(suffix,signal,headers,this.timeoutMs);
 }
 /** Large authenticated installers get a separate bounded body-transfer deadline. */
 async installer(assetId:number,signal?:AbortSignal){
  if(!Number.isSafeInteger(assetId)||assetId<1)throw Error('Invalid installer asset ID');
  return this.transfer('/releases/assets/'+assetId,signal,{},this.installerTimeoutMs);
 }
 private async transfer(suffix:string,signal:AbortSignal|undefined,headers:Record<string,string>,timeoutMs:number){
  if(!/^\/releases\/(latest|tags\/v[0-9A-Za-z.+-]+|assets\/[1-9]\d*)$/.test(suffix))throw updateError('Invalid launcher update endpoint','ERR_UPDATER_INVALID_SOURCE');
  let url=new URL(this.base+suffix);
  this.allowed(url,true);
  const combined=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
  for(let redirects=0;;redirects++){
   const response=await fetch(url,{
    signal:combined,
    redirect:'manual',
    credentials:'omit',
    headers:{
     'User-Agent':'Frostveil-Launcher-Updater',
     'Accept':suffix.includes('/assets/')?'application/octet-stream':'application/vnd.github+json',
     'X-GitHub-Api-Version':'2022-11-28',
     'Accept-Encoding':'identity',
     ...headers
    }
   });
   if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('location');
    await response.body?.cancel();
    if(!location||redirects>=2)throw updateError('Launcher update redirect limit exceeded','ERR_UPDATER_UNAPPROVED_REDIRECT');
    url=new URL(location,url);
    this.allowed(url,false);
    continue;
   }
   return response;
  }
 }
 async json(suffix:string,signal?:AbortSignal,max=1024*1024,expectedSize?:number){
  const r=await this.request(suffix,signal);
  if(r.status===404){await r.body?.cancel();throw updateError('No published launcher release found (404)','ERR_UPDATER_NO_PUBLISHED_VERSIONS');}
  if(r.status===403||r.status===429){await r.body?.cancel();throw updateError('GitHub rate limit reached ('+r.status+')','HTTP429');}
  if(r.status!==200){await r.body?.cancel();throw updateError('Launcher update HTTP failure ('+r.status+')','ERR_UPDATER_HTTP_'+r.status);}
  if(!r.body)throw updateError('Empty launcher update metadata response','ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
  const parts:Uint8Array[]=[],reader=r.body.getReader();
  let bytes=0;
  try{
   for(;;){
    const chunk=await reader.read();
    if(chunk.done)break;
    bytes+=chunk.value.length;
    if(bytes>max)throw updateError('Launcher update metadata exceeds size limit','ERR_UPDATER_INVALID_MANIFEST');
    parts.push(chunk.value);
   }
  }finally{
   await reader.cancel().catch(()=>{});
   reader.releaseLock();
  }
  if(expectedSize!==undefined&&bytes!==expectedSize)throw updateError('Launcher update metadata declared size mismatch','ERR_UPDATER_INVALID_MANIFEST');
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
 }
}

export async function verifyDownloadedInstaller(
 file:string,
 sha512:string,
 publishers:readonly string[],
 signature=authenticode,
 ed25519Binding?:Ed25519InstallerBinding
):Promise<void>{
 if(!file.toLowerCase().endsWith('.exe'))throw Error('Trusted NSIS installer required');
 if(!ed25519Binding){
  if(!publishers.length)throw Error('Trusted NSIS installer required');
  const hash512=createHash('sha512');
  for await(const chunk of createReadStream(file))hash512.update(chunk);
  if(hash512.digest('base64')!==sha512)throw updateError('Update checksum failed','ERR_UPDATER_CHECKSUM_MISMATCH');
  const signer=await signature(file);
  if(!signer.valid||!publishers.includes(signer.subject))throw updateError('Update signer failed','ERR_UPDATER_INVALID_SIGNATURE');
  return;
 }
 await noLinks(file);
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.nlink!==1)throw updateError('Cached installer link or replacement detected','ERR_UPDATER_INSTALLER_REPLACED');
 const authenticated=authenticateLauncherUpdate(ed25519Binding.envelope,ed25519Binding.source,ed25519Binding.release,ed25519Binding.installedVersion,ed25519Binding.now);
 if(ed25519Binding.expectedIdentity!==undefined&&await fileIdentity(file)!==ed25519Binding.expectedIdentity)throw updateError('Cached installer identity changed after verification','ERR_UPDATER_INSTALLER_REPLACED');
 if(ed25519Binding.expectedMtimeMs!==undefined&&Math.abs(stat.mtimeMs-ed25519Binding.expectedMtimeMs)>1)throw updateError('Cached installer timestamp changed after verification','ERR_UPDATER_INSTALLER_REPLACED');
 const hash512=createHash('sha512'),hash256=createHash('sha256');
 let total=0;
 const header=Buffer.alloc(2);
 let headerRead=0;
 for await(const chunk of createReadStream(file)){
  const buf=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
  if(headerRead<2){
   const copyLen=Math.min(2-headerRead,buf.length);
   buf.copy(header,headerRead,0,copyLen);
   headerRead+=copyLen;
  }
  total+=buf.length;
  if(total>MAX_INSTALLER_BYTES)throw updateError('Installer exceeds maximum allowed size','ERR_UPDATER_CHECKSUM_MISMATCH');
  hash512.update(buf);
  hash256.update(buf);
 }
 const digest512=hash512.digest('base64'),digest256=hash256.digest('hex');
 if(total!==authenticated.manifest.installer.size||digest512!==sha512||digest512!==authenticated.manifest.installer.sha512||digest256!==authenticated.manifest.installer.sha256)throw updateError('Update checksum or size failed','ERR_UPDATER_CHECKSUM_MISMATCH');
 if(headerRead<2||header[0]!==0x4d||header[1]!==0x5a)throw updateError('Downloaded file is not a valid Windows PE installer','ERR_UPDATER_INVALID_INSTALLER');
}

export async function prepareVerifiedInstallHandoff(cachedFile:string,binding:Ed25519InstallerBinding,storageDir:string):Promise<string>{
 await verifyDownloadedInstaller(cachedFile,validateLauncherUpdateManifest(JSON.parse(Buffer.from(binding.envelope.payloadBase64,'base64').toString('utf8'))).installer.sha512,[],authenticode,binding);
 const authenticated=authenticateLauncherUpdate(binding.envelope,binding.source,binding.release,binding.installedVersion,binding.now);
 const beforeStat=await fs.lstat(cachedFile);
 const beforeIdentity=await fileIdentity(cachedFile);
 if(binding.expectedIdentity!==undefined&&beforeIdentity!==binding.expectedIdentity)throw updateError('Cached installer replaced before handoff','ERR_UPDATER_INSTALLER_REPLACED');
 const handoffDir=path.join(storageDir,'launcher-updates','handoff-'+randomUUID());
 await safeDirectory(handoffDir);
 const handoffFile=path.join(handoffDir,authenticated.manifest.installer.assetName);
 await fs.copyFile(cachedFile,handoffFile,fs.constants.COPYFILE_EXCL);
 const handle=await fs.open(handoffFile,'r+');
 try{await handle.sync();}finally{await handle.close();}
 const afterStat=await fs.lstat(cachedFile);
 const afterIdentity=await fileIdentity(cachedFile);
 if(afterIdentity!==beforeIdentity||Math.abs(afterStat.mtimeMs-beforeStat.mtimeMs)>1||afterStat.nlink!==1)throw updateError('Cached installer mutated during handoff copy','ERR_UPDATER_INSTALLER_REPLACED');
 const handoffStat=await fs.lstat(handoffFile);
 const handoffIdentity=await fileIdentity(handoffFile);
 await verifyDownloadedInstaller(handoffFile,authenticated.manifest.installer.sha512,[],authenticode,{
  ...binding,
  expectedIdentity:handoffIdentity,
  expectedMtimeMs:handoffStat.mtimeMs
 });
 return handoffFile;
}

export function validateLauncherUpdateTestProfile(raw:unknown,now:()=>number=Date.now):LauncherUpdateTestProfile{
 const p=object(raw,['schemaVersion','repository','loopbackOrigin','installDirectory','keyId','publicKey','fingerprint','expiresAt','revoked']);
 identifier(p.keyId);
 timestamp(p.expiresAt);
 if(p.schemaVersion!==1||p.repository!==LAUNCHER_UPDATE_REPOSITORY||p.revoked!==false||!p.keyId.startsWith('frostveil-launcher-test-')||Date.parse(p.expiresAt)<=now()||Date.parse(p.expiresAt)>now()+7*86400000)throw Error('Invalid or expired launcher update test profile');
 const u=new URL(String(p.loopbackOrigin));
 if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.search||u.hash)throw Error('Loopback origin required for launcher update test profile');
 if(typeof p.installDirectory!=='string'||!path.isAbsolute(p.installDirectory)||!contained(os.tmpdir(),p.installDirectory))throw Error('Disposable test installDirectory must be inside os.tmpdir()');
 if(typeof p.publicKey!=='string'||p.publicKey.length>4096||!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(p.publicKey))throw Error('Public SPKI PEM required');
 const key=createPublicKey(p.publicKey);
 if(key.asymmetricKeyType!=='ed25519'||createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex')!==p.fingerprint)throw Error('Launcher update test key fingerprint mismatch');
 return structuredClone(p) as LauncherUpdateTestProfile;
}
