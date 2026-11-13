import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkExistingAncestors,contained,noLinks,safeDirectory,safeFile} from '../files';
import {gameRunning,steamRoots,fileVersion} from '../windows';
import {registerRuntimePreparationTarget} from '../installer/managed-target';
import {MetadataStore} from '../installer/metadata';
import type {SandboxGrant} from '../installer/sandbox';
import {verifySteamSelection,assertSteamIdle} from './steam';
import {authenticateRuntimeCohort,type RuntimeCohort} from './policy';
import {RuntimeTransaction,type WholePlayCheckpoint,type WholePlayPlanner} from './transaction';
import {ensureDepotHelper,acquireDepots} from './depot';
import type {RuntimePreparationState,RuntimeRecoveryState} from '../../shared/runtime-contracts';
const policyUrl='https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/runtime/steam-1170.json';
const runtimeJournal='runtime-preparation/journal.json';
const digest=/^[a-f0-9]{64}$/;
const installationId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const selectionsInUse=new Set<string>();
type Selection={game:string;config:string};
type Recovery={recovery:RuntimeRecoveryState;recoveryRequired:boolean;canRestore:boolean;recoveryMessage?:string};
type RuntimeOperation={controller:AbortController;selectionRevision:number;store?:MetadataStore};

function recoveryState(recovery:RuntimeRecoveryState,recoveryRequired=false):Recovery{
 const recoveryMessage={
  checking:'กำลังตรวจข้อมูลการคืนไฟล์ของเกมที่เลือก',
  absent:undefined,
  recoverable:recoveryRequired?'การเตรียมเกมค้างอยู่ ใช้ปุ่มคืนไฟล์ก่อนลอง Play อีกครั้ง':'คืนไฟล์ชุดเดิมของเกมที่เลือกได้',
  foreign:'เลือกโฟลเดอร์เกมเดิมที่เริ่มเตรียมไว้เพื่อคืนไฟล์',
  unsafe:'ตรวจสอบข้อมูลการคืนไฟล์ไม่ได้ เก็บข้อมูลเดิมไว้และติดต่อทีม Frostveil',
 }[recovery];
 return{recovery,recoveryRequired,canRestore:recovery==='recoverable',recoveryMessage};
}

function recoveryFromHistory({canRestore,recoveryRequired}:{canRestore:boolean;recoveryRequired:boolean}){
 return recoveryState(canRestore?'recoverable':'absent',recoveryRequired);
}
function initialRuntimeState(selectionRevision=0,revision=0):RuntimePreparationState{
 return{phase:'idle',message:'ตรวจและเตรียม Steam Skyrim 1.6.1170.0 ก่อนเปิดเกม',targetRuntime:'1.6.1170.0',
  changedFiles:0,downloadBytes:0,backupBytes:0,stagingBytes:0,authQr:undefined,selectionRevision,revision,...recoveryState('absent')};
}

function operationMessage(error:unknown,cancelled:boolean){
 if(cancelled)return 'ยกเลิกการเตรียมเกมแล้ว ตรวจสถานะการคืนไฟล์ก่อนลองอีกครั้ง';
 const message=error instanceof Error?error.message:'';
 if(/game running|close Skyrim|Skyrim\/SKSE or Steam update active|Steam update|Steam installation changed/i.test(message))
  return 'ปิด Skyrim และ SKSE หรือรอให้ Steam อัปเดตเสร็จ แล้วลองอีกครั้ง';
 if(/disk space|free space/i.test(message))return 'พื้นที่ว่างไม่เพียงพอ ตรวจพื้นที่ของเกม โปรไฟล์ และข้อมูลสำรอง แล้วลองอีกครั้ง';
 if(/another whole-Play recovery journal owns/i.test(message))return 'เลือกโฟลเดอร์เกมเดิมที่เริ่มเตรียมไว้เพื่อคืนไฟล์';
 if(/journal before a standalone write|interrupted play|recovery required|restore is available/i.test(message))
  return 'พบข้อมูลการเตรียมเกมที่ต้องกู้คืน ตรวจสถานะและใช้ปุ่มคืนไฟล์ก่อนลองอีกครั้ง';
 if(/conflict|changed after|changed during/i.test(message))return 'พบไฟล์ที่เปลี่ยนไปจากข้อมูลที่ตรวจไว้ เก็บไฟล์เดิมไว้และตรวจสอบก่อนลองอีกครั้ง';
 if(/metadata|fetch|network|http|expired|signature|publisher/i.test(message))
  return 'ตรวจข้อมูลยืนยันชุดเกมไม่ได้ ลองตรวจอีกครั้งเมื่อบริการพร้อม หรือใช้ปุ่มคืนไฟล์หากเปิดใช้งาน';
 return 'ดำเนินการกับเกมที่เลือกไม่ได้ ตรวจโฟลเดอร์เกมและสถานะการคืนไฟล์ก่อนลองอีกครั้ง';
}


