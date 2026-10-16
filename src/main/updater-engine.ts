import {NsisUpdater} from 'electron-updater';
import {CancellationToken} from 'builder-util-runtime';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {UpdateEngine} from './launcher-update-service';
import {authenticode} from './windows';
import {safeDirectory} from './files';
import {fileIdentity} from './installer/sandbox';
import {
 LAUNCHER_MANIFEST_ASSET,
 LauncherUpdateLedger,
 LauncherUpdateTransport,
 authenticateLauncherUpdate,
 hasActiveLauncherUpdateKey,
 parseLauncherRelease,
 prepareVerifiedInstallHandoff,
 productionLauncherUpdateSource,
 validateLauncherUpdateManifest,
 verifyDownloadedInstaller,
 type AuthenticatedLauncherUpdate,
 type Ed25519InstallerBinding,
 type LauncherUpdateSource
} from './update-integrity';

export interface NsisEngineOptions {
 source?:LauncherUpdateSource;
 transport?:LauncherUpdateTransport;
 storageDir?:string;
 installedVersion?:string;
 installDirectory?:string;
 now?:()=>number;
 runHandoffInstaller?:(handoffFile:string,args:string[])=>Promise<void>;
}

function createNsisUpdater(installedVersion:string,storageDir:string):NsisUpdater{
 try{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron=require('electron') as {app?:{getVersion?:()=>string}};
  if(electron?.app&&typeof electron.app.getVersion==='function')return new NsisUpdater();
 }catch{/* Running in plain Node test process */}
 const fallbackApp={
  version:installedVersion,
  name:'skyrim-rp-launcher',
  isPackaged:true,
  appUpdateConfigPath:path.join(storageDir,'app-update.yml'),
  userDataPath:storageDir,
  baseCachePath:storageDir,
  whenReady:async()=>{},
  quit:()=>{},
  relaunch:()=>{},
  onQuit:()=>{}
 };
 return new NsisUpdater(undefined,fallbackApp as any);
}

export class NsisEngine extends EventEmitter implements UpdateEngine {
 readonly updater:NsisUpdater;
 private token?:CancellationToken;
 private controller?:AbortController;
 private info?:Record<string,unknown>;
 private authenticated?:AuthenticatedLauncherUpdate;
 private verifiedFile?:string;
 private verifiedBinding?:{sha512:string;binding:Ed25519InstallerBinding};
 private readonly source:LauncherUpdateSource;
 private readonly transport:LauncherUpdateTransport;
 private readonly storageDir:string;
 private readonly installedVersion:string;
 private readonly now:()=>number;
 private readonly ledger:LauncherUpdateLedger;

 constructor(private readonly publishers:readonly string[]=[],private readonly options:NsisEngineOptions={}){
  super();
  this.source=options.source??productionLauncherUpdateSource;
  this.transport=options.transport??LauncherUpdateTransport.github();
  this.storageDir=options.storageDir??path.join(process.env.LOCALAPPDATA??os.tmpdir(),'SkyrimRPLauncher');
  this.installedVersion=options.installedVersion??'0.1.6';
  this.now=options.now??Date.now;
  this.ledger=new LauncherUpdateLedger(this.storageDir);
  this.updater=createNsisUpdater(this.installedVersion,this.storageDir);
  const u=this.updater;
  u.autoDownload=false;
  u.autoInstallOnAppQuit=false;
  u.allowPrerelease=false;
  u.channel='latest';
  u.allowDowngrade=false;
  u.disableWebInstaller=true;
  u.disableDifferentialDownload=true;
  u.logger=null;
  if(options.installDirectory)u.installDirectory=options.installDirectory;
  const verify=u.verifyUpdateCodeSignature;
  u.verifyUpdateCodeSignature=async(pubs,file)=>{
   if(this.verifiedBinding){
    try{
     await verifyDownloadedInstaller(file,this.verifiedBinding.sha512,this.publishers,authenticode,this.verifiedBinding.binding);
     return null;
    }catch{
     return 'Ed25519 installer binding verification failed closed';
    }
   }
   const result=await verify(pubs,file);
   if(result!==null)return result;
   const signature=await authenticode(file);
   return signature.valid&&pubs.includes(signature.subject)?null:'Authenticode validation failed closed';
  };
  u.on('error',error=>this.emit('install-error',error));
 }

