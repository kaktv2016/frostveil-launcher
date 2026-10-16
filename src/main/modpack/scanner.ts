import fs from 'node:fs/promises';import {createReadStream} from 'node:fs';import {createHash} from 'node:crypto';
import {safeFile} from '../files';import {normalizedVersion} from '../installation';import {allowedTarget,MAX_FILE_BYTES} from './schema';
import type {PackFile,FileEvidence} from '../../shared/modpack-contracts';
export interface ScanOptions {signal?:AbortSignal;concurrency?:number;onProgress?:(p:{completed:number;total:number;bytes:number})=>void;version?:(file:string)=>Promise<string>;resolveFile?:typeof safeFile;}
export function cancelled(signal?:AbortSignal){if(signal?.aborted)throw Error('Scan cancelled');}
/** Hash only the declared files; streamed bounded parallel reads, no scan cache and no writes. */
export async function scanPackFiles(root:string,files:PackFile[],options:ScanOptions={}):Promise<FileEvidence[]> {
 let next=0,completed=0,bytes=0;const results:FileEvidence[]=new Array(files.length);const progress=()=>options.onProgress?.({completed,total:files.length,bytes});progress();
 async function worker(){for(;;){cancelled(options.signal);const i=next++;if(i>=files.length)return;const expected=files[i]!;const result:FileEvidence={path:expected.path,componentId:expected.componentId,required:expected.required,status:'unknown',expectedHash:expected.sha256,expectedSize:expected.size,expectedVersion:expected.version};
  try{allowedTarget(expected.path);const file=await(options.resolveFile??safeFile)(root,expected.path);const before=await fs.stat(file);if(!before.isFile()||before.size>MAX_FILE_BYTES)throw Error('Unsupported file size');const digest=createHash('sha256');let count=0;const stream=createReadStream(file,{highWaterMark:256*1024});const abort=()=>stream.destroy(Error('Scan cancelled'));options.signal?.addEventListener('abort',abort,{once:true});
   try{for await(const chunk of stream){cancelled(options.signal);count+=chunk.length;bytes+=chunk.length;if(count>MAX_FILE_BYTES)throw Error('File size limit exceeded');digest.update(chunk);progress();}}finally{options.signal?.removeEventListener('abort',abort);stream.destroy();}
   cancelled(options.signal);const after=await fs.stat(file);if(count!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('File changed during scan');result.observedSize=count;result.observedHash=digest.digest('hex');result.status=result.observedHash===expected.sha256&&count===expected.size?'verified':'modified';
   if(expected.version){result.observedVersion=normalizedVersion(await options.version?.(file)??'');if(!result.observedVersion){result.status='unknown';result.reason='File version unverified';}else if(result.observedVersion!==expected.version){const a=result.observedVersion.split('.').map(Number),b=expected.version.split('.').map(Number);let older=false;for(let n=0;n<4;n++){if(a[n]!==b[n]){older=a[n]!<b[n]!;break;}}result.status=older?'outdated':'incompatible';result.reason='Resource version mismatch';}}
  }catch(error){cancelled(options.signal);const code=(error as NodeJS.ErrnoException).code;result.status=code==='ENOENT'?(expected.required?'missing':'optional-missing'):'scan-error';result.reason=code==='EACCES'||code==='EPERM'?'Access denied':result.status==='scan-error'?'Read failed, unsafe path, or file changed':'File absent';}
  results[i]=result;completed++;progress();
 }}
 await Promise.all(Array.from({length:Math.max(1,Math.min(4,Math.floor(options.concurrency??2)))},worker));cancelled(options.signal);return results;
}
