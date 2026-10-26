import fs from 'node:fs/promises';
import {safeFile,hashFile}from'../files';
import {MetadataStore,durableWrite}from'../installer/metadata';
import {checkManagedRoots}from'../installer/managed-target';
import type {SandboxGrant}from'../installer/sandbox';
import {planDigest,freezePlan}from'./authorization';
import {planActivation}from'./activation';import {readOrderInputs,readPluginHeader}from'../modpack/plugins';
export interface NpcReferencePolicy {version:1;catalogHash:string;assets:{path:string;size:number;sha256:string}[];runtime:{path:string;size:number;sha256:string}[];}
interface Write {slot:'plugins'|'settings';before:string;after:string;}
interface LocalPlan {source:'LOCAL OWNED REFERENCE ONLY';schemaVersion:1;installationId:string;policyHash:string;expiresAt:number;writes:Write[];digest:string;}
interface Journal {state:'prepared'|'applying'|'active'|'reverting'|'reverted'|'recovery-required';plan:LocalPlan;}
const journalPath='npc-development/journal.json';
/** Local operator entry only. No IPC, remote source, asset copy or signature
 * override. References already owned files and changes exactly two config files
 * through the existing authenticated metadata, root checks, lease and durable IO.
 * Production installer and release policy are not involved or relaxed. */