 getVerifiedFilePath():string|undefined{
  return this.verifiedFile;
 }

 async check(){
  this.controller=new AbortController();
  this.authenticated=undefined;
  this.verifiedFile=undefined;
  this.verifiedBinding=undefined;
  try{
   const rawRelease=await this.transport.json('/releases/latest',this.controller.signal);
   const release=parseLauncherRelease(rawRelease,this.now);
   const manifestAsset=release.assets.find(a=>a.name===LAUNCHER_MANIFEST_ASSET);
   if(!manifestAsset)throw Object.assign(Error('Release is missing signed launcher update manifest'),{code:'ERR_UPDATER_UNSIGNED_METADATA'});
   const envelope=await this.transport.json('/releases/assets/'+manifestAsset.id,this.controller.signal,manifestAsset.size,manifestAsset.size);
   if(Object.keys(this.source.keys).length>0){
    const authenticated=authenticateLauncherUpdate(envelope,this.source,rawRelease,this.installedVersion,this.now);
    await this.ledger.check(authenticated);
    this.authenticated=authenticated;
    this.info={
     version:authenticated.manifest.version,
     files:[{url:authenticated.manifest.installer.assetName,sha512:authenticated.manifest.installer.sha512,size:authenticated.manifest.installer.size}],
     releaseNotes:authenticated.manifest.releaseNotes,
     keyId:authenticated.manifest.keyId,
     minimumLauncherVersion:authenticated.manifest.minimumLauncherVersion,
     verifiedManifest:true
    };
    return this.info;
   }
   // No production key pinned yet: still require a structurally valid signed manifest envelope, never unsigned latest.yml.
   if(!envelope||typeof envelope!=='object'||typeof (envelope as Record<string,unknown>).payloadBase64!=='string')throw Object.assign(Error('Unsigned release metadata rejected'),{code:'ERR_UPDATER_UNSIGNED_METADATA'});
   const preview=validateLauncherUpdateManifest(JSON.parse(Buffer.from(String((envelope as Record<string,unknown>).payloadBase64),'base64').toString('utf8')));
   if(release.draft||release.prerelease||release.tag_name!==preview.tag)throw Object.assign(Error('Release tag mismatch'),{code:'ERR_UPDATER_WRONG_RELEASE'});
   this.info={
    version:preview.version,
    files:[{url:preview.installer.assetName,sha512:preview.installer.sha512,size:preview.installer.size}],
    releaseNotes:preview.releaseNotes,
    keyId:preview.keyId,
    minimumLauncherVersion:preview.minimumLauncherVersion,
    verifiedManifest:false
   };
   return this.info;
  }finally{
   this.controller=undefined;
  }
 }

