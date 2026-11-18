import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {createManagedFixture} from '../src/main/installer/managed-target';
import {MetadataStore} from '../src/main/installer/metadata';
import {authenticateRuntimeCohort,type RuntimeCohort} from '../src/main/runtime/policy';
import {RuntimePreparation} from '../src/main/runtime/service';
import {preparePlay,restorePlay,type PlayAdapters,type PlayWrite} from '../src/main/runtime/whole-play';
import {GameLauncher} from '../src/main/launch';
import {GraphicsPackService,type GraphicsManifest} from '../src/main/management/graphics-pack';
import type {Profile,Scan} from '../src/shared/contracts';

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const keys=generateKeyPairSync('ed25519');
const trust={w08:{publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString(),environment:'test' as const,revoked:false}};
const baseline:Profile={id:'w08-fixture-profile',runtime:'1.6.1170.0',skseVersion:'2.2.6',skseDll:'skse64_1_6_1170.dll',evidence:'fixture',files:[],backupFiles:[]};
const originalPlugins=Buffer.from('# Original player profile\r\n');
const originalLoadorder=Buffer.from('# Original player load order\r\n');
const finalPlugins=Buffer.from('*FrostveilQuest.esp\r\n');
const finalLoadorder=Buffer.from('FrostveilQuest.esp\r\n');
const tes4=(masters:string[]=[])=>{
 const fields=masters.map(name=>{const value=Buffer.from(name+'\0'),field=Buffer.alloc(6);field.write('MAST');field.writeUInt16LE(value.length,4);return Buffer.concat([field,value]);});
 const body=Buffer.concat(fields),header=Buffer.alloc(24);header.write('TES4');header.writeUInt32LE(body.length,4);return Buffer.concat([header,body]);
};
const runtimeBefore=Buffer.from('original inert runtime'),runtimeAfter=Buffer.from('verified inert runtime');
const loaderBytes=Buffer.from('inert signed loader');
const skseRuntimeBytes=Buffer.from('inert pinned SKSE runtime DLL');
const gameMaster=tes4(),quest=tes4(['Skyrim.esm']),graphics=Buffer.from('verified fixture graphics');
const sourceGraphics=tes4(['Skyrim.esm']),client=Buffer.from('fixture client bytes');
const targets=[
 {path:'Data/Skyrim.esm',bytes:gameMaster},
 {path:'Data/LegacyGraphics.ini',bytes:graphics},
 {path:'Data/FrostveilWorld.esp',bytes:sourceGraphics},
 {path:'Data/Platform/Plugins/skymp5-client.js',bytes:client},
 {path:'Data/FrostveilQuest.esp',bytes:quest},
] as const;
const graphicMasters=[
 'unofficial skyrim special edition patch.esp','Lux - Master plugin.esm','Lux - Resources.esp',
 'Natural Waterfalls.esp','Natural Waterfalls - Dawnguard.esp','Natural Waterfalls - Dragonborn.esp',
 'Natural Waterfalls - Blackreach.esp',
];
const graphicActivations=[
 'Skyrim.esm','Update.esm','Dawnguard.esm','HearthFires.esm','Dragonborn.esm','ccBGSSSE001-Fish.esm',
 'ccBGSSSE025-AdvDSGS.esm','ccBGSSSE037-Curios.esl','ccQDRSSE001-SurvivalMode.esl','_ResourcePack.esl',
];
const graphicCanonical=[...graphicMasters,'FrostveilCourierNavigation.esp','FrostveilWorld.esp','SkyUI_SE.esp','FrostveilQuest.esp'];
const graphicsProfileFiles=[...new Set([...graphicActivations,...graphicMasters,'FrostveilQuest.esp','FrostveilWorld.esp','SkyUI_SE.esp'])]
 .map(name=>({path:'Data/'+name,bytes:tes4()}));
graphicsProfileFiles.push({path:'Data/FrostveilCourierNavigation.esp',bytes:tes4(['Skyrim.esm'])});
const graphicPlugins=Buffer.from([
 '# This file is used by Skyrim to keep track of your downloaded content.',
 '# Please do not modify this file.',
 ...graphicCanonical.map(name=>'*'+name),
 ''].join('\r\n'));
const graphicLoadorder=Buffer.from([...graphicActivations,...graphicCanonical.slice(0,-1),'FrostveilQuest.esp',''].join('\r\n'));

