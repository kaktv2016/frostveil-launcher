import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {checkManagedRoots,isManagedTarget} from '../installer/managed-target';
import {MetadataStore} from '../installer/metadata';
import {relativePath,safeDirectory,safeFile,hashFile,checkExistingAncestors,contained} from '../files';
import type {SandboxGrant} from '../installer/sandbox';
import {assertRuntimeCohort,runtimePath,managedRuntimePath,type RuntimeCohort} from './policy';
import {planCreationIsolation,type Isolation} from './creations';

interface Image {size:number;sha256:string;}
interface Change {path:string;before:Image|null;after:Image|null;kind?:'modpack';intermediate?:Image|null;}
interface Journal {schemaVersion:1;installationId:string;policyHash:string;steamStamp?:string;state:'prepared'|'applying'|'active'|'modpack'|'restoring'|'restored';files:Change[];}
interface Options {freeBytes?:(root:string)=>Promise<number>;checkpoint?:(stage:string)=>Promise<void>;iniDirectories?:readonly string[];steamStamp?:string;}
const journal='runtime-preparation/journal.json',limit=8*1024**3;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const same=(a:Image|null,b:Image|null)=>a===null?b===null:b!==null&&a.size===b.size&&a.sha256===b.sha256;
const hash=/^[a-f0-9]{64}$/;
// Cache only cryptographic observations tied to filesystem identity + both
// nanosecond timestamps. Every access still checks roots/links/file metadata;
// replacements and same-size edits invalidate it. No extra disk ledger writes.
const observations=new Map<string,{stamp:string;image:Image}>();

