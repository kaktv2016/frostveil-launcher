import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {relativePath,safeFile} from './files';
import {verifyW14UpdateAcl} from './windows';

export function localW14Folder(root:string){
 if(process.platform!=='win32'||!/^[A-Za-z]:[\\/].+/.test(root))throw Error('An absolute local Windows folder is required');
 relativePath(root.slice(3).replace(/\\/g,'/'));
 return path.normalize(root);
}

export async function openProtectedW14File(root:string,reference:string,max:number,signal?:AbortSignal){
 signal?.throwIfAborted();
 const file=await safeFile(root,reference);
 const before=await fs.lstat(file,{bigint:true});
 if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>BigInt(max))throw Error('Unsafe or linked W14 payload');
 if(!await verifyW14UpdateAcl(root,path.dirname(file),file)){
  throw Object.assign(Error('Private folder permissions failed verification'),{code:'ERR_W14_FOLDER_PERMISSIONS'});
 }
 signal?.throwIfAborted();
 const handle=await fs.open(file,'r');
 try{
  const opened=await handle.stat({bigint:true});
  if(await safeFile(root,reference)!==file||(await fs.realpath(file)).toLowerCase()!==file.toLowerCase()){
   throw Error('W14 payload path changed at open');
  }
  const after=await fs.lstat(file,{bigint:true});
  if(!opened.isFile()||opened.nlink!==1n||[before,after].some(stat=>
   !stat.isFile()||stat.nlink!==1n||stat.dev!==opened.dev||stat.ino!==opened.ino||
   stat.size!==opened.size||stat.mtimeNs!==opened.mtimeNs||stat.ctimeNs!==opened.ctimeNs))throw Error('W14 payload changed at open');
  signal?.throwIfAborted();
  return {handle,opened};
 }catch(error){await handle.close().catch(()=>{});throw error;}
}

export async function readW14Json(file:Awaited<ReturnType<typeof openProtectedW14File>>,expectedSize?:number,expectedSha256?:string,signal?:AbortSignal){
 const {handle,opened}=file;
 try{
  const size=Number(opened.size);
  if(expectedSize!==undefined&&size!==expectedSize)throw Error('W14 metadata size mismatch');
  const bytes=Buffer.alloc(size);
  for(let offset=0;offset<size;){
   signal?.throwIfAborted();
   const {bytesRead}=await handle.read(bytes,offset,size-offset,offset);
   if(!bytesRead)throw Error('Truncated W14 metadata');
   offset+=bytesRead;
  }
  const after=await handle.stat({bigint:true});
  if(after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs||after.nlink!==1n||
     expectedSha256!==undefined&&expectedSha256!==createHash('sha256').update(bytes).digest('hex')){
   throw Error('W14 metadata digest or size mismatch');
  }
  signal?.throwIfAborted();
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
 }finally{await handle.close();}
}