function policy(plugins:Buffer=finalPlugins,loadorder:Buffer=finalLoadorder,managed:readonly{path:string;bytes:Uint8Array}[]=targets):Readonly<RuntimeCohort>{
 const creationFiles=managed.filter(file=>/^Data\/(?:cc[A-Za-z0-9_-]+|_ResourcePack)\.(?:esm|esl)$/i.test(file.path));
 const managedFiles=managed.filter(file=>!creationFiles.includes(file));
 const value:RuntimeCohort={
  schemaVersion:1,kind:'frostveil-steam-runtime',runtime:'1.6.1170.0',appId:'489830',language:'english',
  createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60*60*1000).toISOString(),
  depots:[{id:'489833',manifest:'1914580699073641964'}],
  files:[
   {path:'SkyrimSE.exe',size:runtimeAfter.length,sha256:sha(runtimeAfter),depot:'489833'},
   ...creationFiles.map(file=>({path:file.path,size:file.bytes.length,sha256:sha(file.bytes),depot:'489833'})),
  ],
  creations:creationFiles.map(file=>path.basename(file.path)),managedFiles:[
   {path:'skse64_loader.exe',size:loaderBytes.length,sha256:sha(loaderBytes)},
   {path:'skse64_1_6_1170.dll',size:skseRuntimeBytes.length,sha256:sha(skseRuntimeBytes)},
   ...managedFiles.map(file=>({path:file.path,size:file.bytes.length,sha256:sha(file.bytes)})),
  ],
  pluginOrder:plugins.toString().replace(/^\uFEFF/,'').split(/\r?\n/).filter(name=>name.startsWith('*')).map(name=>name.slice(1)),
  configuration:{pluginsBase64:plugins.toString('base64'),loadorderBase64:loadorder.toString('base64')},
  helper:{version:'3.4.0',size:1,sha256:sha('fixture helper')},acquisition:{verified:true,receiptSha256:sha('fixture receipt')},
 };
 const bytes=Buffer.from(JSON.stringify(value));
 return authenticateRuntimeCohort({keyId:'w08',payloadBase64:bytes.toString('base64'),signatureBase64:sign(null,bytes,keys.privateKey).toString('base64')},trust,{fixture:true});
}