 async download(){
  if(!this.authenticated||!hasActiveLauncherUpdateKey(this.source,this.now))throw Object.assign(Error('Authenticated Ed25519 launcher update manifest required before download'),{code:'ERR_UPDATER_INVALID_SIGNATURE'});
  const authenticated=authenticateLauncherUpdate(this.authenticated.envelope,this.source,this.authenticated.release,this.installedVersion,this.now);
  await this.ledger.check(authenticated);
  this.token=new CancellationToken();
  this.controller=new AbortController();
  const onCancel=()=>this.controller?.abort();
  this.token.addListener('cancel',onCancel);
  const stagingDir=path.join(this.storageDir,'launcher-updates','staging');
  const verifiedDir=path.join(this.storageDir,'launcher-updates','verified');
  await safeDirectory(stagingDir);
  await safeDirectory(verifiedDir);
  const partFile=path.join(stagingDir,randomUUID()+'.part.exe');
  let handle:fs.FileHandle|undefined;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
   const response=await this.transport.installer(authenticated.manifest.installer.assetId,this.controller.signal);
   if(response.status===403||response.status===429){await response.body?.cancel();throw Object.assign(Error('GitHub rate limit reached'),{code:'HTTP429'});}
   if(response.status!==200||!response.body){await response.body?.cancel();throw Object.assign(Error('Installer asset download failed ('+response.status+')'),{code:'ECONNRESET'});}
   const encoding=response.headers.get('content-encoding');
   if(encoding&&encoding!=='identity')throw Object.assign(Error('Encoded installer transfer refused'),{code:'ERR_UPDATER_CHECKSUM_MISMATCH'});
   const declaredLength=response.headers.get('content-length');
   if(declaredLength!==null&&(!/^\d+$/.test(declaredLength)||Number(declaredLength)!==authenticated.manifest.installer.size))throw Object.assign(Error('Installer Content-Length mismatch'),{code:'ERR_UPDATER_CHECKSUM_MISMATCH'});
   handle=await fs.open(partFile,'wx',0o600);
   reader=response.body.getReader();
   const total=authenticated.manifest.installer.size;
   const started=this.now();
   let transferred=0;
   for(;;){
    if(this.controller.signal.aborted)throw Object.assign(Error('Launcher update download cancelled'),{code:'ECONNRESET'});
    const chunk=await reader.read();
    if(chunk.done)break;
    if(transferred+chunk.value.length>total)throw Object.assign(Error('Installer download exceeded declared size'),{code:'ERR_UPDATER_CHECKSUM_MISMATCH'});
    let offset=0;
    while(offset<chunk.value.length){
     const written=await handle.write(chunk.value,offset,chunk.value.length-offset,transferred+offset);
     if(!written.bytesWritten)throw Object.assign(Error('Short installer write'),{code:'ECONNRESET'});
     offset+=written.bytesWritten;
    }
    transferred+=chunk.value.length;
    const elapsed=Math.max(this.now()-started,1);
    this.emit('progress',{
     percent:Math.min(100,(transferred/total)*100),
     transferred,
     total,
     bytesPerSecond:Math.round((transferred*1000)/elapsed)
    });
   }
   await handle.sync();
   await handle.close();
   handle=undefined;
   if(transferred!==total)throw Object.assign(Error('Installer stream ended before declared size'),{code:'ECONNRESET'});
   const initialBinding:Ed25519InstallerBinding={
    envelope:authenticated.envelope,
    source:this.source,
    release:authenticated.release,
    installedVersion:this.installedVersion,
    now:this.now
   };
   await verifyDownloadedInstaller(partFile,authenticated.manifest.installer.sha512,this.publishers,authenticode,initialBinding);
   const targetFile=path.join(verifiedDir,authenticated.manifest.installer.sha256+'.exe');
   await fs.rename(partFile,targetFile);
   const finalHandle=await fs.open(targetFile,'r+');
   try{await finalHandle.sync();}finally{await finalHandle.close();}
   const stat=await fs.lstat(targetFile);
   const identity=await fileIdentity(targetFile);
   const bound:Ed25519InstallerBinding={
    ...initialBinding,
    expectedIdentity:identity,
    expectedMtimeMs:stat.mtimeMs
   };
   await verifyDownloadedInstaller(targetFile,authenticated.manifest.installer.sha512,this.publishers,authenticode,bound);
   await this.ledger.accept(authenticated);
   this.verifiedFile=targetFile;
   this.verifiedBinding={sha512:authenticated.manifest.installer.sha512,binding:bound};
   this.emit('downloaded',this.info);
  }catch(error){
   await handle?.close().catch(()=>{});
   await fs.rm(partFile,{force:true}).catch(()=>{});
   throw error;
  }finally{
   await reader?.cancel().catch(()=>{});
   reader?.releaseLock();
   this.token=undefined;
   this.controller=undefined;
  }
 }

 async install(){
  if(!this.verifiedFile||!this.verifiedBinding||!this.authenticated)throw Error('Verified Ed25519 NSIS download required');
  await this.ledger.check(this.authenticated);
  const handoffFile=await prepareVerifiedInstallHandoff(this.verifiedFile,this.verifiedBinding.binding,this.storageDir);
  const args=['--updated','/S','--force-run',...(this.options.installDirectory?['/D='+this.options.installDirectory]:[])];
  if(this.options.runHandoffInstaller){
   await this.options.runHandoffInstaller(handoffFile,args);
   return;
  }
  await new Promise<void>((resolve,reject)=>{
   const child=spawn(handoffFile,args,{detached:true,stdio:'ignore',windowsHide:false});
   child.once('error',reject);
   child.once('spawn',()=>{
    child.unref();
    resolve();
   });
  });
 }

 cancel(){
  this.token?.cancel();
  this.controller?.abort();
 }
}