function selectionKey(game:string,config:string){
 return createHash('sha256').update(game.toLowerCase()+'\n'+config.toLowerCase()).digest('hex');
}

async function canonicalSelection(game:string,config:string):Promise<Selection>{
 await noLinks(game);
 // A standalone operation can provision an absent profile. Resolve its existing
 // ancestor so aliases cannot evade the shared-profile reservation.
 let ancestor=path.resolve(config);
 const missing:string[]=[];
 checkExistingAncestors(ancestor);
 for(;;){
  try{
   const current=await fs.realpath(ancestor);
   await noLinks(ancestor);
   if(!(await fs.lstat(current)).isDirectory())throw Error('Expected a Skyrim profile directory');
   return{game:await fs.realpath(game),config:path.join(current,...missing)};
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT'||ancestor===path.dirname(ancestor))throw error;
   missing.unshift(path.basename(ancestor));
   ancestor=path.dirname(ancestor);
  }
 }
}

export class RuntimePreparation {
 private state=initialRuntimeState();
 private listeners=new Set<(state:RuntimePreparationState)=>void>();
 private operation?:RuntimeOperation;
 private selection?:Selection;
 private recoveryRead=0;
 private prepared?:{game:string;config:string;tx:RuntimeTransaction};
 constructor(private storage:string,private bundledPolicy:string,private iniDirectory?:string){}
 snapshot(){return structuredClone(this.state);}
 subscribe(fn:(s:RuntimePreparationState)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private update(patch:Partial<RuntimePreparationState>){
  this.state={...this.state,...patch,revision:this.state.revision!+1};
  for(const fn of this.listeners){try{fn(this.snapshot());}catch{/* UI listeners cannot interrupt authenticated recovery. */}}
 }
 private bindSelection(game:string,config:string){
  const next=game?{game:path.resolve(game),config:path.resolve(config)}:undefined;
  if(this.selection?.game.toLowerCase()===next?.game.toLowerCase()&&
     this.selection?.config.toLowerCase()===next?.config.toLowerCase())return;
  this.selection=next;
  this.prepared=undefined;
  ++this.recoveryRead;
  this.update({...initialRuntimeState(this.state.selectionRevision!+1),...recoveryState(next?'checking':'absent')});
 }
 private updateOperation(signal:AbortSignal,patch:Partial<RuntimePreparationState>){
  if(this.operation?.controller.signal===signal&&this.operation.selectionRevision===this.state.selectionRevision)this.update(patch);
 }
 private rememberRecoveryStore(signal:AbortSignal,store:MetadataStore){
  if(this.operation?.controller.signal===signal)this.operation.store=store;
 }
 async refreshRecovery(game:string,config:string):Promise<void>{
  this.bindSelection(game,config);
  const selection=this.selection,revision=this.state.selectionRevision;
  if(!selection||this.operation?.selectionRevision===revision)return;
  const request=++this.recoveryRead;
  const recovery=await this.readRecovery(selection);
  if(this.recoveryRead===request&&this.state.selectionRevision===revision)this.update(recovery);
 }
 cancel(){this.prepared=undefined;this.operation?.controller.abort(Error('Runtime preparation cancelled'));}
 protected async runtimeTarget(game:string,config:string,requireExistingConfig=false){
  if(requireExistingConfig)await this.existingProfile(config);
  const selection=await verifySteamSelection(game,await steamRoots());
  if(!requireExistingConfig)await safeDirectory(config);
  await safeDirectory(this.storage);
  const grant=await registerRuntimePreparationTarget(selection,config,this.storage);
  const steamStamp=await assertSteamIdle(selection);
  const guard=async()=>{if(await assertSteamIdle(selection)!==steamStamp)throw Error('Steam installation changed during preparation; retry after Steam finishes');return gameRunning();};
  return{grant,guard,steamStamp};
 }
 private async existingProfile(config:string){
  try{
   await noLinks(config);
   if(!(await fs.lstat(config)).isDirectory())throw Error('Expected a directory');
  }catch(error){throw Error('Whole-Play recovery requires an existing, unredirected Skyrim profile directory',{cause:error});}
 }
 private async context(game:string,config:string,requireExistingConfig=false){
  if(requireExistingConfig)await this.existingProfile(config);
  const target=await this.runtimeTarget(game,config,requireExistingConfig);
  const store=await MetadataStore.create(target.grant);
  // Do not mix the independently authorized 17777 profile with normal play.
  try{const j=await store.read('npc-development/journal.json') as {state?:string};if(j.state!=='reverted')throw Error('Revert the NPC development profile before normal-server runtime preparation');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  try{const settings=await safeFile(game,'Data/Platform/Plugins/skymp5-client-settings.txt'),s=await fs.stat(settings);if(s.size>1024*1024||s.nlink!==1)throw Error('Client settings exceed bound or use a hard link');const text=await fs.readFile(settings,'utf8');if(/17777/.test(text))throw Error('NPC development endpoint 17777 is active; revert the development profile first');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  return{...target,store};
 }
 protected async loadPolicy(signal:AbortSignal):Promise<Readonly<RuntimeCohort>>{
  // No unsigned local compatibility-profile or renderer-supplied source is used.
  const response=await fetch(policyUrl,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});let bytes:Buffer;
  if(response.ok&&response.body){const parts:Buffer[]=[];let size=0;for await(const part of response.body){size+=part.length;if(size>4*1024*1024)throw Error('Runtime metadata exceeds bound');parts.push(Buffer.from(part));}bytes=Buffer.concat(parts);}
  else if(response.status===404){bytes=await fs.readFile(await safeFile(path.dirname(this.bundledPolicy),path.basename(this.bundledPolicy)));}
  else throw Error('Signed runtime metadata unavailable (HTTP '+response.status+'); game unchanged');
  return authenticateRuntimeCohort(JSON.parse(bytes.toString('utf8')));
 }
 protected async acquire(policy:Readonly<RuntimeCohort>,cache:string,signal:AbortSignal,needed:readonly string[]){
  const helper=await ensureDepotHelper(this.storage,policy,signal);
  return acquireDepots(policy,helper,cache,signal,(phase,message,authQr)=>this.updateOperation(signal,{phase,message,authQr}),needed);
 }
 protected runtimeVersion(file:string){return fileVersion(file);}
 protected async wholePlayCheckpoint(_stage:WholePlayCheckpoint,_path?:string,_writer?:string){}
 private async *relatedRecoveryRecords(selection:Selection){
  let registry:string;
  let registryIdentity:string;
  let entries:Awaited<ReturnType<typeof fs.opendir>>;
  try{
   await noLinks(this.storage);
   registry=path.join(await fs.realpath(this.storage),'managed-installations');
   await noLinks(registry);
   const stat=await fs.lstat(registry,{bigint:true});
   if(!stat.isDirectory())throw Error('Invalid managed installation registry');
   registryIdentity=stat.dev+':'+stat.ino;
   entries=await fs.opendir(registry);
  }
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const checkRegistry=async()=>{
   await noLinks(registry);
   const stat=await fs.lstat(registry,{bigint:true});
   if(!stat.isDirectory()||stat.dev+':'+stat.ino!==registryIdentity)throw Error('Managed installation registry identity changed');
  };
  try{await checkRegistry();}catch(error){await entries.close();throw error;}
  const game=selection.game.toLowerCase(),config=selection.config.toLowerCase();
  let count=0;
  for await(const entry of entries){
   if(++count>256)throw Error('Managed installation registry exceeds the recovery review bound');
   if(!digest.test(entry.name))continue;
   if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('Unsafe managed installation registry entry');
   const directory=path.join(registry,entry.name),metadata=path.join(directory,'metadata');
   let journalFile:string;
   try{journalFile=await safeFile(metadata,runtimeJournal);}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
   const keyFile=await safeFile(metadata,'auth-key'),stat=await fs.lstat(keyFile);
   if(!stat.isFile()||stat.nlink!==1||stat.size!==32)throw Error('Invalid runtime recovery key');
   const key=await fs.readFile(keyFile);
   if(key.length!==32)throw Error('Runtime recovery key changed');
   // Authenticate both records using only the Launcher's registry. Never walk
   // or reattach the other installation just to check profile ownership.
   const grant=await MetadataStore.readAuthenticated(path.join(metadata,'sandbox.json'),key) as SandboxGrant;
   if(!grant||grant.targetClass!=='real-skyrim'||typeof grant.id!=='string'||!installationId.test(grant.id)||
      grant.directory!==directory||grant.metadata!==metadata||grant.payloads!==path.join(directory,'packages')||
      typeof grant.installation!=='string'||path.resolve(grant.installation)!==grant.installation||
      typeof grant.configDirectory!=='string'||path.resolve(grant.configDirectory)!==grant.configDirectory||
      selectionKey(grant.installation,grant.configDirectory)!==entry.name)throw Error('Invalid managed installation identity');
   if(grant.installation.toLowerCase()!==game&&grant.configDirectory.toLowerCase()!==config)continue;
   yield{grant,record:await MetadataStore.readAuthenticated(journalFile,key),
    exact:grant.installation.toLowerCase()===game&&grant.configDirectory.toLowerCase()===config};
  }
  await checkRegistry();
 }
 private async assertSelectionAvailable(selection:Selection,allowExact:boolean){
  for await(const {grant,record:raw,exact} of this.relatedRecoveryRecords(selection)){
   const record=raw as {schemaVersion?:number;state?:string;installationId?:string};
   if(!record||![1,2].includes(record.schemaVersion??0)||record.installationId!==grant.id||
      !['prepared','applying','active','modpack','restoring','restored'].includes(record.state??'')){
    throw Error('Invalid runtime recovery journal identity');
   }
   if(record.schemaVersion!==2||record.state==='restored'||allowExact&&exact)continue;
   if(exact)throw Error('Restore the existing whole-Play recovery journal before a standalone write');
   throw Error('Another whole-Play recovery journal owns this installation or profile. Select its original installation and profile to Restore');
  }
 }
 private async checkRecoveryRoots(grant:SandboxGrant){
  const config=grant.configDirectory!,storage=await fs.realpath(this.storage);
  if([config,storage].some(root=>contained(grant.installation,root)||contained(root,grant.installation))||
     contained(config,storage)||contained(storage,config))throw Error('Recovery roots overlap');
  for(const root of [grant.directory,grant.installation,path.join(grant.installation,'Data'),config,grant.metadata,grant.payloads]){
   await noLinks(root);
   const stat=await fs.lstat(root,{bigint:true});
   if(!stat.isDirectory()||grant.roots?.[root]!==stat.dev+':'+stat.ino||
      (await fs.realpath(root)).toLowerCase()!==root.toLowerCase())throw Error('Recovery root identity changed');
  }
 }
 private async readRecovery(selection:Selection,opened?:MetadataStore):Promise<Recovery>{
  try{
   if(opened){
    let record:unknown;
    try{record=await opened.read(runtimeJournal);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return recoveryState('absent');throw error;}
    const status=RuntimeTransaction.recoveryStatus(opened.grant,record,true);
    return recoveryFromHistory(status);
   }
   const selected=await canonicalSelection(selection.game,selection.config);
   let exact:Recovery|undefined,foreign=false;
   for await(const {grant,record,exact:matches} of this.relatedRecoveryRecords(selected)){
    if(matches)await this.checkRecoveryRoots(grant);
    const status=RuntimeTransaction.recoveryStatus(grant,record,matches);
    if(matches)exact=recoveryFromHistory(status);
    else if(status.schemaVersion===2&&status.canRestore)foreign=true;
   }
   return foreign?recoveryState('foreign'):exact??recoveryState('absent');
  }catch{return recoveryState('unsafe');}
 }
 private async withSelection<T>(game:string,config:string,allowExact:boolean,operation:()=>Promise<T>):Promise<T>{
  const selection=await canonicalSelection(game,config);
  const keys=new Set([selection.game.toLowerCase(),selection.config.toLowerCase()]);
  for(const key of keys)if(selectionsInUse.has(key))throw Error('Another runtime operation owns this installation or profile');
  for(const key of keys)selectionsInUse.add(key);
  try{
   await this.assertSelectionAvailable(selection,allowExact);
   return await operation();
  }finally{for(const key of keys)selectionsInUse.delete(key);}
 }
 async assertStandaloneWriteAllowed(game:string,config:string){
  await this.withStandaloneWrite(game,config,async()=>{});
 }
 async withStandaloneWrite<T>(game:string,config:string,operation:()=>Promise<T>):Promise<T>{
  return this.withSelection(game,config,false,operation);
 }
 async prepareWholePlay(game:string,config:string,planner:WholePlayPlanner){
  return this.run(game,config,true,async signal=>{
   this.prepared=undefined;
   this.updateOperation(signal,{phase:'checking',message:'ตรวจชุด runtime และไฟล์ Play ก่อนเขียนข้อมูลเกม',authQr:undefined});
   const selected=await this.context(game,config,true);
   this.rememberRecoveryStore(signal,selected.store);
   if(await selected.guard())throw Error('Close Skyrim/SKSE before whole-Play preparation');
   this.updateOperation(signal,await this.readRecovery({game,config},selected.store));
   const policy=await this.loadPolicy(signal);
   await this.ledger(selected.store,policy);
   const tx=await RuntimeTransaction.open(selected.grant,policy,selected.guard,{
    iniDirectories:this.iniDirectory?[config,this.iniDirectory]:[config],
    steamStamp:selected.steamStamp,wholePlayStorage:this.storage,
    wholePlayCheckpoint:async(stage,relative,writer)=>{
     if(stage==='after-preimages-commit'){
      this.updateOperation(signal,{...recoveryState('recoverable',true),phase:'applying',message:'สำรองไฟล์ต้นฉบับครบแล้ว กำลังเตรียมไฟล์ Play'});
     }
     await this.wholePlayCheckpoint(stage,relative,writer);
    }
   });
   const acquire=async(needed:readonly string[])=>{
    const files=new Set(needed);
    const neededBytes=policy.files.filter(file=>files.has(file.path)).reduce((total,file)=>total+file.size,0);
    const space=await fs.statfs(selected.grant.payloads);
    if(Number(space.bavail)*Number(space.bsize)<neededBytes*2+128*1024**2){
     throw Error('Insufficient disk space for whole-Play runtime acquisition');
    }
    const id=createHash('sha256').update(JSON.stringify({depots:policy.depots,files:policy.files})).digest('hex');
    const cache=path.join(selected.grant.payloads,'steam-depots',id);
    await safeDirectory(cache);
    return this.acquire(policy,cache,signal,needed);
   };
   const verifyRuntime=async()=>{
    if(await this.runtimeVersion(await safeFile(selected.grant.installation,'SkyrimSE.exe'))!=='1.6.1170.0'){
     throw Error('Final runtime version verification failed; Restore is available');
    }
   };
   await tx.prepareWholePlay(planner,acquire,verifyRuntime,signal);
   this.updateOperation(signal,{phase:'ready',message:'runtime และไฟล์ Play ผ่านการตรวจสอบครบแล้ว',authQr:undefined});
  });
 }
 private async ledger(store:MetadataStore,policy:Readonly<RuntimeCohort>){
  const createdAt=Date.parse(policy.createdAt),sha256=createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  try{const previous=await store.read('runtime-preparation/policy-ledger.json') as {createdAt:number;sha256:string};if(createdAt<previous.createdAt||createdAt===previous.createdAt&&sha256!==previous.sha256)throw Error('Stale/conflicting runtime metadata');if(createdAt===previous.createdAt)return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await store.write('runtime-preparation/policy-ledger.json',{createdAt,sha256});
 }
 async inspect(game:string,config:string){return this.run(game,config,true,async signal=>{
  this.updateOperation(signal,{phase:'checking',message:'ตรวจเกมและ metadata ที่ลงลายเซ็นแล้ว',authQr:undefined});
  const c=await this.context(game,config);
  this.rememberRecoveryStore(signal,c.store);
  this.updateOperation(signal,await this.readRecovery({game,config},c.store));
  const p=await this.loadPolicy(signal);await this.ledger(c.store,p);
  const tx=await RuntimeTransaction.open(c.grant,p,c.guard,{iniDirectories:this.iniDirectory?[config,this.iniDirectory]:[config],steamStamp:c.steamStamp}),plan=await tx.inspect();
  const recovery=await this.readRecovery({game,config},c.store);
  const blocked=recovery.recoveryRequired||recovery.recovery==='unsafe';
  this.updateOperation(signal,{...plan,...recovery,phase:blocked?'blocked':'ready',message:blocked?recovery.recoveryMessage:'ตรวจแล้ว — แสดงพื้นที่ที่ต้องใช้ก่อนเตรียมเกม'});
 });}
 async prepare(game:string,config:string){return this.run(game,config,false,async signal=>{
  this.prepared=undefined;
  this.updateOperation(signal,{phase:'checking',message:'ตรวจชุดไฟล์ Skyrim และส่วนเสริม',authQr:undefined});
  const c=await this.context(game,config);
  this.rememberRecoveryStore(signal,c.store);
  if(await c.guard())throw Error('Close Skyrim/SKSE before runtime preparation');
  const recovery=await RuntimeTransaction.forRecovery(c.grant,c.guard);
  await recovery.assertStandaloneWriteAllowed();
  await recovery.recover();
  const p=await this.loadPolicy(signal);await this.ledger(c.store,p);const tx=await RuntimeTransaction.open(c.grant,p,c.guard,{iniDirectories:this.iniDirectory?[config,this.iniDirectory]:[config],steamStamp:c.steamStamp}),plan=await tx.inspect();this.updateOperation(signal,{...plan,...await this.readRecovery({game,config},c.store)});
  if(plan.changedFiles){
   const required=plan.backupBytes+plan.stagingBytes+plan.downloadBytes*2+128*1024**2;
   for(const root of [c.grant.installation,c.grant.payloads,this.storage,c.grant.configDirectory!]){const stat=await fs.statfs(root);if(Number(stat.bavail)*Number(stat.bsize)<required)throw Error('Insufficient disk space for download, staging and original-file backups');}
   const needed=await tx.neededPayloads();
   const digest=createHash('sha256').update(JSON.stringify({depots:p.depots,files:p.files})).digest('hex'),cache=path.join(c.grant.payloads,'steam-depots',digest);await safeDirectory(cache);
   const source=needed.length?await this.acquire(p,cache,signal,needed):cache;
   this.updateOperation(signal,{phase:'applying',message:'ตรวจครบแล้ว กำลังเตรียม runtime และพักส่วนเสริมที่ไม่ใช้',authQr:undefined});await tx.apply(source,signal);
  }
  if(await this.runtimeVersion(await safeFile(game,'SkyrimSE.exe'))!=='1.6.1170.0')throw Error('Final runtime version verification failed; restore is available');
  const final=await tx.inspect();if(final.changedFiles!==0)throw Error('Runtime cohort verification failed after preparation');
  this.updateOperation(signal,{...final,...await this.readRecovery({game,config},c.store),phase:'ready',message:'Skyrim 1.6.1170.0 และชุดส่วนเสริมผ่านตรวจแล้ว — ติดตั้ง modpack ต่อได้',authQr:undefined});
  signal.throwIfAborted();if(this.operation?.selectionRevision===this.state.selectionRevision)this.prepared={game,config,tx};
 });}
 async beginModpack(game:string,config:string){return this.run(game,config,false,async signal=>{
  const prepared=this.prepared;
  if(!prepared||prepared.game!==game||prepared.config!==config)throw Error('Prepare the verified runtime before installing modpack');
  await prepared.tx.beginModpack();
  if(this.prepared!==prepared)throw Error('Runtime preparation cancelled');
  this.updateOperation(signal,{...recoveryState('recoverable',true),phase:'staging',message:'สำรองไฟล์ที่ modpack จะเปลี่ยนแล้ว กำลังติดตั้งผ่านระบบลายเซ็นเดิม'});
 });}
 async completeModpack(game:string,config:string){return this.run(game,config,false,async signal=>{
  if(!this.prepared||this.prepared.game!==game||this.prepared.config!==config)throw Error('Runtime preparation session changed');
  await this.prepared.tx.completeModpack();
  this.updateOperation(signal,{...recoveryState('recoverable'),phase:'ready',message:'runtime / ส่วนเสริม / modpack ผ่านตรวจครบ พร้อมเปิดเกม'});
  this.prepared=undefined;
 });}
 async restore(game:string,config:string){return this.run(game,config,true,async signal=>{
  this.prepared=undefined;
  this.updateOperation(signal,{phase:'restoring',message:'ตรวจ conflict และคืนไฟล์ต้นฉบับก่อน Frostveil',authQr:undefined});
  const c=await this.context(game,config,true);
  this.rememberRecoveryStore(signal,c.store);
  const tx=await RuntimeTransaction.forRecovery(c.grant,c.guard,{wholePlayCheckpoint:(stage,relative,writer)=>this.wholePlayCheckpoint(stage,relative,writer)});
  await tx.restore();
  this.updateOperation(signal,{phase:'idle',...recoveryState('absent'),message:'คืนไฟล์ runtime / ส่วนเสริม / modpack ที่บันทึกในรอบเตรียมนี้แล้ว'});
 });}
 private async run(game:string,config:string,allowExact:boolean,operation:(signal:AbortSignal)=>Promise<void>){
  if(this.operation)throw Error('Runtime preparation already running');
  if(!game)throw Error('Select your Steam Skyrim installation first');
  this.bindSelection(game,config);
  const selection=this.selection!;
  ++this.recoveryRead;
  const controller=new AbortController(),{signal}=controller;
  const current:RuntimeOperation={controller,selectionRevision:this.state.selectionRevision!};
  this.operation=current;
  try{
   await this.withSelection(game,config,allowExact,()=>{
    signal.throwIfAborted();
    return operation(signal);
   });
   const recovery=await this.readRecovery(selection,current.store);
   signal.throwIfAborted();
   this.updateOperation(signal,{...recovery,authQr:undefined});
  }catch(error){
   const recovery=await this.readRecovery(selection,current.store);
   this.updateOperation(signal,{...recovery,phase:signal.aborted?'cancelled':'blocked',message:operationMessage(error,signal.aborted),authQr:undefined});
   throw error;
  }finally{
   if(this.operation===current)this.operation=undefined;
  }
 }
}