export class NpcDevelopmentProfile {
 private constructor(readonly grant:SandboxGrant,readonly policy:NpcReferencePolicy,private store:MetadataStore,private running:()=>Promise<boolean>){}
 static async open(grant:SandboxGrant,raw:NpcReferencePolicy,running:()=>Promise<boolean>){
  await checkManagedRoots(grant);const policy=freezePlan(raw) as NpcReferencePolicy;
  const expected=['Data/FrostveilNPCTest.esp',...['00005901','00005906'].flatMap(n=>['Data/meshes/actors/character/FaceGenData/FaceGeom/FrostveilNPCTest.esp/'+n+'.nif','Data/textures/actors/character/FaceGenData/FaceTint/FrostveilNPCTest.esp/'+n+'.dds'])].sort();
  if(policy.version!==1||!/^[a-f0-9]{64}$/.test(policy.catalogHash)||policy.assets.length!==5||JSON.stringify(policy.assets.map(a=>a.path).sort())!==JSON.stringify(expected)||grant.targetClass==='real-skyrim'&&policy.runtime.length!==9)throw Error('Unapproved local reference policy');
  for(const f of [...policy.assets,...policy.runtime])if(!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.size)||f.size<1)throw Error('Invalid local asset pin');
  return new NpcDevelopmentProfile(grant,policy,await MetadataStore.create(grant),running);
 }
 private async target(slot:Write['slot']){return slot==='plugins'?await safeFile(this.grant.configDirectory!,'plugins.txt'):await safeFile(this.grant.installation,'Data/Platform/Plugins/skymp5-client-settings.txt');}
 private async checkFiles(){await checkManagedRoots(this.grant);for(const f of [...this.policy.assets,...this.policy.runtime]){const got=await hashFile(await safeFile(this.grant.installation,f.path),64*1024*1024);if(got.sha256!==f.sha256||got.size!==f.size)throw Error('Local asset/runtime changed: '+f.path);}const h=await readPluginHeader(await safeFile(this.grant.installation,'Data/FrostveilNPCTest.esp'));if(h.light||h.master)throw Error('Ordinary full test ESP required');}
 private async current(){try{return await this.store.read(journalPath) as Journal;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
 private async verifyWrites(plan:LocalPlan,which:'before'|'after'){for(const w of plan.writes){const f=await this.target(w.slot),st=await fs.lstat(f);if(st.nlink!==1||st.size>1024*1024||!(await fs.readFile(f)).equals(Buffer.from(w[which],'base64')))throw Error('Profile configuration changed; conflict retained');}}
 async prepare():Promise<LocalPlan>{
  await this.checkFiles();if(await this.running())throw Error('Close Skyrim/SKSE before profile preparation');const unlock=await this.store.lease();
  try{
   const existing=await this.current();if(existing?.state==='active'){await this.verifyWrites(existing.plan,'after');return existing.plan;}if(existing&&!['prepared','reverted'].includes(existing.state))throw Error('Local profile recovery required');
   const input=await readOrderInputs(this.grant.installation,this.grant.configDirectory!);
   const baseline=await planActivation(this.grant.installation,[],input);
   const testHeader=await readPluginHeader(await safeFile(this.grant.installation,'Data/FrostveilNPCTest.esp'));
   const activation=await planActivation(this.grant.installation,[{filename:'FrostveilNPCTest.esp',required:true,role:'client-only',order:253,masters:testHeader.masters,sha256:this.policy.assets.find(a=>a.path==='Data/FrostveilNPCTest.esp')!.sha256}],input);
   if(baseline.status!=='ready'||baseline.configWrites.length||activation.status!=='ready'||activation.configWrites.some(w=>w.path!=='@config/plugins.txt')||JSON.stringify(baseline.active.filter(n=>n.toLowerCase()!=='frostveilnpctest.esp'))!==JSON.stringify(activation.active.filter(n=>n.toLowerCase()!=='frostveilnpctest.esp')))throw Error('Activation would disturb existing approved plugins');
   const plugins=await fs.readFile(await this.target('plugins')),settings=await fs.readFile(await this.target('settings'));
   if(settings.length>65536)throw Error('Oversized client configuration');const config=JSON.parse(settings.toString('utf8'));
   if(config.master||config['server-master-key'])throw Error('A different authenticated profile is selected; refuse to overwrite credentials');
   const changed=Buffer.from(JSON.stringify({...config,'server-ip':'127.0.0.1','server-port':17777},null,2)+'\n');
   const writes:Write[]=[{slot:'plugins',before:plugins.toString('base64'),after:activation.configWrites[0]?.bytesBase64??plugins.toString('base64')},{slot:'settings',before:settings.toString('base64'),after:changed.toString('base64')}];
   const value={source:'LOCAL OWNED REFERENCE ONLY' as const,schemaVersion:1 as const,installationId:this.grant.id,policyHash:planDigest(this.policy),expiresAt:Date.now()+3600000,writes};
   const plan={...value,digest:planDigest(value)};await this.store.write(journalPath,{state:'prepared',plan});return plan;
  }finally{await unlock();}
 }
 async activate(plan:LocalPlan,confirm:(digest:string)=>Promise<boolean>){
  if(await confirm(plan.digest)!==true)throw Error('Local activation declined');if(await this.running())throw Error('Game process active');
  const unlock=await this.store.lease();try{
   await this.checkFiles();const j=await this.current();if(!j||planDigest(j.plan)!==planDigest(plan)||plan.installationId!==this.grant.id||plan.policyHash!==planDigest(this.policy))throw Error('Unapproved/tampered local plan');
   if(j.state==='active'){await this.verifyWrites(plan,'after');return;}
   if(j.state!=='prepared'||plan.expiresAt<=Date.now())throw Error('Local plan expired or recovery required');await this.verifyWrites(plan,'before');
   await this.store.write(journalPath,{state:'applying',plan});
   try{for(const w of plan.writes){await checkManagedRoots(this.grant);if(await this.running())throw Error('Game started during activation');await durableWrite(await this.target(w.slot),Buffer.from(w.after,'base64'));}await this.verifyWrites(plan,'after');await this.store.write(journalPath,{state:'active',plan});}
   catch(error){await this.store.write(journalPath,{state:'recovery-required',plan});throw error;}
  }finally{await unlock();}
 }
 async status(){const j=await this.current();if(!j||j.state!=='active')return {active:false,state:j?.state??'absent',trust:'LOCAL OWNED REFERENCE ONLY'};await this.checkFiles();await this.verifyWrites(j.plan,'after');const input=await readOrderInputs(this.grant.installation,this.grant.configDirectory!),activation=await planActivation(this.grant.installation,[],input);if(activation.status!=='ready'||activation.configWrites.length||!activation.active.includes('FrostveilNPCTest.esp'))throw Error('Development plugin is not verifiably active');return{active:true,state:j.state,profileHash:planDigest(this.policy),fullOrder:activation.order,trust:'LOCAL OWNED REFERENCE ONLY'};}
 async revert(confirm:(digest:string)=>Promise<boolean>){
  const j=await this.current();if(!j||j.state==='reverted')return;if(await confirm(j.plan.digest)!==true)throw Error('Local revert declined');if(await this.running())throw Error('Game process active');
  const unlock=await this.store.lease();try{
   await checkManagedRoots(this.grant);const current=await this.current();if(!current||planDigest(current.plan)!==planDigest(j.plan))throw Error('Concurrent profile change');
   // Preflight every target before restoring either; preserve later owner edits.
   for(const w of j.plan.writes){const b=await fs.readFile(await this.target(w.slot));if(!b.equals(Buffer.from(w.after,'base64'))&&!b.equals(Buffer.from(w.before,'base64')))throw Error('Configuration changed; revert conflict retained');}
   await this.store.write(journalPath,{state:'reverting',plan:j.plan});
   for(const w of [...j.plan.writes].reverse()){await checkManagedRoots(this.grant);if(await this.running())throw Error('Game started during revert');await durableWrite(await this.target(w.slot),Buffer.from(w.before,'base64'));}
   await this.verifyWrites(j.plan,'before');await this.store.write(journalPath,{state:'reverted',plan:j.plan});
  }finally{await unlock();}
 }
}
