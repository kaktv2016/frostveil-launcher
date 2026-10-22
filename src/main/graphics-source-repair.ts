import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {relativePath,checkExistingAncestors,safeDirectory,safeFile,hashFile,noLinks,contained} from './files';
import {decodeBsaPayload} from './bsa-payload';
import {durableWrite} from './installer/metadata';
import {downloadGraphicsSource,validateSourceDownload} from './graphics-source-download';
import {playerBootstrapTargets} from './player-bootstrap-targets';
import {navigationRepairTargets} from './navigation-repair-targets';

export interface BsaRecord {offset:number;storedSize:number;compressed:boolean;embeddedName:boolean;bsaVersion:number;}
export interface ArchiveSource {archiveName?:string;archiveSize?:number;archiveSha256?:string;downloadUrl?:string;member?:string;memberSize?:number;memberSha256?:string;installedArchive?:string;bsa?:BsaRecord;contentBase64?:string;}
export interface GraphicsSourcePlan {version:string;files:{path:string;size:number;sha256:string;source:ArchiveSource;previous?:{size:number;sha256:string}[]}[];}
export interface RepairOptions {sourceDirectories:string[];signal?:AbortSignal;progress?:(phase:string,completed?:number,total?:number)=>void;}
type Entry=GraphicsSourcePlan['files'][number];
type Observation={size:number;sha256:string}|null;
interface Journal {game:string;version:string;id:string;files:{path:string;before:Observation;after:{size:number;sha256:string}}[];}
const MAX=256*1024*1024;
const SHADER_TARGETS=new Set(['Data/Shaders/Features/GrassLighting.ini','Data/Shaders/GrassLighting/GrassLighting.hlsli']);
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const equal=(a:Observation,b:Observation)=>a===null?b===null:b!==null&&a.size===b.size&&a.sha256===b.sha256;
async function observe(game:string,relative:string):Promise<Observation>{
 const target=path.join(game,...relativePath(relative).split('/'));checkExistingAncestors(target);
 try{const file=await safeFile(game,relative);if((await fs.lstat(file)).nlink!==1)throw Error('Hard-linked graphics asset refused');return await hashFile(file,MAX);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
function validatePlan(plan:GraphicsSourcePlan){
 if(!plan||typeof plan.version!=='string'||!Array.isArray(plan.files)||plan.files.length>3000)throw Error('Invalid graphics source plan');const names=new Set<string>();
 for(const file of plan.files){relativePath(file.path);if(!playerBootstrapTargets.has(file.path)&&!navigationRepairTargets.has(file.path)&&!SHADER_TARGETS.has(file.path)&&!/^Data\/(meshes\/.*\.nif|textures\/.*\.dds|[^/]+\.ini|SKSE\/Plugins\/(po3_Tweaks\.(dll|ini))|scripts\/po3_Tweaks\.pex|source\/scripts\/po3_Tweaks\.psc)$/i.test(file.path))throw Error('Unsupported graphics repair target');
  if(names.has(file.path.toLowerCase())||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid graphics repair target identity');names.add(file.path.toLowerCase());
  if(file.previous!==undefined&&(!['Data/Platform/Plugins/skymp5-client.js','Data/FrostveilCourierNavigation.esp','Data/Interface/Frostveil/CourierQuestTint.swf'].includes(file.path)||!Array.isArray(file.previous)||file.previous.length>8||file.previous.some(p=>!Number.isSafeInteger(p.size)||p.size<1||p.size>MAX||!/^[a-f0-9]{64}$/.test(p.sha256))))throw Error('Invalid previous recovery identity');
  const s=file.source;
  if(s?.downloadUrl){if(!s.archiveName||s.installedArchive||s.contentBase64!==undefined)throw Error('Invalid source download target');validateSourceDownload(s);}
  if(s?.contentBase64!==undefined){if((file.path!=='Data/SKSE/Plugins/po3_Tweaks.ini'&&!SHADER_TARGETS.has(file.path))||s.archiveName||s.installedArchive||s.contentBase64.length>10000)throw Error('Unexpected inline graphics configuration');continue;}
  if(!s||Boolean(s.installedArchive)===Boolean(s.archiveName))throw Error('Ambiguous graphics source');
  if(s.installedArchive){relativePath(s.installedArchive);if(!/^Data\/[^/]+\.bsa$/i.test(s.installedArchive)||!s.bsa)throw Error('Invalid installed archive');}
  else{relativePath(s.archiveName);if(s.archiveName!.includes('/'))throw Error('Source archive must be a filename');relativePath(s.member);if(s.bsa&&(!s.memberSize||!/^[a-f0-9]{64}$/.test(s.memberSha256??'')))throw Error('Nested BSA identity missing');}
  if(s.bsa&&(!Number.isSafeInteger(s.bsa.offset)||s.bsa.offset<0||!Number.isSafeInteger(s.bsa.storedSize)||s.bsa.storedSize<1||s.bsa.storedSize>MAX))throw Error('Invalid BSA source range');
 }
}
async function extractMember(archive:string,member:string,destination:string,size:number,expected:string){
 relativePath(member);if(!Number.isSafeInteger(size)||size<1||size>2*1024*1024*1024)throw Error('Source member size limit');
 const child=spawn('tar.exe',['-xOf',archive,member],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(-2000);});
 const exit=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('Original archive extraction failed: '+stderr)));});
 let received=0;const limiter=new Transform({transform(chunk,encoding,done){received+=chunk.length;if(received>size)done(Error('Source member exceeds pinned size'));else done(null,chunk);}});
 try{await Promise.all([pipeline(child.stdout,limiter,createWriteStream(destination,{flags:'wx'})),exit]);const actual=await hashFile(destination,size);if(actual.size!==size||actual.sha256!==expected)throw Error('Source member hash mismatch');}catch(error){child.kill();await fs.unlink(destination).catch(()=>{});throw error;}
}

