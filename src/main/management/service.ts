import fs from 'node:fs/promises';
import path from 'node:path';
import {lt} from 'semver';
import {contained,safeFile,safeDirectory,noLinks} from '../files';
import {fileVersion,gameRunning} from '../windows';
import {scanInstallation} from '../installation';
import {GitHubDistributionProvider} from '../distribution/github';
import {PackageDownloader} from '../distribution/download';
import {authenticateRelease,productionSource,VersionLedger,type AuthenticatedRelease,type DistributionSource} from '../distribution/policy';
import {MetadataStore,durableWrite} from '../installer/metadata';
import {SandboxInstaller,type InstallerOptions} from '../installer/engine';
import {adoptRealTarget,registerRealTarget,withManagedWrite} from '../installer/managed-target';
import {checkRoots,observe,sameObservation,type SandboxGrant} from '../installer/sandbox';
import {readPluginHeader} from '../modpack/plugins';
import {cancelled} from '../modpack/scanner';
import {inspectManagedInstallation,type ManagedPreflight} from './preflight';
import {planActivation,type ActivationHeader} from './activation';
import {installPreflightIssue,finalPlanPreflightIssue,restorationPreflightIssue} from './eligibility';
import type {PackageReference} from '../../shared/modpack-contracts';
import {prepareManagementPlan} from './planner';
import {freezePlan,planDigest,PlanAuthorizer} from './authorization';
import type {ManagedPlan,ManagementIntent,ManagementState,ManagedAction} from '../../shared/management-contracts';
import type {InstallJournal,OwnershipReceipt} from '../../shared/installer-contracts';
import type {Scan,Profile} from '../../shared/contracts';

