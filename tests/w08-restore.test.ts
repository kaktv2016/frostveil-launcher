import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,createHmac,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {createManagedFixture} from '../src/main/installer/managed-target';
import {MetadataStore} from '../src/main/installer/metadata';
import {authenticateRuntimeCohort,type RuntimeCohort} from '../src/main/runtime/policy';
import {RuntimeTransaction,type WholePlayPlanner} from '../src/main/runtime/transaction';
import {RuntimePreparation} from '../src/main/runtime/service';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const keys=generateKeyPairSync('ed25519');
const trust={w08:{publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString(),environment:'test' as const,revoked:false}};
const targetFiles=[
 {path:'SkyrimSE.exe',before:'original-runtime',target:'verified-runtime'},
 {path:'SkyrimSELauncher.exe',before:'original-launcher',target:'verified-launcher'},
 {path:'Data/ccBase.esm',before:'old-approved-master',target:'verified-approved-master'}
];
const signedPlugins=Buffer.from('*ccBase.esm\r\n').toString('base64');
const signedLoadorder=Buffer.from('ccBase.esm\r\n').toString('base64');
const originalCcc=Buffer.from('ccBase.esm\r\nccPaid.esl\r\n');

function authenticatedPolicy():Readonly<RuntimeCohort>{
 const policy:RuntimeCohort={
  schemaVersion:1,kind:'frostveil-steam-runtime',runtime:'1.6.1170.0',appId:'489830',language:'english',
  createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60*60*1000).toISOString(),
  depots:[{id:'489833',manifest:'1914580699073641964'}],
  files:targetFiles.map(file=>({path:file.path,size:Buffer.byteLength(file.target),sha256:sha(file.target),depot:'489833'})),
  creations:['ccBase.esm'],managedFiles:[],pluginOrder:['ccBase.esm'],
  configuration:{pluginsBase64:signedPlugins,loadorderBase64:signedLoadorder},
  helper:{version:'3.4.0',size:1,sha256:sha('fixture-helper')},
  acquisition:{verified:true,receiptSha256:sha('fixture-receipt')}
 };
 const payload=Buffer.from(JSON.stringify(policy));
 const envelope={keyId:'w08',payloadBase64:payload.toString('base64'),signatureBase64:sign(null,payload,keys.privateKey).toString('base64')};
 return authenticateRuntimeCohort(envelope,trust,{fixture:true});
}

async function fixture(t:test.TestContext){
 const grant=await createManagedFixture();
 t.after(()=>fs.rm(grant.directory,{recursive:true,force:true}));
 const game=grant.installation,config=grant.configDirectory!,source=path.join(grant.payloads,'w08-source');
 await fs.mkdir(source);
 for(const file of targetFiles){
  await fs.mkdir(path.dirname(path.join(source,file.path)),{recursive:true});
  await fs.writeFile(path.join(game,file.path),file.before);
  await fs.writeFile(path.join(source,file.path),file.target);
 }
 const originalPlugins=Buffer.from('*ccBase.esm\r\n*ccPaid.esl\r\n');
 const originalLoadorder=Buffer.from('ccBase.esm\r\nccPaid.esl\r\n');
 await fs.writeFile(path.join(config,'plugins.txt'),originalPlugins);
 await fs.writeFile(path.join(config,'loadorder.txt'),originalLoadorder);
 await fs.writeFile(path.join(game,'Skyrim.ccc'),originalCcc);
 await fs.writeFile(path.join(game,'Data/ccPaid.esl'),'obsolete creation');
 class FixturePreparation extends RuntimePreparation{
  protected override async runtimeTarget(selectedGame:string,selectedConfig:string){
   assert.equal(selectedGame,game);
   assert.equal(selectedConfig,config);
   return{grant,guard:async()=>false,steamStamp:sha('inert Steam selection')};
  }
 }
 const readJournal=async()=>await (await MetadataStore.create(grant)).read('runtime-preparation/journal.json') as {
  state:string;files:{path:string;before:{size:number;sha256:string}|null;after:{size:number;sha256:string}|null}[];
 };
 const snapshot=async()=>{
  const targets=[...targetFiles.map(file=>path.join(game,file.path)),path.join(game,'Skyrim.ccc'),path.join(game,'Data/ccPaid.esl'),path.join(config,'plugins.txt'),path.join(config,'loadorder.txt')];
  const entries=[];
  for(const target of targets){
   try{
    const stat=await fs.lstat(target,{bigint:true});
    entries.push({target,sha256:sha(await fs.readFile(target)),dev:String(stat.dev),ino:String(stat.ino),size:Number(stat.size)});
   }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')entries.push({target,sha256:null,dev:null,ino:null,size:null});else throw error;}
  }
  const journal=await fs.readFile(path.join(grant.metadata,'runtime-preparation/journal.json'));
  const stat=await fs.stat(path.join(grant.metadata,'runtime-preparation/journal.json'),{bigint:true});
  const backupRoot=path.join(grant.payloads,'runtime-backups');
  const backups=(await fs.readdir(backupRoot)).sort();
  const backupImages=await Promise.all(backups.map(async name=>({name,sha256:sha(await fs.readFile(path.join(backupRoot,name)))})));
  return{entries,journalSha256:sha(journal),journalDev:String(stat.dev),journalIno:String(stat.ino),backupImages};
 };
 return{grant,game,config,source,restart:()=>new FixturePreparation(grant.directory,path.join(grant.directory,'unused-policy.json')),readJournal,snapshot,originalPlugins,originalLoadorder,originalCcc};
}

