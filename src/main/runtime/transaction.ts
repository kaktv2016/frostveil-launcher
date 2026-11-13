import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {checkManagedRoots,isManagedTarget} from '../installer/managed-target';
import {MetadataStore} from '../installer/metadata';
import {relativePath,safeDirectory,safeFile,hashFile,checkExistingAncestors,contained,noLinks} from '../files';
import {checkRoots,type SandboxGrant} from '../installer/sandbox';
import {assertRuntimeCohort,runtimePath,managedRuntimePath,type RuntimeCohort} from './policy';
import {planCreationIsolation,type Isolation} from './creations';

interface Image {size:number;sha256:string;}
interface ObservedImage extends Image {stamp:string;}
interface Change {
 path:string;before:Image|null;after:Image|null;kind?:'modpack';intermediate?:Image|null;writer?:string;
}
interface DirectoryRecord {path:string;identity:string|null;owned:boolean;}
interface TransientCopy {path:string;name:string;direction:'apply'|'restore';identity:string|null;}
interface WholePlayRecord {cohortId:string;directories:DirectoryRecord[];transient?:TransientCopy;}
interface Journal {
 schemaVersion:1|2;installationId:string;policyHash:string;steamStamp?:string;
 state:'prepared'|'applying'|'active'|'modpack'|'restoring'|'restored';files:Change[];wholePlay?:WholePlayRecord;
}
export interface WholePlayWrite extends Image {
 path:string;source:string;sourceGrant?:SandboxGrant;writer?:string;
}
export interface WholePlayPlanning {
 policy:Readonly<RuntimeCohort>;signal:AbortSignal;
 projectedFile:(relative:string)=>Promise<string|null>;isRuntimeRemoval?:(relative:string)=>boolean;
}
export interface WholePlayPlan {
 cohortId:string;writes:readonly WholePlayWrite[];
 revalidate:()=>Promise<void>;verifyInstalled:()=>Promise<void>;
}
export type WholePlayPlanner=(planning:WholePlayPlanning)=>Promise<WholePlayPlan>;
export type WholePlayCheckpoint='before-preimages-commit'|'after-preimages-commit'|'before-target-write'|'after-target-temp-staged'|'after-target-write'|'before-ready';
interface Options {
 freeBytes?:(root:string)=>Promise<number>;checkpoint?:(stage:string)=>Promise<void>;
 iniDirectories?:readonly string[];steamStamp?:string;wholePlayStorage?:string;
 wholePlayCheckpoint?:(stage:WholePlayCheckpoint,path?:string,writer?:string)=>Promise<void>;
}
interface Intent {
 path:string;after:Image|null;writer:string;source?:string;sourceGrant?:SandboxGrant;managed?:boolean;
}
const journal='runtime-preparation/journal.json',limit=8*1024**3;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const same=(a:Image|null,b:Image|null)=>a===null?b===null:b!==null&&a.size===b.size&&a.sha256===b.sha256;
const hash=/^[a-f0-9]{64}$/;
const writerName=/^[a-z][a-z0-9-]{0,31}$/;
const transientName=/^\.frostveil-runtime-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const filesystemIdentity=/^[0-9]+:[0-9]+$/;
const onlyImage=(image:Image|null):Image|null=>image&&{size:image.size,sha256:image.sha256};
const validImage=(image:Image|null)=>image!==null&&!!image&&typeof image.sha256==='string'&&hash.test(image.sha256)&&Number.isSafeInteger(image.size)&&image.size>=0&&image.size<=limit;
const fileStamp=(stat:{dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint})=>
 [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
// Cache only cryptographic observations tied to filesystem identity + both
// nanosecond timestamps. Every access still checks roots/links/file metadata;
// replacements and same-size edits invalidate it. No extra disk ledger writes.
const observations=new Map<string,{stamp:string;image:Image}>();
function cacheObservation(key:string,stamp:string,image:Image){
 if(observations.size>=30000)observations.delete(observations.keys().next().value!);
 observations.set(key,{stamp,image});
}

function runtimeDestination(grant:SandboxGrant,raw:string){
 const config=raw==='@config/plugins.txt'||raw==='@config/loadorder.txt';
 return{config,root:config?grant.configDirectory!:grant.installation};
}

function runtimeTarget(grant:SandboxGrant,managedPaths:ReadonlySet<string>,raw:string,checkPaths:boolean){
 const {config,root}=runtimeDestination(grant,raw),relative=config?raw.slice(8):relativePath(raw);
 if(!config&&relative!=='Skyrim.ccc'&&relative!=='SkyrimReservedAddOnIndexes.txt'&&!managedPaths.has(relative)&&
    !/^Data\/cc[A-Za-z0-9_-]+(?: - [A-Za-z0-9 _-]+)?\.(?:esm|esp|esl|bsa)$/i.test(relative))runtimePath(relative);
 const file=path.join(root,...relative.split('/'));
 if(checkPaths)checkExistingAncestors(file);
 return file;
}

function recoveryDirectory(grant:SandboxGrant,relative:string,checkPaths:boolean){
 const directory=path.join(grant.installation,...relativePath(relative).split('/'));
 if(checkPaths)checkExistingAncestors(directory);
 return directory;
}

function recoveryAncestors(relative:string){
 if(relative.startsWith('@config/'))return [];
 const parts=relativePath(relative).split('/').slice(0,-1);
 return parts.map((_,index)=>parts.slice(0,index+1).join('/')).filter(folder=>folder.toLowerCase()!=='data');
}

function recoveryTransientTarget(grant:SandboxGrant,managedPaths:ReadonlySet<string>,j:Journal,transient:TransientCopy,checkPaths:boolean){
 const change=j.files.find(file=>file.path===transient.path);
 const image=transient.direction==='apply'?change?.after:change?.before;
 if(!image)throw Error('Transient copy has no authorized journal image');
 const target=runtimeTarget(grant,managedPaths,transient.path,checkPaths),file=path.join(path.dirname(target),transient.name);
 const relative=(transient.path.startsWith('@config/')?'@config/':'')+
  path.relative(runtimeDestination(grant,transient.path).root,file).split(path.sep).join('/');
 if(j.files.some(entry=>entry.path.toLowerCase()===relative.toLowerCase()))throw Error('Transient copy overlaps a planned target');
 return{target,file,relative,image};
}

function validateRuntimeJournal(raw:unknown,grant:SandboxGrant,managedPaths:Set<string>,checkPaths:boolean):Journal{
 const j=raw as Journal;
 if(!j||![1,2].includes(j.schemaVersion)||j.installationId!==grant.id||!hash.test(j.policyHash)||
    j.steamStamp!==undefined&&!hash.test(j.steamStamp)||!['prepared','applying','active','modpack','restoring','restored'].includes(j.state)||
    !Array.isArray(j.files)||j.files.length>26000)throw Error('Invalid runtime recovery journal');
 if(j.schemaVersion===2){
  if(!j.wholePlay||!hash.test(j.wholePlay.cohortId)||!Array.isArray(j.wholePlay.directories)||j.wholePlay.directories.length>26000||
     j.state==='modpack')throw Error('Invalid whole-Play recovery journal');
  const directories=new Set<string>();
  for(const dir of j.wholePlay.directories){
   if(!dir||recoveryDirectory(grant,dir.path,checkPaths)===grant.installation||typeof dir.owned!=='boolean'||
      (dir.identity===null?!dir.owned:!filesystemIdentity.test(dir.identity))||
      directories.has(dir.path.toLowerCase()))throw Error('Invalid whole-Play recovery directory');
   directories.add(dir.path.toLowerCase());
  }
 }else if(j.wholePlay!==undefined)throw Error('Invalid legacy runtime recovery journal');
 const names=new Set<string>();
 for(const f of j.files){
  if(!f||typeof f.path!=='string'||j.schemaVersion===2&&
     (typeof f.writer!=='string'||!writerName.test(f.writer)||f.kind!==undefined&&f.kind!=='modpack')){
   throw Error('Invalid runtime journal target');
  }
  if(f.kind==='modpack'&&!f.path.startsWith('@config/'))managedPaths.add(managedRuntimePath(f.path));
  runtimeTarget(grant,managedPaths,f.path,checkPaths);
  if(names.has(f.path.toLowerCase()))throw Error('Duplicate runtime journal target');
  names.add(f.path.toLowerCase());
  for(const image of [f.before,f.after,...(f.intermediate===undefined?[]:[f.intermediate])]){
   if(image!==null&&!validImage(image))throw Error('Invalid runtime journal image');
  }
 }
 if(j.wholePlay){
  const used=new Set<string>();
  for(const f of j.files){
   for(const parent of recoveryAncestors(f.path))used.add(parent.toLowerCase());
  }
  if(j.wholePlay.directories.some(dir=>!used.has(dir.path.toLowerCase())))throw Error('Unrelated whole-Play recovery directory');
  const transient=j.wholePlay.transient;
  if(transient!==undefined){
   if(!transient||typeof transient.path!=='string'||typeof transient.name!=='string'||!transientName.test(transient.name)||
      transient.identity!==null&&(typeof transient.identity!=='string'||!filesystemIdentity.test(transient.identity))||
      (j.state!=='applying'&&j.state!=='restoring')||
      transient.direction!==(j.state==='restoring'?'restore':'apply'))throw Error('Invalid whole-Play transient copy');
   recoveryTransientTarget(grant,managedPaths,j,transient,checkPaths);
  }
 }
 return j;
}

/** Separate capability from mod-content writes. No executable path comes from IPC. */
export class RuntimeTransaction {
 private managedPaths=new Set<string>();
 private constructor(private grant:SandboxGrant,private policy:Readonly<RuntimeCohort>|null,private store:MetadataStore,private running:()=>Promise<boolean>,private options:Options){}
 static async open(grant:SandboxGrant,policy:Readonly<RuntimeCohort>,running:()=>Promise<boolean>,options:Options={}){
  assertRuntimeCohort(policy,grant.targetClass==='managed-fixture');return this.openStore(grant,policy,running,options);
 }
 static async forRecovery(grant:SandboxGrant,running:()=>Promise<boolean>,options:Options={}){return this.openStore(grant,null,running,options);}
 /** Summarize authenticated metadata without creating a store or acquiring a writer lease. */
 static recoveryStatus(grant:SandboxGrant,record:unknown,checkPaths:boolean){
  const journal=validateRuntimeJournal(record,grant,new Set<string>(),checkPaths);
  const {schemaVersion,state,policyHash,steamStamp,wholePlay}=journal;
  // W08 never emits coerced digests or partial directory inventories. Keep
  // recovery status conservative while leaving Restore's reader unchanged.
  if(typeof policyHash!=='string'||steamStamp!==undefined&&typeof steamStamp!=='string'){
   throw Error('Invalid runtime recovery digest');
  }
  if(wholePlay){
   if(typeof wholePlay.cohortId!=='string'||!journal.files.length)throw Error('Invalid whole-Play recovery inventory');
   const required=new Set(journal.files.flatMap(file=>recoveryAncestors(file.path)).map(directory=>directory.toLowerCase()));
   if(wholePlay.directories.length!==required.size||
      wholePlay.directories.some(directory=>directory.identity!==null&&typeof directory.identity!=='string')){
    throw Error('Invalid whole-Play recovery directory inventory');
   }
  }
  return{schemaVersion,canRestore:state!=='restored',recoveryRequired:state!=='active'&&state!=='restored'};
 }
 private static async openStore(grant:SandboxGrant,policy:Readonly<RuntimeCohort>|null,running:()=>Promise<boolean>,options:Options){
  if(!isManagedTarget(grant))throw Error('Managed runtime installation identity required');await checkManagedRoots(grant);
  if(options.steamStamp!==undefined&&!hash.test(options.steamStamp))throw Error('Invalid verified Steam depot stamp');
  const tx=new RuntimeTransaction(grant,policy,await MetadataStore.create(grant),running,options);for(const f of policy?.managedFiles??[])tx.managedPaths.add(f.path);return tx;
 }
 private async guard(){await checkManagedRoots(this.grant);if(await this.running())throw Error('Skyrim/SKSE or Steam update active; runtime writes refused');}
 private destination(raw:string){return runtimeDestination(this.grant,raw);}
 private target(raw:string){return runtimeTarget(this.grant,this.managedPaths,raw,true);}
 private directoryPath(relative:string){return recoveryDirectory(this.grant,relative,true);}
 private directoryAncestors(relative:string){return recoveryAncestors(relative);}
 private async directoryIdentity(relative:string){
  const directory=this.directoryPath(relative);
  try{
   const stat=await fs.lstat(directory,{bigint:true});
   if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe whole-Play directory: '+relative);
   return stat.dev+':'+stat.ino;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 }
 private async planDirectories(files:readonly Change[],previous:readonly DirectoryRecord[]){
  const records=new Map(previous.map(dir=>[dir.path.toLowerCase(),{...dir}]));
  for(const change of files){
   for(const relative of this.directoryAncestors(change.path)){
    const key=relative.toLowerCase();
    if(records.has(key))continue;
    const identity=await this.directoryIdentity(relative);
    records.set(key,{path:relative,identity,owned:identity===null});
   }
  }
  return [...records.values()].sort((a,b)=>a.path.split('/').length-b.path.split('/').length);
 }
 private async checkDirectory(dir:DirectoryRecord){
  if(await this.directoryIdentity(dir.path)!==dir.identity)throw Error('Whole-Play directory identity conflict: '+dir.path);
 }
 private async ensureDirectories(j:Journal){
  for(const dir of j.wholePlay!.directories){
   await this.guard();
   await this.checkDirectory(dir);
   if(dir.identity!==null)continue;
   const directory=this.directoryPath(dir.path);
   await noLinks(path.dirname(directory));
   await fs.mkdir(directory);
   dir.identity=await this.directoryIdentity(dir.path);
   if(dir.identity===null)throw Error('Whole-Play directory disappeared after creation: '+dir.path);
   await this.store.write(journal,j);
  }
 }
 private async guardParents(directories:ReadonlyMap<string,DirectoryRecord>,relative:string){
  for(const parent of this.directoryAncestors(relative)){
   const dir=directories.get(parent.toLowerCase());
   if(!dir)throw Error('Unrecorded whole-Play directory: '+parent);
   await this.checkDirectory(dir);
  }
  await noLinks(path.dirname(this.target(relative)));
 }
 private async removeOwnedDirectories(j:Journal){
  for(const dir of [...(j.wholePlay?.directories??[])].reverse()){
   if(!dir.owned||dir.identity===null)continue;
   await this.guard();
   if(await this.directoryIdentity(dir.path)!==dir.identity)continue;
   try{await fs.rmdir(this.directoryPath(dir.path));}
   catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }
 }
 private async snapshot(raw:string):Promise<ObservedImage|null>{
  const file=this.target(raw);
  try{
   const before=await fs.lstat(file,{bigint:true});
   if(!before.isFile()||before.nlink!==1n)throw Error('Unsafe runtime target: '+raw);
   const key=this.grant.id+':'+raw.toLowerCase(),stamp=fileStamp(before),cached=observations.get(key);
   if(cached?.stamp===stamp)return {...cached.image,stamp};
   const image=await hashFile(file,limit),after=await fs.lstat(file,{bigint:true});
   if(after.nlink!==1n||fileStamp(after)!==stamp)throw Error('Runtime file changed during inspection: '+raw);
   cacheObservation(key,stamp,image);
   return {...image,stamp};
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 }
 private async image(raw:string):Promise<Image|null>{return onlyImage(await this.snapshot(raw));}
 private async current():Promise<Journal|null>{
  let j:Journal;try{j=await this.store.read(journal) as Journal;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  return validateRuntimeJournal(j,this.grant,this.managedPaths,true);
 }
 private blob(kind:'runtime-backups'|'runtime-staging',sha256:string){if(!hash.test(sha256))throw Error('Invalid blob identity');return path.join(this.grant.payloads,kind,sha256);}
 private async save(kind:'runtime-backups'|'runtime-staging',source:string,want:Image){
  const file=this.blob(kind,want.sha256);await safeDirectory(path.dirname(file));
  try{const existing=await safeFile(this.grant.payloads,kind+'/'+want.sha256);if(!same(await hashFile(existing,limit),want)||(await fs.stat(existing)).nlink!==1)throw Error('Corrupt runtime content-addressed blob');return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const temp=file+'.'+randomUUID();await fs.copyFile(source,temp,fs.constants.COPYFILE_EXCL);
  try{if(!same(await hashFile(temp,limit),want))throw Error('Runtime payload hash mismatch');const handle=await fs.open(temp,'r+');try{await handle.sync();}finally{await handle.close();}await this.guard();await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 private async verifiedBlob(kind:'runtime-backups'|'runtime-staging',image:Image){
  try{
   const blob=await safeFile(this.grant.payloads,kind+'/'+image.sha256);
   const before=await fs.lstat(blob,{bigint:true}),stamp=fileStamp(before),key=this.grant.id+':'+kind+':'+image.sha256;
   if(!before.isFile()||before.nlink!==1n)throw Error('Unsafe recovery file');
   const cached=observations.get(key);
   if(cached?.stamp===stamp&&same(cached.image,image))return blob;
   if(!same(await hashFile(blob,limit),image))throw Error('Unexpected recovery bytes');
   const after=await fs.lstat(blob,{bigint:true});
   if(after.nlink!==1n||stamp!==fileStamp(after))throw Error('Recovery blob changed during verification');
   cacheObservation(key,stamp,image);
   return blob;
  }catch(error){throw Error('Recovery blob integrity failure: '+kind+'/'+image.sha256,{cause:error});}
 }
 private async replace(
  change:Change,want:Image|null,expected:Image|null,kind:'runtime-backups'|'runtime-staging',
  fence?:()=>Promise<void>,wholePlay?:Journal
 ){
  const recheck=async()=>{
   await this.guard();await fence?.();
   if(!same(await this.image(change.path),expected))throw Error('Runtime preimage conflict: '+change.path);
  };
  await recheck();
  const file=this.target(change.path);
  if(want===null){if(expected!==null)await fs.unlink(file);return;}
  const blob=await this.verifiedBlob(kind,want);
  if(!wholePlay)await safeDirectory(path.dirname(file));
  await recheck();
  if(wholePlay){await this.replaceWholePlay(wholePlay,change,blob,want,recheck);return;}
  const temp=path.join(path.dirname(file),'.frostveil-runtime-'+randomUUID());
  await fs.copyFile(blob,temp,fs.constants.COPYFILE_EXCL);
  try{
   if(!same(await hashFile(temp,limit),want))throw Error('Recovery copy integrity failure');
   const handle=await fs.open(temp,'r+');
   try{await handle.sync();}finally{await handle.close();}
   await recheck();
   await fs.rename(temp,file);
  }finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 private transientTarget(j:Journal,transient:TransientCopy){
  return recoveryTransientTarget(this.grant,this.managedPaths,j,transient,true);
 }
 private async replaceWholePlay(j:Journal,change:Change,blob:string,want:Image,recheck:()=>Promise<void>){
  const transient:TransientCopy={
   path:change.path,name:'.frostveil-runtime-'+randomUUID(),direction:j.state==='restoring'?'restore':'apply',identity:null,
  };
  const {target,file}=this.transientTarget(j,transient);
  j.wholePlay!.transient=transient;
  await this.store.write(journal,j);
  await recheck();
  const handle=await fs.open(file,'wx',0o600);
  let stamp:string;
  try{
   const stat=await handle.stat({bigint:true});
   if(!stat.isFile()||stat.nlink!==1n||stat.size!==0n)throw Error('Unsafe reserved whole-Play transient copy');
   transient.identity=stat.dev+':'+stat.ino;
   await this.store.write(journal,j);
   await this.requireTransientStamp(file,fileStamp(stat));
   await recheck();
   const source=await fs.open(blob,'r');
   try{
    const buffer=Buffer.alloc(1024*1024);
    for(let offset=0;offset<want.size;){
     const length=Math.min(buffer.length,want.size-offset);
     const {bytesRead}=await source.read(buffer,0,length,offset);
     if(bytesRead!==length)throw Error('Whole-Play transient source truncated');
     for(let written=0;written<length;){
      const {bytesWritten}=await handle.write(buffer,written,length-written,offset+written);
      if(!bytesWritten)throw Error('Whole-Play transient copy stopped');
      written+=bytesWritten;
     }
     offset+=length;
    }
   }
   finally{await source.close();}
   await handle.sync();
   stamp=fileStamp(await handle.stat({bigint:true}));
  }finally{await handle.close();}
  await this.requireTransientStamp(file,stamp);
  if(!same(await hashFile(file,want.size),want))throw Error('Recovery copy integrity failure');
  await this.options.wholePlayCheckpoint?.('after-target-temp-staged',change.path,change.writer);
  await recheck();
  await this.requireTransientStamp(file,stamp);
  await fs.rename(file,target);
  // If interrupted, the persisted reservation now points to an absent file.
  // The next reservation or terminal state write clears it durably.
  delete j.wholePlay!.transient;
 }
 private async requireTransientStamp(file:string,stamp:string){
  await noLinks(file);
  const stat=await fs.lstat(file,{bigint:true});
  if(!stat.isFile()||stat.nlink!==1n||fileStamp(stat)!==stamp)throw Error('Whole-Play transient copy changed');
 }
 private async preflightTransient(j:Journal){
  const transient=j.wholePlay?.transient;
  if(!transient)return null;
  const {file,relative,image}=this.transientTarget(j,transient);
  let stat:BigIntStats;
  try{stat=await fs.lstat(file,{bigint:true});}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  const stamp=fileStamp(stat);
  await this.requireTransientStamp(file,stamp);
  if(transient.identity===null)throw Error('Unowned whole-Play transient reservation. Retain the file for recovery review: '+transient.name);
  if(stat.dev+':'+stat.ino!==transient.identity||stat.size>BigInt(image.size))throw Error('Whole-Play transient copy identity or size conflicts');
  const source=await this.verifiedBlob(transient.direction==='apply'?'runtime-staging':'runtime-backups',image);
  const before=await fs.lstat(source,{bigint:true});
  const candidate=await fs.open(file,'r');
  try{
   if(fileStamp(await candidate.stat({bigint:true}))!==stamp)throw Error('Whole-Play transient copy changed');
   const expected=await fs.open(source,'r');
   try{
    if(fileStamp(await expected.stat({bigint:true}))!==fileStamp(before))throw Error('Whole-Play transient source changed');
    const actualBytes=Buffer.alloc(64*1024),expectedBytes=Buffer.alloc(actualBytes.length);
    for(let offset=0;offset<Number(stat.size);){
     const length=Math.min(actualBytes.length,Number(stat.size)-offset);
     const a=await candidate.read(actualBytes,0,length,offset),b=await expected.read(expectedBytes,0,length,offset);
     if(a.bytesRead!==length||b.bytesRead!==length||!actualBytes.subarray(0,length).equals(expectedBytes.subarray(0,length)))throw Error('Unexpected whole-Play transient bytes');
     offset+=length;
    }
   }finally{await expected.close();}
  }finally{await candidate.close();}
  await this.requireTransientStamp(source,fileStamp(before));
  await this.requireTransientStamp(file,stamp);
  return{relative,stamp};
 }
 private async clearTransient(j:Journal,observed:Awaited<ReturnType<RuntimeTransaction['preflightTransient']>>){
  if(!j.wholePlay?.transient)return;
  const {path:relative}=j.wholePlay.transient;
  const {file}=this.transientTarget(j,j.wholePlay.transient);
  if(observed){
   const parents=new Map(j.wholePlay.directories.map(dir=>[dir.path.toLowerCase(),dir]));
   await this.guardParents(parents,relative);
   await this.requireTransientStamp(file,observed.stamp);
   await fs.unlink(file);
  }else{
   try{await fs.lstat(file);throw Error('Whole-Play transient appeared after recovery preflight');}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  delete j.wholePlay.transient;
 }
 private async planned(previousWholePlay?:Journal,verifiedTransient?:string){
  if(!this.policy)throw Error('Signed runtime policy required for preparation');assertRuntimeCohort(this.policy,this.grant.targetClass==='managed-fixture');
  const extra=previousWholePlay?.files.filter(f=>f.kind==='modpack'&&!f.path.startsWith('@config/')).map(f=>f.path)??[];
  const approved=[...this.policy.files.map(f=>f.path),...this.policy.managedFiles.map(f=>f.path),...extra];
  if(verifiedTransient&&!verifiedTransient.startsWith('@config/'))approved.push(verifiedTransient);
  const isolation=await planCreationIsolation(this.grant,this.policy.creations,approved,this.options.iniDirectories);
  const files:Change[]=[];
  for(const f of this.policy.files){const before=await this.image(f.path),after={size:f.size,sha256:f.sha256};if(!same(before,after))files.push({path:f.path,before,after});}
  for(const f of isolation.writes){const before=await this.image(f.path),after={size:f.bytes.length,sha256:digest(f.bytes)};if(!same(before,after))files.push({path:f.path,before,after});}
  for(const p of isolation.quarantine){const before=await this.image(p);if(before)files.push({path:p,before,after:null});}
  return{files,isolation};
 }
 async history(){const j=await this.current();return{canRestore:!!j&&j.state!=='restored',recoveryRequired:!!j&&!['active','restored'].includes(j.state)};}
 async assertStandaloneWriteAllowed(){
  const current=await this.current();
  if(current?.schemaVersion===2&&current.state!=='restored'){
   throw Error('Restore the existing whole-Play recovery journal before a standalone write');
  }
 }
 async neededPayloads(){
  if(!this.policy)throw Error('Signed runtime policy required');const needed:string[]=[];
  for(const f of this.policy.files){if(same(await this.image(f.path),{size:f.size,sha256:f.sha256}))continue;
   try{const blob=await safeFile(this.grant.payloads,'runtime-staging/'+f.sha256);if(same(await hashFile(blob,limit),{size:f.size,sha256:f.sha256})&&(await fs.stat(blob)).nlink===1)continue;throw Error('Corrupt staged runtime payload');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;needed.push(f.path);}
  }return needed;
 }
 /** Drop only redundant, verified acquisition copies. Original backups and
  * content-addressed target bytes remain available for recovery/reuse. */
 async clearAcquiredCopies(sourceRoot:string,requested:readonly string[]){
  if(!this.policy)throw Error('Signed runtime policy required');const p=this.policy;
  const key=digest(Buffer.from(JSON.stringify({depots:p.depots,files:p.files}))),expectedRoot=path.join(this.grant.payloads,'steam-depots',key,'cohort');
  if(path.resolve(sourceRoot)!==expectedRoot||!contained(this.grant.payloads,sourceRoot)||new Set(requested).size!==requested.length||requested.some(n=>!p.files.some(f=>f.path===n)))throw Error('Unsafe acquisition cleanup target');
  for(const rel of requested){await this.guard();const f=p.files.find(n=>n.path===rel)!,want={size:f.size,sha256:f.sha256};
   if(!same(await this.image(rel),want))throw Error('Runtime changed before acquisition cleanup');
   const staged=await safeFile(this.grant.payloads,'runtime-staging/'+f.sha256);if(!same(await hashFile(staged,limit),want)||(await fs.stat(staged)).nlink!==1)throw Error('Recovery target missing before acquisition cleanup');
   let file:string;try{file=await safeFile(sourceRoot,rel);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
   if(!same(await hashFile(file,limit),want)||(await fs.stat(file)).nlink!==1)throw Error('Acquisition cache changed; retained for review');await fs.unlink(file);
  }
 }
 async inspect(){
  await checkManagedRoots(this.grant);
  const j=await this.current(),{files}=await this.planned(j?.wholePlay&&j.state!=='restored'?j:undefined);
  return{changedFiles:files.length,backupBytes:files.reduce((n,f)=>n+(f.before?.size??0),0),downloadBytes:files.filter(f=>!f.path.startsWith('@')&&f.path!=='Skyrim.ccc'&&f.after!==null).reduce((n,f)=>n+(f.after?.size??0),0),stagingBytes:files.reduce((n,f)=>n+(f.after?.size??0),0),canRestore:!!j&&j.state!=='restored',recoveryRequired:!!j&&!['active','restored'].includes(j.state)};
 }
 private async stageBytes(bytes:Buffer,after:Image){
  const scratch=path.join(this.grant.payloads,'runtime-profile-'+randomUUID());
  await fs.writeFile(scratch,bytes,{flag:'wx'});
  try{await this.save('runtime-staging',scratch,after);}
  finally{await fs.unlink(scratch);}
  return this.verifiedBlob('runtime-staging',after);
 }
 private async stageRuntimeFile(file:RuntimeCohort['files'][number],sourceRoot?:string){
  const after={size:file.size,sha256:file.sha256};
  const blob=this.blob('runtime-staging',after.sha256);
  try{await fs.lstat(blob);return this.verifiedBlob('runtime-staging',after);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!sourceRoot)throw Error('Missing verified runtime source: '+file.path);
  let source:string;
  try{source=await safeFile(sourceRoot,file.path);}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
   source=await safeFile(sourceRoot,file.depot+'/'+file.path);
  }
  if((await fs.lstat(source)).nlink!==1)throw Error('Hard-linked runtime source: '+file.path);
  await this.save('runtime-staging',source,after);
  return this.verifiedBlob('runtime-staging',after);
 }
 private async runtimeIntents(
  policy:Readonly<RuntimeCohort>,previous:Journal|null,
  capture:(relative:string)=>Promise<ObservedImage|null>,
  acquire:(needed:readonly string[])=>Promise<string>,signal:AbortSignal,verifiedTransient?:string
 ){
  const {files,isolation}=await this.planned(previous?.wholePlay&&previous.state!=='restored'?previous:undefined,verifiedTransient);
  for(const change of files){
   if(!same(await capture(change.path),change.before))throw Error('Runtime preimage changed during planning: '+change.path);
  }
  const intents=new Map<string,Intent>();
  const needed=await this.neededPayloads(),sourceRoot=needed.length?await acquire(needed):undefined;
  for(const file of policy.files){
   signal.throwIfAborted();
   const after={size:file.size,sha256:file.sha256},observed=await capture(file.path);
   const source=same(observed,after)?undefined:await this.stageRuntimeFile(file,sourceRoot);
   intents.set(file.path.toLowerCase(),{path:file.path,after,source,writer:'runtime'});
  }
  for(const change of files){
   if(intents.has(change.path.toLowerCase())||change.path.startsWith('@config/'))continue;
   const write=isolation.writes.find(file=>file.path===change.path);
   const source=write&&change.after?await this.stageBytes(write.bytes,change.after):undefined;
   intents.set(change.path.toLowerCase(),{path:change.path,after:change.after,source,writer:'runtime'});
  }
  for(const [relative,base64] of [
   ['@config/plugins.txt',policy.configuration.pluginsBase64],['@config/loadorder.txt',policy.configuration.loadorderBase64]
  ] as const){
   const bytes=Buffer.from(base64,'base64'),after={size:bytes.length,sha256:digest(bytes)};
   const source=same(await capture(relative),after)?undefined:await this.stageBytes(bytes,after);
   intents.set(relative,{path:relative,after,source,writer:'profile',managed:true});
  }
  return intents;
 }
 private async acceptWholePlayWrite(write:WholePlayWrite,intents:Map<string,Intent>){
  if(!validImage(write)||!path.isAbsolute(write.source)||write.writer!==undefined&&!writerName.test(write.writer)){
   throw Error('Invalid whole-Play writer image');
  }
  const key=write.path.toLowerCase(),previous=intents.get(key);
  const after={size:write.size,sha256:write.sha256};
  if(previous){
   if(!same(previous.after,after))throw Error('Whole-Play after-image conflicts with '+previous.writer+': '+previous.path);
   return;
  }
  const relative=managedRuntimePath(write.path);
  this.managedPaths.add(relative);
  const source=path.resolve(write.source);
  if(write.sourceGrant){
   const grant=write.sourceGrant;
   if(grant.targetClass!==undefined||!contained(grant.payloads,source))throw Error('Whole-Play source outside verified package staging');
   await checkRoots(grant);
  }else if(![this.grant.installation,this.grant.configDirectory!,this.grant.payloads,this.options.wholePlayStorage]
     .some(root=>root!==undefined&&contained(root,source))){
   throw Error('Whole-Play source outside selected installation and Launcher staging');
  }
  await noLinks(source);
  const stat=await fs.lstat(source,{bigint:true});
  if(!stat.isFile()||stat.nlink!==1n||stat.size!==BigInt(after.size))throw Error('Unsafe staged whole-Play writer source');
  intents.set(key,{path:relative,after,source,sourceGrant:write.sourceGrant,writer:write.writer??'managed',managed:true});
 }
 private async checkWholePlaySpace(changes:readonly Change[],needsBackup:readonly Image[]){
  if(!changes.length)return;
  const use=new Map<string,number>();
  const add=(root:string,bytes:number)=>use.set(root,(use.get(root)??0)+bytes);
  for(const change of changes){
   if(!change.after)continue;
   add(this.destination(change.path).root,change.after.size);
   add(this.grant.payloads,change.after.size);
  }
  const originals=new Map(needsBackup.map(image=>[image.sha256,image.size]));
  for(const size of originals.values())add(this.grant.payloads,size);
  const volumes=new Map<string,{bytes:number;roots:string[]}>();
  for(const [root,bytes] of use){
   const device=String((await fs.lstat(root,{bigint:true})).dev);
   const volume=volumes.get(device)??{bytes:64*1024**2,roots:[]};
   volume.bytes+=bytes;volume.roots.push(root);volumes.set(device,volume);
  }
  for(const {bytes,roots} of volumes.values()){
   if(!Number.isSafeInteger(bytes))throw Error('Whole-Play storage requirement exceeds supported bound');
   for(const root of roots){
    const free=this.options.freeBytes?await this.options.freeBytes(root):await fs.statfs(root).then(stat=>Number(stat.bavail)*Number(stat.bsize));
    if(!Number.isSafeInteger(free)||free<bytes)throw Error('Insufficient disk space for whole-Play targets and recovery');
   }
  }
 }
 private async stageWholePlay(
  files:readonly Change[],intents:Map<string,Intent>,active:Map<string,Change>,resuming:boolean
 ){
  const backups=new Map<string,Image>();
  for(const file of files){
   if(file.before)backups.set(file.before.sha256,file.before);
  }
  await this.checkWholePlaySpace(files,[...backups.values()]);
  for(const file of files){
   if(file.after){
    const intent=intents.get(file.path.toLowerCase());
    if(!intent?.source)throw Error('Whole-Play writer did not stage its expected image: '+file.path);
    if(intent.sourceGrant)await checkRoots(intent.sourceGrant);
    await noLinks(intent.source);
    const stat=await fs.lstat(intent.source,{bigint:true});
    if(!stat.isFile()||stat.nlink!==1n)throw Error('Unsafe whole-Play staging source');
    await this.save('runtime-staging',intent.source,file.after);
    const final=await fs.lstat(intent.source,{bigint:true});
    if(final.nlink!==1n||fileStamp(final)!==fileStamp(stat))throw Error('Whole-Play staging source changed: '+file.path);
   }
   if(file.before){
    const prior=active.get(file.path.toLowerCase());
    if(!resuming&&(!prior?.before||same(prior.before,prior.after))){
     await this.save('runtime-backups',this.target(file.path),file.before);
    }
   }
  }
 }
 private async verifyOriginalBlobs(files:readonly Change[]){
  const seen=new Map<string,Image>();
  for(const file of files){
   if(!file.before||same(file.before,file.after))continue;
   const earlier=seen.get(file.before.sha256);
   if(earlier&&!same(earlier,file.before))throw Error('Conflicting whole-Play original blob identity');
   seen.set(file.before.sha256,file.before);
  }
  for(const image of seen.values())await this.verifiedBlob('runtime-backups',image);
 }
 async prepareWholePlay(
  planner:WholePlayPlanner,acquire:(needed:readonly string[])=>Promise<string>,
  verifyRuntime:()=>Promise<void>,signal:AbortSignal
 ){
  if(!this.policy)throw Error('Signed runtime policy required for whole-Play preparation');
  const policy=this.policy;
  const validateRuntime=()=>assertRuntimeCohort(policy,this.grant.targetClass==='managed-fixture');
  const policyHash=digest(Buffer.from(JSON.stringify(policy)));
  const release=await this.store.lease(true);
  try{
   await this.guard();signal.throwIfAborted();validateRuntime();
   const previous=await this.current();
   const pending=previous&&['prepared','applying'].includes(previous.state)?previous:null;
   if(previous&&['modpack','restoring'].includes(previous.state)||pending&&!pending.wholePlay){
    throw Error('Restore the interrupted runtime before Play');
   }
   if(previous&&previous.state!=='restored'&&previous.steamStamp!==undefined&&previous.steamStamp!==this.options.steamStamp){
    throw Error('Steam identity changed; Restore or review the recorded installation before Play');
   }
   if(pending&&pending.policyHash!==policyHash)throw Error('Interrupted Play requires its original signed runtime policy; Restore remains available');
   const transient=pending?await this.preflightTransient(pending):null;
   const active=new Map((previous?.state==='active'?previous.files:[]).map(file=>[file.path.toLowerCase(),file]));
   const observed=new Map<string,{path:string;image:ObservedImage|null}>();
   const capture=async(relative:string)=>{
    const key=relative.toLowerCase(),old=observed.get(key);
    if(old)return old.image;
    const image=await this.snapshot(relative);
    observed.set(key,{path:relative,image});
    return image;
   };
   for(const file of active.values()){
    if(!same(await capture(file.path),file.after))throw Error('Active runtime profile conflict; restore/review external changes first: '+file.path);
   }
   if(pending){
    for(const file of pending.files){
     const got=await capture(file.path),before=file.intermediate===undefined?file.before:file.intermediate;
     if(!same(got,file.after)&&!same(got,before))throw Error('Interrupted Play target conflict: '+file.path);
    }
   }
   const intents=await this.runtimeIntents(policy,previous,capture,acquire,signal,transient?.relative);
   const pendingRemovals=new Set(pending?.files.filter(file=>file.writer==='runtime'&&file.after===null)
    .map(file=>file.path.toLowerCase()));
   const projectedFile=async(relative:string)=>{
    const key=relative.toLowerCase(),known=intents.get(key);
    if(known)return known.after===null?null:known.source??this.target(known.path);
    if(pendingRemovals.has(key)&&observed.get(key)?.image===null)return null;
    const canonical=relative==='Skyrim.ccc'||relative==='SkyrimReservedAddOnIndexes.txt'?relative:managedRuntimePath(relative.replace(/^data\//i,'Data/'));
    if(canonical!=='Skyrim.ccc'&&canonical!=='SkyrimReservedAddOnIndexes.txt')this.managedPaths.add(canonical);
    return await capture(canonical)?this.target(canonical):null;
   };
   const isRuntimeRemoval=(relative:string)=>{
    const key=relative.toLowerCase();
    const intent=intents.get(key);
    return intent?.writer==='runtime'&&intent.after===null||pendingRemovals.has(key);
   };
   const plan=await planner({policy,signal,projectedFile,isRuntimeRemoval});
   if(typeof plan.cohortId!=='string'||!hash.test(plan.cohortId)||!Array.isArray(plan.writes)||plan.writes.length>26000)throw Error('Invalid whole-Play writer plan');
   if(pending?.wholePlay&&pending.wholePlay.cohortId!==plan.cohortId){
    throw Error('Interrupted Play requires the original admitted pack; Restore remains available');
   }
   for(const write of plan.writes){
    signal.throwIfAborted();
    await this.acceptWholePlayWrite(write,intents);
   }
   for(const file of policy.managedFiles){
    const key=file.path.toLowerCase(),known=intents.get(key);
    if(!same(known?known.after:await capture(file.path),file))throw Error('Whole-Play writer conflicts with signed runtime policy: '+file.path);
    if(!known)intents.set(key,{path:file.path,after:onlyImage(file),writer:'managed',managed:true});
   }
   const changes:Change[]=[];
   const pendingByPath=new Map((pending?.files??[]).map(file=>[file.path.toLowerCase(),file]));
   const ordered=[...intents.values()].sort((a,b)=>Number(a.writer==='profile')-Number(b.writer==='profile'));
   for(const intent of ordered){
    const key=intent.path.toLowerCase(),before=await capture(intent.path),prior=active.get(key),interrupted=pendingByPath.get(key);
    if(interrupted&&!same(interrupted.after,intent.after))throw Error('Interrupted Play writer plan changed: '+intent.path);
    if(same(before,intent.after))continue;
    if(pending&&!interrupted)throw Error('Interrupted Play cannot add another target: '+intent.path);
    changes.push(interrupted??{
     path:intent.path,before:prior?prior.before:onlyImage(before),after:intent.after,
     writer:intent.writer,...(intent.managed?{kind:'modpack'} as const:{}),...(prior?{intermediate:onlyImage(before)}:{})
    });
   }
   for(const file of pendingByPath.values()){
    if(!intents.has(file.path.toLowerCase())&&!same(await capture(file.path),file.after)){
     throw Error('Interrupted Play writer did not verify its pending target: '+file.path);
    }
   }
   await this.stageWholePlay(changes,intents,active,!!pending);
   const changed=new Set(changes.map(file=>file.path.toLowerCase()));
   const combined=[
    ...[...active.values()].filter(file=>!changed.has(file.path.toLowerCase()))
     .map(file=>({...file,writer:file.writer??(file.path.startsWith('@config/')?'profile':file.kind==='modpack'?'managed':'runtime')})),
    ...changes
   ];
   if(combined.length>26000)throw Error('Whole-Play recovery inventory exceeds bound');
   const originals=pending?.files??combined;
   const directories=pending?.wholePlay?.directories??await this.planDirectories(combined,previous?.state==='active'?previous.wholePlay?.directories??[]:[]);
   // A later inventory cannot authorize more writes. It only checks the
   // original signed policy and the admitted writer/journal paths for drift.
   const approved=[...policy.files,...policy.managedFiles,...intents.values(),...originals]
    .map(file=>file.path).filter(relative=>!relative.startsWith('@config/'));
   const auditIsolation=async(installed:boolean)=>{
    const permitted=transient&&!installed&&!transient.relative.startsWith('@config/')?[...approved,transient.relative]:approved;
    const isolation=await planCreationIsolation(this.grant,policy.creations,permitted,this.options.iniDirectories);
    const hasPlannedRemoval=(relative:string)=>intents.get(relative.toLowerCase())?.after===null;
    const conflict=isolation.quarantine.find(relative=>installed||!hasPlannedRemoval(relative));
    if(conflict)throw Error('Creation isolation changed during whole-Play preparation: '+conflict);
    if(installed&&isolation.writes.length)throw Error('Whole-Play profile still requires Creation isolation');
   };
   const fence=async()=>{
    signal.throwIfAborted();await this.guard();validateRuntime();
    for(const record of observed.values()){
     if((await this.snapshot(record.path))?.stamp!==record.image?.stamp)throw Error('Whole-Play target or profile changed during preflight: '+record.path);
    }
    for(const dir of directories)await this.checkDirectory(dir);
   };
   const verify=async(j?:Journal)=>{
    await this.options.wholePlayCheckpoint?.('before-ready');
    await this.guard();signal.throwIfAborted();validateRuntime();
    await auditIsolation(true);
    const verified=new Map<string,{path:string;stamp:string|undefined}>();
    for(const {path:relative,after} of [...intents.values(),...(j?.files??[])]){
     const snapshot=await this.snapshot(relative);
     if(!same(snapshot,after))throw Error('Whole-Play final image differs: '+relative);
     verified.set(relative.toLowerCase(),{path:relative,stamp:snapshot?.stamp});
    }
    await verifyRuntime();
    await plan.verifyInstalled();
    await this.guard();signal.throwIfAborted();validateRuntime();
    await auditIsolation(true);
    for(const {path:relative,stamp} of verified.values()){
     if((await this.snapshot(relative))?.stamp!==stamp)throw Error('Whole-Play final image changed during verification: '+relative);
    }
   };
   if(!pending&&!changes.length){
    await plan.revalidate();
    await this.verifyOriginalBlobs(originals);
    await fence();await verify(previous?.state==='active'?previous:undefined);
    return;
   }
   const j:Journal=pending??{
    schemaVersion:2,installationId:this.grant.id,policyHash,state:'prepared',files:combined,
    ...(this.options.steamStamp?{steamStamp:this.options.steamStamp}:{}),wholePlay:{cohortId:plan.cohortId,directories}
   };
   if(!pending){
    await this.options.wholePlayCheckpoint?.('before-preimages-commit');
    await plan.revalidate();
    await this.verifyOriginalBlobs(originals);
    await auditIsolation(false);
    await fence();
    await this.store.write(journal,j);
    await this.options.wholePlayCheckpoint?.('after-preimages-commit');
   }
   await plan.revalidate();
   await this.verifyOriginalBlobs(originals);
   await auditIsolation(false);
   await fence();
   await this.clearTransient(j,transient);
   j.state='applying';await this.store.write(journal,j);
   await this.ensureDirectories(j);
   const parentRecords=new Map(directories.map(dir=>[dir.path.toLowerCase(),dir]));
   for(const change of changes){
    const before=observed.get(change.path.toLowerCase())?.image;
    if(before===undefined)throw Error('Missing whole-Play preimage observation');
    await this.options.wholePlayCheckpoint?.('before-target-write',change.path,change.writer);
    await this.replace(change,change.after,before,'runtime-staging',async()=>{
     signal.throwIfAborted();validateRuntime();await this.guardParents(parentRecords,change.path);
     if((await this.snapshot(change.path))?.stamp!==before?.stamp)throw Error('Whole-Play target identity changed: '+change.path);
    },j);
    await this.options.wholePlayCheckpoint?.('after-target-write',change.path,change.writer);
   }
   await verify(j);
   j.state='active';await this.store.write(journal,j);
  }finally{await release();}
 }
 async apply(sourceRoot:string,signal?:AbortSignal){
  const release=await this.store.lease();try{
   await this.guard();signal?.throwIfAborted();const previous=await this.current();
   if(previous?.schemaVersion===2&&previous.state!=='restored')throw Error('Restore the existing whole-Play recovery journal before a standalone write');
   if(previous&&!['active','restored'].includes(previous.state))throw Error('Runtime recovery required before Play');
   const steamChanged=previous?.state==='active'&&previous.steamStamp!==undefined&&this.options.steamStamp!==undefined&&previous.steamStamp!==this.options.steamStamp;
   const steamOwned=(f:Change)=>f.kind!=='modpack'&&(this.policy!.files.some(n=>n.path===f.path)||f.path==='Skyrim.ccc'||f.path==='SkyrimReservedAddOnIndexes.txt'||f.after===null&&/^Data\/cc[A-Za-z0-9_-]+(?: - [A-Za-z0-9 _-]+)?\.(?:esm|esp|esl|bsa)$/i.test(f.path));
   if(previous?.state==='active')for(const f of previous.files)if(!same(await this.image(f.path),f.after)&&!(steamChanged&&steamOwned(f)))throw Error('Active runtime profile conflict; restore/review external changes first: '+f.path);
   const {files,isolation}=await this.planned();if(!files.length)return;
   const required=files.reduce((n,f)=>n+(f.before?.size??0)+(f.after?.size??0),0)+64*1024**2;
   for(const root of new Set([this.grant.installation,this.grant.payloads,this.grant.configDirectory!])){const free=this.options.freeBytes?await this.options.freeBytes(root):Number((await fs.statfs(root)).bavail)*Number((await fs.statfs(root)).bsize);if(free<required)throw Error('Insufficient disk space for staged runtime and rollback');}
   // Acquire/verify the complete changed cohort before saving a journal or touching game bytes.
   for(const f of files){signal?.throwIfAborted();if(f.after){const config=isolation.writes.find(w=>w.path===f.path);if(config){const temp=path.join(this.grant.payloads,'config-'+randomUUID());await fs.writeFile(temp,config.bytes,{flag:'wx'});try{await this.save('runtime-staging',temp,f.after);}finally{await fs.unlink(temp);}}else {
    let source:string;try{source=await safeFile(this.grant.payloads,'runtime-staging/'+f.after.sha256);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
     try{source=await safeFile(sourceRoot,f.path);}catch(inner){if((inner as NodeJS.ErrnoException).code!=='ENOENT')throw inner;const depot=this.policy!.files.find(n=>n.path===f.path)!.depot;source=await safeFile(sourceRoot,depot+'/'+f.path);}
    }await this.save('runtime-staging',source,f.after);
   }}if(f.before)await this.save('runtime-backups',this.target(f.path),f.before);}
   await this.guard();for(const f of files)if(!same(await this.image(f.path),f.before))throw Error('Runtime preimage changed during staging');signal?.throwIfAborted();
   let combined=previous?.state==='active'?[...previous.files.filter(old=>!files.some(f=>f.path===old.path)),...files.map(f=>{const old=previous.files.find(old=>old.path===f.path);return{...f,before:old?old.before:f.before};})]:files;
   if(steamChanged){
    // A complete, verified Steam update can replace vanilla files while RP is
    // inactive. Keep prior generations; don't silently reinterpret mod edits.
    for(const f of previous!.files)if(f.before&&!same(f.before,f.after)){const blob=await safeFile(this.grant.payloads,'runtime-backups/'+f.before.sha256);if(!same(await hashFile(blob,limit),f.before)||(await fs.stat(blob)).nlink!==1)throw Error('Previous runtime generation backup integrity failure');}
    const history=path.join(this.grant.metadata,'runtime-preparation/history');await safeDirectory(history);const entries=await fs.readdir(history);if(entries.length>=8)throw Error('Runtime generation history limit reached; preserve/archive history before another Steam normalization');
    await this.store.write('runtime-preparation/history/'+randomUUID()+'.json',previous);
    const beforeUpdate:Change[]=[];for(const f of this.policy!.files)beforeUpdate.push({path:f.path,before:files.find(n=>n.path===f.path)?.before??await this.image(f.path),after:{size:f.size,sha256:f.sha256}});
    combined=[...combined.filter(f=>!this.policy!.files.some(n=>n.path===f.path)&&!files.some(n=>n.path===f.path&&steamOwned(n))),...beforeUpdate,...files.filter(f=>!this.policy!.files.some(n=>n.path===f.path)&&steamOwned(f))];
   }
   const j:Journal={schemaVersion:1,installationId:this.grant.id,policyHash:digest(Buffer.from(JSON.stringify(this.policy))),...(this.options.steamStamp?{steamStamp:this.options.steamStamp}:{}),state:'prepared',files:combined};
   await this.store.write(journal,j);await this.options.checkpoint?.('prepared');await this.finish(j,false,signal);
  }finally{await release();}
 }
 /** Snapshot approved modpack changes before the existing signed installers run.
  * Expected after-images come from the signed cohort, never an arbitrary scan.
  * This method does not install mod payloads or replace their trust checks. */
 async beginModpack(){const release=await this.store.lease();try{
  await this.guard();if(!this.policy)throw Error('Signed runtime policy required');assertRuntimeCohort(this.policy,this.grant.targetClass==='managed-fixture');
  const previous=await this.current();
  if(previous?.schemaVersion===2&&previous.state!=='restored')throw Error('Restore the existing whole-Play recovery journal before a standalone write');
  if(previous?.state==='modpack')return;
  if(previous&&!['active','restored'].includes(previous.state))throw Error('Runtime recovery required');
  const initial=previous?.state==='active'?previous.files:[];
  const updates:Change[]=[],actual=new Map<string,Image|null>();
  const configs=[{path:'@config/plugins.txt',bytes:Buffer.from(this.policy.configuration.pluginsBase64,'base64')},{path:'@config/loadorder.txt',bytes:Buffer.from(this.policy.configuration.loadorderBase64,'base64')}];
  const expected=[...this.policy.managedFiles,...configs.map(f=>({path:f.path,size:f.bytes.length,sha256:digest(f.bytes)}))];
  for(const f of expected){const got=await this.image(f.path),after={size:f.size,sha256:f.sha256};if(same(got,after))continue;
   const old=initial.find(n=>n.path===f.path);actual.set(f.path,got);updates.push({path:f.path,before:old?old.before:got,after,kind:'modpack',intermediate:got});
  }
  const required=updates.reduce((n,f)=>n+(actual.get(f.path)?.size??0),0)+64*1024**2;
  const free=this.options.freeBytes?await this.options.freeBytes(this.grant.payloads):Number((await fs.statfs(this.grant.payloads)).bavail)*Number((await fs.statfs(this.grant.payloads)).bsize);if(free<required)throw Error('Insufficient disk space for modpack rollback snapshot');
  for(const f of updates){const before=actual.get(f.path)!;if(before)await this.save('runtime-backups',this.target(f.path),before);}
  for(const c of configs){const f=updates.find(n=>n.path===c.path);if(f?.after){const temp=path.join(this.grant.payloads,'config-'+randomUUID());await fs.writeFile(temp,c.bytes,{flag:'wx'});try{await this.save('runtime-staging',temp,f.after);}finally{await fs.unlink(temp);}}}
  for(const f of updates)if(!same(await this.image(f.path),actual.get(f.path)!))throw Error('Modpack snapshot preimage conflict');
  if(!updates.length&&previous?.state==='active')return;
  const j:Journal={schemaVersion:1,installationId:this.grant.id,policyHash:digest(Buffer.from(JSON.stringify(this.policy))),...(this.options.steamStamp?{steamStamp:this.options.steamStamp}:{}),state:'modpack',files:[...initial.filter(f=>!updates.some(n=>n.path===f.path)),...updates]};
  await this.store.write(journal,j);
  for(const c of configs){const f=updates.find(n=>n.path===c.path);if(f)await this.replace(f,f.after,actual.get(f.path)!,'runtime-staging');}
 }finally{await release();}}
 async completeModpack(){const release=await this.store.lease();try{
  await this.guard();if(!this.policy)throw Error('Signed runtime policy required');const j=await this.current();if(!j||j.schemaVersion!==1||!['modpack','active'].includes(j.state))throw Error('No pending modpack snapshot');
  for(const f of [...this.policy.files,...this.policy.managedFiles])if(!same(await this.image(f.path),{size:f.size,sha256:f.sha256}))throw Error('Modpack incomplete/integrity failure: '+f.path);
  for(const f of j.files)if(!same(await this.image(f.path),f.after))throw Error('Modpack incomplete/integrity failure: '+f.path);
  if(j.state!=='active'){j.state='active';await this.store.write(journal,j);}
 }finally{await release();}}
 private async checkRestoreSpace(files:Change[]){
  // Replacements use one temporary sibling at a time. Use current free bytes
  // without assuming any space will be freed by a later deletion or rename.
  const requiredByRoot=new Map<string,number>();
  for(const f of files){
   if(!f.before||same(await this.image(f.path),f.before))continue;
   const {root}=this.destination(f.path);
   requiredByRoot.set(root,Math.max(requiredByRoot.get(root)??0,f.before.size));
  }
  for(const [root,required] of requiredByRoot){
   const destination=root===this.grant.installation?'installation':'configuration';
   const unavailable='Unable to determine free disk space for runtime restore at '+destination+' root';
   let free:number;
   try{
    if(this.options.freeBytes)free=await this.options.freeBytes(root);
    else{
     const stat=await fs.statfs(root);
     free=Number(stat.bavail)*Number(stat.bsize);
    }
   }catch(error){throw Error(unavailable,{cause:error});}
   if(!Number.isSafeInteger(free)||free<0)throw Error(unavailable);
   if(free<required)throw Error('Insufficient disk space for runtime restore at '+destination+' root');
  }
 }
 private async preflightRestore(j:Journal,parents:ReadonlyMap<string,DirectoryRecord>){
  const backups=new Map<string,Image>(),targets=new Map<string,ObservedImage|null>();
  const observed=new Map<string,ObservedImage|null>();
  for(const change of j.files){
   const got=await this.snapshot(change.path);
   observed.set(change.path,got);
   const atPreimage=same(got,change.before);
   const atIntermediate=change.intermediate!==undefined&&same(got,change.intermediate);
   if(!same(got,change.after)&&!(j.state!=='active'&&(atPreimage||atIntermediate))){
    throw Error('Runtime restore conflict: '+change.path);
   }
   if(atPreimage)continue;
   if(j.wholePlay)await this.guardParents(parents,change.path);
   targets.set(change.path,got);
   if(change.before){
    const existing=backups.get(change.before.sha256);
    if(existing&&!same(existing,change.before))throw Error('Conflicting recovery blob identity');
    backups.set(change.before.sha256,change.before);
   }
  }
  await this.checkRestoreSpace(j.files);
  for(const image of backups.values())await this.verifiedBlob('runtime-backups',image);
  await this.guard();
  for(const [relative,snapshot] of observed){
   if(j.wholePlay&&targets.has(relative))await this.guardParents(parents,relative);
   if((await this.snapshot(relative))?.stamp!==snapshot?.stamp)throw Error('Runtime restore conflict: '+relative);
  }
  return targets;
 }
 private async restoreFiles(j:Journal){
  const parents=new Map(j.wholePlay?.directories.map(dir=>[dir.path.toLowerCase(),dir])??[]);
  const transient=await this.preflightTransient(j);
  const targets=await this.preflightRestore(j,parents);
  await this.clearTransient(j,transient);
  j.state='restoring';
  await this.store.write(journal,j);
  for(const change of [...j.files].reverse()){
   const expected=targets.get(change.path);
   if(expected===undefined)continue;
   await this.replace(change,change.before,expected,'runtime-backups',async()=>{
    if(j.wholePlay)await this.guardParents(parents,change.path);
    if((await this.snapshot(change.path))?.stamp!==expected?.stamp)throw Error('Runtime restore conflict: '+change.path);
   },j.wholePlay?j:undefined);
   await this.options.checkpoint?.('file-applied');
  }
  await this.removeOwnedDirectories(j);
  await this.guard();
  for(const change of j.files){
   if(!same(await this.image(change.path),change.before))throw Error('Runtime restore conflict: '+change.path);
  }
  j.state='restored';
  await this.store.write(journal,j);
 }
 private async finish(j:Journal,restore:boolean,signal?:AbortSignal){
  if(restore){await this.restoreFiles(j);return;}
  j.state='applying';await this.store.write(journal,j);
  for(const change of j.files){
   signal?.throwIfAborted();await this.guard();
   const got=await this.image(change.path);
   if(same(got,change.after))continue;
   if(!same(got,change.before))throw Error('Runtime recovery conflict: '+change.path);
   await this.replace(change,change.after,change.before,'runtime-staging');
   await this.options.checkpoint?.('file-applied');
  }
  j.state='active';await this.store.write(journal,j);
 }
 async recover(){
  const release=await this.store.lease(true);
  try{
   await this.guard();
   const j=await this.current();
   if(!j||['active','restored','modpack'].includes(j.state))return;
   if(j.wholePlay&&j.state!=='restoring')throw Error('Resume interrupted Play with pinned authority or Restore it offline');
   await this.finish(j,j.state==='restoring');
  }finally{await release();}
 }
 async restore(){
  const release=await this.store.lease(true);
  try{
   await this.guard();
   const j=await this.current();
   if(j&&j.state!=='restored')await this.finish(j,true);
  }finally{await release();}
 }
}
