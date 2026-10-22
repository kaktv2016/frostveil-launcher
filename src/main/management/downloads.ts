import {effectiveClientRequirement}from'../client-repair';
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
import {productionSource,authenticateRelease,VersionLedger,type DistributionSource} from '../distribution/policy';
import type {PackageReference} from '../../shared/modpack-contracts';
import type {ProductionDownloadState} from '../../shared/management-contracts';
import type {Profile} from '../../shared/contracts';
import {planActivation} from './activation';
import {readOrderInputs,readPluginHeader} from '../modpack/plugins';

/** Main owns target selection; only authenticated, redistribution-allowed payloads can be installed. */
export class ProductionDownloads {
 private state:ProductionDownloadState={phase:'idle',message:'Download signed server files before choosing whether to install them.',signature:'UNVERIFIED',installed:false,files:[],externalRequirements:0,bytes:0,totalBytes:0};
 private grant?:SandboxGrant;
 private controller?:AbortController;
 private lastBundle?:ReturnType<typeof authenticateRelease>;
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
  return this.acquire();
 }
 private async acquire(needs?:(file:{path:string;size:number;sha256:string})=>Promise<boolean>){
  if(this.disposed)throw Error('Download service disposed');
  if(this.controller)throw Error('A download is already running');
  const controller=new AbortController();this.controller=controller;
  this.update({phase:'checking',signature:'UNVERIFIED',message:'Verifying signed GitHub release.',files:[],bytes:0,totalBytes:0,installed:false});
  try{
   const provider=this.providerFactory!(),release=await provider.resolve(this.source.channel,undefined,controller.signal);
   const bundle=authenticateRelease(await provider.envelope(release,controller.signal),this.source,release);
   this.lastBundle=bundle;this.lastBundleAt=Date.now();
   if(lt(this.version,bundle.manifest.minimumLauncherVersion))throw Error('Update Launcher before downloading this pack');
   const grant=await this.cache();await new VersionLedger(path.join(this.storage,'production-download-history')).accept(bundle.manifest.packId,bundle.manifest.channel,bundle.manifest.packVersion,bundle.manifestHash);
   const wanted=new Set<string>();
   for(const file of bundle.manifest.files)if(file.package&&(!needs||await needs(file)))wanted.add(file.package.sha256);
   const packages=bundle.packages.filter(p=>wanted.has(p.sha256));
   const totalBytes=packages.reduce((n,p)=>n+p.size,0);let completed=0;
   this.update({phase:'downloading',signature:'AUTHENTICATED',packId:bundle.manifest.packId,version:bundle.manifest.packVersion,release:release.tag_name,totalBytes,externalRequirements:bundle.manifest.files.filter(f=>f.distribution!=='allowed').length,message:'Downloading verified files outside Skyrim. No game files are being changed.'});
   const downloader=new PackageDownloader(grant,provider.transport,{onProgress:p=>this.update({bytes:completed+p.bytes})});
   for(const ref of packages){await downloader.acquire(ref,controller.signal);completed+=ref.size;this.update({bytes:completed,files:[...this.state.files,{name:ref.assetName,size:ref.size,sha256:ref.sha256,verified:true}]});}
   this.update({phase:'complete',message:'Files downloaded and verified. NOT INSTALLED — review installation separately.',bytes:totalBytes});
  }catch(e){this.update({phase:controller.signal.aborted?'cancelled':'error',message:controller.signal.aborted?'Download cancelled; verified cache retained.':e instanceof Error?e.message:'Download failed',installed:false});}
  finally{this.controller=undefined;}
  return this.snapshot();
 }
 setInstalled(installed:boolean){if(this.state.installed!==installed)this.update({installed,...(installed&&this.state.phase==='idle'?{message:'Server files & mods (SkyUI) are installed and active.'}:{})});}
 private async currentBundle(){
  if(this.isDefaultProvider&&this.lastBundle&&Date.now()-this.lastBundleAt<15000)return this.lastBundle;
  const provider=this.providerFactory!(),release=await provider.resolve(this.source.channel);
  const bundle=authenticateRelease(await provider.envelope(release),this.source,release);
  if(lt(this.version,bundle.manifest.minimumLauncherVersion))throw Error('Update Launcher before playing this pack');
  await safeDirectory(this.storage);await new VersionLedger(path.join(this.storage,'production-download-history')).accept(bundle.manifest.packId,bundle.manifest.channel,bundle.manifest.packVersion,bundle.manifestHash);
  this.lastBundle=bundle;this.lastBundleAt=Date.now();
  return bundle;
 }
 private async matches(game:string,file:{path:string;size:number;sha256:string}){file=effectiveClientRequirement(file);
  try{const target=await safeFile(game,file.path),st=await fs.lstat(target);if(st.nlink!==1)throw Error('Hard-linked game file is not allowed');const hash=await hashFile(target,Math.max(PAYLOAD_LIMIT,file.size));return hash.size===file.size&&hash.sha256===file.sha256;}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}
 }
 private requiredActivation(bundle:ReturnType<typeof authenticateRelease>){
  const implicit=/^(?:Skyrim|Update|Dawnguard|HearthFires|Dragonborn)\.esm$/i;
  return [...new Set([...bundle.manifest.requiredPlugins.filter(p=>p.required&&!implicit.test(p.filename)).map(p=>p.filename),...bundle.manifest.files.filter(f=>f.required&&/^Data\/[^/]+\.(?:esp|esl|esm)$/i.test(f.path)&&!implicit.test(path.basename(f.path))).map(f=>path.basename(f.path))])];
 }
 private async activationForPlay(game:string,order:string,bundle:ReturnType<typeof authenticateRelease>){
  const requirements=[...bundle.manifest.requiredPlugins];let nextOrder=Math.max(-1,...requirements.map(p=>p.order))+1;
  // Existing signed packs declare external SkyUI as a required file, not a shared server plugin.
  for(const filename of this.requiredActivation(bundle))if(!requirements.some(p=>p.filename.toLowerCase()===filename.toLowerCase())){
   const file=bundle.manifest.files.find(f=>f.path.toLowerCase()==='data/'+filename.toLowerCase());if(!file||!await this.matches(game,file))throw Error('Required plugin bytes unavailable: '+filename);
   const header=await readPluginHeader(await safeFile(game,file.path));requirements.push({filename,required:true,role:'client-only',order:nextOrder++,masters:header.masters,sha256:file.sha256});
  }
  const inputs=await readOrderInputs(game,order);
  const implicit=/^(?:Skyrim|Update|Dawnguard|HearthFires|Dragonborn)\.esm$/i;
  const reqNames=new Set(bundle.manifest.requiredPlugins.map(p=>p.filename.toLowerCase()));
  let extraFullMasters=0;
  const seenExtra=new Set<string>();
  const cccNames=(inputs.cccText??'').replace(/^\uFEFF/,'').split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
  const activeNames=(inputs.pluginsText??'').replace(/^\uFEFF/,'').split(/\r?\n/).map(l=>l.trim()).filter(l=>l.startsWith('*')).map(l=>l.slice(1).trim());
  for(const [name,fromCcc] of [...cccNames.map(n=>[n,true] as const),...activeNames.map(n=>[n,false] as const)]){
   const lower=name.toLowerCase();
   if(implicit.test(name)||reqNames.has(lower)||seenExtra.has(lower))continue;
   try{
    const h=await readPluginHeader(await safeFile(game,'Data/'+name));
    const isLight=h.light||/\.esl$/i.test(name);
    const isMaster=fromCcc||h.master||/\.(esm|esl)$/i.test(name);
    if(!isLight&&isMaster){extraFullMasters++;seenExtra.add(lower);}
   }catch{/* ignore missing files */}
  }
  const adjustedReqs=requirements.map(p=>({...p,order:!implicit.test(p.filename)&&p.role==='server-required'?p.order+extraFullMasters:p.order}));
  const plan=await planActivation(game,adjustedReqs,inputs);
  if(plan.status!=='ready')return plan;
  // SSE uses plugins.txt; keep its existing diagnostic loadorder mirror consistent too.
  const active=new Set(plan.active.map(p=>p.toLowerCase())),raw=inputs.loadorderText??'',bom=raw.startsWith('\uFEFF')?'\uFEFF':'',newline=raw.includes('\r\n')?'\r\n':'\n';
  const lines=raw.slice(bom.length).split(/\r?\n/),observed=lines.map(l=>l.trim().replace(/^\*/,'' )).filter(l=>active.has(l.toLowerCase()));
  if(observed.map(p=>p.toLowerCase()).join('|')!==plan.active.map(p=>p.toLowerCase()).join('|')){
   const retained=lines.filter(l=>!active.has(l.trim().replace(/^\*/,'').toLowerCase()));
   const text=bom+plan.active.join(newline)+newline+retained.join(newline),bytes=Buffer.from(text,'utf8'),digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
   plan.configWrites.push({path:'@config/loadorder.txt',bytesBase64:bytes.toString('base64'),sha256:digest(bytes),originalHash:inputs.loadorderText===null?null:digest(Buffer.from(raw,'utf8'))});
  }
  return plan;
 }
 /** Read-only comparison against the current signed release, never just the presence of SkyUI. */
 async inspectInstallation(game:string,order:string){
  const bundle=await this.currentBundle();await noLinks(game);
  const missing:string[]=[],external:string[]=[];
  const requiredFiles=bundle.manifest.files.filter(f=>f.required);
  const matchResults=await Promise.all(requiredFiles.map(async file=>({file,ok:await this.matches(game,file)})));
  for(const {file,ok} of matchResults)if(!ok){
   (file.distribution==='allowed'&&file.package?missing:external).push(file.path);
  }
  const plugins=this.requiredActivation(bundle);
  let text='';try{text=await fs.readFile(await safeFile(order,'plugins.txt'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const active=new Set(text.split(/\r?\n/).filter(l=>l.trim().startsWith('*')).map(l=>l.trim().slice(1).toLowerCase()));
  const inactive=plugins.filter(p=>!active.has(p.toLowerCase()));
  if(plugins.length)try{const activation=await this.activationForPlay(game,order,bundle);if(activation.status!=='ready')inactive.push('Plugin activation blocked: '+activation.blockers.join('; '));else if(activation.configWrites.length)inactive.push('Shared plugin order requires repair');}catch(e){inactive.push(e instanceof Error?e.message:'Plugin activation unavailable');}
  const installed=!missing.length&&!external.length&&!inactive.length;
  this.update({installed,signature:'AUTHENTICATED',packId:bundle.manifest.packId,version:bundle.manifest.packVersion,release:bundle.manifest.distribution.release?.tag});
  return{installed,missing,external,inactive};
 }
 async prepareForPlay(game:string,order:string){
  if(this.preparing||this.controller)throw Error('Another pack operation is in progress');this.preparing=true;
  const cancellation=this.cancellation;
  try{
   if(this.disposed)throw Error('Download service disposed');
   if(await this.running())throw Error('Skyrim or SKSE is running; close it before verifying or repairing files');
   this.update({phase:'checking',installed:false,message:'Checking signed server pack and local file hashes before Play…'});
   const before=await this.inspectInstallation(game,order);
   this.checkCancellation(cancellation);
   if(before.external.length)throw Error('External dependency missing or different (cannot auto-download): '+before.external.join(', '));
   if(!before.installed){
    await this.installAndActivate(game,order);
    const after=await this.inspectInstallation(game,order);
    this.checkCancellation(cancellation);
    if(!after.installed)throw Error('Pack verification incomplete: '+[...after.missing,...after.external,...after.inactive].join(', '));
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
  const cancellation=this.cancellation;
  if(this.disposed)throw Error('Download service disposed');
  if(!gameDirectory)throw Error('Skyrim game folder is required');
  if(await this.running())throw Error('Skyrim or SKSE is running; close it before installing files');
  await noLinks(gameDirectory);checkExistingAncestors(orderDirectory);
  await this.acquire(async file=>!await this.matches(gameDirectory,file));
  this.checkCancellation(cancellation);
  if(this.state.phase!=='complete')throw Error('Server files download could not be completed: '+this.state.message);
  const bundle=this.lastBundle??await(async()=>{const provider=this.providerFactory!(),release=await provider.resolve(this.source.channel);return authenticateRelease(await provider.envelope(release),this.source,release);})();
  const grant=await this.cache();
  this.update({phase:'downloading',message:'Installing verified server files & mods (SkyUI) to Skyrim…'});
  const allowedFiles=bundle.manifest.files.filter(f=>f.distribution==='allowed'&&f.package);
  for(const file of allowedFiles){
   this.checkCancellation(cancellation);
   if(await this.matches(gameDirectory,file))continue;
   const payloadPath=path.join(grant.payloads,file.package!.sha256+'.bin');
   await noLinks(payloadPath);
   const st=await fs.stat(payloadPath);
   if(st.size!==file.package!.size)throw Error(`Payload size mismatch for ${file.path}`);
   const h=await hashFile(payloadPath,PAYLOAD_LIMIT);
   if(h.sha256!==file.package!.sha256)throw Error(`Payload hash mismatch for ${file.path}`);
   if(await this.running())throw Error('Skyrim or SKSE started during installation; close it and retry Play');
   const destPath=path.join(gameDirectory,...relativePath(file.path).split('/'));
   await safeDirectory(path.dirname(destPath));checkExistingAncestors(destPath);
   try{const old=await safeFile(gameDirectory,file.path);if((await fs.lstat(old)).nlink!==1)throw Error('Hard-linked destination refused');const backup=path.join(this.storage,'auto-repair-backups',randomUUID(),...file.path.split('/'));await safeDirectory(path.dirname(backup));await fs.copyFile(old,backup,fs.constants.COPYFILE_EXCL);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   const temporary=destPath+'.frostveil-'+randomUUID();
   try{await fs.copyFile(payloadPath,temporary,fs.constants.COPYFILE_EXCL);const copy=await hashFile(temporary,PAYLOAD_LIMIT);if(copy.sha256!==file.sha256||copy.size!==file.size)throw Error('Staged file changed');if(await this.running())throw Error('Skyrim or SKSE started; installation stopped');await noLinks(gameDirectory);checkExistingAncestors(destPath);this.checkCancellation(cancellation);await fs.rename(temporary,destPath);}finally{await fs.unlink(temporary).catch(()=>{});}
   const destHash=await hashFile(destPath,PAYLOAD_LIMIT);
   if(destHash.sha256!==file.package!.sha256||destHash.size!==file.package!.size)throw Error(`Failed to verify installed file: ${file.path}`);
  }
  const pluginsToActivate=this.requiredActivation(bundle);
  if(pluginsToActivate.length>0){
   if(await this.running())throw Error('Skyrim or SKSE is running; plugin activation stopped');
   const activation=await this.activationForPlay(gameDirectory,orderDirectory,bundle);
   if(activation.status!=='ready')throw Error('Plugin activation blocked: '+activation.blockers.join('; '));
   await safeDirectory(orderDirectory);
   for(const write of activation.configWrites){
    const filename=write.path==='@config/plugins.txt'?'plugins.txt':'loadorder.txt';
    const destination=path.join(orderDirectory,filename);checkExistingAncestors(destination);
    let observed:string|null=null;
    try{await noLinks(destination);if((await fs.lstat(destination)).nlink!==1)throw Error('Hard-linked plugin configuration refused');observed=(await hashFile(destination,1024*1024)).sha256;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(observed!==write.originalHash)throw Error('Plugin configuration changed during Play preparation');
    if(observed!==null){const backup=path.join(this.storage,'auto-repair-backups',randomUUID(),filename);await safeDirectory(path.dirname(backup));await fs.copyFile(destination,backup,fs.constants.COPYFILE_EXCL);}
    const temporary=destination+'.frostveil-'+randomUUID();
    try{await fs.writeFile(temporary,Buffer.from(write.bytesBase64,'base64'),{flag:'wx'});checkExistingAncestors(destination);if(await this.running())throw Error('Skyrim or SKSE started; activation stopped');this.checkCancellation(cancellation);await fs.rename(temporary,destination);}finally{await fs.unlink(temporary).catch(()=>{});}
   }
  }
  const verification=await this.inspectInstallation(gameDirectory,orderDirectory);
  this.checkCancellation(cancellation);
  this.update({phase:'complete',installed:verification.installed,message:verification.installed?'Signed server pack installed and verified. Ready to play.':'Server assets installed; unresolved requirements: '+[...verification.missing,...verification.external,...verification.inactive].join(', ')});
  return this.snapshot();
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
