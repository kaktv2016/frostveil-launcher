import fs from 'node:fs/promises';import path from 'node:path';import {safeFile} from '../files';import {MAX_METADATA,object,validateManifest,validateServerProfile} from './schema';import {loadRemoteProfile,remoteTrust,type TrustedBundle} from './trust';import {scanPackFiles,cancelled} from './scanner';import {checkPlugins,readOrderInputs} from './plugins';import {evaluateCompatibility,enforcePackGate} from './compatibility';
import type {ModpackState} from '../../shared/modpack-contracts';import type {Scan,Channel} from '../../shared/contracts';
// Reviewed main-process policy. Never accepted from IPC, a downloaded manifest, or user settings.
export const mandatoryPackPolicy=false;
function initial():ModpackState{return{phase:'idle',source:'not-configured',trust:'NOT CONFIGURED',status:'Not Configured',message:'SERVER PROFILE NOT CONFIGURED',enforcement:mandatoryPackPolicy,components:[],progress:{completed:0,total:0,bytes:0},files:[]};}
export class ModpackVerifier {
 private state=initial();private controller?:AbortController;private listeners=new Set<(s:ModpackState)=>void>();
 constructor(private storage:string,private launcherVersion:string,private orderDirectory:string,private version:(file:string)=>Promise<string>){}
 snapshot(){return structuredClone(this.state);}
 subscribe(fn:(s:ModpackState)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private emit(){for(const fn of this.listeners)fn(this.snapshot());}
 invalidate(){this.cancel();this.state=initial();this.emit();}
 cancel(){this.controller?.abort();}
 dispose(){this.cancel();this.listeners.clear();}
 async scan(directory:string,channel:Channel,runtime:Scan|null):Promise<void>{
  if(this.controller)throw Error('Modpack scan already in progress');const controller=new AbortController();this.controller=controller;this.state={...initial(),phase:'scanning',status:'Unverified',message:'Verifying configured requirements…'};this.emit();
  try{let bundle:TrustedBundle;
   try{const file=await safeFile(this.storage,'modpack-development.json');if((await fs.stat(file)).size>MAX_METADATA)throw Error('Metadata limit');const value=object(JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'')),['manifest','server']);const manifest=validateManifest(value.manifest);if(manifest.distribution.source!=='local-development')throw Error('Local profile must be explicitly development-only');bundle={trust:'LOCAL DEVELOPMENT ONLY',manifest,server:validateServerProfile(value.server)};
   }catch(error){bundle=(error as NodeJS.ErrnoException).code==='ENOENT'?await loadRemoteProfile(remoteTrust):{trust:'INVALID'};}
   cancelled(controller.signal);this.state.trust=bundle.trust;
   if(!bundle.manifest||!bundle.server){this.state.status=bundle.trust==='NOT CONFIGURED'?'Not Configured':'Unverified';this.state.message=bundle.trust==='NOT CONFIGURED'?'SERVER PROFILE NOT CONFIGURED — production trust key/source not configured':bundle.trust==='MISSING TRUST KEY'?'MISSING TRUST KEY':'Profile invalid or authenticity unavailable';this.state.phase='complete';this.emit();return;}
   const pack=bundle.manifest;this.state.source=bundle.trust==='AUTHENTICATED'?'signed-release':'local-development';this.state.packId=pack.packId;this.state.requiredPackVersion=bundle.server.packVersion;this.state.channel=pack.channel;this.state.components=pack.components;this.emit();
   let last=0;this.state.files=await scanPackFiles(directory,pack.files,{signal:controller.signal,version:this.version,onProgress:p=>{this.state.progress=p;if(Date.now()-last>75||p.completed===p.total){last=Date.now();this.emit();}}});cancelled(controller.signal);
   const inputs=await readOrderInputs(directory,this.orderDirectory);cancelled(controller.signal);this.state.plugins=await checkPlugins(directory,pack.requiredPlugins,inputs);cancelled(controller.signal);
   this.state.result=evaluateCompatibility({manifest:pack,server:bundle.server,files:this.state.files,plugins:this.state.plugins,runtime,trust:bundle.trust,launcherVersion:this.launcherVersion,channel});this.state.status=this.state.result.status;this.state.localPackVersion=this.state.result.local==='VERIFIED'?pack.packVersion:undefined;this.state.message=this.state.status==='Compatible'?'Matches local development/offline snapshot requirements; live server version UNVERIFIED':'See compatibility details and the read-only future update plan';this.state.phase='complete';this.state.scannedAt=new Date().toISOString();this.emit();
  }catch{this.state.phase=controller.signal.aborted?'cancelled':'error';this.state.status=controller.signal.aborted?'Unverified':'Scan Error';this.state.message=controller.signal.aborted?'Scan cancelled — previous verification cleared':'Verification failed — no compatible decision available';this.state.result=undefined;this.state.localPackVersion=undefined;this.emit();}finally{this.controller=undefined;}
 }
 enforce(){enforcePackGate(mandatoryPackPolicy,this.state.result,this.state.trust);}
}