async function fixture(t:TestContext,preferences:Buffer|null){
 const grant=await createManagedFixture();t.after(()=>fs.rm(grant.directory,{recursive:true,force:true}));
 const game=grant.installation,config=grant.configDirectory!,source=path.join(grant.payloads,'w08-whole-play-source');
 await fs.mkdir(path.join(game,'Data/Platform/Plugins'),{recursive:true});await fs.mkdir(source,{recursive:true});
 await fs.mkdir(config,{recursive:true});
 await fs.writeFile(path.join(game,'SkyrimSE.exe'),runtimeBefore);
 await fs.writeFile(path.join(game,'skse64_loader.exe'),loaderBytes);
 await fs.writeFile(path.join(game,'skse64_1_6_1170.dll'),skseRuntimeBytes);
 await fs.writeFile(path.join(config,'plugins.txt'),originalPlugins);await fs.writeFile(path.join(config,'loadorder.txt'),originalLoadorder);
 for(const file of targets){
  const destination=path.join(game,file.path);
  const before=file.path==='Data/Skyrim.esm'?gameMaster:Buffer.from('original '+file.path);
  await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,before);
  const staged=path.join(source,file.path.replaceAll('/',path.sep));await fs.mkdir(path.dirname(staged),{recursive:true});await fs.writeFile(staged,file.bytes);
 }
 const prefsPath=path.join(grant.directory,'Documents','My Games','Skyrim Special Edition','SkyrimPrefs.ini');
 await fs.mkdir(path.dirname(prefsPath),{recursive:true});
 if(preferences)await fs.writeFile(prefsPath,preferences);else await fs.rm(prefsPath,{force:true});
 const signed=policy();let acquisitions=0,policyLoads=0;
 let duringAcquire:(()=>Promise<void>)|undefined;
 const stagedRuntime=path.join(source,'SkyrimSE.exe');await fs.writeFile(stagedRuntime,runtimeAfter);
 const stagedLoader=path.join(source,'skse64_loader.exe');await fs.writeFile(stagedLoader,loaderBytes);
 const stagedSkse=path.join(source,'skse64_1_6_1170.dll');await fs.writeFile(stagedSkse,skseRuntimeBytes);
 const executable=path.join(game,'SkyrimSE.exe'),stagedExecutable=path.join(grant.payloads,'runtime-staging',sha(runtimeAfter));
 const versionProbes:string[]=[];
 let executableVersion='1.6.1170.0',driftAt:string|undefined,stopAfterJournal=false;
 let corruptOriginalBlob=false,corrupted=false,interruptWriter:string|undefined,interrupted=false,addLateUnknown=false;
 class FixturePreparation extends RuntimePreparation{
  protected override async runtimeTarget(g:string,c:string){assert.equal(g,game);assert.equal(c,config);return{grant,guard:async()=>false,steamStamp:sha('synthetic Steam identity')};}
  protected override async loadPolicy(){policyLoads++;return signed;}
  protected override async acquire(value:Readonly<RuntimeCohort>,_destination:string,signal:AbortSignal,requested:readonly string[]){
   signal.throwIfAborted();assert.equal(value,signed);acquisitions++;
   assert.deepEqual([...requested].sort(),['SkyrimSE.exe']);await duringAcquire?.();return source;
  }
  protected override async runtimeVersion(file:string){
   assert.ok([executable,stagedExecutable].includes(file));
   assert.deepEqual(await fs.readFile(file),runtimeAfter);
   versionProbes.push(file);
   return executableVersion;
  }
  protected override async wholePlayCheckpoint(stage:string,file?:string,writer?:string){
   if(stopAfterJournal&&stage==='after-preimages-commit'){
    stopAfterJournal=false;
    throw Error('Fixture interruption after journal publication');
   }
   if(driftAt===stage){
    driftAt=undefined;
    const replacement=stagedExecutable+'.replacement';
    await fs.copyFile(stagedExecutable,replacement);
    await fs.rename(replacement,stagedExecutable);
   }
   if(addLateUnknown&&stage==='before-ready'){
    addLateUnknown=false;await fs.writeFile(path.join(game,'Data/late-unreviewed.esp'),tes4());
   }
   if(interruptWriter!==undefined&&writer===interruptWriter&&!interrupted&&stage==='after-target-write'){
    interrupted=true;throw Error('Fixture interruption at writer '+writer);
   }
   if(!corruptOriginalBlob||corrupted||stage!=='after-target-write'||file!=='SkyrimSE.exe')return;
   const journalPath=path.join(grant.metadata,'runtime-preparation/journal.json');
   const relativeJournal=path.relative(grant.metadata,journalPath).split(path.sep).join('/');
   const journal=await (await MetadataStore.create(grant)).read(relativeJournal) as {files:Array<{path:string;before?:{sha256:string}}>};
   const before=journal.files.find(item=>item.path==='SkyrimSE.exe')?.before;
   assert.ok(before);await fs.writeFile(path.join(grant.payloads,'runtime-backups',before.sha256),Buffer.from('corrupted original blob'));
   corrupted=true;throw Error('Fixture interruption after first target write');
  }
 }
 const runtime=new FixturePreparation(grant.directory,path.join(grant.directory,'unused-policy.json'),path.dirname(prefsPath));
 const sourceByPath=new Map<string,string>([['SkyrimSE.exe',stagedRuntime],['skse64_loader.exe',stagedLoader],['skse64_1_6_1170.dll',stagedSkse]]);
 for(const target of targets)sourceByPath.set(target.path,path.join(source,target.path.replaceAll('/',path.sep)));
 const write=(name:string,bytes:Buffer,writer?:string):PlayWrite=>({path:name,source:sourceByPath.get(name)!,sha256:sha(bytes),size:bytes.length,...(writer?{writer}:{})});
 const makeProfileSource=async(file:string,bytes:Buffer)=>{const output=path.join(source,'profiles',file);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,bytes);return output;};
 let profileConflict=false,finalFailure=false,latestRelease='pack-v1',packCalls=0,verifiedWrites=0,scans=0;
 const admittedRelease='pack-v1';
 const adapters:PlayAdapters<Scan>={
  legacyGraphics:async()=>({authority:'fixture legacy graphics cohort',writes:[write('Data/LegacyGraphics.ini',graphics,'legacy-graphics')]}),
  sourceGraphics:async()=>({authority:'fixture source graphics cohort',writes:[write('Data/FrostveilWorld.esp',sourceGraphics,'source-graphics')]}),
  client:async()=>({authority:'fixture client pin',writes:[write('Data/Platform/Plugins/skymp5-client.js',client,'client')]}),
  pack:async projection=>{
   packCalls++;const projected=await projection.projectedFile('Data/FrostveilQuest.esp');assert.ok(projected);
   const sourcePlugins=await makeProfileSource('pack-plugins.txt',profileConflict?Buffer.from('*FrostveilQuest.esp\r\n# byte difference\r\n'):finalPlugins);
   const sourceLoadorder=await makeProfileSource('pack-loadorder.txt',finalLoadorder);
   const selected=latestRelease;
   return{
    cohortId:selected,baseline,authority:'fixture signed pack '+selected,
    writes:[write('Data/FrostveilQuest.esp',quest,'pack'),
     {path:'@config/plugins.txt',source:sourcePlugins,sha256:sha(await fs.readFile(sourcePlugins)),size:(await fs.stat(sourcePlugins)).size},
     {path:'@config/loadorder.txt',source:sourceLoadorder,sha256:sha(finalLoadorder),size:finalLoadorder.length}],
    revalidate:async()=>{assert.equal(selected,admittedRelease);},
    verifyInstalled:async()=>{verifiedWrites++;if(finalFailure)throw Error('Fixture final verification failed');assert.equal(selected,admittedRelease);},
   };
  },
  scan:async selected=>{scans++;assert.equal(selected,baseline);return{directory:game,ready:true,runtime:'1.6.1170.0',skseLoader:'2.2.6',skseRuntime:'1.6.1170.0',nativeLauncherAvailable:true,files:[],errors:[],scannedAt:new Date().toISOString()};},
 };
 const targetImages=async()=>{
  const files:string[]=['SkyrimSE.exe',...targets.map(item=>item.path),'@config/plugins.txt','@config/loadorder.txt'];
  const images=[];
  for(const name of files){const full=name.startsWith('@config/')?path.join(config,name.slice(8)):path.join(game,name);const stat=await fs.stat(full,{bigint:true});images.push({name,hash:sha(await fs.readFile(full)),dev:String(stat.dev),ino:String(stat.ino)});}
  return images;
 };
 const journalPath=path.join(grant.metadata,'runtime-preparation/journal.json');
 const snapshot=async()=>({images:await targetImages(),journal:sha(await fs.readFile(journalPath))});
 return{grant,game,config,runtime,adapters,prefsPath,preferences,snapshot,
  targetImages,journalPath,versionProbes,executable,stagedExecutable,
  duringAcquire:(action:()=>Promise<void>)=>{duringAcquire=action;},
  setExecutableVersion:(version:string)=>{executableVersion=version;},
  swapExecutableBeforeJournal:()=>{driftAt='before-preimages-commit';},
  interruptAfterJournal:()=>{stopAfterJournal=true;},
  swapExecutableBeforeFirstWrite:()=>{driftAt='before-target-write';},
  stats:()=>({acquisitions,policyLoads,packCalls,verifiedWrites,scans}),
  setProfileConflict:(value:boolean)=>{profileConflict=value;},
  switchRelease:(tag:string)=>{latestRelease=tag;},
  setFinalFailure:(value:boolean)=>{finalFailure=value;},
  interruptAt:(writer:string)=>{interruptWriter=writer;},
  addLateUnknown:()=>{addLateUnknown=true;},
  corruptNextOriginalBlob:()=>{corruptOriginalBlob=true;},
  restart:()=>new FixturePreparation(grant.directory,path.join(grant.directory,'unused-policy.json'),path.dirname(prefsPath)),
 };
}