/** Authenticated plan targets only, from verified local archives or pinned R2 downloads. */
export async function repairGraphicsSources(game:string,storage:string,running:()=>Promise<boolean>,plan:GraphicsSourcePlan,options:RepairOptions):Promise<{changed:number;backupDirectory?:string}>{
 validatePlan(plan);await noLinks(game);const base=path.join(storage,'graphics-source-repair');await safeDirectory(base);
 const lockPath=path.join(base,'operation.lock');
 const lockBytes=JSON.stringify({pid:process.pid,token:randomUUID()});
 // Publish a complete lock atomically: process death cannot leave empty JSON.
 const acquireLock=async()=>{const tmp=lockPath+'.'+randomUUID();try{await fs.writeFile(tmp,lockBytes,{flag:'wx'});await fs.link(tmp,lockPath);return await fs.open(lockPath,'r+');}finally{await fs.unlink(tmp).catch(()=>{});}};
 let lock;try{lock=await acquireLock();}catch(e){
  if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
  const previous=await safeFile(base,'operation.lock'),text=await fs.readFile(previous,'utf8');
  if(text.length>1000)throw Error('Invalid graphics repair lock');const owner=JSON.parse(text);
  if(!Number.isInteger(owner.pid)||owner.pid<1)throw Error('Invalid graphics repair lock');
  let alive=true;try{process.kill(owner.pid,0);}catch(err){if((err as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw err;}
  if(alive)throw Error('Graphics source repair already in progress');
  if(await fs.readFile(previous,'utf8')!==text)throw Error('Graphics repair lock changed');await fs.unlink(previous);lock=await acquireLock();
 }
 const active=path.join(base,'active.json');
 const stopped=async()=>{if(await running())throw Error('Skyrim/SKSE is running; close it before graphics repair');};
 const atomic=async(relative:string,data:Buffer,expected:Observation,restoring=false)=>{const target=path.join(game,...relativePath(relative).split('/'));checkExistingAncestors(target);await safeDirectory(path.dirname(target));const tmp=target+'.frostveil-'+randomUUID();try{await fs.writeFile(tmp,data,{flag:'wx'});await stopped();if(!equal(await observe(game,relative),expected))throw Error('Graphics file changed before atomic replacement');checkExistingAncestors(target);if(!restoring)options.signal?.throwIfAborted();await fs.rename(tmp,target);}finally{await fs.unlink(tmp).catch(()=>{});}};
 const rollback=async(journal:Journal)=>{
  const versions=['1.0.7','1.0.8','1.0.9','1.0.10','1.0.11','1.0.12','1.0.13','1.0.14','1.0.15'];
  const compatible=journal.version===plan.version||(versions.indexOf(journal.version)>=0&&versions.indexOf(plan.version)>=versions.indexOf(journal.version));
  if(journal.game!==path.resolve(game)||!compatible||!/^[a-f0-9-]{36}$/.test(journal.id)||!Array.isArray(journal.files))throw Error('Graphics recovery identity mismatch');
  const tx=path.join(base,journal.id),byName=new Map(plan.files.map(f=>[f.path.toLowerCase(),f]));
  for(let i=journal.files.length-1;i>=0;i--){await stopped();const file=journal.files[i]!,expected=byName.get(file.path.toLowerCase());if(!expected||(!equal(expected,file.after)&&!expected.previous?.some(p=>equal(p,file.after))))throw Error('Unexpected graphics recovery target');
   const current=await observe(game,file.path);if(equal(current,file.before))continue;if(!equal(current,file.after))throw Error('Graphics file changed externally; recovery stopped');
   const target=path.join(game,...relativePath(file.path).split('/'));
   if(file.before){const before=await safeFile(tx,'before/'+i);if(!equal(await hashFile(before,MAX),file.before))throw Error('Graphics backup hash mismatch');await atomic(file.path,await fs.readFile(before),file.after,true);}
   else{await stopped();if(!equal(await observe(game,file.path),file.after))throw Error('Graphics file changed during recovery');await fs.unlink(target);}
  }
  await fs.rename(active,path.join(tx,'rolled-back.json'));
 };
 try{
  await stopped();
  try{const pending=JSON.parse(await fs.readFile(await safeFile(base,'active.json'),'utf8')) as Journal;await rollback(pending);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  options.signal?.throwIfAborted();
  const changed:{entry:Entry;before:Observation}[]=[];
  for(let i=0;i<plan.files.length;i++){const entry=plan.files[i]!,before=await observe(game,entry.path);if(!equal(before,entry))changed.push({entry,before});if(i%25===0)options.progress?.('checking',i,plan.files.length);}
  if(!changed.length)return{changed:0};
  const id=randomUUID(),tx=path.join(base,id);await safeDirectory(path.join(tx,'before'));await safeDirectory(path.join(tx,'stage'));
  const archiveCache=new Map<string,string>(),memberCache=new Map<string,string>();
  const sourceArchive=async(source:ArchiveSource)=>{
   const key=source.installedArchive??source.archiveName!;if(archiveCache.has(key))return archiveCache.get(key)!;
   if(source.installedArchive){const p=await safeFile(game,source.installedArchive);if(source.archiveSha256){const actual=await hashFile(p,2*1024*1024*1024);if(actual.sha256!==source.archiveSha256||actual.size!==source.archiveSize)throw Error('Installed BSA source hash mismatch: '+key);}archiveCache.set(key,p);return p;}
   for(const directory of options.sourceDirectories){try{const p=await safeFile(directory,source.archiveName!);const actual=await hashFile(p,2*1024*1024*1024);if(actual.size===source.archiveSize&&actual.sha256===source.archiveSha256){archiveCache.set(key,p);return p;}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
   if(source.downloadUrl){options.progress?.('downloading '+key,0,source.archiveSize);const p=await downloadGraphicsSource(storage,source,running,(done,total)=>options.progress?.('downloading '+key,done,total),options.signal);archiveCache.set(key,p);return p;}
   throw Error('Original mod source archive missing or hash mismatch: '+key+'. Keep the original download in the configured source folder or Downloads.');
  };
  for(let i=0;i<changed.length;i++){
   options.signal?.throwIfAborted();
   const {entry,before}=changed[i]!,s=entry.source;let bytes:Buffer;
   if(s.contentBase64!==undefined)bytes=Buffer.from(s.contentBase64,'base64');
   else{
    let source=await sourceArchive(s);
    if(s.archiveName){const key=s.archiveName+'\0'+s.member;if(!memberCache.has(key)){const dest=path.join(tx,'member-'+memberCache.size);await extractMember(source,s.member!,dest,s.bsa?s.memberSize!:entry.size,s.bsa?s.memberSha256!:entry.sha256);memberCache.set(key,dest);}source=memberCache.get(key)!;}
    if(s.bsa){const fd=await fs.open(source,'r');try{const raw=Buffer.alloc(s.bsa.storedSize);const {bytesRead}=await fd.read(raw,0,raw.length,s.bsa.offset);if(bytesRead!==raw.length)throw Error('BSA source truncated');bytes=decodeBsaPayload(raw,s.bsa,entry.size);}finally{await fd.close();}}
    else bytes=await fs.readFile(source);
   }
   if(bytes.length!==entry.size||sha(bytes)!==entry.sha256)throw Error('Original asset hash mismatch: '+entry.path);
   await fs.writeFile(path.join(tx,'stage',String(i)),bytes,{flag:'wx'});
   if(before){const target=await safeFile(game,entry.path);await fs.copyFile(target,path.join(tx,'before',String(i)));if(!equal(await hashFile(path.join(tx,'before',String(i)),MAX),before))throw Error('Graphics backup changed');}
   options.progress?.('preparing',i+1,changed.length);await stopped();
  }
  options.progress?.('prepared',changed.length,changed.length);await stopped();
  options.signal?.throwIfAborted();
  const journal:Journal={game:path.resolve(game),version:plan.version,id,files:changed.map(({entry,before})=>({path:entry.path,before,after:{size:entry.size,sha256:entry.sha256}}))};
  await durableWrite(active,Buffer.from(JSON.stringify(journal)),true);
  try{
   for(let i=0;i<changed.length;i++){options.signal?.throwIfAborted();await stopped();const {entry,before}=changed[i]!;if(!equal(await observe(game,entry.path),before))throw Error('Graphics target changed during repair');const stage=await safeFile(tx,'stage/'+i);if(!equal(await hashFile(stage,MAX),entry))throw Error('Graphics staging changed');await atomic(entry.path,await fs.readFile(stage),before);options.progress?.('applied',i+1,changed.length);}
   options.signal?.throwIfAborted();
   for(const {entry} of changed){if(!equal(await observe(game,entry.path),entry))throw Error('Installed graphics hash mismatch');}
   await fs.rename(active,path.join(tx,'complete.json'));return{changed:changed.length,backupDirectory:tx};
  }catch(error){if(!await running())await rollback(journal);throw error;}
 }finally{await lock.close();await fs.unlink(lockPath);}
}
