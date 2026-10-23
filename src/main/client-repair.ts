import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID,createHash}from'node:crypto';import {safeDirectory,safeFile,noLinks,hashFile,checkExistingAncestors}from'./files';import {clientRepairPin}from'./client-repair-pin';
interface Pin{path:string;size:number;sha256:string;url:string;previous:{size:number;sha256:string};previousVersions?:readonly {size:number;sha256:string}[];}
/** Only this reviewed old->new transition. Never pin an arbitrary observed file. */
export function effectiveClientRequirement<T extends {path:string;size:number;sha256:string}>(file:T,pin:Pin=clientRepairPin):T{return file.path.toLowerCase()===pin.path.toLowerCase()&&[pin.previous,...(pin.previousVersions??[])].some(p=>file.size===p.size&&file.sha256===p.sha256)?{...file,size:pin.size,sha256:pin.sha256}:file;}
async function acquire(url:string):Promise<Buffer>{const r=await fetch(url,{signal:AbortSignal.timeout(60000),redirect:'error'});if(!r.ok||!r.body)throw Error('Client repair download unavailable');const parts:Buffer[]=[];let size=0;for await(const p of r.body){size+=p.length;if(size>8*1024*1024)throw Error('Client repair exceeds size limit');parts.push(Buffer.from(p));}return Buffer.concat(parts);}
export async function repairClientForPlay(game:string,storage:string,running:()=>Promise<boolean>,download:(url:string)=>Promise<Buffer>=acquire,pin:Pin=clientRepairPin){
 if(pin.path!=='Data/Platform/Plugins/skymp5-client.js')throw Error('Unexpected repair target');
 if(await running())throw Error('Skyrim/SKSE is running; close it before client repair');
 const target=await safeFile(game,pin.path),before=await hashFile(target,8*1024*1024);
 if(before.sha256===pin.sha256&&before.size===pin.size)return;
 if(![pin.previous,...(pin.previousVersions??[])].some(p=>before.sha256===p.sha256&&before.size===p.size))throw Error('Unrecognized SkyMP client; refusing to overwrite an unreviewed file');
 if((await fs.lstat(target)).nlink!==1)throw Error('Hard-linked client refused');
 const bytes=await download(pin.url);if(bytes.length!==pin.size||createHash('sha256').update(bytes).digest('hex')!==pin.sha256)throw Error('Client repair hash mismatch');
 if(await running())throw Error('Skyrim/SKSE started during client download; repair stopped');
 const folder=path.join(storage,'client-repair-backups');await safeDirectory(folder);const backup=path.join(folder,before.sha256+'.js');
 try{await fs.copyFile(target,backup,fs.constants.COPYFILE_EXCL);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 await noLinks(backup);if((await hashFile(backup)).sha256!==before.sha256)throw Error('Client backup changed');
 const temporary=target+'.frostveil-'+randomUUID();try{await fs.writeFile(temporary,bytes,{flag:'wx'});if(await running())throw Error('Skyrim/SKSE is running; repair stopped');await noLinks(game);checkExistingAncestors(target);const current=await hashFile(await safeFile(game,pin.path));if(current.sha256!==before.sha256||current.size!==before.size)throw Error('Client changed while preparing repair');await fs.rename(temporary,target);}finally{await fs.unlink(temporary).catch(()=>{});}
 const installed=await hashFile(target);if(installed.sha256!==pin.sha256||installed.size!==pin.size)throw Error('Installed client verification failed');
}

export async function clientRequirementForScan<T extends {path:string;size:number;sha256:string}>(file:T,game:string,pin:Pin=clientRepairPin):Promise<T>{const next=effectiveClientRequirement(file,pin);if(next===file)return file;try{const actual=await hashFile(await safeFile(game,pin.path),8*1024*1024);if(actual.sha256===pin.sha256&&actual.size===pin.size)return next;}catch{}return file;}

const nativeTransition={path:'Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll',size:15674880,sha256:'8549f8be88fefec1341399a64293b3798c8ea5f20c34a60204d0088759d4025b',url:'',previousVersions:[{size:15668224,sha256:'18b530ef76a5b84d6da090b5e9c87f7e93b436e02104b48aa1602a8b26d6e30a'}],previous:{size:15668224,sha256:'ce58aa2ddddb72e8c941d4fde5edcdfa5398815e33cf95efead0fd71608e4666'}};
export function effectiveNativeRequirement<T extends {path:string;size:number;sha256:string}>(file:T):T{return effectiveClientRequirement(file,nativeTransition);}
export async function nativeRequirementForScan<T extends {path:string;size:number;sha256:string}>(file:T,game:string):Promise<T>{const next=effectiveNativeRequirement(file);if(next===file)return file;try{const actual=await hashFile(await safeFile(game,next.path),32*1024*1024);if(actual.size===next.size&&actual.sha256===next.sha256)return next;}catch{}return file;}