test('W03 admission Whole Play refuses a signed replacement with wrong version before journaling or writes',async t=>{
 const f=await fixture(t,null),before=await f.targetImages();
 f.setExecutableVersion('1.6.640.0');
 let spawns=0;
 const launch=new GameLauncher(async()=>false,async()=>{spawns++;});
 await assert.rejects(launch.play(()=>preparePlay(f.runtime,f.game,f.config,f.adapters)),/runtime version/i);
 assert.deepEqual(await f.targetImages(),before);
 assert.deepEqual(f.versionProbes,[f.stagedExecutable]);
 await assert.rejects(fs.stat(f.journalPath),{code:'ENOENT'});
 assert.equal(spawns,0);
});

test('W03 admission Whole Play fences staged executable identity after version probe',async t=>{
 const f=await fixture(t,null),before=await f.targetImages();
 f.swapExecutableBeforeJournal();
 await assert.rejects(preparePlay(f.runtime,f.game,f.config,f.adapters),/runtime executable.*changed/i);
 assert.deepEqual(await f.targetImages(),before);
 await assert.rejects(fs.stat(f.journalPath),{code:'ENOENT'});
 assert.deepEqual(f.versionProbes,[f.stagedExecutable]);
});

test('W03 admission Whole Play pending forward resume verifies installed executable and preserves journal on refusal',async t=>{
 const f=await fixture(t,null);f.interruptAt('runtime');
 await assert.rejects(preparePlay(f.runtime,f.game,f.config,f.adapters),/fixture interruption/i);
 const pending=await f.snapshot();
 f.setExecutableVersion('1.6.640.0');
 let spawns=0;
 const launch=new GameLauncher(async()=>false,async()=>{spawns++;});
 await assert.rejects(launch.play(()=>preparePlay(f.restart(),f.game,f.config,f.adapters)),/runtime version/i);
 assert.deepEqual(await f.snapshot(),pending);
 assert.equal(f.versionProbes.at(-1),f.executable);
 assert.equal(spawns,0);
 await f.restart().restore(f.game,f.config);
 assert.deepEqual(await fs.readFile(f.executable),runtimeBefore);
});

