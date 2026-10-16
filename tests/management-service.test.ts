import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ManagementService} from '../src/main/management/service';
import {productionSource} from '../src/main/distribution/policy';
const unconfiguredSource={...productionSource,keys:{}};

async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-management-service-'));
 const storage=path.join(root,'launcher'),game=path.join(root,'installation'),profile=path.join(root,'profile');
 await fs.mkdir(storage);await fs.mkdir(game);await fs.mkdir(path.join(game,'Data'));await fs.mkdir(profile);
 await fs.writeFile(path.join(profile,'plugins.txt'),'# untouched fixture\r\n');
 let confirmations=0,contextReads=0;
 const service=new ManagementService(storage,'0.1.6',()=>{contextReads++;return{directory:game,orderDirectory:profile,runtime:null,channel:'stable'};},async()=>{confirmations++;return true;},undefined,unconfiguredSource);
 return{root,storage,game,profile,service,counts:()=>({confirmations,contextReads})};
}

test('production not configured blocks every real intent before acquisition or native approval',async()=>{
 const f=await fixture();
 try{
  for(const intent of ['install','update','repair','remove']){
   await f.service.prepare(intent);
   const state=f.service.snapshot();assert.equal(state.phase,'blocked');assert.equal(state.productionConfigured,false);
   assert.equal(state.realWriteAuthorized,false);assert.match(state.status,/PRODUCTION.*NOT CONFIGURED/i);assert.equal(state.planHash,undefined);
  }
  assert.deepEqual(f.counts(),{confirmations:0,contextReads:0});
  assert.deepEqual(await fs.readdir(f.storage),[]);
  assert.equal(await fs.readFile(path.join(f.profile,'plugins.txt'),'utf8'),'# untouched fixture\r\n');
 }finally{f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

test('renderer inputs cannot supply an intent object, filesystem path, key or arbitrary plan',async()=>{
 const f=await fixture();
 try{
  for(const invalid of [undefined,null,{},'verify','Install','../Data/file.esp',{intent:'install',directory:f.game},1])await assert.rejects(()=>f.service.prepare(invalid));
  for(const invalid of [undefined,null,{},f.game,'../plan','a'.repeat(64),{hash:'a'.repeat(64)}])await assert.rejects(()=>f.service.apply(invalid));
  assert.equal(f.counts().confirmations,0);assert.equal(f.service.snapshot().realWriteAuthorized,false);
 }finally{f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

test('cancel revokes the current review and leaves a truthful cancelled state',async()=>{
 const f=await fixture();
 try{
  await f.service.prepare('install');f.service.cancel();
  const state=f.service.snapshot();assert.equal(state.phase,'cancelled');assert.equal(state.plan,undefined);assert.equal(state.planHash,undefined);assert.equal(state.realWriteAuthorized,false);
  await assert.rejects(()=>f.service.apply('a'.repeat(64)));
  assert.equal(f.counts().confirmations,0);
 }finally{f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

test('initialize without a persisted transaction never starts inspection, download or recovery',async()=>{
 const f=await fixture();
 try{
  await f.service.initialize();assert.equal(f.service.snapshot().phase,'idle');
  assert.deepEqual(f.counts(),{confirmations:0,contextReads:0});assert.deepEqual(await fs.readdir(f.storage),[]);
  await assert.rejects(()=>f.service.rollback());await assert.rejects(()=>f.service.recover());
  assert.equal(f.counts().confirmations,0);
 }finally{f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

test('untrusted persisted session evidence requires recovery review without touching its target',async()=>{
 const f=await fixture();
 try{
  await fs.writeFile(path.join(f.storage,'management-session.json'),JSON.stringify({directory:f.game,id:'forged'}));
  await f.service.initialize();assert.equal(f.service.snapshot().phase,'recovery-required');
  assert.equal(f.counts().confirmations,0);assert.equal(f.service.snapshot().realWriteAuthorized,false);
  assert.deepEqual(await fs.readdir(f.game),['Data']);
  assert.equal(await fs.readFile(path.join(f.profile,'plugins.txt'),'utf8'),'# untouched fixture\r\n');
 }finally{f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

test('a valid session pointer whose recovery evidence is missing cannot be mistaken for first startup',async()=>{
 const f=await fixture();
 const service=new ManagementService(f.storage,'0.1.6',()=>({directory:f.game,orderDirectory:f.profile,channel:'stable',runtime:{directory:f.game,ready:true,runtime:'1.6.1170.0',skseLoader:'0.2.2.6',skseRuntime:'0.2.2.6',nativeLauncherAvailable:false,files:[],errors:[],scannedAt:new Date().toISOString()}}),async()=>{throw Error('Startup must not ask for write approval');},undefined,unconfiguredSource);
 try{
  await fs.writeFile(path.join(f.storage,'management-session.json'),JSON.stringify({directory:path.join(f.storage,'managed-installations','a'.repeat(64)),id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}));
  await service.initialize();assert.equal(service.snapshot().phase,'recovery-required');assert.equal(service.snapshot().recovery,'required');
  assert.deepEqual(await fs.readdir(f.game),['Data']);
 }finally{service.dispose();f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

test('read-only inspect cannot report ready for an unverified runtime or missing game executable',async()=>{
 const f=await fixture();
 try{
  await f.service.inspect();const state=f.service.snapshot();
  assert.ok(['blocked','conflict'].includes(state.phase));assert.equal(state.productionConfigured,false);
  assert.equal(state.live,'UNVERIFIED');assert.equal(state.realWriteAuthorized,false);assert.notEqual(state.status,'READY');
  assert.equal(f.counts().confirmations,0);assert.deepEqual(await fs.readdir(f.storage),[]);
  assert.equal(await fs.readFile(path.join(f.profile,'plugins.txt'),'utf8'),'# untouched fixture\r\n');
 }finally{f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

test('cancellation during inspection cannot be overwritten by a late asynchronous result',async()=>{
 const f=await fixture();
 try{
  const inspecting=f.service.inspect();f.service.cancel();await inspecting;
  assert.equal(f.service.snapshot().phase,'cancelled');assert.equal(f.service.snapshot().planHash,undefined);
 }finally{f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

test('state subscriptions receive isolated snapshots and dispose revokes further operations',async()=>{
 const f=await fixture();let events=0;
 try{
  const unsubscribe=f.service.subscribe(state=>{events++;state.conflicts.push('subscriber mutation');});
  await f.service.prepare('install');assert.ok(events>0);assert.deepEqual(f.service.snapshot().conflicts,[]);
  const snapshot=f.service.snapshot();snapshot.checks.push('outside mutation');assert.deepEqual(f.service.snapshot().checks,[]);
  unsubscribe();const previous=events;f.service.cancel();assert.equal(events,previous);
  f.service.dispose();await assert.rejects(()=>f.service.prepare('install'));await assert.rejects(()=>f.service.inspect());
 }finally{f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

test('persisted session opened before L1 scan rebinds recovery evidence after scan completes',async()=>{
 const f=await fixture();
 const {registerRealTarget}=await import('../src/main/installer/managed-target');
 const {MetadataStore}=await import('../src/main/installer/metadata');
 const versionReader=async(file:string)=>path.basename(file)==='SkyrimSE.exe'?'1.6.1170.0':'0.2.2.6';
 await fs.writeFile(path.join(f.game,'SkyrimSE.exe'),'inert');
 let runtime:any=null;
 const readyRuntime={directory:f.game,ready:true,runtime:'1.6.1170.0',skseLoader:'0.2.2.6',skseRuntime:'0.2.2.6',nativeLauncherAvailable:false,files:[{path:'skse64_1_6_1170.dll',required:true,category:'skse' as const,sha256:'',size:5,status:'verified' as const}],errors:[],scannedAt:new Date().toISOString()};
 const service=new ManagementService(f.storage,'0.1.6',()=>({directory:f.game,orderDirectory:f.profile,channel:'stable',runtime}),async()=>{throw Error('Startup/rebind must not ask for write approval');},versionReader,unconfiguredSource);
 try{
  const grant=await registerRealTarget(f.game,f.profile,f.storage,readyRuntime,versionReader);
  const store=await MetadataStore.create(grant);
  const journalId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await store.write('transactions/'+journalId+'/journal.json',{schemaVersion:1,id:journalId,installationId:grant.id,manifestHash:'a'.repeat(64),createdAt:new Date().toISOString(),state:'applying',operations:[{path:'Data/Interface/Frostveil/notice.html',componentId:'owned',componentVersion:'1.0.0',packId:'frostveil-pack',packVersion:'1.0.0',sha256:'b'.repeat(64),size:4,type:'install',packageIdentity:'a'.repeat(64),ownership:'custom-rp',original:null,stageVerified:true,backupVerified:true,pending:true,restored:false}],previousReceipt:{schemaVersion:1,installationId:grant.id,files:[]}});
  await fs.writeFile(path.join(f.storage,'management-session.json'),JSON.stringify({directory:grant.directory,id:grant.id}));
  await service.initialize();
  assert.equal(service.snapshot().phase,'recovery-required');
  assert.equal(service.snapshot().backups.length,0);
  runtime=readyRuntime;
  await service.initialize();
  assert.equal(service.snapshot().phase,'recovery-required');
  assert.equal(service.snapshot().recovery,'required');
  assert.deepEqual(service.snapshot().backups,[journalId],JSON.stringify({state:service.snapshot(),storage:f.storage,canonicalStorage:await fs.realpath(f.storage),grantDirectory:grant.directory}));
 }finally{service.dispose();f.service.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

