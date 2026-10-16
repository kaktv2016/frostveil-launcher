import semver from 'semver';
import type {LauncherUpdate} from '../shared/contracts';
export interface UpdateEngine {
 on(event:string,listener:(value:any)=>void):unknown;
 removeListener(event:string,listener:(value:any)=>void):unknown;
 check():Promise<unknown>;download():Promise<void>;install():void|Promise<void>;cancel():void;
}
interface Options {version:string;checkEnabled:boolean;downloadTrusted:boolean;installed:boolean;now?:()=>number;gameRunning:()=>Promise<boolean>;sourceUrl?:string;}
const DEFAULT_SOURCE='https://github.com/kaktv2016/frostveil-launcher/releases';
const DEFAULT_FALLBACK='Manual recovery: download and run the latest verified NSIS installer from https://github.com/kaktv2016/frostveil-launcher/releases';
export class LauncherUpdateService {
 private value:LauncherUpdate;
 private readonly subscribers=new Set<(state:LauncherUpdate)=>void>();
 private lock=false;private lastCheck=-Infinity;private disposed=false;
 private readonly now:()=>number;
 private readonly listeners:Array<[string,(value:any)=>void]>;
 constructor(private readonly engine:UpdateEngine,private readonly options:Options){
  this.now=options.now??Date.now;
  this.value={
   state:options.checkEnabled?'idle':'unsupported',
   installedVersion:options.version,
   message:options.checkEnabled?'Ready to check stable releases':'Development/fixture mode: real self-update disabled',
   canDownload:false,
   canInstall:false,
   source:options.sourceUrl??DEFAULT_SOURCE,
   publisherTrust:options.downloadTrusted?'verified':'unconfigured',
   verification:options.downloadTrusted?'pending':'unconfigured',
   recoveryFallback:DEFAULT_FALLBACK
  };
  this.listeners=[
   ['progress',p=>{
    if(this.value.state!=='downloading'||this.disposed)return;
    if(!p||![p.percent,p.transferred,p.total,p.bytesPerSecond].every(Number.isFinite)||p.total<0||p.transferred<0||p.transferred>p.total||p.bytesPerSecond<0)return;
    this.set({progress:{percent:Math.max(0,Math.min(100,p.percent)),transferred:p.transferred,total:p.total,bytesPerSecond:p.bytesPerSecond}});
   }],
   ['downloaded',info=>{
    if(this.value.state==='downloading'&&!this.disposed&&info?.version===this.value.availableVersion){
     this.set({
      state:'downloaded',
      message:'Verified download ready; installation requires your action',
      canDownload:false,
      canInstall:this.options.installed,
      publisherTrust:'verified',
      verification:'installer-verified',
      keyId:typeof info?.keyId==='string'?info.keyId:this.value.keyId,
      minimumLauncherVersion:typeof info?.minimumLauncherVersion==='string'?info.minimumLauncherVersion:this.value.minimumLauncherVersion,
      progress:this.value.progress?{...this.value.progress,percent:100,transferred:this.value.progress.total}:undefined
     });
    }
   }]
  ];
  for(const [name,listener] of this.listeners)engine.on(name,listener);
  const installError=()=>{if(this.value.state==='installing')this.set({state:'downloaded',message:'NSIS update installation failed; verified download retained for retry',canInstall:true});};
  this.listeners.push(['install-error',installError]);engine.on('install-error',installError);
 }
 snapshot():LauncherUpdate{return structuredClone(this.value);}
 subscribe(listener:(state:LauncherUpdate)=>void):()=>void {this.subscribers.add(listener);return()=>{this.subscribers.delete(listener);};}
 private set(patch:Partial<LauncherUpdate>){if(this.disposed)return;this.value={...this.value,...patch};for(const listener of this.subscribers)listener(this.snapshot());}
 private fail(error:unknown){
  const code=String((error as {code?:unknown})?.code??'');
  let message='Update failed; retry after a short wait';
  if(/NO_PUBLISHED|404/.test(code))message='No public launcher release is available';
  else if(/UNSIGNED_METADATA/.test(code))message='Unsigned update metadata rejected; signed Ed25519 manifest required';
  else if(/CHANNEL_FILE/.test(code))message='Release update metadata is unavailable';
  else if(/DOWNGRADE/.test(code))message='Update rejected: version downgrade blocked';
  else if(/MUTATION/.test(code))message='Update rejected: same-version payload mutation blocked';
  else if(/MINIMUM_VERSION/.test(code))message='Current launcher is older than minimum supported version; manual reinstall required';
  else if(/REDIRECT/.test(code))message='Update download rejected: untrusted redirect host blocked';
  else if(/REPLACEMENT|TOCTOU/.test(code))message='Cached installer changed before execution; update blocked';
  else if(/KEY_REVOKED|KEY_EXPIRED|KEY_UNTRUSTED|PUBLISHER/.test(code))message='Update publisher key rejected or untrusted';
  else if(/CHECKSUM|SIGNATURE|MANIFEST/.test(code))message='Update integrity/signature verification failed';
  else if(/429|RATE/.test(code))message='GitHub rate limit reached; retry later';
  else if(/ECONN|ENOTFOUND|ETIMEDOUT/.test(code))message='Network unavailable; launcher remains usable';
  const publisherTrust=/KEY_|SIGNATURE|MANIFEST|UNSIGNED_METADATA/.test(code)?'rejected':this.value.publisherTrust;
  this.set({state:'error',message,canDownload:false,canInstall:false,progress:undefined,publisherTrust,verification:'failed'});
 }
 async check():Promise<void>{
  if(this.disposed||!this.options.checkEnabled||this.lock||['downloaded','deferred','installing'].includes(this.value.state)||this.now()-this.lastCheck<30000)return;
  this.lock=true;this.lastCheck=this.now();this.set({state:'checking',message:'Checking stable public GitHub releases',canDownload:false,canInstall:false,progress:undefined,availableVersion:undefined,releaseNotes:undefined});
  try{
   const info=await this.engine.check() as {version?:unknown;files?:unknown;releaseNotes?:unknown;keyId?:unknown;minimumLauncherVersion?:unknown}|null;
   if(this.disposed)return;
   if(!info||typeof info.version!=='string'||!semver.valid(info.version)||semver.prerelease(info.version)||!Array.isArray(info.files)||!info.files.length)throw Error('Invalid update metadata');
   if(info.files.some(file=>!file||typeof file.url!=='string'||!file.url.endsWith('.exe')||typeof file.sha512!=='string'||!/^\S{88}$/.test(file.sha512)))throw Error('Invalid installer metadata');
   const keyId=typeof info.keyId==='string'?info.keyId:undefined;
   const minimumLauncherVersion=typeof info.minimumLauncherVersion==='string'&&semver.valid(info.minimumLauncherVersion)?info.minimumLauncherVersion:undefined;
   if(minimumLauncherVersion&&semver.lt(this.options.version,minimumLauncherVersion)){
    throw Object.assign(Error('Manual reinstall required for this update'),{code:'ERR_UPDATER_MINIMUM_VERSION'});
   }
   if(!semver.gt(info.version,this.options.version)){
    this.set({state:'up-to-date',message:'No newer compatible stable release',availableVersion:info.version,keyId,minimumLauncherVersion,publisherTrust:this.options.downloadTrusted?'verified':'unconfigured',verification:this.options.downloadTrusted?'manifest-verified':'unconfigured'});
    return;
   }
   const notes=typeof info.releaseNotes==='string'?info.releaseNotes:Array.isArray(info.releaseNotes)?info.releaseNotes.map(n=>typeof n.note==='string'?n.note:'').join('\n'):'';
   this.set({
    state:'available',
    availableVersion:info.version,
    releaseNotes:notes.slice(0,8000),
    keyId,
    minimumLauncherVersion,
    publisherTrust:this.options.downloadTrusted?'verified':'unconfigured',
    verification:this.options.downloadTrusted?'manifest-verified':'unconfigured',
    message:this.options.downloadTrusted?'A newer stable release is available':'A release exists; download BLOCKED BY SIGNING configuration',
    canDownload:this.options.downloadTrusted
   });
  }catch(error){this.fail(error);}finally{this.lock=false;}
 }
 async download():Promise<void>{
  if(!this.options.downloadTrusted)throw Error('BLOCKED BY SIGNING: trusted publisher not configured');
  if(this.disposed||this.lock||this.value.state!=='available')throw Error('No update is available for download');
  this.lock=true;this.set({state:'downloading',message:'Downloading with library integrity and publisher verification',canDownload:false,canInstall:false});
  try{await this.engine.download();if(this.snapshot().state==='downloading')throw Error('Download was not verified');}catch(error){this.fail(error);}finally{this.lock=false;}
 }
 defer(){if(!['downloaded','deferred'].includes(this.value.state)||this.lock)throw Error('No downloaded update');this.set({state:'deferred',message:'Update deferred; it will not install automatically on quit'});}
 async install(){
  if(this.disposed||this.lock||!this.options.installed||!this.options.downloadTrusted||!['downloaded','deferred'].includes(this.value.state))throw Error('Installed signed NSIS build and verified download required');
  this.lock=true;const previous=this.value.state;
  try{if(await this.options.gameRunning())throw Error('Skyrim/SKSE is running; close it yourself before updating');this.set({state:'installing',message:'Restarting through NSIS updater; installation not yet confirmed',canInstall:false});await this.engine.install();}catch(error){const message=error instanceof Error&&error.message.startsWith('Skyrim/SKSE is running')?error.message:'Verified update installation could not start; retry later';this.set({state:previous,message,canInstall:true});throw Error(message);}finally{this.lock=false;}
 }
 dispose(){this.disposed=true;this.engine.cancel();for(const [name,listener] of this.listeners)this.engine.removeListener(name,listener);this.subscribers.clear();}
}