test('public Restore after restart restores an interrupted forward Apply without completing it',async t=>{
 const f=await fixture(t);
 let interrupted=false;
 const setup=await RuntimeTransaction.open(f.grant,authenticatedPolicy(),async()=>false,{
  checkpoint:async stage=>{if(stage==='file-applied'&&!interrupted){interrupted=true;throw Error('synthetic forward interruption');}}
 });
 await assert.rejects(setup.apply(f.source),/synthetic forward interruption/);
 const journalBefore=await f.readJournal();
 assert.equal(journalBefore.state,'applying');
 const writtenStates:string[]=[];
 const originalWrite=MetadataStore.prototype.write;
 MetadataStore.prototype.write=async function(relative,value){
  if(relative==='runtime-preparation/journal.json')writtenStates.push((value as {state:string}).state);
  return originalWrite.call(this,relative,value);
 };
 try{
  const restarted=f.restart();
  await restarted.restore(f.game,f.config);
 }finally{MetadataStore.prototype.write=originalWrite;}
 const restored=await f.readJournal();
 assert.equal(restored.state,'restored');
 assert.equal(writtenStates.some(state=>state==='active'||state==='applying'),false);
 for(const file of targetFiles)assert.equal(await fs.readFile(path.join(f.game,file.path),'utf8'),file.before);
 assert.deepEqual(await fs.readFile(path.join(f.config,'plugins.txt')),f.originalPlugins);
 assert.deepEqual(await fs.readFile(path.join(f.config,'loadorder.txt')),f.originalLoadorder);
});

test('public offline Restore accepts an existing schema-1 active journal after restart',async t=>{
 const f=await fixture(t);
 const setup=await RuntimeTransaction.open(f.grant,authenticatedPolicy(),async()=>false);
 await setup.apply(f.source);
 assert.equal((await f.readJournal()).state,'active');
 const restarted=f.restart();
 await restarted.restore(f.game,f.config);
 const restored=await f.readJournal();
 assert.equal(restored.state,'restored');
 for(const file of targetFiles)assert.equal(await fs.readFile(path.join(f.game,file.path),'utf8'),file.before);
 assert.deepEqual(await fs.readFile(path.join(f.game,'Skyrim.ccc')),f.originalCcc);
 assert.deepEqual(await fs.readFile(path.join(f.config,'plugins.txt')),f.originalPlugins);
 assert.deepEqual(await fs.readFile(path.join(f.config,'loadorder.txt')),f.originalLoadorder);
 assert.equal(await fs.readFile(path.join(f.game,'Data/ccPaid.esl'),'utf8'),'obsolete creation');
});