interface Context {directory:string;orderDirectory:string;runtime:Scan|null;channel:'stable'|'beta';iniDirectory?:string;}
interface Prepared {plan:ManagedPlan;bundle:AuthenticatedRelease;grant:SandboxGrant;downloader:PackageDownloader;}
const terminal=new Set(['committed','rolled-back','failed']);
const transactionStates=new Set(['planned','acquiring','staged','verified','backup-complete','applying','verifying-installed','committed','rollback-required','rolling-back','rolled-back','recovery-required','failed']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DEFAULT_SCOPE_NOTICE='Managed Modpack writes apply only to approved Data/* paths and plugins.txt/loadorder.txt; official Bethesda files, SKSE/SkyMP binaries, saves, and unrelated third-party mods are never overwritten.';
function configuredSource(source:DistributionSource){return source.mode==='production'&&Object.values(source.keys).some(k=>k.environment==='production'&&!k.revoked&&typeof k.expiresAt==='string'&&Number.isFinite(Date.parse(k.expiresAt))&&Date.parse(k.expiresAt)>Date.now());}
function withoutClock(plan:ManagedPlan){const {createdAt:_created,expiresAt:_expires,...bound}=plan;return bound;}
async function sameSelection(a:Context,g:SandboxGrant){
 await noLinks(a.directory);await noLinks(a.orderDirectory);
 return (await fs.realpath(a.directory)).toLowerCase()===g.installation.toLowerCase()&&(await fs.realpath(a.orderDirectory)).toLowerCase()===g.configDirectory!.toLowerCase();
}
function message(error:unknown){const code=(error as NodeJS.ErrnoException)?.code;if(code&&/^[A-Z0-9_]+$/.test(code))return'Modpack operation failed: '+code;return error instanceof Error&&error.message.length<300?error.message:'Modpack operation failed; retained evidence requires review';}

/** Main owns the selected installation and native confirmation. No renderer target, source or key is accepted. */
export class ManagementService {
 private state:ManagementState;
 private listeners=new Set<(state:ManagementState)=>void>();
 private controller?:AbortController;
 private revision=0;
 private disposed=false;
 private prepared?:Prepared;
 private grant?:SandboxGrant;
 private initialized=false;
 private readonly authorizer:PlanAuthorizer;
 constructor(
  private readonly storage:string,
  private readonly launcherVersion:string,
  private readonly getContext:()=>Context,
  confirm:(plan:unknown,hash:string)=>Promise<boolean>,
  private readonly versionReader=fileVersion,
  private readonly source:DistributionSource=productionSource,
  private readonly providerFactory:()=>GitHubDistributionProvider=()=>new GitHubDistributionProvider(),
  private readonly stageDownload?:(grant:SandboxGrant,reference:PackageReference,signal?:AbortSignal)=>Promise<string>
 ){
  this.authorizer=new PlanAuthorizer(confirm);
  this.state={
   phase:'idle',
   status:this.configured()?'READY':'PRODUCTION NOT CONFIGURED',
   message:'Inspect Skyrim read-only; production modpack installation requires an approved publisher and release.',
   runtime:'UNVERIFIED',
   skse:'UNVERIFIED',
   skyMP:'UNVERIFIED',
   publisher:this.configured()?'APPROVED PRODUCTION PUBLISHER':'PRODUCTION NOT CONFIGURED',
   server:'UNVERIFIED',
   live:'UNVERIFIED',
   plugins:'UNVERIFIED',
   productionConfigured:this.configured(),
   realWriteAuthorized:false,
   backups:[],
   progress:{stage:'idle',completed:0,total:0,bytes:0},
   recovery:'not-needed',
   conflicts:[],
   checks:[],
   fileScanResult:'UNVERIFIED',
   warnings:[],
   scopeNotice:DEFAULT_SCOPE_NOTICE
  };
 }
 private configured(){return configuredSource(this.source);}
 snapshot():ManagementState{return structuredClone(this.state);}
 subscribe(listener:(state:ManagementState)=>void){this.active();this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private update(change:Partial<ManagementState>){if(this.disposed)return;this.state={...this.state,...change};for(const listener of this.listeners){try{listener(this.snapshot());}catch{/* A renderer subscriber cannot change transaction behavior. */}}}
 private active(){if(this.disposed)throw Error('Modpack management service disposed');}
 private idle(){this.active();if(this.controller)throw Error('A modpack operation is already running');}
 private start(){this.idle();const controller=new AbortController(),revision=++this.revision;this.controller=controller;return{controller,revision};}
 private current(revision:number){return!this.disposed&&this.revision===revision;}
 private finish(controller:AbortController){if(this.controller===controller)this.controller=undefined;}
 private clearPlan(){this.prepared=undefined;this.update({plan:undefined,planHash:undefined,realWriteAuthorized:false});}
 dispose(){if(this.disposed)return;this.controller?.abort();this.revision++;this.prepared=undefined;this.listeners.clear();this.disposed=true;}
 cancel(){this.active();this.controller?.abort();this.revision++;this.clearPlan();this.update({phase:'cancelled',status:'CANCELLED',message:this.state.transaction?'Cancellation requested; the transaction must finish rollback or report recovery.':'Modpack operation cancelled; no plan remains authorized.',recovery:this.state.transaction&&!terminal.has(this.state.transaction)?'transaction outcome pending':this.state.recovery});}
 private productionBlocked(){this.clearPlan();this.update({phase:'blocked',status:'PRODUCTION NOT CONFIGURED',message:'No approved production publisher identity and real modpack release are configured. The test publisher and Level B release cannot authorize Skyrim writes.',publisher:'PRODUCTION NOT CONFIGURED',productionConfigured:false});return this.snapshot();}
 private async context(fresh=false):Promise<Context>{
  const context=this.getContext();
  if(!context||typeof context.directory!=='string'||!context.directory||!path.isAbsolute(context.directory)||typeof context.orderDirectory!=='string'||!path.isAbsolute(context.orderDirectory)||!['stable','beta'].includes(context.channel))throw Error('A trusted L1 Skyrim selection and native activation profile are required');
  if(!fresh||!context.runtime?.ready)return context;
  const previous=context.runtime,skseDll=previous.files.find(f=>/^skse64_\d+_\d+_\d+\.dll$/i.test(f.path))?.path;
  if(!skseDll)throw Error('Trusted L1 SKSE baseline is incomplete');
  const profile:Profile={id:'management-current-l1-baseline',runtime:previous.runtime,skseVersion:previous.skseLoader,skseDll,evidence:'Previously selected L1 baseline, freshly rechecked',files:previous.files.map(({status:_status,...entry})=>entry),backupFiles:[]};
  return{...context,runtime:await scanInstallation(context.directory,profile,this.versionReader)};
 }
 private async preflight(context:Context){return inspectManagedInstallation(context.directory,context.orderDirectory,context.runtime,{processActive:gameRunning,storage:this.storage,...(context.iniDirectory?{iniDirectory:context.iniDirectory}:{})});}
 private evidence(preflight:ManagedPreflight){const runtime=preflight.runtime;return{...preflight,runtime:runtime?{ready:runtime.ready,runtime:runtime.runtime,skseLoader:runtime.skseLoader,skseRuntime:runtime.skseRuntime}:null,compatibleComponents:[]};}
 private present(preflight:ManagedPreflight){
  this.update({
   preflight,
   runtime:preflight.runtime?.runtime||'UNVERIFIED',
   skse:preflight.runtime?.ready?preflight.runtime.skseLoader:'UNVERIFIED',
   skyMP:preflight.runtime?.ready?'LOCAL BASELINE MATCH':'UNVERIFIED',
   plugins:preflight.activation?.status==='ready'?'CONFIGURATION DERIVED':'UNVERIFIED',
   conflicts:[...preflight.blockers],
   warnings:[...preflight.manual,...preflight.blockers],
   fileScanResult:preflight.runtime?.ready?`VERIFIED (${preflight.runtime.files.length} baseline files)`:'NEEDS VERIFICATION',
   productionConfigured:this.configured(),
   live:'UNVERIFIED',
   server:'UNVERIFIED'
  });
 }
 async inspect(){
  const {controller,revision}=this.start();this.clearPlan();this.update({phase:'inspecting',status:'READ-ONLY PREFLIGHT',message:'Inspecting the selected Skyrim installation and native activation evidence without probe writes.'});
  try{
   const context=await this.context(true),preflight=await this.preflight(context);if(!this.initialized)await this.bindSession(context);cancelled(controller.signal);
   if(this.current(revision)){
    this.present(preflight);
    if(this.state.recovery==='required')this.update({phase:'recovery-required',status:'RECOVERY REQUIRED',message:'An incomplete managed transaction requires recovery review before new modpack operations.'});
    else this.update({phase:preflight.status==='CONFLICT'?'conflict':preflight.status==='READY'&&this.configured()?'complete':'blocked',status:!this.configured()?'PRODUCTION NOT CONFIGURED':preflight.status,message:preflight.blockers[0]??preflight.manual[0]??(!this.configured()?'Read-only inspection complete; production modpack installation is not configured.':'Read-only preflight complete; review a signed modpack plan before installation.')});
   }
  }
  catch(error){if(this.current(revision))this.update({phase:'error',status:'INSPECTION FAILED',message:message(error)});}
  finally{this.finish(controller);}return this.snapshot();
 }
 private pointer(){return path.join(this.storage,'management-session.json');}
 private async savePointer(grant:SandboxGrant){await durableWrite(this.pointer(),Buffer.from(JSON.stringify({directory:grant.directory,id:grant.id})));}
 private async journals(store:MetadataStore):Promise<InstallJournal[]>{
  const records:InstallJournal[]=[];
  for(const id of await store.journals()){
   const raw=await store.read('transactions/'+id+'/journal.json') as InstallJournal;
   if(!raw||raw.id!==id||raw.installationId!==store.grant.id||raw.schemaVersion!==1||!transactionStates.has(raw.state)||!Array.isArray(raw.operations))throw Error('Recovery journal identity or state cannot be verified');
   records.push(raw);
  }
  return records;
 }
 private async history(grant:SandboxGrant){
  const store=await MetadataStore.create(grant),records=await this.journals(store),engine=await SandboxInstaller.open(grant,{}),receipt=await engine.receipt();
  const versions=[...new Set(receipt.files.map(f=>f.packVersion))];
  this.update({backups:records.filter(j=>j.operations.some(o=>o.backupVerified)).map(j=>j.id),installedVersion:versions.length===1?versions[0]:undefined,recovery:records.some(j=>!terminal.has(j.state))?'required':'not-needed'});
  return{store,records,receipt};
 }
 private async bindSession(currentContext?:Context){
  if(this.initialized)return;let pointerFound=false;
  try{
   const file=await safeFile(this.storage,'management-session.json');pointerFound=true;const stat=await fs.stat(file);if(stat.nlink!==1||stat.size>4096)throw Error('Unsafe managed session pointer');
   const raw=JSON.parse(await fs.readFile(file,'utf8'));
   const parent=path.join(await fs.realpath(this.storage),'managed-installations');
   if(!raw||Object.keys(raw).sort().join(',')!=='directory,id'||typeof raw.directory!=='string'||typeof raw.id!=='string'||!uuid.test(raw.id)||path.dirname(raw.directory)!==parent||!contained(parent,raw.directory)||!/^[a-f0-9]{64}$/.test(path.basename(raw.directory)))throw Error('Untrusted managed session pointer');
   const context=currentContext??await this.context();if(!context.runtime?.ready)throw Error('Current L1 runtime selection required before opening recovery evidence');
   const store=await MetadataStore.recover(raw.directory,(directory,grant)=>adoptRealTarget(directory,grant,context.directory,context.orderDirectory,context.runtime!,this.versionReader));
   if(store.grant.id!==raw.id)throw Error('Managed session identity mismatch');
   // Read authenticated evidence only. Startup never calls recover(), rollback(), or native confirmation.
   const records=await this.journals(store),pending=records.some(j=>!terminal.has(j.state));this.grant=store.grant;this.initialized=true;
   this.update({backups:records.filter(j=>j.operations.some(o=>o.backupVerified)).map(j=>j.id),recovery:pending?'required':'not-needed',...(pending?{phase:'recovery-required' as const,status:'RECOVERY REQUIRED',message:'An incomplete managed transaction was found. Review and explicitly authorize its recovery; startup performed no game writes.'}:this.state.phase==='recovery-required'?{phase:'idle' as const,status:this.configured()?'READY':'PRODUCTION NOT CONFIGURED',message:'Inspect Skyrim read-only; production modpack installation requires an approved publisher and release.'}:{})});
  }catch(error){
   if(!pointerFound&&(error as NodeJS.ErrnoException).code==='ENOENT'){this.initialized=true;return;}
   this.update({phase:'recovery-required',status:'RECOVERY REQUIRED',recovery:'required',message:'Persisted managed transaction evidence cannot be safely opened. Retain it for manual review; no automatic recovery was attempted.'});
  }
 }
 async initialize(){
  this.idle();await this.bindSession();return this.snapshot();
 }
 private removedPlugins(bundle:AuthenticatedRelease,receipt:OwnershipReceipt,intent:ManagementIntent){return receipt.files.filter(f=>f.packId===bundle.manifest.packId&&/^data\/[^/]+\.(esm|esp)$/i.test(f.path)&&(intent==='remove'||intent==='update'&&!bundle.manifest.files.some(target=>target.path.toLowerCase()===f.path.toLowerCase()))).map(f=>f.path.slice(5));}
 private async activation(preflight:ManagedPreflight,bundle:AuthenticatedRelease,receipt:OwnershipReceipt,intent:ManagementIntent,headers:Record<string,ActivationHeader>){
  const deactivate=this.removedPlugins(bundle,receipt,intent),removed=new Set(deactivate.map(n=>n.toLowerCase()));
  return planActivation(preflight.root,bundle.manifest.requiredPlugins.filter(p=>!removed.has(p.filename.toLowerCase())),preflight.pluginInputs,{pendingHeaders:headers,deactivate});
 }
 private async headers(prepared:Prepared){
  const headers:Record<string,ActivationHeader>={};
  for(const file of prepared.bundle.manifest.files.filter(f=>f.distribution==='allowed'&&/^data\/[^/]+\.(esm|esp)$/i.test(f.path))){
   if(prepared.plan.intent==='remove')continue;
   const actual=await observe(prepared.grant,file.path);
   if(actual?.sha256===file.sha256&&actual.size===file.size)continue;
   const cache=await safeFile(prepared.grant.payloads,file.sha256+'.bin');headers[file.path.slice(5)]=await readPluginHeader(cache);
  }
  return headers;
 }
 async prepare(rawIntent:unknown){
  this.idle();if(typeof rawIntent!=='string'||!['install','update','repair','remove'].includes(rawIntent))throw Error('Invalid modpack management intent');
  if(!this.configured())return this.productionBlocked();
  if(!this.initialized)await this.initialize();if(this.state.recovery==='required')throw Error('Recovery required before another modpack plan');
  const intent=rawIntent as ManagementIntent,{controller,revision}=this.start();this.clearPlan();this.update({phase:'planning',status:'PREPARING SIGNED PLAN',intent,message:'Verifying production release, rights, installed ownership and activation requirements.',conflicts:[]});
  try{
   const context=await this.context(true);if(context.channel!==this.source.channel)throw Error('Selected release channel is not approved by production policy');
   const preflight=await this.preflight(context);cancelled(controller.signal);if(!this.current(revision))return this.snapshot();this.present(preflight);
   if(preflight.blockers.length){this.update({phase:'blocked',status:preflight.status,message:preflight.blockers[0]!});return this.snapshot();}
   const provider=this.providerFactory(),release=await provider.resolve(this.source.channel,undefined,controller.signal),bundle=authenticateRelease(await provider.envelope(release,controller.signal),this.source,release);
   const issue=installPreflightIssue(preflight,bundle);if(issue){this.update({phase:'blocked',status:preflight.status,message:issue});return this.snapshot();}
   if(lt(this.launcherVersion,bundle.manifest.minimumLauncherVersion))throw Error('This modpack requires a newer Launcher version');
   await safeDirectory(this.storage);const grant=await registerRealTarget(context.directory,context.orderDirectory,this.storage,context.runtime!,this.versionReader),history=await this.history(grant);
   if(history.records.some(j=>!terminal.has(j.state)))throw Error('Recovery required before another installation');
   this.grant=grant;await this.savePointer(grant);
   await new VersionLedger(path.join(this.storage,'managed-history')).accept(bundle.manifest.packId,bundle.manifest.channel,bundle.manifest.packVersion,bundle.manifestHash);
   const downloader=new PackageDownloader(grant,provider.transport,{onProgress:p=>{if(this.current(revision))this.update({progress:{stage:'download / hash verification',completed:0,total:bundle.packages.length,bytes:p.bytes}});}});
   const headers:Record<string,ActivationHeader>={};let completed=0,bytes=0;
   // All needed direct-file packages are verified outside game content before any native approval.
   if(intent!=='remove')for(const file of bundle.manifest.files.filter(f=>f.distribution==='allowed')){
    cancelled(controller.signal);const actual=await observe(grant,file.path);
    if(actual?.sha256===file.sha256&&actual.size===file.size)continue;
    const ref=bundle.packages.find(p=>p.sha256===file.sha256&&p.size===file.size);if(!ref)throw Error('Authenticated direct-file package binding missing');
    const cache=await (this.stageDownload?this.stageDownload(grant,ref,controller.signal):downloader.acquire(ref,controller.signal));completed++;bytes+=file.size;
    if(/^data\/[^/]+\.(esm|esp)$/i.test(file.path))headers[file.path.slice(5)]=await readPluginHeader(cache);
    if(this.current(revision))this.update({progress:{stage:'verified staging outside Skyrim',completed,total:bundle.packages.length,bytes}});
   }
   const activation=await this.activation(preflight,bundle,history.receipt,intent,headers),plan=await prepareManagementPlan(grant,bundle,history.receipt,intent,this.evidence(preflight),activation,this.launcherVersion);
   const finalIssue=finalPlanPreflightIssue(preflight,bundle,plan);if(finalIssue){this.update({phase:'blocked',status:preflight.status,message:finalIssue});return this.snapshot();}
   cancelled(controller.signal);if(!this.current(revision))return this.snapshot();
   this.prepared={plan,bundle,grant,downloader};
   this.update({
    phase:plan.blockers.length?'conflict':'awaiting-review',
    status:plan.blockers.length?'INSTALLATION BLOCKED':'REVIEW REQUIRED',
    message:plan.blockers[0]??'Review these exact verified operations. Apply will revalidate the plan and request native confirmation before the first game write.',
    plan,
    planHash:planDigest(plan),
    publisher:'APPROVED PRODUCTION PUBLISHER',
    productionConfigured:true,
    packId:plan.packId,
    availableVersion:plan.packVersion,
    requiredServerVersion:bundle.manifest.serverProfileVersion,
    downloadBytes:plan.downloadBytes,
    fileScanResult:plan.blockers.length?'ACTION REQUIRED':`VERIFIED (${plan.actions.length} planned operations)`,
    warnings:[...plan.manual,...plan.blockers],
    server:plan.server,
    plugins:activation.status==='ready'?'PLANNED CONFIGURATION VERIFIED':'MANUAL ACTION REQUIRED',
    conflicts:[...plan.blockers],
    realWriteAuthorized:false
   });
  }catch(error){if(this.current(revision)){this.clearPlan();this.update({phase:'error',status:'PLAN FAILED',message:message(error)});}}
  finally{this.finish(controller);}return this.snapshot();
 }
 private async revalidate(prepared:Prepared){
  const context=await this.context(true);if(!await sameSelection(context,prepared.grant)||context.channel!==prepared.plan.channel)throw Error('Selected installation or release channel changed');
  await checkRoots(prepared.grant);const bundle=authenticateRelease(prepared.bundle.envelope,this.source,prepared.bundle.release);
  const preflight=await this.preflight(context),issue=installPreflightIssue(preflight,bundle);if(issue)throw Error(issue);
  const engine=await SandboxInstaller.open(prepared.grant,{}),receipt=await engine.receipt(),activation=await this.activation(preflight,bundle,receipt,prepared.plan.intent,await this.headers(prepared));
  const current=await prepareManagementPlan(prepared.grant,bundle,receipt,prepared.plan.intent,this.evidence(preflight),activation,this.launcherVersion);
  const finalIssue=finalPlanPreflightIssue(preflight,bundle,current);if(finalIssue)throw Error(finalIssue);
  if(current.blockers.length||Date.parse(prepared.plan.expiresAt)<=Date.now()||planDigest(withoutClock(current))!==planDigest(withoutClock(prepared.plan)))throw Error('Installation plan changed or expired; prepare a fresh review');
  return preflight;
 }
 private options(plan:ManagedPlan,controller:AbortController):InstallerOptions{return{managedPlan:plan,distributionSource:this.source,launcherVersion:this.launcherVersion,channel:plan.channel,onTransaction:journal=>{if(!this.disposed&&this.controller===controller)this.update({transaction:journal.state,progress:{stage:journal.state,completed:journal.operations.filter(o=>o.applied||o.restored).length,total:journal.operations.length,bytes:journal.operations.filter(o=>o.stageVerified).reduce((n,o)=>n+o.size,0)}});},onProgress:progress=>{if(!this.disposed&&this.controller===controller)this.update({progress:{stage:'transaction staging',...progress}});}};}
 private result(journal:InstallJournal,aborted:boolean){
  const recovery=journal.state==='recovery-required';this.update({phase:recovery?'recovery-required':aborted?'cancelled':journal.state==='committed'||journal.state==='rolled-back'?'complete':'error',status:recovery?'MANUAL RECOVERY REQUIRED':aborted&&journal.state==='rolled-back'?'CANCELLED — ROLLBACK VERIFIED':journal.state.toUpperCase(),message:recovery?'The transaction preserved evidence and requires manual recovery.':journal.state==='committed'?'Managed transaction committed and verified. In-game acceptance and live server compatibility remain unverified.':journal.state==='rolled-back'?'Original file state and ownership receipt were restored and verified.':journal.error??'Transaction did not complete.',transaction:journal.state,fileScanResult:journal.state==='committed'?'INSTALLED & VERIFIED':journal.state==='rolled-back'?'ROLLED BACK & VERIFIED':'RECOVERY REQUIRED',recovery:recovery?'required':'not-needed',realWriteAuthorized:false});
 }
 async apply(rawHash:unknown){
  this.idle();if(typeof rawHash!=='string'||!/^[a-f0-9]{64}$/.test(rawHash)||!this.prepared||this.state.planHash!==rawHash||planDigest(this.prepared.plan)!==rawHash)throw Error('Only the current reviewed plan hash may be applied');
  if(!this.configured())return this.productionBlocked();const prepared=this.prepared;if(prepared.plan.blockers.length)throw Error('Blocked plan cannot be authorized');
  const {controller,revision}=this.start();let appliedJournal:InstallJournal|undefined;
  try{
   await this.revalidate(prepared);cancelled(controller.signal);
   const token=await this.authorizer.request(prepared.plan);cancelled(controller.signal);
   await this.revalidate(prepared);cancelled(controller.signal);if(!this.current(revision))throw Error('Installation authorization cancelled');
   const store=await MetadataStore.create(prepared.grant);await store.write('management-plan.json',{plan:prepared.plan,envelope:prepared.bundle.envelope});
   this.update({phase:'running',status:'INSTALLING',message:'Applying the explicitly approved managed transaction.',realWriteAuthorized:true});
   const key=this.source.keys[prepared.bundle.manifest.signing.keyId];if(!key)throw Error('Approved production publisher is no longer configured');
   const engine=await SandboxInstaller.open(prepared.grant,{[prepared.bundle.manifest.signing.keyId]:key.publicKey},{...this.options(prepared.plan,controller),acquire:async(sha,size,signal)=>{const ref=prepared.bundle.packages.find(p=>p.sha256===sha&&p.size===size);if(!ref)throw Error('Approved package binding missing');await prepared.downloader.acquire(ref,signal);}});
   appliedJournal=await withManagedWrite(prepared.grant,prepared.plan,token,this.authorizer,()=>engine.install(prepared.bundle.envelope,controller.signal));
   this.result(appliedJournal,controller.signal.aborted);
   await store.write('transactions/'+appliedJournal.id+'/management-plan.json',{plan:prepared.plan,envelope:prepared.bundle.envelope});
   await this.history(prepared.grant);
  }catch(error){
   if(appliedJournal)this.update({phase:'recovery-required',status:'TRANSACTION EVIDENCE REVIEW REQUIRED',transaction:appliedJournal.state,recovery:'required',message:'The transaction reached '+appliedJournal.state+'; additional history archival failed. Retain transaction evidence for review.',realWriteAuthorized:false});
   else if(this.current(revision)){
    let pending=false;try{pending=(await this.journals(await MetadataStore.create(prepared.grant))).some(j=>!terminal.has(j.state));}catch{pending=true;}
    const declined=/declined|cancel/i.test(message(error));this.update({phase:pending?'recovery-required':declined?'cancelled':'error',status:pending?'RECOVERY REQUIRED':declined?'CANCELLED':'INSTALLATION REFUSED',message:message(error),recovery:pending?'required':'not-needed',realWriteAuthorized:false});
   }
  }
  finally{this.clearPlan();this.finish(controller);}return this.snapshot();
 }
 private async restoration(mode:'rollback'|'recover'){
  this.idle();if(!this.initialized)await this.initialize();if(!this.grant)throw Error('No validated managed transaction is available for '+mode);
  const grant=this.grant,{controller,revision}=this.start();this.clearPlan();
  try{
   const context=await this.context(true);if(!await sameSelection(context,grant)||!context.runtime?.ready)throw Error('Current trusted Skyrim selection is required for recovery');
   const preflight=await this.preflight(context);if(preflight.blockers.length)throw Error(preflight.blockers[0]);
   const {store,records,receipt}=await this.history(grant),reader=await SandboxInstaller.open(grant,{}),candidate=mode==='rollback'?await reader.rollbackCandidate():undefined;
   const selected=mode==='rollback'?records.filter(j=>j.id===candidate):records.filter(j=>!terminal.has(j.state));if(!selected.length)throw Error('No '+mode+' candidate is available');
   if(selected.length!==1)throw Error('Multiple incomplete transactions require individual manual recovery review');
   let saved:{plan:ManagedPlan;envelope:unknown};try{saved=await store.read('transactions/'+selected[0]!.id+'/management-plan.json') as typeof saved;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;saved=await store.read('management-plan.json') as typeof saved;}
   if(!saved?.plan||saved.plan.targetId!==grant.id||saved.plan.signedPayloadHash!==selected[0]!.manifestHash||!saved.envelope)throw Error('Original reviewed management plan is unavailable or does not match this transaction');
   const restorationIssue=restorationPreflightIssue(preflight,selected.flatMap(j=>j.operations.map(o=>o.path)),saved.plan.pluginPlan.order);if(restorationIssue)throw Error(restorationIssue);
   const actions:ManagedAction[]=[];
   for(const journal of selected)for(const operation of [...journal.operations].reverse()){
    const actual=await observe(grant,operation.path);
    const recognizable=sameObservation(actual,operation.original)||operation.applied!==undefined&&sameObservation(actual,operation.applied)||operation.type==='remove'&&operation.pending&&actual===null||!!actual&&[operation.replacement,operation.restoreReplacement,operation.restoredObservation].some(value=>!!value&&value.identity===actual.identity&&value.sha256===actual.sha256&&value.size===actual.size);
    if(!recognizable)throw Error('External file changes require manual recovery: '+operation.path);
    actions.push({path:operation.path,action:operation.type==='configuration'?'configuration':operation.original?'repair':'remove',sha256:operation.original?.sha256??operation.sha256,size:operation.original?.size??0,componentId:operation.componentId,original:actual});
   }
   const journalBinding=selected.map(j=>({id:j.id,digest:planDigest(j)}));
   const plan=freezePlan({...saved.plan,intent:mode==='rollback'?'remove':'repair',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),receiptDigest:planDigest(receipt),actions,blockers:[],manual:[...preflight.manual,'Restore only files attributable to the selected transaction; external changes must be preserved.'],release:{...(saved.plan.release as object),restoration:{operation:mode,journals:journalBinding}},downloadBytes:0,backupBytes:0,requiredBytes:actions.reduce((n,a)=>n+a.size*2,1024*1024)}) as ManagedPlan;
   this.update({phase:'awaiting-review',status:'RECOVERY REVIEW REQUIRED',message:'Review the exact restoration operations before native confirmation.',plan,planHash:planDigest(plan),realWriteAuthorized:false});
   const token=await this.authorizer.request(plan);cancelled(controller.signal);
   const freshContext=await this.context(true);if(!await sameSelection(freshContext,grant))throw Error('Recovery installation selection changed');
   const fresh=await this.preflight(freshContext);if(restorationPreflightIssue(fresh,selected.flatMap(j=>j.operations.map(o=>o.path)),saved.plan.pluginPlan.order))throw Error('Recovery preflight changed');
   if(planDigest(await reader.receipt())!==plan.receiptDigest)throw Error('Recovery ownership receipt changed');
   for(const binding of journalBinding)if(planDigest(await store.read('transactions/'+binding.id+'/journal.json'))!==binding.digest)throw Error('Recovery journal changed');
   for(const action of plan.actions)if(!sameObservation(action.original,await observe(grant,action.path)))throw Error('Recovery target changed after approval');
   cancelled(controller.signal);if(!this.current(revision))throw Error('Recovery authorization cancelled');
   const engine=await SandboxInstaller.open(grant,{},this.options(plan,controller));this.update({phase:'running',status:mode==='rollback'?'ROLLING BACK':'RECOVERING',realWriteAuthorized:true});
   const results=await withManagedWrite(grant,plan,token,this.authorizer,async()=>mode==='rollback'?[await engine.rollback(candidate!)]:await engine.recover());
   for(const journal of results)this.result(journal,controller.signal.aborted);await this.history(grant);
  }catch(error){if(this.current(revision))this.update({phase:'recovery-required',status:'MANUAL RECOVERY REQUIRED',message:message(error),recovery:'required',realWriteAuthorized:false});}
  finally{this.clearPlan();this.finish(controller);}return this.snapshot();
 }
 async rollback(){return this.restoration('rollback');}
 async recover(){return this.restoration('recover');}
}
