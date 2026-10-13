import path from 'node:path';
import {safeFile,hashFile} from './files';
import type {Profile,Scan} from '../shared/contracts';
export function normalizedVersion(text:string):string {return (text.match(/\d+/g)??[]).join('.');}
export async function scanInstallation(directory:string,profile:Profile,version:(file:string)=>Promise<string>):Promise<Scan>{
 const scan:Scan={directory:path.resolve(directory),ready:false,runtime:'',skseLoader:'',skseRuntime:'',nativeLauncherAvailable:false,files:[],errors:[],scannedAt:new Date().toISOString()};
 try{await safeFile(directory,'SkyrimSELauncher.exe');scan.nativeLauncherAvailable=true;}catch{/* Optional for the existing SKSE launch path; never launch it instead. */}
 for(const [name,key,expected] of [['SkyrimSE.exe','runtime',profile.runtime],['skse64_loader.exe','skseLoader',profile.skseVersion],[profile.skseDll,'skseRuntime',profile.skseVersion]] as const){
  try{scan[key]=normalizedVersion(await version(await safeFile(directory,name)));if(!scan[key])scan.errors.push(name+': Detected — exact version unverified');else if(scan[key]!==expected)scan.errors.push('Unsupported '+name+' version '+scan[key]);}catch{scan.errors.push(name+': version unavailable/unverified');}
 }
 for(const entry of profile.files){let status:Scan['files'][number]['status']='UNVERIFIED';try{const actual=await hashFile(await safeFile(directory,entry.path));status=actual.sha256===entry.sha256&&actual.size===entry.size?'LOCAL BASELINE MATCH':'DIFFERENT';}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')status='MISSING';}scan.files.push({...entry,status});if(status!=='LOCAL BASELINE MATCH')scan.errors.push(entry.path+': '+status);}
 if(!profile.files.length||!profile.files.some(f=>f.path==='SkyrimSE.exe')||!profile.files.some(f=>f.component==='client'))scan.errors.push('Local baseline not configured');
 scan.ready=scan.errors.length===0;return scan;
}