test('W03 admission leaves a prepared Whole Play journal intact on executable drift before its first write',async t=>{
 const f=await fixture(t,null);
 f.interruptAfterJournal();
 await assert.rejects(preparePlay(f.runtime,f.game,f.config,f.adapters),/interruption after journal publication/);
 const pending=await f.snapshot();
 const journalBefore=await fs.stat(f.journalPath,{bigint:true});
 f.swapExecutableBeforeFirstWrite();
 await assert.rejects(preparePlay(f.restart(),f.game,f.config,f.adapters),/runtime executable.*changed/i);
 assert.deepEqual(await f.snapshot(),pending);
 assert.equal((await fs.stat(f.journalPath,{bigint:true})).ino,journalBefore.ino);
 await f.restart().restore(f.game,f.config);
 assert.deepEqual(await fs.readFile(f.executable),runtimeBefore);
});

test('normal Play composes writers once, preserves preferences, skips warm target writes, and restores the original images after restart',async t=>{
 const prefs=Buffer.from('[General]\r\nfMaxTime=1.0\r\n'),f=await fixture(t,prefs);
 const first=await preparePlay(f.runtime,f.game,f.config,f.adapters);assert.equal(first.ready,true);
 const afterCold=await f.snapshot();assert.deepEqual(await fs.readFile(f.prefsPath),prefs);
 const calls=f.stats();assert.equal(calls.policyLoads,1);assert.equal(calls.acquisitions,1);assert.equal(calls.packCalls,1);assert.equal(calls.scans,1);
 const launch=new GameLauncher(async()=>false,async(exe)=>{assert.equal(exe,path.join(f.game,'skse64_loader.exe'));});
 await launch.play(()=>preparePlay(f.runtime,f.game,f.config,f.adapters));assert.equal(f.stats().scans,2);
 const warm=await f.snapshot();assert.deepEqual(warm.images,afterCold.images);
 const restarted=f.restart();
 const restored=await restorePlay(restarted,f.game,f.config,async()=>({state:'idle'}));
 assert.deepEqual(restored,{state:'idle'});
 assert.equal(await fs.readFile(f.prefsPath,'utf8'),prefs.toString());
 assert.equal(await fs.readFile(path.join(f.game,'SkyrimSE.exe'),'utf8'),'original inert runtime');
 assert.deepEqual(await fs.readFile(path.join(f.config,'plugins.txt')),originalPlugins);
 assert.deepEqual(await fs.readFile(path.join(f.config,'loadorder.txt')),originalLoadorder);
 assert.equal(f.stats().policyLoads,calls.policyLoads+1);
 assert.equal(f.stats().acquisitions,calls.acquisitions);
 assert.equal(f.stats().packCalls,calls.packCalls+1);
 void afterCold;
});

test('normal Play preserves an absent Skyrim preferences file',async t=>{
 const f=await fixture(t,null);
 await preparePlay(f.runtime,f.game,f.config,f.adapters);
 await assert.rejects(fs.stat(f.prefsPath),{code:'ENOENT'});
});