for(const interruptedRestore of [false,true]){
 test(`public Restore ${interruptedRestore?'resumed':'initial'} preflights the entire journal before refusing a late profile conflict`,async t=>{
  const f=await fixture(t);
  const setup=await RuntimeTransaction.open(f.grant,authenticatedPolicy(),async()=>false);
  await setup.apply(f.source);
  if(interruptedRestore){
   let interrupted=false;
   const partial=await RuntimeTransaction.forRecovery(f.grant,async()=>false,{
    checkpoint:async stage=>{if(stage==='file-applied'&&!interrupted){interrupted=true;throw Error('synthetic Restore interruption');}}
   });
   await assert.rejects(partial.restore(),/synthetic Restore interruption/);
   assert.equal((await f.readJournal()).state,'restoring');
  }
  await fs.writeFile(path.join(f.game,'SkyrimSE.exe'),'external runtime edit');
  const before=await f.snapshot();
  const restarted=f.restart();
  await assert.rejects(restarted.restore(f.game,f.config),/conflict/i);
  assert.deepEqual(await f.snapshot(),before);
 });

 test(`public Restore ${interruptedRestore?'resumed':'initial'} validates all backup blobs before changing targets or journal`,async t=>{
  const f=await fixture(t);
  const setup=await RuntimeTransaction.open(f.grant,authenticatedPolicy(),async()=>false);
  await setup.apply(f.source);
  if(interruptedRestore){
   let interrupted=false;
   const partial=await RuntimeTransaction.forRecovery(f.grant,async()=>false,{
    checkpoint:async stage=>{if(stage==='file-applied'&&!interrupted){interrupted=true;throw Error('synthetic Restore interruption');}}
   });
   await assert.rejects(partial.restore(),/synthetic Restore interruption/);
   assert.equal((await f.readJournal()).state,'restoring');
  }
  const journal=await f.readJournal();
  const first=journal.files[0]!;
  assert.equal(first.path,'SkyrimSE.exe');
  assert.ok(first.before);
  const backup=path.join(f.grant.payloads,'runtime-backups',first.before.sha256);
  await fs.writeFile(backup,'corrupt last restore backup');
  const before=await f.snapshot();
  const restarted=f.restart();
  await assert.rejects(restarted.restore(f.game,f.config),/blob|backup|integrity/i);
  assert.deepEqual(await f.snapshot(),before);
 });
}


test('resumed Restore fences an already-restored target during whole-set preflight',async t=>{
 const f=await fixture(t);
 const setup=await RuntimeTransaction.open(f.grant,authenticatedPolicy(),async()=>false);
 await setup.apply(f.source);
 const first=[...(await f.readJournal()).files].reverse().find(file=>file.before?.sha256!==file.after?.sha256);
 assert.ok(first);
 const target=first.path.startsWith('@config/')?path.join(f.config,first.path.slice(8)):path.join(f.game,first.path);
 const partial=await RuntimeTransaction.forRecovery(f.grant,async()=>false,{
  checkpoint:async stage=>{if(stage==='file-applied')throw Error('synthetic Restore interruption');},
 });
 await assert.rejects(partial.restore(),/synthetic Restore interruption/);
 assert.equal((await f.readJournal()).state,'restoring');
 if(first.before)assert.equal(sha(await fs.readFile(target)),first.before.sha256);
 else await assert.rejects(fs.stat(target),{code:'ENOENT'});
 let edited:Awaited<ReturnType<typeof f.snapshot>>|undefined;
 const restarted=await RuntimeTransaction.forRecovery(f.grant,async()=>false,{
  freeBytes:async()=>{
   if(!edited){
    await fs.writeFile(target,'external edit during Restore preflight');
    edited=await f.snapshot();
   }
   return Number.MAX_SAFE_INTEGER;
  },
 });
 await assert.rejects(restarted.restore(),/restore conflict/i);
 assert.ok(edited);
 assert.deepEqual(await f.snapshot(),edited);
});

