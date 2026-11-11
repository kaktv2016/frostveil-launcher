import fs from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hashFile,noLinks} from '../files';
import {checkRoots,identity,PAYLOAD_LIMIT,type SandboxGrant} from '../installer/sandbox';
import {MetadataStore} from '../installer/metadata';
import {cancelled} from '../modpack/scanner';
import {object,releaseBinding,assetName,size,hash} from '../modpack/schema';
import type {PackageReference} from '../../shared/modpack-contracts';
import {DistributionTransport,HttpFailure} from './transport';

export interface DownloadProgress {asset:string;bytes:number;total:number;bytesPerSecond:number;attempt:number;state:'downloading'|'retrying'|'verified';}
interface Options {onProgress?:(p:DownloadProgress)=>void|Promise<void>;attempts?:number;backoffMs?:number;writeChunk?:(h:fs.FileHandle,bytes:Uint8Array)=>Promise<void>;}
interface Partial {binding:string;etag:string|null;bytes:number;prefixHash:string;identity:string;}

const prefixReadBytes=64*1024;
const emptyHash=createHash('sha256').digest('hex');
const strongETag=/^"[^"\r\n]{1,200}"$/;
const activePayloads=new Set<string>();

function sameFile(a:BigIntStats,b:BigIntStats){
 return identity(a)===identity(b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}

function cacheConflict(){
 return Error('Protected cache integrity conflict. Use an independently verified cache or request a cache ownership assessment.');
}

export class PackageDownloader {
 private busy=false;

 constructor(private grant:SandboxGrant,private transport:DistributionTransport,private options:Options={}){
  if(!transport.testOnly&&options.writeChunk)throw Error('Production acquisition cannot override filesystem writes');
 }

 async acquire(ref:PackageReference,signal?:AbortSignal):Promise<string>{
  if(this.busy)throw Error('Concurrent package acquisition refused');
  this.busy=true;
  let payloadKey:string|undefined;
  try{
   const asset={...ref,rights:{...ref.rights}};
   releaseBinding({owner:asset.owner,repo:asset.repo,tag:asset.tag},asset.packVersion);
   assetName(asset.assetName);
   size(asset.assetId,Number.MAX_SAFE_INTEGER);
   size(asset.size,PAYLOAD_LIMIT);
   hash(asset.sha256);
   if(asset.assetId<1)throw Error('Invalid asset identity');
   await checkRoots(this.grant);
   const root=await fs.realpath(this.grant.payloads);
   cancelled(signal);
   const key=path.join(process.platform==='win32'?root.toLowerCase():root,asset.sha256);
   if(activePayloads.has(key))throw Error('Concurrent package acquisition refused');
   activePayloads.add(key);
   payloadKey=key;
   return await this.download(asset,signal);
  }finally{
   if(payloadKey!==undefined)activePayloads.delete(payloadKey);
   this.busy=false;
  }
 }

 private async checked(file:string){
  await checkRoots(this.grant);
  return this.namedFile(file);
 }

 private async namedFile(file:string){
  await noLinks(file);
  const stat=await fs.lstat(file,{bigint:true});
  if(!stat.isFile()||stat.nlink!==1n)throw Error('Unsafe download cache');
  return stat;
 }

 private async optionalFile(file:string){
  await checkRoots(this.grant);
  try{return await this.namedFile(file);}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
   // An unavailable grant root cannot be treated as an absent cache entry.
   await checkRoots(this.grant);
   return undefined;
  }
 }

 private async cached(target:string,ref:PackageReference){
  const before=await this.optionalFile(target);
  if(!before)return false;
  if(before.size!==BigInt(ref.size))throw cacheConflict();
  const observed=await hashFile(target,PAYLOAD_LIMIT);
  const after=await this.checked(target);
  if(!sameFile(before,after)||observed.size!==ref.size||observed.sha256!==ref.sha256)throw cacheConflict();
  return true;
 }

 private async partialState(store:MetadataStore,meta:string,partial:string,binding:string,limit:number):Promise<Partial>{
  try{
   const raw=object(await store.read(meta),['binding','etag','bytes','prefixHash','identity']);
   if(raw.binding!==binding||raw.etag!==null&&(typeof raw.etag!=='string'||!strongETag.test(raw.etag))||
      typeof raw.identity!=='string'||!/^\d+:\d+$/.test(raw.identity))throw Error('Invalid partial metadata');
   size(raw.bytes,limit);
   hash(raw.prefixHash);
   return raw as Partial;
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  let stat=await this.optionalFile(partial);
  if(!stat){
   const handle=await fs.open(partial,'wx',0o600);
   try{
    await handle.sync();
    stat=await handle.stat({bigint:true});
   }finally{await handle.close();}
   if(!sameFile(stat,await this.checked(partial)))throw Error('Partial substituted before first checkpoint');
  }
  if(stat.size!==0n)throw Error('Unknown partial conflict');
  const state={binding,etag:null,bytes:0,prefixHash:emptyHash,identity:identity(stat)};
  await store.write(meta,state);
  return state;
 }

 private async openPartial(file:string,saved:Partial,complete=false){
  try{
   const stat=await this.checked(file);
   if(identity(stat)!==saved.identity)throw Error('Partial identity changed');
   return await fs.open(file,complete&&stat.size===BigInt(saved.bytes)?'r':'r+');
  }catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT')throw Error('Partial evidence missing');
   throw error;
  }
 }

 private async checkedPartial(handle:fs.FileHandle,file:string,saved:Partial){
  const stat=await handle.stat({bigint:true});
  const named=await this.checked(file);
  if(!stat.isFile()||stat.nlink!==1n||identity(stat)!==saved.identity||!sameFile(stat,named)||
     stat.size<BigInt(saved.bytes)||stat.size>BigInt(PAYLOAD_LIMIT))throw Error('Partial identity/content changed');
  return stat;
 }

 private async prefix(handle:fs.FileHandle,file:string,saved:Partial,signal?:AbortSignal){
  const stat=await this.checkedPartial(handle,file,saved);
  const digest=createHash('sha256');
  const buffer=Buffer.allocUnsafe(Math.min(saved.bytes,prefixReadBytes));
  for(let position=0;position<saved.bytes;){
   cancelled(signal);
   const length=Math.min(buffer.length,saved.bytes-position);
   const {bytesRead}=await handle.read(buffer,0,length,position);
   if(!bytesRead)throw Error('Partial prefix was truncated');
   digest.update(buffer.subarray(0,bytesRead));
   position+=bytesRead;
  }
  if(!sameFile(stat,await this.checkedPartial(handle,file,saved))||
     digest.copy().digest('hex')!==saved.prefixHash)throw Error('Partial authenticated prefix changed');
  return {stat,digest};
 }

 private async download(ref:PackageReference,signal?:AbortSignal){
  const target=path.join(this.grant.payloads,ref.sha256+'.bin');
  const store=await MetadataStore.create(this.grant);
  if(await this.cached(target,ref))return target;
  const binding=createHash('sha256').update(JSON.stringify(ref)).digest('hex');
  const partial=path.join(this.grant.payloads,binding+'.partial');
  const meta='downloads/'+binding+'.json';
  let saved=await this.partialState(store,meta,partial,binding,ref.size);

  if(saved.bytes===ref.size){
   await this.finalizeComplete(partial,target,ref,saved,signal);
   return target;
  }

  const max=Math.floor(Math.min(Math.max(this.options.attempts??3,1),4));
  const started=Date.now();
  let fullRestartAttempt:number|undefined;
  for(let attempt=1;attempt<=max;attempt++){
   cancelled(signal);
   let handle:fs.FileHandle|undefined;
   let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
   try{
    handle=await this.openPartial(partial,saved);
    const prefix=await this.prefix(handle,partial,saved,signal);
    let offset=attempt!==fullRestartAttempt&&saved.etag?saved.bytes:0;
    const response=await this.transport.request('/releases/assets/'+ref.assetId,signal,
     offset?{Range:'bytes='+offset+'-','If-Range':saved.etag!}:{});
    if(response.status!==200&&response.status!==206){
     await response.body?.cancel().catch(()=>{});
     if(response.status===416&&offset>0&&offset<ref.size&&fullRestartAttempt===undefined&&attempt<max&&
        response.headers.get('content-range')==='bytes */'+ref.size){
      fullRestartAttempt=attempt+1;
      continue;
     }
     throw new HttpFailure(response.status);
    }
    if(!response.body)throw Error('Empty package response');
    reader=response.body.getReader();
    const encoding=response.headers.get('content-encoding');
    if(encoding&&encoding!=='identity')throw Error('Encoded package transfer refused');
    const etag=response.headers.get('etag');
    const strong=etag&&strongETag.test(etag)?etag:null;
    if(response.status===206){
     const range='bytes '+offset+'-'+(ref.size-1)+'/'+ref.size;
     if(!offset||strong!==saved.etag||response.headers.get('content-range')!==range)
      throw Error('Invalid Content-Range or changed ETag');
    }else{
     offset=0;
     if(response.headers.has('content-range'))throw Error('Unexpected Content-Range');
    }
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==ref.size-offset))throw Error('Content-Length mismatch');

    if(!sameFile(prefix.stat,await this.checkedPartial(handle,partial,saved)))throw Error('Partial changed during request');
    cancelled(signal);
    const digest=offset?prefix.digest:createHash('sha256');
    const checkpoint={...saved,etag:strong,bytes:offset,prefixHash:digest.copy().digest('hex')};
    await store.write(meta,checkpoint);
    // A user cancellation during the atomic reset can restore the authenticated
    // old state because no partial bytes have been changed yet. An interruption
    // before that restore commits leaves either valid checkpoint.
    const afterReset=signal?.aborted?undefined:await this.checkedPartial(handle,partial,saved);
    if(!offset&&saved.bytes>0&&signal?.aborted)await store.write(meta,saved);
    cancelled(signal);
    if(!afterReset||!sameFile(prefix.stat,afterReset))throw Error('Partial changed during checkpoint');
    saved=checkpoint;
    if(prefix.stat.size!==BigInt(offset))await handle.truncate(offset);
    await handle.sync();

    let bytes=offset;
    for(;;){
     cancelled(signal);
     const chunk=await reader.read();
     if(chunk.done)break;
     if(bytes+chunk.value.length>ref.size)throw Error('Payload exceeds declared size');
     const current=await this.checkedPartial(handle,partial,saved);
     if(current.size!==BigInt(bytes))throw Error('Partial size changed before download write');
     cancelled(signal);
     if(this.options.writeChunk)await this.options.writeChunk(handle,chunk.value);
     else{
      let written=0;
      while(written<chunk.value.length){
       const result=await handle.write(chunk.value,written,chunk.value.length-written,bytes+written);
       if(!result.bytesWritten)throw Error('Short download write');
       written+=result.bytesWritten;
      }
     }
     bytes+=chunk.value.length;
     digest.update(chunk.value);
     await handle.sync();
     const progress={...saved,bytes,prefixHash:digest.copy().digest('hex')};
     await store.write(meta,progress);
     saved=progress;
     await this.options.onProgress?.({asset:ref.assetName,bytes,total:ref.size,bytesPerSecond:Math.round(bytes*1000/Math.max(Date.now()-started,1)),attempt,state:'downloading'});
    }

    await handle.sync();
    await handle.close();
    handle=undefined;
    cancelled(signal);
    if(bytes!==ref.size)throw Error('Interrupted incomplete payload');
    await this.finalize(partial,target,ref,saved,signal);
    await this.options.onProgress?.({asset:ref.assetName,bytes,total:ref.size,bytesPerSecond:Math.round(bytes*1000/Math.max(Date.now()-started,1)),attempt,state:'verified'});
    return target;
   }catch(error){
    await handle?.close();
    handle=undefined;
    if(signal?.aborted)throw Error('Download cancelled; authenticated partial evidence retained');
    const retry=error instanceof HttpFailure?[429,500,502,503,504].includes(error.status):
     error instanceof TypeError||(error as Error)?.name==='TimeoutError'||
     /terminated|fetch failed|incomplete|ECONNRESET/.test(error instanceof Error?error.message:'');
    if(!retry)throw error;
    if(saved.bytes===ref.size){
     // The response may fail after delivering every signed byte. The durable
     // complete checkpoint can be verified without another request.
     await this.finalizeComplete(partial,target,ref,saved,signal);
     return target;
    }
    if(attempt===max)throw error;
    await this.options.onProgress?.({asset:ref.assetName,bytes:saved.bytes,total:ref.size,bytesPerSecond:0,attempt,state:'retrying'});
    await delay(Math.min(2000,(this.options.backoffMs??100)*2**(attempt-1)),undefined,{signal});
   }finally{
    await handle?.close();
    await reader?.cancel().catch(()=>{});
    reader?.releaseLock();
   }
  }
  throw Error('Acquisition attempts exhausted');
 }

 private async finalizeComplete(partial:string,target:string,ref:PackageReference,saved:Partial,signal?:AbortSignal){
  const handle=await this.openPartial(partial,saved,true);
  try{
   const {stat}=await this.prefix(handle,partial,saved,signal);
   cancelled(signal);
   if(stat.size!==BigInt(saved.bytes)){
    await handle.truncate(saved.bytes);
    await handle.sync();
   }
  }finally{await handle.close();}
  cancelled(signal);
  await this.finalize(partial,target,ref,saved,signal);
 }

 private async finalize(partial:string,target:string,ref:PackageReference,saved:Partial,signal?:AbortSignal){
  const before=await this.checked(partial);
  const observed=await hashFile(partial,PAYLOAD_LIMIT);
  if(observed.size!==ref.size||observed.sha256!==ref.sha256)throw Error('Final SHA256 mismatch');
  if(identity(before)!==saved.identity||!sameFile(before,await this.checked(partial)))
   throw Error('Partial substituted before final verification');
  if(await this.cached(target,ref))return;

  const temporary=target+'.verified-'+randomUUID();
  await fs.copyFile(partial,temporary,fs.constants.COPYFILE_EXCL);
  const prepared=await this.checked(temporary);
  const verified=await hashFile(temporary,PAYLOAD_LIMIT);
  if(verified.size!==ref.size||verified.sha256!==ref.sha256)throw Error('Cache preparation verification failed');
  const handle=await fs.open(temporary,'r+');
  try{
   const current=await handle.stat({bigint:true});
   if(!current.isFile()||current.nlink!==1n||!sameFile(prepared,current))throw Error('Cache preparation identity changed');
   await handle.sync();
  }finally{await handle.close();}
  if(!sameFile(prepared,await this.checked(temporary)))throw Error('Cache preparation identity changed');
  // The payload lock covers Launcher writers in this process. Recheck any
  // external entry visible before the rename. A writer racing the rename itself
  // remains outside this process-level guarantee.
  if(await this.cached(target,ref))return;
  cancelled(signal);
  await fs.rename(temporary,target);
  if(!await this.cached(target,ref))throw Error('Final cache missing after promotion');
 }
}