test('same active plugin order with different profile bytes is refused before runtime or profile target writes and never spawns',async t=>{
 const f=await fixture(t,Buffer.from('[General]\r\nKeep=1\r\n'));f.setProfileConflict(true);
 let spawns=0;const launch=new GameLauncher(async()=>false,async()=>{spawns++;});
 await assert.rejects(launch.play(()=>preparePlay(f.runtime,f.game,f.config,f.adapters)),/writer|profile|signed|configuration/i);
 assert.equal(spawns,0);assert.equal(f.stats().scans,0);
 assert.equal(await fs.readFile(path.join(f.game,'SkyrimSE.exe'),'utf8'),'original inert runtime');
 assert.deepEqual(await fs.readFile(path.join(f.config,'plugins.txt')),originalPlugins);
 assert.deepEqual(await fs.readFile(path.join(f.config,'loadorder.txt')),originalLoadorder);
 assert.deepEqual(await fs.readFile(f.prefsPath,'utf8'),'[General]\r\nKeep=1\r\n');
});

test('a final pack verification failure prevents Ready and spawn while retaining recoverable preimages',async t=>{
 const f=await fixture(t,Buffer.from('player prefs'));f.setFinalFailure(true);
 let spawns=0;const launch=new GameLauncher(async()=>false,async()=>{spawns++;});
 await assert.rejects(launch.play(()=>preparePlay(f.runtime,f.game,f.config,f.adapters)),/final verification/i);
 assert.equal(spawns,0);assert.equal(f.stats().scans,0);
 const after=await f.snapshot();assert.notDeepEqual(after.images.find(file=>file.name==='SkyrimSE.exe')?.hash,sha(runtimeBefore));
 await f.runtime.restore(f.game,f.config);
 assert.equal(await fs.readFile(path.join(f.game,'SkyrimSE.exe'),'utf8'),'original inert runtime');
 assert.equal(await fs.readFile(f.prefsPath,'utf8'),'player prefs');
});

test('corrupt original blob is refused on interrupted restart before further writes or journal mutation',async t=>{
 const f=await fixture(t,null);f.corruptNextOriginalBlob();
 await assert.rejects(preparePlay(f.runtime,f.game,f.config,f.adapters),/fixture interruption/i);
 assert.deepEqual(await fs.readFile(path.join(f.game,'SkyrimSE.exe')),runtimeAfter);
 const journalPath=path.join(f.grant.metadata,'runtime-preparation/journal.json');
 const journalBefore=await fs.readFile(journalPath);const targetBefore=await fs.readFile(path.join(f.game,'Data/LegacyGraphics.ini'));
 await assert.rejects(preparePlay(f.restart(),f.game,f.config,f.adapters),/blob|backup|integrity/i);
 assert.deepEqual(await fs.readFile(path.join(f.game,'Data/LegacyGraphics.ini')),targetBefore);
 assert.deepEqual(await fs.readFile(journalPath),journalBefore);
});

test('a release change during the attempt is fenced to the admitted pack cohort',async t=>{
 const f=await fixture(t,null);
 const result=await preparePlay(f.runtime,f.game,f.config,{
  ...f.adapters,
  pack:async projection=>{
   const pack=await f.adapters.pack(projection);
   f.switchRelease('pack-v2');
   return pack;
  },
 });
 assert.equal(result.ready,true);
 assert.equal(f.stats().packCalls,1);
});

test('each whole-Play writer resumes safely after process interruption',async t=>{
 for(const [writer,target,expected] of [
  ['runtime','SkyrimSE.exe',runtimeAfter],['legacy-graphics','Data/LegacyGraphics.ini',graphics],
  ['source-graphics','Data/FrostveilWorld.esp',sourceGraphics],['client','Data/Platform/Plugins/skymp5-client.js',client],
  ['pack','Data/FrostveilQuest.esp',quest],
 ] as const){
  await t.test(writer,async child=>{
   const f=await fixture(child,null);f.interruptAt(writer);
   await assert.rejects(preparePlay(f.runtime,f.game,f.config,f.adapters),new RegExp('Fixture interruption at writer '+writer));
   assert.deepEqual(await fs.readFile(path.join(f.game,target)),expected);
   const resumed=await preparePlay(f.restart(),f.game,f.config,f.adapters);
   assert.equal(resumed.ready,true);
   assert.deepEqual(await fs.readFile(path.join(f.game,target)),expected);
  });
 }
});

test('a late unknown installed asset discovered at the Ready fence blocks Play',async t=>{
 const f=await fixture(t,null);f.addLateUnknown();
 let spawned=false;const launch=new GameLauncher(async()=>false,async()=>{spawned=true;});
 await assert.rejects(launch.play(()=>preparePlay(f.runtime,f.game,f.config,f.adapters)),/unreviewed|unexpected|not authorized|runtime cohort/i);
 assert.equal(spawned,false);assert.equal(f.stats().scans,0);
});

