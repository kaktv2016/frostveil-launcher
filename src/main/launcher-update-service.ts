import semver from 'semver';
import type {LauncherUpdate} from '../shared/contracts';
export interface UpdateEngine {
 on(event:string,listener:(value:any)=>void):unknown;
 removeListener(event:string,listener:(value:any)=>void):unknown;
 check():Promise<unknown>;download():Promise<void>;install():void|Promise<void>;cancel():void;
}
interface Options {version:string;checkEnabled:boolean;downloadTrusted:boolean;installed:boolean;now?:()=>number;gameRunning:()=>Promise<boolean>;}
export class LauncherUpdateService {
 private value:LauncherUpdate;
 private readonly subscribers=new Set<(state:LauncherUpdate)=>void>();
 private lock=false;private lastCheck=-Infinity;private disposed=false;
 private readonly now:()=>number;
 private readonly listeners:Array<[string,(value:any)=>void]>;
 constructor(private readonly engine:UpdateEngine,private readonly options:Options){
  this.now=options.now??Date.now;
  this.value={state:options.checkEnabled?'idle':'unsupported',installedVersion:options.version,message:options.checkEnabled?'Ready to check stable releases':'Development/fixture mode: real self-update disabled',canDownload:false,canInstall:false,source:'https://github.com/kaktv2016/frostveil-launcher/releases'};
  this.listeners=[['progress',p=>{if(this.value.state!=='downloading'||this.disposed)return;if(!p||![p.percent,p.transferred,p.total,p.bytesPerSecond].every(Number.isFinite)||p.total<0||p.transferred<0||p.transferred>p.total||p.bytesPerSecond<0)return;this.set({progress:{percent:Math.max(0,Math.min(100,p.percent)),transferred:p.transferred,total:p.total,bytesPerSecond:p.bytesPerSecond}});}],['downloaded',info=>{if(this.value.state==='downloading'&&!this.disposed&&info?.version===this.value.availableVersion)this.set({state:'downloaded',message:'Verified download ready; installation requires your action',canDownload:false,canInstall:this.options.installed,progress:this.value.progress?{...this.value.progress,percent:100,transferred:this.value.progress.total}:undefined});}]];
  for(const [name,listener] of this.listeners)engine.on(name,listener);
  const installError=()=>{if(this.value.state==='installing')this.set({state:'downloaded',message:'NSIS update installation failed; verified download retained for retry',canInstall:true});};
  this.listeners.push(['install-error',installError]);engine.on('install-error',installError);
 }
 snapshot():LauncherUpdate{return structuredClone(this.value);}
 subscribe(listener:(state:LauncherUpdate)=>void):()=>void {this.subscribers.add(listener);return()=>{this.subscribers.delete(listener);};}
 private set(patch:Partial<LauncherUpdate>){if(this.disposed)return;this.value={...this.value,...patch};for(const listener of this.subscribers)listener(this.snapshot());}
 private fail(error:unknown){const code=String((error as {code?:unknown})?.code??'');let message='Update failed; retry after a short wait';if(/NO_PUBLISHED|404/.test(code))message='No public launcher release is available';else if(/CHANNEL_FILE/.test(code))message='Release update metadata is unavailable';else if(/CHECKSUM|SIGNATURE/.test(code))message='Update integrity/signature verification failed';else if(/429|RATE/.test(code))message='GitHub rate limit reached; retry later';else if(/ECONN|ENOTFOUND|ETIMEDOUT/.test(code))message='Network unavailable; launcher remains usable';this.set({state:'error',message,canDownload:false,canInstall:false,progress:undefined});}
 async check():Promise<void>{
  if(this.disposed||!this.options.checkEnabled||this.lock||['downloaded','deferred','installing'].includes(this.value.state)||this.now()-this.lastCheck<30000)return;
  this.lock=true;this.lastCheck=this.now();this.set({state:'checking',message:'Checking stable public GitHub releases',canDownload:false,canInstall:false,progress:undefined,availableVersion:undefined,releaseNotes:undefined});
  try{const info=await this.engine.check() as {version?:unknown;files?:unknown;releaseNotes?:unknown}|null;if(this.disposed)return;
   if(!info||typeof info.version!=='string'||!semver.valid(info.version)||semver.prerelease(info.version)||!Array.isArray(info.files)||!info.files.length)throw Error('Invalid update metadata');
   if(info.files.some(file=>!file||typeof file.url!=='string'||!file.url.endsWith('.exe')||typeof file.sha512!=='string'||!/^\S{88}$/.test(file.sha512)))throw Error('Invalid installer metadata');
   if(!semver.gt(info.version,this.options.version)){this.set({state:'up-to-date',message:'No newer compatible stable release',availableVersion:info.version});return;}
   const notes=typeof info.releaseNotes==='string'?info.releaseNotes:Array.isArray(info.releaseNotes)?info.releaseNotes.map(n=>typeof n.note==='string'?n.note:'').join('\n'):'';
   this.set({state:'available',availableVersion:info.version,releaseNotes:notes.slice(0,8000),message:this.options.downloadTrusted?'A newer stable release is available':'A release exists; download BLOCKED BY SIGNING configuration',canDownload:this.options.downloadTrusted});
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