test('restart refuses another installation that shares a pending whole-Play profile', async t=>{
 const f=await fixture(t);
 const storage=path.join(f.grant.directory,'shared-selection-storage');
 const other=path.join(f.grant.directory,'other-inert-installation');
 await fs.mkdir(other);
 const game=await fs.realpath(f.game),config=await fs.realpath(f.config);
 const registry=path.join(storage,'managed-installations',sha(game.toLowerCase()+'\n'+config.toLowerCase()));
 const metadata=path.join(registry,'metadata');
 await fs.mkdir(path.join(metadata,'runtime-preparation'),{recursive:true});
 const id=randomUUID(),key=Buffer.alloc(32,37);
 await fs.writeFile(path.join(metadata,'auth-key'),key,{flag:'wx'});
 const signed=async(relative:string,value:unknown)=>{
  const body=JSON.stringify(value),mac=createHmac('sha256',key).update(body).digest('hex');
  await fs.writeFile(path.join(metadata,relative),JSON.stringify({body,mac}));
 };
 await signed('sandbox.json',{targetClass:'real-skyrim',id,directory:registry,installation:game,
  configDirectory:config,metadata,payloads:path.join(registry,'packages')});
 const journal='runtime-preparation/journal.json';
 const record={schemaVersion:2,state:'applying',installationId:id};
 await signed(journal,record);
 const journalBytes=await fs.readFile(path.join(metadata,journal));
 const service=new RuntimePreparation(storage,path.join(storage,'unavailable-policy.json'));
 let callbacks=0;
 const mutate=async()=>{callbacks++;await fs.writeFile(path.join(config,'plugins.txt'),'unexpected other installation write');};
 await assert.rejects(service.withStandaloneWrite(other,config,mutate),/another whole-Play recovery journal owns/i);
 await assert.rejects(service.prepareWholePlay(other,config,async()=>{throw Error('unexpected planner');}),/another whole-Play recovery journal owns/i);
 await assert.rejects(service.restore(other,config),/another whole-Play recovery journal owns/i);
 await assert.rejects(service.withStandaloneWrite(game,config,mutate),/existing whole-Play recovery journal/i);
 assert.equal(callbacks,0);
 assert.deepEqual(await fs.readFile(path.join(config,'plugins.txt')),f.originalPlugins);
 assert.deepEqual(await fs.readFile(path.join(metadata,journal)),journalBytes);
 await signed(journal,{...record,state:'restored'});
 const outcome=await service.withStandaloneWrite(other,config,async()=>{callbacks++;return 'allowed';});
 assert.equal(outcome,'allowed');
 assert.equal(callbacks,1);
});

test('concurrent standalone operations cannot share a profile even across service instances', async t=>{
 const f=await fixture(t);
 const other=path.join(f.grant.directory,'concurrent-inert-installation');
 await fs.mkdir(other);
 const first=f.restart(),second=f.restart();
 let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;});
 const hold=new Promise<void>(resolve=>{release=resolve;});
 const writing=first.withStandaloneWrite(f.game,f.config,async()=>{enter();await hold;});
 try{
  await entered;
  await assert.rejects(second.withStandaloneWrite(other,f.config,async()=>{throw Error('unexpected concurrent writer');}),/another runtime operation owns/i);
 }finally{
  release();
  await writing;
 }
 assert.equal(await second.withStandaloneWrite(other,f.config,async()=>true),true);
});

