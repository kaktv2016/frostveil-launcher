import {effectiveClientRequirement,effectiveNativeRequirement}from'../client-repair';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalTemporaryRoot} from '../temporary-root';
import {lt} from 'semver';
import {safeDirectory,safeFile,hashFile,noLinks,relativePath,checkExistingAncestors} from '../files';
import {createInstallerSandbox,checkRoots,PAYLOAD_LIMIT,type SandboxGrant} from '../installer/sandbox';
import {MetadataStore,durableWrite} from '../installer/metadata';
import {GitHubDistributionProvider} from '../distribution/github';
import {PackageDownloader} from '../distribution/download';
import {productionSource,authenticateRelease,VersionLedger,type AuthenticatedRelease,type DistributionSource} from '../distribution/policy';
import type {PackFile,PackageReference} from '../../shared/modpack-contracts';
import type {ProductionDownloadState} from '../../shared/management-contracts';
import type {Profile} from '../../shared/contracts';
import {planActivation} from './activation';
import {readOrderInputs,readPluginHeader,type OrderInputs} from '../modpack/plugins';
import {assertSharedPluginCompatibility,samePluginNames} from '../modpack/compatibility';

interface FileImage {size:number;sha256:string;stamp:string;}
interface PackProfile {inputs:OrderInputs;files:Map<string,FileImage|null>;}
interface RepairTarget {file:PackFile;destination:string;before:FileImage|null;}
interface StagedRepair extends RepairTarget {source:string;image:FileImage;}
const profileLimit=1024*1024;
const pluginPath=/^Data\/[^/]+\.(?:esp|esl|esm)$/i;
const implicitOfficial=/^(?:Skyrim|Update|Dawnguard|HearthFires|Dragonborn)\.esm$/i;
const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const filePath=(root:string,relative:string)=>path.join(root,...relativePath(relative).split('/'));

async function directoryIdentity(directory:string):Promise<string|null>{
 try{
  await noLinks(directory);
  const stat=await fs.lstat(directory,{bigint:true});
  if(!stat.isDirectory())throw Error('Unsafe pack directory: '+path.basename(directory));
  return stat.dev+':'+stat.ino;
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
  throw error;
 }
}

async function requireDirectories(expected:ReadonlyMap<string,string|null>){
 for(const [directory,identity] of expected){
  if(await directoryIdentity(directory)!==identity)throw Error('Pack directory changed: '+path.basename(directory));
 }
}

async function fileStamp(file:string):Promise<string|null>{
 try{
  await noLinks(file);
  const stat=await fs.lstat(file,{bigint:true});
  if(!stat.isFile()||stat.nlink!==1n)throw Error('Unsafe or hard-linked pack file: '+path.basename(file));
  return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
  throw error;
 }
}

async function requireStamp(file:string,expected:string|null){
 if(await fileStamp(file)!==expected)throw Error('File changed during Play preparation: '+path.basename(file));
}

async function observeFile(file:string,limit:number):Promise<FileImage|null>{
 const stamp=await fileStamp(file);
 if(stamp===null)return null;
 const image=await hashFile(file,limit);
 await requireStamp(file,stamp);
 return {...image,stamp};
}

function matchesImage(image:FileImage|null,expected:{size:number;sha256:string}):boolean{
 return image?.size===expected.size&&image.sha256===expected.sha256;
}

async function observeProfile(game:string,order:string):Promise<PackProfile>{
 const sources=[
  ['pluginsText',path.join(order,'plugins.txt')],
  ['loadorderText',path.join(order,'loadorder.txt')],
  ['cccText',path.join(game,'Skyrim.ccc')],
 ] as const;
 const files=new Map<string,FileImage|null>();
 for(const [,file] of sources)files.set(file,await observeFile(file,profileLimit));
 const inputs=await readOrderInputs(game,order);
 for(const [key,file] of sources){
  const before=files.get(file)??null,text=inputs[key];
  if((before?.sha256??null)!==(text===null?null:sha256(Buffer.from(text,'utf8'))))
   throw Error('Plugin profile changed during Play preparation or has an unsupported encoding: '+path.basename(file));
  await requireStamp(file,before?.stamp??null);
 }
 return {inputs,files};
}