async function legacyGraphicsFixture(t:TestContext,configuration:{plugins:Buffer;loadorder:Buffer;unauthorized?:boolean}){
 const grant=await createManagedFixture();t.after(()=>fs.rm(grant.directory,{recursive:true,force:true}));
 const game=grant.installation,storage=path.join(grant.directory,'launcher-storage'),source=path.join(grant.payloads,'legacy-projection');
 await fs.mkdir(storage,{recursive:true});await fs.mkdir(source,{recursive:true});
 const baseFiles=[
  {path:'d3dx9_42.dll',bytes:Buffer.from('signed base DirectX shim')},
  {path:'Data/Lux.esp',bytes:tes4()},
  {path:'Data/Ulvenwald.esp',bytes:tes4(['Skyrim.esm'])},
  {path:'Data/BlendedRoads.esp',bytes:tes4(['Skyrim.esm'])},
  {path:'Data/FrostveilWorld.esp',bytes:sourceGraphics},
  {path:'Data/FrostveilQuest.esp',bytes:quest},
 ];
 if(configuration.unauthorized)baseFiles.push({path:'Data/UnexpectedGraphics.esp',bytes:tes4()});
 const authorized=configuration.unauthorized?baseFiles.slice(0,-1):baseFiles;
 const uniqueTargets=new Map<string,{path:string;bytes:Uint8Array}>();
 for(const file of [...targets,...graphicsProfileFiles,...authorized])uniqueTargets.set(file.path.toLowerCase(),{path:file.path,bytes:file.bytes});
 const managed=[...uniqueTargets.values()];
 const signed=policy(configuration.plugins,configuration.loadorder,managed);
 const projected=new Map<string,string>();
 for(const file of baseFiles){
  const staged=path.join(source,file.path.replaceAll('/',path.sep));await fs.mkdir(path.dirname(staged),{recursive:true});await fs.writeFile(staged,file.bytes);
  projected.set(file.path.toLowerCase(),staged);
 }
 const manifest:GraphicsManifest={
  version:'fixture-graphics-1',generatedAt:new Date().toISOString(),packageName:'synthetic only',
  downloadUrl:'',size:1,sha256:sha('synthetic archive'),activePlugins:[...graphicMasters,'FrostveilWorld.esp'],
  masterPlugins:graphicMasters,
  integrityFiles:Object.fromEntries(baseFiles.map(file=>[file.path,{size:file.bytes.length,sha256:sha(file.bytes)}])),
 };
 const graphics=new GraphicsPackService(storage);
 graphics.fetchManifest=async()=>manifest;
 const projection={
  policy:signed,signal:new AbortController().signal,
  projectedFile:async(relative:string)=>projected.get(relative.toLowerCase())??null,
 };
 return{game,graphics,projection,baseFiles};
}

test('the legacy graphics planner accepts only outputs authorized by runtime and signed profile bytes',async t=>{
 const f=await legacyGraphicsFixture(t,{plugins:graphicPlugins,loadorder:graphicLoadorder});
 const plan=await f.graphics.planWholePlay(f.projection,new Set(f.projection.policy.managedFiles.map(file=>file.path.toLowerCase())));
 assert.equal(plan.writes.length,0);
 assert.ok(plan.authority);
 assert.equal(plan.writes.some(write=>write.path==='@config/plugins.txt'||write.path==='@config/loadorder.txt'),false);
});

test('legacy graphics activation with the same active order and different signed profile bytes is refused',async t=>{
 const differing=Buffer.from(graphicPlugins.toString().replace('*SkyUI_SE.esp\r\n','*SkyUI_SE.esp\r\n# bytes differ\r\n'));
 const f=await legacyGraphicsFixture(t,{plugins:differing,loadorder:graphicLoadorder});
 await assert.rejects(()=>f.graphics.planWholePlay(f.projection),/differs from the exact signed runtime profile bytes/i);
});

test('legacy graphics refuses reversed Creation slots before observing projected files',async t=>{
 const order=graphicLoadorder.toString().replace('ccBGSSSE025-AdvDSGS.esm','__CREATION_SLOT__')
  .replace('ccQDRSSE001-SurvivalMode.esl','ccBGSSSE025-AdvDSGS.esm')
  .replace('__CREATION_SLOT__','ccQDRSSE001-SurvivalMode.esl');
 const f=await legacyGraphicsFixture(t,{plugins:graphicPlugins,loadorder:Buffer.from(order)});
 let observed=false;
 f.projection.projectedFile=async()=>{observed=true;return null;};
 await assert.rejects(()=>f.graphics.planWholePlay(f.projection),/exact signed runtime profile bytes/i);
 assert.equal(observed,false);
});