test('whole-Play restart removes only its authenticated staged sibling before resuming or restoring',async t=>{
 for(const mode of ['resume','restore','preserve-tampered'] as const){
  await t.test(mode,async sub=>{
   const f=await fixture(sub),policy=authenticatedPolicy();
   const planner:WholePlayPlanner=async()=>({
    cohortId:sha('inert transient cohort'),writes:[],revalidate:async()=>{},verifyInstalled:async()=>{},
   });
   const prepare=async(tx:RuntimeTransaction)=>tx.prepareWholePlay(planner,async()=>f.source,async()=>{},new AbortController().signal);
   const readTransient=async()=>{
    const state=await (await MetadataStore.create(f.grant)).read('runtime-preparation/journal.json') as {
     wholePlay:{transient?:{path:string;name:string;identity:string|null;direction:string}};
    };
    return state.wholePlay.transient;
   };
   const tx=await RuntimeTransaction.open(f.grant,policy,async()=>false,{
    wholePlayCheckpoint:async(stage)=>{if(stage==='after-target-temp-staged')throw Error('interrupted at target temp');},
   });
   await assert.rejects(prepare(tx),/interrupted at target temp/);
   const transient=await readTransient();
   assert.ok(transient?.identity);
   assert.equal(transient.direction,'apply');
   const destination=path.join(f.game,transient.path),file=path.join(path.dirname(destination),transient.name);
   assert.equal(await fs.readFile(destination,'utf8'),targetFiles[0]!.before);
   assert.equal(await fs.readFile(file,'utf8'),targetFiles[0]!.target);
   if(mode==='preserve-tampered'){
    const before=await f.snapshot();
    await fs.writeFile(file,'X');
    await assert.rejects(f.restart().restore(f.game,f.config),/unexpected whole-Play transient bytes/i);
    assert.deepEqual(await f.snapshot(),before);
    assert.equal(await fs.readFile(file,'utf8'),'X');
   }else if(mode==='restore'){
    await f.restart().restore(f.game,f.config);
    assert.equal((await f.readJournal()).state,'restored');
    await assert.rejects(fs.stat(file),{code:'ENOENT'});
   }else{
    await prepare(await RuntimeTransaction.open(f.grant,policy,async()=>false));
    assert.equal((await f.readJournal()).state,'active');
    assert.equal(await fs.readFile(destination,'utf8'),targetFiles[0]!.target);
    await assert.rejects(fs.stat(file),{code:'ENOENT'});
   }
  });
 }
});

test('resumed whole-Play uses authenticated Creation removal when the old profile still enables it',async t=>{
 const f=await fixture(t),policy=authenticatedPolicy();
 let plans=0;
 const planner:WholePlayPlanner=async projection=>{
  assert.equal(projection.isRuntimeRemoval?.('Data/ccPaid.esl'),true);
  assert.equal(projection.isRuntimeRemoval?.('Data/PlayerOwned.esp'),false);
  assert.equal(await projection.projectedFile('Data/ccPaid.esl'),null);
  plans++;
  return{cohortId:sha('inert creation cohort'),writes:[],revalidate:async()=>{},verifyInstalled:async()=>{}};
 };
 const run=async(tx:RuntimeTransaction)=>tx.prepareWholePlay(planner,async()=>f.source,async()=>{},new AbortController().signal);
 const first=await RuntimeTransaction.open(f.grant,policy,async()=>false,{
  wholePlayCheckpoint:async(stage,file)=>{
   if(stage==='after-target-write'&&file==='Data/ccPaid.esl')throw Error('interrupted after paid Creation quarantine');
  },
 });
 await assert.rejects(run(first),/interrupted after paid Creation quarantine/);
 await assert.rejects(fs.stat(path.join(f.game,'Data/ccPaid.esl')),{code:'ENOENT'});
 assert.deepEqual(await fs.readFile(path.join(f.config,'plugins.txt')),f.originalPlugins);
 await run(await RuntimeTransaction.open(f.grant,policy,async()=>false));
 assert.equal(plans,2);
 assert.equal((await f.readJournal()).state,'active');
 assert.equal(await fs.readFile(path.join(f.config,'plugins.txt'),'utf8'),Buffer.from(signedPlugins,'base64').toString());
 await f.restart().restore(f.game,f.config);
 assert.equal(await fs.readFile(path.join(f.game,'Data/ccPaid.esl'),'utf8'),'obsolete creation');
});
