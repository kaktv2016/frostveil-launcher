import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {relativePath,safeFile} from './files';
import {MAX_INSTALLER_BYTES,updateError,type LauncherUpdateFeed} from './update-integrity';
import {verifyW14UpdateAcl} from './windows';

declare const FROSTVEIL_W14_UPDATE_FOLDER:string|undefined;
export const packagedW14UpdateFolder=typeof FROSTVEIL_W14_UPDATE_FOLDER==='undefined'?undefined:FROSTVEIL_W14_UPDATE_FOLDER;

export class FolderLauncherUpdateTransport implements LauncherUpdateFeed {
 readonly channel='w14-pilot' as const;
 private readonly root:string;

 constructor(root:string){
  if(process.platform!=='win32'||!/^[A-Za-z]:[\\/].+/.test(root))throw Error('An absolute local Windows update folder is required');
  relativePath(root.slice(3).replace(/\\/g,'/'));
  this.root=path.normalize(root);
 }

 private async open(reference:string,max:number,signal?:AbortSignal){
  let handle:fs.FileHandle|undefined;
  try{
   signal?.throwIfAborted();
   const file=await safeFile(this.root,reference);
   const before=await fs.lstat(file,{bigint:true});
   if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>BigInt(max))throw Error('Unsafe or linked update payload');
   if(!await verifyW14UpdateAcl(this.root,path.dirname(file),file)){
    throw updateError('Private update folder permissions failed verification','ERR_UPDATER_FOLDER_PERMISSIONS');
   }
   signal?.throwIfAborted();
   handle=await fs.open(file,'r');
   const opened=await handle.stat({bigint:true});
   if(await safeFile(this.root,reference)!==file||(await fs.realpath(file)).toLowerCase()!==file.toLowerCase()){
    throw Error('Update payload path changed at open');
   }
   const after=await fs.lstat(file,{bigint:true});
   if(!opened.isFile()||opened.nlink!==1n||[before,after].some(stat=>
    !stat.isFile()||stat.nlink!==1n||stat.dev!==opened.dev||stat.ino!==opened.ino||
    stat.size!==opened.size||stat.mtimeNs!==opened.mtimeNs||stat.ctimeNs!==opened.ctimeNs)){
    throw Error('Update payload changed at open');
   }
   signal?.throwIfAborted();
   return {handle,opened};
  }catch(error){
   await handle?.close().catch(()=>{});
   signal?.throwIfAborted();
   const code=(error as NodeJS.ErrnoException).code;
   if(code==='ERR_UPDATER_FOLDER_PERMISSIONS')throw error;
   if(code==='ENOENT')throw updateError('Private update folder or file is unavailable','ERR_UPDATER_FOLDER_UNAVAILABLE');
   throw updateError('Private update folder contains an unsafe or inaccessible file','ERR_UPDATER_FOLDER_UNSAFE');
  }
 }

 async json(suffix:string,signal?:AbortSignal,max=1024*1024,expectedSize?:number,expectedDigest?:string){
  const asset=/^\/releases\/assets\/([1-9]\d{0,15})$/.exec(suffix);
  if(suffix!=='/releases/latest'&&(!asset||!Number.isSafeInteger(Number(asset[1]))||!expectedDigest)){
   throw updateError('Invalid private update metadata reference','ERR_UPDATER_INVALID_MANIFEST');
  }
  const {handle,opened}=await this.open(asset?'assets/'+asset[1]:'latest.json',Math.min(max,1024*1024),signal);
  try{
   const size=Number(opened.size);
   if(expectedSize!==undefined&&size!==expectedSize)throw updateError('Update metadata size mismatch','ERR_UPDATER_INVALID_MANIFEST');
   const bytes=Buffer.alloc(size);
   for(let offset=0;offset<size;){
    signal?.throwIfAborted();
    const {bytesRead}=await handle.read(bytes,offset,size-offset,offset);
    if(!bytesRead)throw updateError('Truncated update metadata','ERR_UPDATER_INVALID_MANIFEST');
    offset+=bytesRead;
   }
   const after=await handle.stat({bigint:true});
   if(after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs||after.nlink!==1n||expectedDigest!==undefined&&
      expectedDigest!=='sha256:'+createHash('sha256').update(bytes).digest('hex')){
    throw updateError('Update metadata digest or size mismatch','ERR_UPDATER_INVALID_MANIFEST');
   }
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }finally{await handle.close();}
 }

 async installer(assetId:number,signal?:AbortSignal){
  if(!Number.isSafeInteger(assetId)||assetId<1)throw Error('Invalid installer asset ID');
  const {handle,opened}=await this.open('assets/'+assetId,MAX_INSTALLER_BYTES,signal);
  try{
   const body=Readable.toWeb(handle.createReadStream({signal})) as ReadableStream<Uint8Array>;
   return {status:200,headers:new Headers({'content-length':String(opened.size)}),body};
  }catch(error){await handle.close();throw error;}
 }
}