async function requireProfile(game:string,order:string,expected:PackProfile){
 const actual=await observeProfile(game,order);
 if(actual.inputs.managed!==expected.inputs.managed)throw Error('Managed plugin profile changed during Play preparation');
 for(const [file,before] of expected.files){
  const now=actual.files.get(file);
  if((now?.stamp??null)!==(before?.stamp??null)||(now?.sha256??null)!==(before?.sha256??null))
   throw Error('Plugin profile changed during Play preparation: '+path.basename(file));
 }
 return actual;
}

/** Main owns target selection; only authenticated, redistribution-allowed payloads can be installed. */
export class ProductionDownloads {
 private state:ProductionDownloadState={phase:'idle',message:'Download signed server files before choosing whether to install them.',signature:'UNVERIFIED',installed:false,files:[],externalRequirements:0,bytes:0,totalBytes:0};
 private grant?:SandboxGrant;
 private controller?:AbortController;
 private lastBundle?:AuthenticatedRelease;
 private bundleAdmission=Promise.resolve();
 private lastBundleAt=0;
 private isDefaultProvider=false;
 private listeners=new Set<(state:ProductionDownloadState)=>void>();
 private disposed=false;
 private preparing=false;
 private cancellation=0;
 private checkCancellation(version:number){if(this.disposed||this.cancellation!==version)throw Error('Server file preparation cancelled');}
 constructor(private storage:string,private version:string,private source:DistributionSource=productionSource,private providerFactory?:()=>GitHubDistributionProvider,private running:()=>Promise<boolean>=async()=>false){
  if(!this.providerFactory){this.isDefaultProvider=true;this.providerFactory=()=>new GitHubDistributionProvider();}
 }
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
  const bundle=await this.currentBundle();
  const pack=bundle.manifest,skseDll='skse64_'+pack.requiredSkyrimRuntime.split('.').slice(0,3).join('_')+'.dll';
  const files=pack.files.filter(f=>f.required&&f.distribution==='external-only');
  if(['SkyrimSE.exe','skse64_loader.exe',skseDll].some(p=>!files.some(f=>f.path.toLowerCase()===p.toLowerCase())))throw Error('Signed public runtime baseline is incomplete');
  const backupPaths=['Data/SKSE/Plugins/SkyrimPlatform.ini','Data/Platform/Plugins/skymp5-client.js','Data/Platform/Plugins/skymp5-client-settings.txt','Data/Platform/UI/rp-chat/index.html'];
  return{id:'production-'+pack.packId+'-'+pack.packVersion,runtime:pack.requiredSkyrimRuntime,skseVersion:pack.requiredSKSEVersion,skseDll,evidence:'Authenticated production manifest '+bundle.manifestHash+'; external files are verified, never downloaded.',files:files.map(f=>({path:f.path,size:f.size,sha256:f.sha256,component:f.path==='SkyrimSE.exe'||f.role==='native'?'game' as const:/^skse64_/i.test(f.path)?'skse' as const:f.role==='configuration'?'configuration' as const:'client' as const})),backupFiles:backupPaths.filter(p=>files.some(f=>f.path===p))};
 }
 async download(unexpected?:unknown){
  if(unexpected!==undefined||this.disposed)throw Error('Unexpected or unavailable download operation');
  if(this.preparing)throw Error('Another pack operation is in progress');
  await this.acquire();
  return this.snapshot();
 }
 private async acquire(plan?:(bundle:AuthenticatedRelease)=>Promise<ReadonlySet<string>>,selected?:AuthenticatedRelease){
  if(this.disposed)throw Error('Download service disposed');
  if(this.controller)throw Error('A download is already running');
  const controller=new AbortController();this.controller=controller;
  this.update({phase:'checking',signature:'UNVERIFIED',message:'Verifying signed GitHub release.',files:[],bytes:0,totalBytes:0,installed:false});
  try{
   const provider=this.providerFactory!();
   const bundle=selected??await this.resolveBundle(provider,controller.signal);
   if(lt(this.version,bundle.manifest.minimumLauncherVersion))throw Error('Update Launcher before downloading this pack');
   if(selected)this.revalidateBundle(selected);
   controller.signal.throwIfAborted();
   const wanted=await plan?.(bundle);
   controller.signal.throwIfAborted();
   const grant=await this.cache();
   await this.admitBundle(bundle,selected===undefined,controller.signal);
   const packages=wanted?bundle.packages.filter(p=>wanted.has(p.sha256)):bundle.packages;
   const totalBytes=packages.reduce((n,p)=>n+p.size,0);let completed=0;
   this.update({phase:'downloading',signature:'AUTHENTICATED',packId:bundle.manifest.packId,version:bundle.manifest.packVersion,release:bundle.release.tag_name,totalBytes,externalRequirements:bundle.manifest.files.filter(f=>f.distribution!=='allowed').length,message:'Downloading verified files outside Skyrim. No game files are being changed.'});
   const downloader=new PackageDownloader(grant,provider.transport,{onProgress:p=>this.update({bytes:completed+p.bytes})});
   for(const ref of packages){await downloader.acquire(ref,controller.signal);completed+=ref.size;this.update({bytes:completed,files:[...this.state.files,{name:ref.assetName,size:ref.size,sha256:ref.sha256,verified:true}]});}
   controller.signal.throwIfAborted();
   this.update({phase:'complete',message:'Files downloaded and verified. NOT INSTALLED — review installation separately.',bytes:totalBytes});
   return{bundle,grant};
  }catch(e){this.update({phase:controller.signal.aborted?'cancelled':'error',message:controller.signal.aborted?'Download cancelled; verified cache retained.':e instanceof Error?e.message:'Download failed',installed:false});}
  finally{this.controller=undefined;}
 }
 setInstalled(installed:boolean){if(this.state.installed!==installed)this.update({installed,...(installed&&this.state.phase==='idle'?{message:'Server files & mods (SkyUI) are installed and active.'}:{})});}
 private async resolveBundle(provider:GitHubDistributionProvider,signal?:AbortSignal){
  const release=await provider.resolve(this.source.channel,undefined,signal);
   const bundle=authenticateRelease(await provider.envelope(release,signal),this.source,release);
   assertSharedPluginCompatibility(bundle.manifest,bundle.server);
   return bundle;
 }
 private revalidateBundle(bundle:AuthenticatedRelease){
   const verified=authenticateRelease(bundle.envelope,this.source,bundle.release);
   if(verified.manifestHash!==bundle.manifestHash)throw Error('Signed release changed during Play preparation');
   assertSharedPluginCompatibility(verified.manifest,verified.server);
 }
 private admitBundle(bundle:AuthenticatedRelease,remember:boolean,signal?:AbortSignal){
  // Serialize ledger reads and writes with publication of the corresponding cache entry.
  const admission=this.bundleAdmission.then(async()=>{
   if(this.disposed)throw Error('Download service disposed');
   signal?.throwIfAborted();
   await safeDirectory(this.storage);
   signal?.throwIfAborted();
   this.revalidateBundle(bundle);
   await new VersionLedger(path.join(this.storage,'production-download-history')).accept(
    bundle.manifest.packId,bundle.manifest.channel,bundle.manifest.packVersion,bundle.manifestHash);
   if(remember){
    // A durable admission supersedes the prior cache even if this request was cancelled.
    this.lastBundle=signal?.aborted?undefined:bundle;
    this.lastBundleAt=Date.now();
   }
   signal?.throwIfAborted();
  });
  this.bundleAdmission=admission.catch(()=>{});
  return admission;
 }
 private async currentBundle(){
  await this.bundleAdmission;
  if(this.isDefaultProvider&&this.lastBundle){
   const age=Date.now()-this.lastBundleAt;
   if(age>=0&&age<15000){
    try{
     this.revalidateBundle(this.lastBundle);
     return this.lastBundle;
    }catch{/* Refresh metadata when the cached release no longer passes trust checks. */}
   }
   this.lastBundle=undefined;
  }
  const bundle=await this.resolveBundle(this.providerFactory!());
  if(lt(this.version,bundle.manifest.minimumLauncherVersion))throw Error('Update Launcher before playing this pack');
  await this.admitBundle(bundle,true);
  return bundle;
 }
 private requiredActivation(bundle:AuthenticatedRelease){
  return bundle.manifest.files.filter(file=>file.required&&pluginPath.test(file.path)&&!implicitOfficial.test(path.basename(file.path)));
 }

 private async activationForPlay(game:string,bundle:AuthenticatedRelease,profile:PackProfile,watched:Map<string,string|null>,
  local:Map<string,FileImage|null>,staged=new Map<string,StagedRepair>()){
  const requirements=[...bundle.manifest.requiredPlugins];
  const byName=new Map(requirements.map(plugin=>[plugin.filename.toLowerCase(),plugin]));
  const signedFiles=new Map(bundle.manifest.files.filter(file=>pluginPath.test(file.path)).map(file=>[file.path.toLowerCase(),file]));
  const headers=new Map<string,Awaited<ReturnType<typeof readPluginHeader>>>();
  const readVerifiedHeader=async(filename:string)=>{
   const name=filename.toLowerCase(),key='data/'+name;
   const earlier=headers.get(name);if(earlier)return earlier;
   const signed=signedFiles.get(key),replacement=staged.get(key);
   const source=replacement?.source??filePath(game,signed?.path??'Data/'+filename);
   const image=replacement?.image??(signed?(local.has(key)?local.get(key):await observeFile(source,Math.max(PAYLOAD_LIMIT,signed.size))):undefined);
   const stamp=image?.stamp??(signed?null:await fileStamp(source));
   watched.set(source,stamp);
   if(stamp===null)throw Object.assign(Error('Plugin file unavailable: '+filename),{code:'ENOENT'});
   if(signed&&!matchesImage(image??null,signed))throw Error('Signed plugin bytes differ: '+filename);
   await requireStamp(source,stamp);
   const header=await readPluginHeader(source);
   await requireStamp(source,stamp);
   const shared=byName.get(name);
   if(shared?.role==='server-required'){
    if(header.light||/\.esl$/i.test(filename))throw Error('Shared plugin must use a verified full slot: '+filename);
    if(!samePluginNames(header.masters,shared.masters))throw Error('Shared plugin TES4 master sequence differs: '+filename);
   }
   headers.set(name,header);
   return header;
  };

  // Some signed packs list a required client plugin as a file only.
  const explicitFiles=this.requiredActivation(bundle);
  let nextOrder=Math.max(-1,...requirements.map(plugin=>plugin.order))+1;
  for(const file of explicitFiles){
   const filename=path.basename(file.path);
   if(byName.has(filename.toLowerCase()))continue;
   const header=await readVerifiedHeader(filename);
   requirements.push({filename,required:true,role:'client-only',order:nextOrder++,masters:header.masters,sha256:file.sha256});
  }

  const inputs=profile.inputs,plan=await planActivation(game,requirements,inputs,{readVerifiedHeader});
  if(plan.status!=='ready'||!explicitFiles.length)return plan;

  // Maintain the existing diagnostic mirror when editable pack plugins are required.
  const active=new Set(plan.active.map(p=>p.toLowerCase())),raw=inputs.loadorderText??'';
  const bom=raw.startsWith('\uFEFF')?'\uFEFF':'',newline=raw.includes('\r\n')?'\r\n':'\n';
  const lines=raw.slice(bom.length).split(/\r?\n/);
  const nameOf=(line:string)=>line.trim().replace(/^\*/,'').toLowerCase();
  const observed=lines.filter(line=>active.has(nameOf(line))).map(nameOf);
  if(!samePluginNames(observed,plan.active)){
   const retained=lines.filter(line=>!active.has(nameOf(line)));
   const bytes=Buffer.from(bom+plan.active.join(newline)+newline+retained.join(newline),'utf8');
   plan.configWrites.push({path:'@config/loadorder.txt',bytesBase64:bytes.toString('base64'),sha256:sha256(bytes),
    originalHash:inputs.loadorderText===null?null:sha256(Buffer.from(raw,'utf8'))});
  }
  return plan;
 }

 /** Read-only comparison against the current signed release, never just the presence of SkyUI. */
 async inspectInstallation(game:string,order:string){
  try{return await this.inspectBundle(game,order,await this.currentBundle());}
  catch(error){this.setInstalled(false);throw error;}
 }

 private async inspectBundle(game:string,order:string,bundle:AuthenticatedRelease,expectedProfile?:PackProfile){
  await noLinks(game);
  const missing:string[]=[],external:string[]=[],inactive:string[]=[];
  const local=new Map<string,FileImage|null>(),watched=new Map<string,string|null>();
  const requiredFiles=bundle.manifest.files.filter(file=>file.required);
  const observations=await Promise.all(requiredFiles.map(async file=>{
   const destination=filePath(game,file.path);
   const image=await observeFile(destination,Math.max(PAYLOAD_LIMIT,file.size));
   return {file,destination,image};
  }));
  for(const {file,destination,image} of observations){
   local.set(file.path.toLowerCase(),image);
   watched.set(destination,image?.stamp??null);
   if(!matchesImage(image,effectiveNativeRequirement(effectiveClientRequirement(file)))){
    (file.distribution==='allowed'&&file.package?missing:external).push(file.path);
   }
  }
  if(!missing.length&&!external.length)try{
   const profile=expectedProfile?await requireProfile(game,order,expectedProfile):await observeProfile(game,order);
   const activation=await this.activationForPlay(game,bundle,profile,watched,local);
   if(activation.status!=='ready')inactive.push('Plugin activation blocked: '+[...activation.blockers,...activation.manual].join('; '));
   else if(activation.configWrites.length)inactive.push('Shared plugin order requires repair');
   else{
    await requireProfile(game,order,profile);
    for(const [file,stamp] of watched)await requireStamp(file,stamp);
   }
  }catch(error){inactive.push(error instanceof Error?error.message:'Plugin activation unavailable');}
  this.revalidateBundle(bundle);
  const installed=!missing.length&&!external.length&&!inactive.length;
  this.update({installed,signature:'AUTHENTICATED',packId:bundle.manifest.packId,version:bundle.manifest.packVersion,release:bundle.manifest.distribution.release?.tag});
  return {installed,missing,external,inactive};
 }

 async prepareForPlay(game:string,order:string){
  if(this.preparing||this.controller)throw Error('Another pack operation is in progress');this.preparing=true;
  const cancellation=this.cancellation;
  try{
   if(this.disposed)throw Error('Download service disposed');
   if(await this.running())throw Error('Skyrim or SKSE is running; close it before verifying or repairing files');
   this.update({phase:'checking',installed:false,message:'Checking signed server pack and local file hashes before Play…'});
   this.checkCancellation(cancellation);
   const bundle=await this.currentBundle();
   this.checkCancellation(cancellation);
   const before=await this.inspectBundle(game,order,bundle);
   this.checkCancellation(cancellation);
   if(before.external.length)throw Error('External dependency missing or different (cannot auto-download): '+before.external.join(', '));
   if(!before.installed){
    await this.installBundle(game,order,cancellation,bundle);
    this.checkCancellation(cancellation);
   }
   this.update({phase:'complete',installed:true,message:'Signed server pack verified. Starting Skyrim…'});
   return this.snapshot();
  }catch(e){this.update({phase:this.cancellation!==cancellation?'cancelled':'error',installed:false,message:e instanceof Error?e.message:'Pack preparation failed'});throw e;}
  finally{this.preparing=false;}
 }
 async isInstalled(gameDirectory:string,orderDirectory:string):Promise<boolean>{
  if(!gameDirectory)return false;
  try{return(await this.inspectInstallation(gameDirectory,orderDirectory)).installed;}catch{this.setInstalled(false);return false;}
 }
 async installAndActivate(gameDirectory:string,orderDirectory:string):Promise<ProductionDownloadState>{
  if(this.preparing||this.controller)throw Error('Another pack operation is in progress');
  this.preparing=true;
  const cancellation=this.cancellation;
  try{
   await this.installBundle(gameDirectory,orderDirectory,cancellation);
   return this.snapshot();
  }catch(error){
   this.update({phase:this.cancellation!==cancellation?'cancelled':'error',installed:false,
    message:error instanceof Error?error.message:'Pack installation failed'});
   throw error;
  }finally{this.preparing=false;}
 }

 private async backupPackFile(source:string,relative:string,expected:FileImage,limit:number){
  const backup=filePath(path.join(this.storage,'auto-repair-backups',randomUUID()),relative);
  await requireStamp(source,expected.stamp);
  await safeDirectory(path.dirname(backup));
  await fs.copyFile(source,backup,fs.constants.COPYFILE_EXCL);
  await requireStamp(source,expected.stamp);
  if(!matchesImage(await observeFile(backup,limit),expected))throw Error('Pack backup verification failed: '+relative);
 }

 private async requireIdle(cancellation:number){
  this.checkCancellation(cancellation);
  if(await this.running())throw Error('Skyrim or SKSE is running; close it before installing files');
  this.checkCancellation(cancellation);
 }

 private async installBundle(game:string,order:string,cancellation:number,selected?:AuthenticatedRelease){
  if(!game)throw Error('Skyrim game folder is required');
  await this.requireIdle(cancellation);
  const gameIdentity=await directoryIdentity(game);
  if(!gameIdentity)throw Error('Skyrim game folder is unavailable');
  const directories=new Map<string,string|null>([[game,gameIdentity],[order,await directoryIdentity(order)]]);
  const data=path.join(game,'Data'),dataIdentity=await directoryIdentity(data);
  if(dataIdentity)directories.set(data,dataIdentity);
  const profile=await observeProfile(game,order);
  const local=new Map<string,FileImage|null>(),watched=new Map<string,string|null>();
  const repairs:RepairTarget[]=[];
  const acquired=await this.acquire(async bundle=>{
   const wanted=new Set<string>();
   for(const file of bundle.manifest.files){
    this.checkCancellation(cancellation);
    if(!file.required&&!file.package)continue;
    const destination=filePath(game,file.path);
    const before=await observeFile(destination,Math.max(PAYLOAD_LIMIT,file.size));
    local.set(file.path.toLowerCase(),before);
    watched.set(destination,before?.stamp??null);
    if(matchesImage(before,effectiveNativeRequirement(effectiveClientRequirement(file))))continue;
    if(file.distribution==='allowed'&&file.package){
     repairs.push({file,destination,before});
     wanted.add(file.package.sha256);
    }else if(file.required)throw Error('External dependency missing or different (cannot auto-download): '+file.path);
   }
   return wanted;
  },selected);
  this.checkCancellation(cancellation);
  if(!acquired)throw Error('Server files download could not be completed: '+this.state.message);

  const {bundle,grant}=acquired;
  await checkRoots(grant);
  const staged=new Map<string,StagedRepair>();
  for(const repair of repairs){
   this.checkCancellation(cancellation);
   const {file}=repair;
   const source=path.join(grant.payloads,file.package!.sha256+'.bin');
   const image=await observeFile(source,PAYLOAD_LIMIT);
   if(!image||!matchesImage(image,file))throw Error('Staged payload hash or size differs: '+file.path);
   staged.set(file.path.toLowerCase(),{...repair,source,image});
   watched.set(source,image.stamp);
  }
  const activation=await this.activationForPlay(game,bundle,profile,watched,local,staged);
  if(activation.status!=='ready')
   throw Error('Plugin activation blocked: '+[...activation.blockers,...activation.manual].join('; '));

  let writesStarted=false;
  const beforeWrite=async()=>{
   await this.requireIdle(cancellation);
   if(!writesStarted){
    // All staged inputs and the signed projection must survive the final
    // progress and idle callbacks before the first pack target or backup write.
    await checkRoots(grant);
    await requireProfile(game,order,profile);
    for(const [file,stamp] of watched)await requireStamp(file,stamp);
    this.revalidateBundle(bundle);
    writesStarted=true;
   }
   await requireDirectories(directories);
   this.checkCancellation(cancellation);
  };
  this.update({phase:'downloading',message:'Installing verified server files & mods (SkyUI) to Skyrim…'});
  for(const {file,destination,before,source,image} of staged.values()){
   await beforeWrite();
   await requireStamp(destination,before?.stamp??null);
   await requireStamp(source,image.stamp);
   if(before)await this.backupPackFile(destination,file.path,before,Math.max(PAYLOAD_LIMIT,before.size));
   await safeDirectory(path.dirname(destination));
   const temporary=destination+'.frostveil-'+randomUUID();
   try{
    await fs.copyFile(source,temporary,fs.constants.COPYFILE_EXCL);
    if(!matchesImage(await observeFile(temporary,PAYLOAD_LIMIT),file))throw Error('Staged file changed: '+file.path);
    await requireStamp(source,image.stamp);
    await this.requireIdle(cancellation);
    await requireDirectories(directories);
    await requireStamp(destination,before?.stamp??null);
    this.checkCancellation(cancellation);
    await fs.rename(temporary,destination);
   }finally{await fs.unlink(temporary).catch(()=>{});}
   const installed=await observeFile(destination,PAYLOAD_LIMIT);
   if(!installed||!matchesImage(installed,file))throw Error('Failed to verify installed file: '+file.path);
   watched.set(destination,installed.stamp);
  }

  await requireProfile(game,order,profile);
  for(const write of activation.configWrites){
   await beforeWrite();
   const filename=write.path==='@config/plugins.txt'?'plugins.txt':'loadorder.txt';
   const destination=path.join(order,filename),before=profile.files.get(destination)??null;
   if((before?.sha256??null)!==write.originalHash)throw Error('Plugin configuration plan does not match its preimage');
   await requireStamp(destination,before?.stamp??null);
   if(before)await this.backupPackFile(destination,filename,before,profileLimit);
   await safeDirectory(order);
   if(directories.get(order)===null)directories.set(order,await directoryIdentity(order));
   const temporary=destination+'.frostveil-'+randomUUID();
   const bytes=Buffer.from(write.bytesBase64,'base64');
   try{
    await fs.writeFile(temporary,bytes,{flag:'wx'});
    await this.requireIdle(cancellation);
    await requireDirectories(directories);
    await requireStamp(destination,before?.stamp??null);
    this.checkCancellation(cancellation);
    await fs.rename(temporary,destination);
   }finally{await fs.unlink(temporary).catch(()=>{});}
   const installed=await observeFile(destination,profileLimit);
   if(!installed||!matchesImage(installed,{size:bytes.length,sha256:write.sha256}))
    throw Error('Failed to verify plugin configuration: '+filename);
   profile.files.set(destination,installed);
  }

  await requireDirectories(directories);
  for(const [file,stamp] of watched)await requireStamp(file,stamp);
  const verification=await this.inspectBundle(game,order,bundle,profile);
  this.checkCancellation(cancellation);
  if(!verification.installed)
   throw Error('Pack verification incomplete: '+[...verification.missing,...verification.external,...verification.inactive].join(', '));
  this.update({phase:'complete',installed:true,message:'Signed server pack installed and verified. Ready to play.'});
 }
 /** Trusted Main supplies an authenticated reference and an existing target capability. */
 async stage(target:SandboxGrant,ref:PackageReference,signal?:AbortSignal){
  if(this.disposed)throw Error('Download service disposed');await checkRoots(target);
  const source=await new PackageDownloader(await this.cache(),this.providerFactory!().transport).acquire(ref,signal);
  const destination=path.join(target.payloads,ref.sha256+'.bin');
  async function verified(file:string){await noLinks(file);const stat=await fs.lstat(file);if(!stat.isFile()||stat.nlink!==1)throw Error('Unsafe staged payload');const h=await hashFile(file,PAYLOAD_LIMIT);if(h.sha256!==ref.sha256||h.size!==ref.size)throw Error('Staged payload hash mismatch');}
  try{await verified(destination);return destination;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const temporary=destination+'.verified-'+randomUUID();
  try{await fs.copyFile(source,temporary,fs.constants.COPYFILE_EXCL);await verified(temporary);await checkRoots(target);const handle=await fs.open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}await fs.rename(temporary,destination);await verified(destination);return destination;}
  catch(e){await fs.unlink(temporary).catch(()=>{});throw e;}
 }
 cancel(){this.cancellation++;this.controller?.abort();}
 dispose(){this.cancel();this.disposed=true;this.listeners.clear();}
}
