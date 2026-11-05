import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {safeDirectory,safeFile} from '../files';
import {gameRunning,steamRoots,fileVersion} from '../windows';
import {registerRuntimePreparationTarget} from '../installer/managed-target';
import {MetadataStore} from '../installer/metadata';
import {verifySteamSelection,assertSteamIdle} from './steam';
import {authenticateRuntimeCohort,type RuntimeCohort} from './policy';
import {RuntimeTransaction} from './transaction';
import {ensureDepotHelper,acquireDepots} from './depot';
import type {RuntimePreparationState} from '../../shared/runtime-contracts';
const policyUrl='https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/runtime/steam-1170.json';

export class RuntimePreparation {
 private state:RuntimePreparationState={phase:'idle',message:'ตรวจและเตรียม Steam Skyrim 1.6.1170.0 ก่อนเปิดเกม',targetRuntime:'1.6.1170.0',changedFiles:0,downloadBytes:0,backupBytes:0,stagingBytes:0,canRestore:false};
 private listeners=new Set<(state:RuntimePreparationState)=>void>();private operation?:AbortController;
 private prepared?:{game:string;config:string;tx:RuntimeTransaction};
 constructor(private storage:string,private bundledPolicy:string,private iniDirectory?:string){}
 snapshot(){return structuredClone(this.state);}
 subscribe(fn:(s:RuntimePreparationState)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private update(patch:Partial<RuntimePreparationState>){this.state={...this.state,...patch};for(const fn of this.listeners){try{fn(this.snapshot());}catch{/* UI listeners cannot interrupt authenticated recovery. */}}}
 cancel(){this.prepared=undefined;this.operation?.abort(Error('Runtime preparation cancelled'));}
 private async context(game:string,config:string){
  const selection=await verifySteamSelection(game,await steamRoots());await safeDirectory(config);await safeDirectory(this.storage);
  const grant=await registerRuntimePreparationTarget(selection,config,this.storage);
  const steamStamp=await assertSteamIdle(selection);
  const guard=async()=>{if(await assertSteamIdle(selection)!==steamStamp)throw Error('Steam installation changed during preparation; retry after Steam finishes');return gameRunning();};
  const store=await MetadataStore.create(grant);
  // Do not mix the independently authorized 17777 profile with normal play.
  try{const j=await store.read('npc-development/journal.json') as {state?:string};if(j.state!=='reverted')throw Error('Revert the NPC development profile before normal-server runtime preparation');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  try{const settings=await safeFile(game,'Data/Platform/Plugins/skymp5-client-settings.txt'),s=await fs.stat(settings);if(s.size>1024*1024||s.nlink!==1)throw Error('Client settings exceed bound or use a hard link');const text=await fs.readFile(settings,'utf8');if(/17777/.test(text))throw Error('NPC development endpoint 17777 is active; revert the development profile first');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  return{selection,grant,guard,store,steamStamp};
 }
 private async loadPolicy(signal:AbortSignal):Promise<Readonly<RuntimeCohort>>{
  // No unsigned local compatibility-profile or renderer-supplied source is used.
  const response=await fetch(policyUrl,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});let bytes:Buffer;
  if(response.ok&&response.body){const parts:Buffer[]=[];let size=0;for await(const part of response.body){size+=part.length;if(size>4*1024*1024)throw Error('Runtime metadata exceeds bound');parts.push(Buffer.from(part));}bytes=Buffer.concat(parts);}
  else if(response.status===404){bytes=await fs.readFile(await safeFile(path.dirname(this.bundledPolicy),path.basename(this.bundledPolicy)));}
  else throw Error('Signed runtime metadata unavailable (HTTP '+response.status+'); game unchanged');
  return authenticateRuntimeCohort(JSON.parse(bytes.toString('utf8')));
 }
 private async ledger(store:MetadataStore,policy:Readonly<RuntimeCohort>){
  const createdAt=Date.parse(policy.createdAt),sha256=createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  try{const previous=await store.read('runtime-preparation/policy-ledger.json') as {createdAt:number;sha256:string};if(createdAt<previous.createdAt||createdAt===previous.createdAt&&sha256!==previous.sha256)throw Error('Stale/conflicting runtime metadata');if(createdAt===previous.createdAt)return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await store.write('runtime-preparation/policy-ledger.json',{createdAt,sha256});
 }
 async inspect(game:string,config:string){return this.run(async signal=>{
  this.update({phase:'checking',message:'ตรวจเกมและ metadata ที่ลงลายเซ็นแล้ว',authQr:undefined});
  const c=await this.context(game,config);this.update(await (await RuntimeTransaction.forRecovery(c.grant,c.guard)).history());const p=await this.loadPolicy(signal);await this.ledger(c.store,p);
  const tx=await RuntimeTransaction.open(c.grant,p,c.guard,{iniDirectories:this.iniDirectory?[config,this.iniDirectory]:[config],steamStamp:c.steamStamp}),plan=await tx.inspect();
  this.update({...plan,phase:plan.recoveryRequired?'blocked':'ready',message:plan.recoveryRequired?'ต้องกู้การเตรียมเกมที่หยุดกลางทางก่อน Play':'ตรวจแล้ว — แสดงพื้นที่ที่ต้องใช้ก่อนเตรียมเกม'});
 });}
 async prepare(game:string,config:string){return this.run(async signal=>{
  this.prepared=undefined;
  this.update({phase:'checking',message:'ตรวจชุดไฟล์ Skyrim และส่วนเสริม',authQr:undefined});
  const c=await this.context(game,config);if(await c.guard())throw Error('Close Skyrim/SKSE before runtime preparation');
  const recovery=await RuntimeTransaction.forRecovery(c.grant,c.guard);await recovery.recover();
  const p=await this.loadPolicy(signal);await this.ledger(c.store,p);const tx=await RuntimeTransaction.open(c.grant,p,c.guard,{iniDirectories:this.iniDirectory?[config,this.iniDirectory]:[config],steamStamp:c.steamStamp}),plan=await tx.inspect();this.update({...plan});
  if(plan.changedFiles){
   const required=plan.backupBytes+plan.stagingBytes+plan.downloadBytes*2+128*1024**2;
   for(const root of [c.grant.installation,c.grant.payloads,this.storage,c.grant.configDirectory!]){const stat=await fs.statfs(root);if(Number(stat.bavail)*Number(stat.bsize)<required)throw Error('Insufficient disk space for download, staging and original-file backups');}
   const needed=await tx.neededPayloads();
   const digest=createHash('sha256').update(JSON.stringify({depots:p.depots,files:p.files})).digest('hex'),cache=path.join(c.grant.payloads,'steam-depots',digest);await safeDirectory(cache);
   let source=cache;if(needed.length){const helper=await ensureDepotHelper(this.storage,p,signal);source=await acquireDepots(p,helper,cache,signal,(phase,message,authQr)=>this.update({phase,message,authQr}),needed);}
   this.update({phase:'applying',message:'ตรวจครบแล้ว กำลังเตรียม runtime และพักส่วนเสริมที่ไม่ใช้',authQr:undefined});await tx.apply(source,signal);if(needed.length)await tx.clearAcquiredCopies(source,needed);
  }
  if(await fileVersion(await safeFile(game,'SkyrimSE.exe'))!=='1.6.1170.0')throw Error('Final runtime version verification failed; restore is available');
  const final=await tx.inspect();if(final.changedFiles!==0)throw Error('Runtime cohort verification failed after preparation');
  this.update({...final,phase:'ready',message:'Skyrim 1.6.1170.0 และชุดส่วนเสริมผ่านตรวจแล้ว — ติดตั้ง modpack ต่อได้',authQr:undefined});
  signal.throwIfAborted();this.prepared={game,config,tx};
 });}
 async beginModpack(game:string,config:string){const prepared=this.prepared;if(!prepared||prepared.game!==game||prepared.config!==config)throw Error('Prepare the verified runtime before installing modpack');await prepared.tx.beginModpack();if(this.prepared!==prepared)throw Error('Runtime preparation cancelled');this.update({canRestore:true,phase:'staging',message:'สำรองไฟล์ที่ modpack จะเปลี่ยนแล้ว กำลังติดตั้งผ่านระบบลายเซ็นเดิม'});}
 async completeModpack(game:string,config:string){if(!this.prepared||this.prepared.game!==game||this.prepared.config!==config)throw Error('Runtime preparation session changed');await this.prepared.tx.completeModpack();this.update({phase:'ready',message:'runtime / ส่วนเสริม / modpack ผ่านตรวจครบ พร้อมเปิดเกม'});this.prepared=undefined;}
 async restore(game:string,config:string){return this.run(async()=>{this.prepared=undefined;this.update({phase:'restoring',message:'ตรวจ conflict และคืนไฟล์ต้นฉบับก่อน Frostveil',authQr:undefined});const c=await this.context(game,config),tx=await RuntimeTransaction.forRecovery(c.grant,c.guard);await tx.recover();await tx.restore();this.update({phase:'idle',canRestore:false,message:'คืนไฟล์ runtime / ส่วนเสริม / modpack ที่บันทึกในรอบเตรียมนี้แล้ว'});});}
 private async run(operation:(signal:AbortSignal)=>Promise<void>){
  if(this.operation)throw Error('Runtime preparation already running');const controller=new AbortController();this.operation=controller;
  try{await operation(controller.signal);}catch(e){this.update({phase:controller.signal.aborted?'cancelled':'blocked',message:e instanceof Error?e.message:'Runtime preparation failed',authQr:undefined});throw e;}finally{this.operation=undefined;}
 }
}