test('a legacy graphics output outside the authenticated runtime inventory is refused during planning',async t=>{
 const f=await legacyGraphicsFixture(t,{plugins:graphicPlugins,loadorder:graphicLoadorder,unauthorized:true});
 await assert.rejects(()=>f.graphics.planWholePlay(f.projection),/not authorized by the signed runtime/i);
});

test('W02 Whole Play acquisition leaves the transaction lease available',async t=>{
 const f=await fixture(t,null);
 let inspected=false;
 f.duringAcquire(async()=>{
  const store=await MetadataStore.create(f.grant);
  const release=await store.lease();
  try{inspected=true;}finally{await release();}
 });
 await preparePlay(f.runtime,f.game,f.config,f.adapters);
 assert.equal(inspected,true);
});

test('W02 Whole Play refuses a target preimage edit during acquisition',async t=>{
 const f=await fixture(t,null),modified=Buffer.from('external edit during acquisition');
 const pathChanged=path.join(f.config,'plugins.txt');
 f.duringAcquire(async()=>{await fs.writeFile(pathChanged,modified);});
 await assert.rejects(preparePlay(f.runtime,f.game,f.config,f.adapters),/preimage changed during acquisition/i);
 assert.deepEqual(await fs.readFile(pathChanged),modified);
 assert.deepEqual(await fs.readFile(f.executable),runtimeBefore);
 await assert.rejects(fs.stat(f.journalPath),{code:'ENOENT'});
});
function simulateSharedVolumePressure(t:TestContext, directory:string){
 const statfs=fs.statfs;
 let freeBlocks=1_000_000;
 const observed:number[]=[];
 t.mock.method(fs,'statfs',async (root:string)=>{
  assert.ok(path.isAbsolute(root));
  assert.equal(path.parse(root).root,path.parse(directory).root);
  const real=await statfs(root);
  observed.push(freeBlocks);
  return {...real,bsize:4096,bavail:freeBlocks};
 });
 return {consume:()=>{freeBlocks=32;},observed};
}

test('W02 independent offline Restore and later same-volume pressure stop Whole Play before staging',async t=>{
 const f=await fixture(t,null),other=await fixture(t,null);
 const before=await f.targetImages(),otherBefore=await other.targetImages();
 const device=async (root:string)=>(await fs.stat(root,{bigint:true})).dev;
 assert.equal(await device(f.grant.payloads),await device(other.grant.payloads));
 await preparePlay(other.runtime,other.game,other.config,other.adapters);
 const otherCalls=other.stats().policyLoads;
 const space=simulateSharedVolumePressure(t,f.grant.directory);
 f.duringAcquire(async()=>{
  await other.restart().restore(other.game,other.config);
  space.consume();
 });
 await assert.rejects(preparePlay(f.runtime,f.game,f.config,f.adapters),/Insufficient disk space for whole-Play/);
 assert.ok(space.observed.includes(32));
 assert.deepEqual(await f.targetImages(),before);
 await assert.rejects(fs.stat(f.stagedExecutable),{code:'ENOENT'});
 await assert.rejects(fs.stat(f.journalPath),{code:'ENOENT'});
 assert.deepEqual((await other.targetImages()).map(file=>file.hash),otherBefore.map(file=>file.hash));
 assert.equal(other.stats().policyLoads,otherCalls);
});

test('W02 pressure after staging stops Whole Play before Apply and retains offline recovery',async t=>{
 const f=await fixture(t,null),before=await f.targetImages();
 const space=simulateSharedVolumePressure(t,f.grant.directory);
 const original=f.adapters.pack;
 f.adapters.pack=async projection=>{
  const result=await original(projection);
  return {...result,revalidate:async()=>{
   await result.revalidate?.();
   try{await fs.stat(f.journalPath);}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
   space.consume();
  }};
 };
 await assert.rejects(preparePlay(f.runtime,f.game,f.config,f.adapters),/Insufficient disk space for whole-Play/);
 assert.deepEqual(await f.targetImages(),before);
 const policyLoads=f.stats().policyLoads;
 await f.restart().restore(f.game,f.config);
 assert.deepEqual(await f.targetImages(),before);
 assert.equal(f.stats().policyLoads,policyLoads);
 assert.ok(space.observed.includes(32));
});