/** Separate capability from mod-content writes. No executable path comes from IPC. */
export class RuntimeTransaction {
 private managedPaths=new Set<string>();
 private constructor(private grant:SandboxGrant,private policy:Readonly<RuntimeCohort>|null,private store:MetadataStore,private running:()=>Promise<boolean>,private options:Options){}
 static async open(grant:SandboxGrant,policy:Readonly<RuntimeCohort>,running:()=>Promise<boolean>,options:Options={}){
  assertRuntimeCohort(policy,grant.targetClass==='managed-fixture');return this.openStore(grant,policy,running,options);
 }
 static async forRecovery(grant:SandboxGrant,running:()=>Promise<boolean>,options:Options={}){return this.openStore(grant,null,running,options);}
 private static async openStore(grant:SandboxGrant,policy:Readonly<RuntimeCohort>|null,running:()=>Promise<boolean>,options:Options){
  if(!isManagedTarget(grant))throw Error('Managed runtime installation identity required');await checkManagedRoots(grant);
  if(options.steamStamp!==undefined&&!hash.test(options.steamStamp))throw Error('Invalid verified Steam depot stamp');
  const tx=new RuntimeTransaction(grant,policy,await MetadataStore.create(grant),running,options);for(const f of policy?.managedFiles??[])tx.managedPaths.add(f.path);return tx;
 }
 private async guard(){await checkManagedRoots(this.grant);if(await this.running())throw Error('Skyrim/SKSE or Steam update active; runtime writes refused');}
 private target(raw:string){
  const config=raw==='@config/plugins.txt'||raw==='@config/loadorder.txt',rel=config?raw.slice(8):relativePath(raw);
  if(!config&&rel!=='Skyrim.ccc'&&rel!=='SkyrimReservedAddOnIndexes.txt'&&!this.managedPaths.has(rel)&&!/^Data\/cc[A-Za-z0-9_-]+(?: - [A-Za-z0-9 _-]+)?\.(?:esm|esp|esl|bsa)$/i.test(rel))runtimePath(rel);
  const file=path.join(config?this.grant.configDirectory!:this.grant.installation,...rel.split('/'));checkExistingAncestors(file);return file;
 }
 private async image(raw:string):Promise<Image|null>{
  const file=this.target(raw);
  try{const before=await fs.lstat(file,{bigint:true});if(!before.isFile()||before.nlink!==1n)throw Error('Unsafe runtime target');
   const key=this.grant.id+':'+raw,stamp=[before.dev,before.ino,before.size,before.mtimeNs,before.ctimeNs].join(':');const cached=observations.get(key);if(cached?.stamp===stamp)return cached.image;
   const h=await hashFile(file,limit);const after=await fs.lstat(file,{bigint:true});
   if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('Runtime file changed during inspection');if(observations.size>=30000)observations.delete(observations.keys().next().value!);observations.set(key,{stamp,image:h});return h;
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
 }
 private async current():Promise<Journal|null>{
  let j:Journal;try{j=await this.store.read(journal) as Journal;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  if(j.schemaVersion!==1||j.installationId!==this.grant.id||!hash.test(j.policyHash)||j.steamStamp!==undefined&&!hash.test(j.steamStamp)||!['prepared','applying','active','modpack','restoring','restored'].includes(j.state)||!Array.isArray(j.files)||j.files.length>26000)throw Error('Invalid runtime recovery journal');
  const names=new Set<string>();for(const f of j.files){if(f.kind==='modpack'&&!f.path.startsWith('@config/'))this.managedPaths.add(managedRuntimePath(f.path));this.target(f.path);if(names.has(f.path.toLowerCase()))throw Error('Duplicate runtime journal target');names.add(f.path.toLowerCase());for(const v of [f.before,f.after,...(f.intermediate===undefined?[]:[f.intermediate])])if(v!==null&&(!v||!hash.test(v.sha256)||!Number.isSafeInteger(v.size)||v.size<0||v.size>limit))throw Error('Invalid runtime journal image');}
  return j;
 }
 private blob(kind:'runtime-backups'|'runtime-staging',sha256:string){if(!hash.test(sha256))throw Error('Invalid blob identity');return path.join(this.grant.payloads,kind,sha256);}
 private async save(kind:'runtime-backups'|'runtime-staging',source:string,want:Image){
  const file=this.blob(kind,want.sha256);await safeDirectory(path.dirname(file));
  try{const existing=await safeFile(this.grant.payloads,kind+'/'+want.sha256);if(!same(await hashFile(existing,limit),want)||(await fs.stat(existing)).nlink!==1)throw Error('Corrupt runtime content-addressed blob');return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const temp=file+'.'+randomUUID();await fs.copyFile(source,temp,fs.constants.COPYFILE_EXCL);
  try{if(!same(await hashFile(temp,limit),want))throw Error('Runtime payload hash mismatch');const handle=await fs.open(temp,'r+');try{await handle.sync();}finally{await handle.close();}await this.guard();await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 private async replace(change:Change,want:Image|null,expected:Image|null,kind:'runtime-backups'|'runtime-staging'){
  await this.guard();if(!same(await this.image(change.path),expected))throw Error('Runtime preimage conflict: '+change.path);
  const file=this.target(change.path);if(want===null){if(expected!==null)await fs.unlink(file);return;}
  const blob=await safeFile(this.grant.payloads,kind+'/'+want.sha256);if((await fs.stat(blob)).nlink!==1||!same(await hashFile(blob,limit),want))throw Error('Recovery blob integrity failure');
  await safeDirectory(path.dirname(file));const temp=path.join(path.dirname(file),'.frostveil-runtime-'+randomUUID());
  await fs.copyFile(blob,temp,fs.constants.COPYFILE_EXCL);
  try{const handle=await fs.open(temp,'r+');try{await handle.sync();}finally{await handle.close();}
   await this.guard();if(!same(await this.image(change.path),expected))throw Error('Runtime preimage conflict: '+change.path);await fs.rename(temp,file);
  }finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 private async planned(){
  if(!this.policy)throw Error('Signed runtime policy required for preparation');assertRuntimeCohort(this.policy,this.grant.targetClass==='managed-fixture');
  const isolation=await planCreationIsolation(this.grant,this.policy.creations,[...this.policy.files.map(f=>f.path),...this.policy.managedFiles.map(f=>f.path)],this.options.iniDirectories);
  const files:Change[]=[];
  for(const f of this.policy.files){const before=await this.image(f.path),after={size:f.size,sha256:f.sha256};if(!same(before,after))files.push({path:f.path,before,after});}
  for(const f of isolation.writes){const before=await this.image(f.path),after={size:f.bytes.length,sha256:digest(f.bytes)};if(!same(before,after))files.push({path:f.path,before,after});}
  for(const p of isolation.quarantine){const before=await this.image(p);if(before)files.push({path:p,before,after:null});}
  return{files,isolation};
 }
 async history(){const j=await this.current();return{canRestore:!!j&&j.state!=='restored',recoveryRequired:!!j&&!['active','restored'].includes(j.state)};}
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
 async inspect(){await checkManagedRoots(this.grant);const {files}=await this.planned(),j=await this.current();return{changedFiles:files.length,backupBytes:files.reduce((n,f)=>n+(f.before?.size??0),0),downloadBytes:files.filter(f=>!f.path.startsWith('@')&&f.path!=='Skyrim.ccc'&&f.after!==null).reduce((n,f)=>n+(f.after?.size??0),0),stagingBytes:files.reduce((n,f)=>n+(f.after?.size??0),0),canRestore:!!j&&j.state!=='restored',recoveryRequired:!!j&&!['active','restored'].includes(j.state)};}
 async apply(sourceRoot:string,signal?:AbortSignal){
  const release=await this.store.lease();try{
   await this.guard();signal?.throwIfAborted();const previous=await this.current();
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
  const previous=await this.current();if(previous?.state==='modpack')return;
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
  await this.guard();if(!this.policy)throw Error('Signed runtime policy required');const j=await this.current();if(!j||!['modpack','active'].includes(j.state))throw Error('No pending modpack snapshot');
  for(const f of [...this.policy.files,...this.policy.managedFiles])if(!same(await this.image(f.path),{size:f.size,sha256:f.sha256}))throw Error('Modpack incomplete/integrity failure: '+f.path);
  for(const f of j.files)if(!same(await this.image(f.path),f.after))throw Error('Modpack incomplete/integrity failure: '+f.path);
  if(j.state!=='active'){j.state='active';await this.store.write(journal,j);}
 }finally{await release();}}
 private async finish(j:Journal,restore:boolean,signal?:AbortSignal){
  j.state=restore?'restoring':'applying';await this.store.write(journal,j);
  for(const f of restore?[...j.files].reverse():j.files){signal?.throwIfAborted();await this.guard();let expected=restore?f.after:f.before;const want=restore?f.before:f.after,got=await this.image(f.path);if(same(got,want))continue;if(restore&&f.intermediate!==undefined&&same(got,f.intermediate))expected=f.intermediate;if(!same(got,expected))throw Error('Runtime recovery conflict: '+f.path);await this.replace(f,want,expected,restore?'runtime-backups':'runtime-staging');await this.options.checkpoint?.('file-applied');}
  j.state=restore?'restored':'active';await this.store.write(journal,j);
 }
 async recover(){const release=await this.store.lease(true);try{await this.guard();const j=await this.current();if(j&&!['active','restored','modpack'].includes(j.state))await this.finish(j,j.state==='restoring');}finally{await release();}}
 async restore(){const release=await this.store.lease(true);try{await this.guard();const j=await this.current();if(!j||j.state==='restored')return;if(!['active','restoring','modpack'].includes(j.state))throw Error('Recover interrupted preparation before restore');
  // Preflight all files before restoring even the first one.
  for(const f of j.files){const got=await this.image(f.path);if(!same(got,f.after)&&!(['restoring','modpack'].includes(j.state)&&(same(got,f.before)||f.intermediate!==undefined&&same(got,f.intermediate))))throw Error('Runtime restore conflict: '+f.path);}
  await this.finish(j,true);
 }finally{await release();}}
}
