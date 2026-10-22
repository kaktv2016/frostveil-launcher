import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {safeDirectory,safeFile,hashFile} from './files';

const ORIGIN='https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev';
export interface SourceDownload {downloadUrl?:string;archiveSize?:number;archiveSha256?:string;}
export function validateSourceDownload(source:SourceDownload){
 if(!source.downloadUrl)return;
 const {archiveSize,archiveSha256}=source;
 if(!Number.isSafeInteger(archiveSize)||archiveSize!<1||archiveSize!>2*1024*1024*1024||!/^[a-f0-9]{64}$/.test(archiveSha256??''))throw Error('Invalid source download identity');
 const url=new URL(source.downloadUrl);
 if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash||!new RegExp('^/sources/'+archiveSha256+'\\.(zip|rar|7z)$').test(url.pathname))throw Error('Untrusted source download URL');
}

/** The bundled recipe authenticates both URL and complete archive bytes. */
export async function downloadGraphicsSource(storage:string,source:SourceDownload,running:()=>Promise<boolean>,progress?:(done:number,total:number)=>void,signal?:AbortSignal):Promise<string>{
 signal?.throwIfAborted();
 validateSourceDownload(source);if(!source.downloadUrl)throw Error('Source download URL missing');
 const size=source.archiveSize!,expected=source.archiveSha256!,root=path.join(storage,'graphics-source-downloads');await safeDirectory(root);
 const name=expected+path.posix.extname(new URL(source.downloadUrl).pathname),target=path.join(root,name);
 try{const cached=await safeFile(root,name),actual=await hashFile(cached,2*1024*1024*1024);if(actual.size===size&&actual.sha256===expected)return cached;await fs.rename(cached,path.join(root,name+'.invalid-'+randomUUID()));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 if(await running())throw Error('Skyrim/SKSE is running; close it before graphics download');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15*60*1000),part=path.join(root,name+'.'+randomUUID()+'.part');
 try{
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  combined.throwIfAborted();
  const response=await fetch(source.downloadUrl,{redirect:'error',signal:combined});
  if(response.status!==200||!response.body)throw Error('Source download failed: HTTP '+response.status);
  const length=response.headers.get('content-length');if(length!==null&&Number(length)!==size){await response.body.cancel();throw Error('Source download size mismatch');}
  let received=0,last=0;const hash=createHash('sha256');
  const check=new Transform({transform(chunk,encoding,done){received+=chunk.length;if(received>size){done(Error('Source download exceeds pinned size'));return;}hash.update(chunk);if(Date.now()-last>200||received===size){last=Date.now();progress?.(received,size);}done(null,chunk);}});
  await pipeline(Readable.fromWeb(response.body as never),check,createWriteStream(part,{flags:'wx'}),{signal:combined});
  signal?.throwIfAborted();
  if(received!==size||hash.digest('hex')!==expected)throw Error('Source download hash/size mismatch');
  if(await running())throw Error('Skyrim/SKSE is running; close it before graphics repair');
  await fs.rename(part,target);return await safeFile(root,name);
 }finally{clearTimeout(timer);controller.abort();await fs.unlink(part).catch(()=>{});}
}
