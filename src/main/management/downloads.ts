import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalTemporaryRoot} from '../temporary-root';
import {lt} from 'semver';
import {safeDirectory,safeFile,hashFile,noLinks} from '../files';
import {createInstallerSandbox,checkRoots,PAYLOAD_LIMIT,type SandboxGrant} from '../installer/sandbox';
import {MetadataStore,durableWrite} from '../installer/metadata';
import {GitHubDistributionProvider} from '../distribution/github';
import {PackageDownloader} from '../distribution/download';
import {productionSource,authenticateRelease,VersionLedger,type DistributionSource} from '../distribution/policy';
import type {PackageReference} from '../../shared/modpack-contracts';
import type {ProductionDownloadState} from '../../shared/management-contracts';
import type {Profile} from '../../shared/contracts';

/** Acquisition only. It never opens the installer or accepts a game target from IPC. */
export class ProductionDownloads {
 private state:ProductionDownloadState={phase:'idle',message:'Download signed server files before choosing whether to install them.',signature:'UNVERIFIED',installed:false,files:[],externalRequirements:0,bytes:0,totalBytes:0};
 private grant?:SandboxGrant;
 private controller?:AbortController;
 private listeners=new Set<(state:ProductionDownloadState)=>void>();
 private disposed=false;
 constructor(private storage:string,private version:string,private source:DistributionSource=productionSource,private providerFactory=()=>new GitHubDistributionProvider()){}
 snapshot():ProductionDownloadState{return structuredClone(this.state);}
 subscribe(listener:(state:ProductionDownloadState)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private update(patch:Partial<ProductionDownloadState>){if(this.disposed)return;this.state={...this.state,...patch};for(const listener of this.listeners){try{listener(this.snapshot());}catch{/* UI listeners cannot affect acquisition. */}}}
 private async absentCache(directory:string){
  const root=await canonicalTemporaryRoot();
  if(path.resolve(directory)!==directory||path.dirname(directory).toLowerCase()!==root.toLowerCase()||!/^frostveil-l4a-[a-z0-9]+$/i.test(path.basename(directory)))return false;
  await noLinks(root);try{await fs.lstat(directory);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}
 }
 private async freshCache(){
  const grant=await createInstallerSandbox();await MetadataStore.create(grant);
  await durableWrite(path.join(this.storage,'production-downloads.json'),Buffer.from(JSON.stringify({directory:grant.directory,id:grant.id})));
  this.grant=grant;return grant;
 }
 private async cache():Promise<SandboxGrant>{
  if(this.grant){try{await checkRoots(this.grant);return this.grant;}catch(e){if(!await this.absentCache(this.grant.directory))throw e;this.grant=undefined;}}
  await safeDirectory(this.storage);let pointerFound=false;
  try{
   const file=await safeFile(this.storage,'production-downloads.json');pointerFound=true;
   const stat=await fs.stat(file);if(stat.nlink!==1||stat.size>4096)throw Error('Unsafe download cache pointer');
   const p=JSON.parse(await fs.readFile(file,'utf8'));
   if(!p||Object.keys(p).sort().join(',')!=='directory,id'||typeof p.directory!=='string'||typeof p.id!=='string'||!/^[a-f0-9-]{36}$/i.test(p.id))throw Error('Invalid download cache pointer');
   // Only total disappearance of an acquisition-only temporary root is replaceable.
   // A surviving root with missing/tampered evidence remains a hard refusal.
   if(await this.absentCache(p.directory))return this.freshCache();
   const store=await MetadataStore.recover(p.directory);
   if(store.grant.targetClass||store.grant.id!==p.id)throw Error('Download cache target identity mismatch');
   this.grant=store.grant;
  }catch(e){
   if(pointerFound||(e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
   return this.freshCache();
  }
  return this.grant!;
 }
 async baselineProfile():Promise<Profile>{
  if(this.disposed)throw Error('Download service disposed');
  const provider=this.providerFactory(),release=await provider.resolve(this.source.channel),bundle=authenticateRelease(await provider.envelope(release),this.source,release);
  if(lt(this.version,bundle.manifest.minimumLauncherVersion))throw Error('Update Launcher before resolving the public baseline');
  await safeDirectory(this.storage);await new VersionLedger(path.join(this.storage,'production-download-history')).accept(bundle.manifest.packId,bundle.manifest.channel,bundle.manifest.packVersion,bundle.manifestHash);
  const pack=bundle.manifest,skseDll='skse64_'+pack.requiredSkyrimRuntime.split('.').slice(0,3).join('_')+'.dll';
  const files=pack.files.filter(f=>f.required&&f.distribution==='external-only');
  if(['SkyrimSE.exe','skse64_loader.exe',skseDll].some(p=>!files.some(f=>f.path.toLowerCase()===p.toLowerCase())))throw Error('Signed public runtime baseline is incomplete');
  const backupPaths=['Data/SKSE/Plugins/SkyrimPlatform.ini','Data/Platform/Plugins/skymp5-client.js','Data/Platform/Plugins/skymp5-client-settings.txt','Data/Platform/UI/rp-chat/index.html'];
  return{id:'production-'+pack.packId+'-'+pack.packVersion,runtime:pack.requiredSkyrimRuntime,skseVersion:pack.requiredSKSEVersion,skseDll,evidence:'Authenticated production manifest '+bundle.manifestHash+'; external files are verified, never downloaded.',files:files.map(f=>({path:f.path,size:f.size,sha256:f.sha256,component:f.path==='SkyrimSE.exe'||f.role==='native'?'game' as const:/^skse64_/i.test(f.path)?'skse' as const:f.role==='configuration'?'configuration' as const:'client' as const})),backupFiles:backupPaths.filter(p=>files.some(f=>f.path===p))};
 }
 async download(unexpected?:unknown){
  if(unexpected!==undefined||this.disposed)throw Error('Unexpected or unavailable download operation');
  if(this.controller)throw Error('A download is already running');
  const controller=new AbortController();this.controller=controller;
  this.update({phase:'checking',signature:'UNVERIFIED',message:'Verifying signed GitHub release.',files:[],bytes:0,totalBytes:0,installed:false});
  try{
   const provider=this.providerFactory(),release=await provider.resolve(this.source.channel,undefined,controller.signal);
   const bundle=authenticateRelease(await provider.envelope(release,controller.signal),this.source,release);
   if(lt(this.version,bundle.manifest.minimumLauncherVersion))throw Error('Update Launcher before downloading this pack');
   const grant=await this.cache();await new VersionLedger(path.join(this.storage,'production-download-history')).accept(bundle.manifest.packId,bundle.manifest.channel,bundle.manifest.packVersion,bundle.manifestHash);
   const totalBytes=bundle.packages.reduce((n,p)=>n+p.size,0);let completed=0;
   this.update({phase:'downloading',signature:'AUTHENTICATED',packId:bundle.manifest.packId,version:bundle.manifest.packVersion,release:release.tag_name,totalBytes,externalRequirements:bundle.manifest.files.filter(f=>f.distribution!=='allowed').length,message:'Downloading verified files outside Skyrim. No game files are being changed.'});
   const downloader=new PackageDownloader(grant,provider.transport,{onProgress:p=>this.update({bytes:completed+p.bytes})});
   for(const ref of bundle.packages){await downloader.acquire(ref,controller.signal);completed+=ref.size;this.update({bytes:completed,files:[...this.state.files,{name:ref.assetName,size:ref.size,sha256:ref.sha256,verified:true}]});}
   this.update({phase:'complete',message:'Files downloaded and verified. NOT INSTALLED — review installation separately.',bytes:totalBytes});
  }catch(e){this.update({phase:controller.signal.aborted?'cancelled':'error',message:controller.signal.aborted?'Download cancelled; verified cache retained.':e instanceof Error?e.message:'Download failed',installed:false});}
  finally{this.controller=undefined;}
  return this.snapshot();
 }
 /** Trusted Main supplies an authenticated reference and an existing target capability. */
 async stage(target:SandboxGrant,ref:PackageReference,signal?:AbortSignal){
  if(this.disposed)throw Error('Download service disposed');await checkRoots(target);
  const source=await new PackageDownloader(await this.cache(),this.providerFactory().transport).acquire(ref,signal);
  const destination=path.join(target.payloads,ref.sha256+'.bin');
  async function verified(file:string){await noLinks(file);const stat=await fs.lstat(file);if(!stat.isFile()||stat.nlink!==1)throw Error('Unsafe staged payload');const h=await hashFile(file,PAYLOAD_LIMIT);if(h.sha256!==ref.sha256||h.size!==ref.size)throw Error('Staged payload hash mismatch');}
  try{await verified(destination);return destination;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const temporary=destination+'.verified-'+randomUUID();
  try{await fs.copyFile(source,temporary,fs.constants.COPYFILE_EXCL);await verified(temporary);await checkRoots(target);const handle=await fs.open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}await fs.rename(temporary,destination);await verified(destination);return destination;}
  catch(e){await fs.unlink(temporary).catch(()=>{});throw e;}
 }
 cancel(){this.controller?.abort();}
 dispose(){this.cancel();this.disposed=true;this.listeners.clear();}
}
