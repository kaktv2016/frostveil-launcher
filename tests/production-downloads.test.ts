import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import http from 'node:http';
import * as api from '../src/main/updates';import {fixture,keyId,publicKey,envelope} from './distribution-fixture';
import {createHash} from 'node:crypto';
import type {ServerProfile} from '../src/shared/modpack-contracts';
const functions=api as any;
test('Play activates shared quest ESP before existing SkyUI and repairs later order drift without redownloading',async()=>{
 const f=await setup(),s=new functions.ProductionDownloads(f.storage,'0.1.9',f.source,f.provider);
 try{const {game,order}=await seedPlayer(f),bytes=await fs.readFile('../mod-work/frostveil-courier-navigation/payload/Data/FrostveilCourierNavigation.esp'),sha256=createHash('sha256').update(bytes).digest('hex');
  const template=f.pack.manifest.files.find(x=>x.package)!;const file={...structuredClone(template),path:'Data/FrostveilCourierNavigation.esp',role:'shared-plugin' as const,size:bytes.length,sha256,package:{...template.package!,assetId:999,assetName:'FrostveilCourierNavigation.esp',size:bytes.length,sha256}};
  f.pack.manifest.files.push(file);const plugin={filename:'FrostveilCourierNavigation.esp',order:1,required:true,role:'server-required' as const,masters:['Skyrim.esm'],sha256};f.pack.manifest.requiredPlugins.push(plugin);(f.pack.server as ServerProfile).plugins.push({...plugin,size:bytes.length,crc32:0,light:false,headerVerified:true});f.pack.payloads.set(999,bytes);
  Object.assign(f.pack.envelope,envelope(f.pack.manifest,f.pack.server));f.pack.metadata.assets.find(a=>a.id===100)!.size=Buffer.byteLength(JSON.stringify(f.pack.envelope));f.pack.metadata.assets.push({id:999,name:file.package.assetName,size:bytes.length,state:'uploaded',digest:'sha256:'+sha256});
  const sky=Buffer.alloc(24);sky.write('TES4');await fs.writeFile(path.join(game,'Data/SkyUI_SE.esp'),sky);await fs.writeFile(path.join(order,'plugins.txt'),'# Existing UI\r\n*SkyUI_SE.esp\r\n');await fs.writeFile(path.join(order,'loadorder.txt'),'SkyUI_SE.esp\r\n');
  await s.prepareForPlay(game,order);let active=await fs.readFile(path.join(order,'plugins.txt'),'utf8');assert.ok(active.indexOf('*FrostveilCourierNavigation.esp')<active.indexOf('*SkyUI_SE.esp'));
  assert.match(await fs.readFile(path.join(order,'loadorder.txt'),'utf8'),/FrostveilCourierNavigation\.esp\r?\nSkyUI_SE\.esp/);const downloads=f.requests();
  await fs.writeFile(path.join(order,'plugins.txt'),'*SkyUI_SE.esp\r\n*FrostveilCourierNavigation.esp\r\n');await fs.writeFile(path.join(order,'loadorder.txt'),'SkyUI_SE.esp\r\nFrostveilCourierNavigation.esp\r\n');await s.prepareForPlay(game,order);active=await fs.readFile(path.join(order,'plugins.txt'),'utf8');assert.ok(active.indexOf('*FrostveilCourierNavigation.esp')<active.indexOf('*SkyUI_SE.esp'));assert.equal(f.requests(),downloads);
 }finally{s.dispose();await f.close();}
});
async function seedPlayer(f:Awaited<ReturnType<typeof setup>>){
 const game=path.join(f.storage,'player'),order=path.join(f.storage,'order');
 await fs.cp(f.pack.grant.installation,game,{recursive:true});await fs.mkdir(order,{recursive:true});
 await fs.writeFile(path.join(order,'plugins.txt'),'# existing order\r\n');return{game,order};
}
async function setup(){
 const pack=await fixture(),storage=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-player-downloads-'));let requests=0;
 const server=http.createServer((req,res)=>{if(req.url?.endsWith('/releases/latest'))res.end(JSON.stringify(pack.metadata));else if(req.url?.endsWith('/assets/100'))res.end(JSON.stringify(pack.envelope));else{requests++;res.end(pack.payloads.get(Number(req.url?.split('/').at(-1))));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const transport=functions.DistributionTransport.loopback('http://127.0.0.1:'+(server.address() as any).port,'sandbox-test');
 const source={mode:'sandbox-test',packId:pack.manifest.packId,channel:'stable',keys:{[keyId]:{publicKey,environment:'test',revoked:false}},permittedReviews:[]};
 return{pack,storage,source,gameEntries:await fs.readdir(pack.grant.installation),provider:()=>new functions.GitHubDistributionProvider(transport),requests:()=>requests,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(storage,{recursive:true,force:true});}};
}

test('Play preparation repairs every signed pack file, detects tampering, and skips unchanged bytes',async()=>{
 const f=await setup(),s=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{const {game,order}=await seedPlayer(f);assert.equal(typeof s.prepareForPlay,'function');
  await s.prepareForPlay(game,order);assert.equal(s.snapshot().installed,true);assert.equal(f.requests(),2);
  const file=f.pack.manifest.files.find(x=>x.package)!,target=path.join(game,file.path);await fs.utimes(target,100000,100000);
  await s.prepareForPlay(game,order);assert.equal((await fs.stat(target)).mtimeMs,100000000);assert.equal(f.requests(),2);
  await fs.writeFile(target,'tampered');await s.prepareForPlay(game,order);assert.equal(await fs.readFile(target,'utf8'),f.pack.payloads.get(file.package!.assetId)!.toString());
  await fs.unlink(target);await s.prepareForPlay(game,order);assert.ok(await fs.stat(target));
 }finally{s.dispose();await f.close();}
});

test('Play preparation refuses missing external dependencies and a running game before writing',async()=>{
 const f=await setup(),s=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider,async()=>true);
 try{const {game,order}=await seedPlayer(f);assert.equal(typeof s.prepareForPlay,'function');await assert.rejects(()=>s.prepareForPlay(game,order),/running/i);assert.equal(f.requests(),0);
  const idle=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);try{const external=f.pack.manifest.files.find(x=>x.required&&x.distribution==='external-only')!;await fs.unlink(path.join(game,external.path));await assert.rejects(()=>idle.prepareForPlay(game,order),/external|dependency/i);assert.equal(f.requests(),0);assert.equal(idle.snapshot().installed,false);}finally{idle.dispose();}
 }finally{s.dispose();await f.close();}
});

test('Play preparation rejects untrusted metadata',async()=>{
 const f=await setup(),s=new functions.ProductionDownloads(f.storage,'0.1.7',{...f.source,keys:{}},f.provider);
 try{const {game,order}=await seedPlayer(f);assert.equal(typeof s.prepareForPlay,'function');await assert.rejects(()=>s.prepareForPlay(game,order));assert.equal(f.requests(),0);
 }finally{s.dispose();await f.close();}
});

test('Play repairs only the missing asset, backs up replaced bytes, and adopts a newer signed pack',async()=>{
 const f=await setup(),s=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{const {game,order}=await seedPlayer(f),files=f.pack.manifest.files.filter(x=>x.package);
  const kept=files[0]!,missing=files[1]!;await fs.mkdir(path.dirname(path.join(game,kept.path)),{recursive:true});await fs.writeFile(path.join(game,kept.path),f.pack.payloads.get(kept.package!.assetId)!);
  await s.prepareForPlay(game,order);assert.equal(f.requests(),1,'Only the absent file is acquired');
  const target=path.join(game,missing.path);await fs.writeFile(target,'owner modified bytes');await s.prepareForPlay(game,order);
  const backupRoot=path.join(f.storage,'auto-repair-backups');const backups=await fs.readdir(backupRoot,{recursive:true});const preserved=await Promise.all(backups.filter(p=>p.endsWith(path.basename(target))).map(p=>fs.readFile(path.join(backupRoot,p),'utf8')));assert.ok(preserved.includes('owner modified bytes'));
  Object.assign(f.pack,await fixture(2,f.pack.grant));await s.prepareForPlay(game,order);assert.equal(s.snapshot().version,'1.0.2');assert.equal(f.requests(),3);
 }finally{s.dispose();await f.close();}
});

test('Play refuses redirected Data directories and concurrent preparations',async()=>{
 const f=await setup(),s=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{const {game,order}=await seedPlayer(f);const first=s.prepareForPlay(game,order);await assert.rejects(()=>s.prepareForPlay(game,order),/progress/);await first;
  const data=path.join(game,'Data'),elsewhere=path.join(f.storage,'redirected');await fs.rename(data,elsewhere);await fs.symlink(elsewhere,data,process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>s.prepareForPlay(game,order),/Redirected/);assert.equal(s.snapshot().installed,false);
 }finally{s.dispose();await f.close();}
});

test('Cancel during Play preflight never installs files or returns launch readiness',async()=>{
 const f=await setup(),s=new functions.ProductionDownloads(f.storage,'0.1.8',f.source,f.provider);
 try{const {game,order}=await seedPlayer(f),before=await fs.readdir(game,{recursive:true});const preparation=s.prepareForPlay(game,order);s.cancel();await assert.rejects(()=>preparation,/cancel/i);assert.equal(f.requests(),0);assert.equal(s.snapshot().installed,false);assert.equal(s.snapshot().phase,'cancelled');assert.deepEqual(await fs.readdir(game,{recursive:true}),before);
 }finally{s.dispose();await f.close();}
});
test('trusted production acquisition stages actual bytes without selecting or writing a game installation',async()=>{
 assert.equal(typeof functions.ProductionDownloads,'function');const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{await service.download();const state=service.snapshot();assert.equal(state.phase,'complete');assert.equal(state.signature,'AUTHENTICATED');assert.equal(state.installed,false);assert.equal(state.files.length,2);assert.ok(state.files.every((x:any)=>x.verified));assert.equal(f.requests(),2);assert.deepEqual(await fs.readdir(f.pack.grant.installation),f.gameEntries);
  const reopened=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);await reopened.download();assert.equal(f.requests(),2,'Authenticated cache reused after service restart');reopened.dispose();
 }finally{service.dispose();await f.close();}
});
test('downloaded payloads may be copied into a generated managed cache while game content remains absent',async()=>{
 assert.equal(typeof functions.ProductionDownloads,'function');const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{await service.download();const ref=f.pack.manifest.files.find(x=>x.package)!.package!;await fs.unlink(path.join(f.pack.grant.payloads,ref.sha256+'.bin'));const file=await service.stage(f.pack.grant,ref);assert.equal((await fs.stat(file)).nlink,1);assert.equal(await fs.readFile(file,'utf8'),f.pack.payloads.get(ref.assetId)!.toString());assert.deepEqual(await fs.readdir(f.pack.grant.installation),f.gameEntries);}finally{service.dispose();await f.close();}
});
test('an unknown publisher is rejected before any payload acquisition and cannot report installed',async()=>{
 assert.equal(typeof functions.ProductionDownloads,'function');const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',{...f.source,keys:{}},f.provider);
 try{await service.download();assert.equal(service.snapshot().phase,'error');assert.equal(service.snapshot().installed,false);assert.equal(f.requests(),0);}finally{service.dispose();await f.close();}
});
test('a forged persisted download pointer cannot be adopted as a game or metadata target',async()=>{
 assert.equal(typeof functions.ProductionDownloads,'function');const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{await fs.writeFile(path.join(f.storage,'production-downloads.json'),JSON.stringify({directory:f.pack.grant.installation,id:f.pack.grant.id}));await service.download();assert.equal(service.snapshot().phase,'error');assert.equal(f.requests(),0);assert.deepEqual(await fs.readdir(f.pack.grant.installation),f.gameEntries);}finally{service.dispose();await f.close();}
});
test('payload substitutions are refused even when a valid previous download pointer exists',async()=>{
 assert.equal(typeof functions.ProductionDownloads,'function');const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{await service.download();const pointer=JSON.parse(await fs.readFile(path.join(f.storage,'production-downloads.json'),'utf8')),ref=f.pack.manifest.files.find(x=>x.package)!.package!;await fs.writeFile(path.join(pointer.directory,'packages',ref.sha256+'.bin'),'modified');await service.download();assert.equal(service.snapshot().phase,'error');assert.equal(service.snapshot().installed,false);}finally{service.dispose();await f.close();}
});
test('new-player L1 baseline derives only from signed external requirements and never authorizes their download',async()=>{
 const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{assert.equal(typeof service.baselineProfile,'function');
  const native=f.pack.manifest.files.find(x=>x.distribution==='external-only')!;
  for(const p of ['SkyrimSE.exe','skse64_loader.exe','skse64_1_6_1170.dll'])f.pack.manifest.files.push({...native,path:p});
  f.pack.envelope=envelope(f.pack.manifest,f.pack.server);f.pack.metadata.assets[0]!.size=Buffer.byteLength(JSON.stringify(f.pack.envelope));
  const profile=await service.baselineProfile();assert.equal(profile.runtime,'1.6.1170.0');assert.equal(profile.skseVersion,'0.2.2.6');assert.ok(profile.files.some((x:any)=>x.path==='SkyrimSE.exe'));assert.ok(profile.files.some((x:any)=>x.component==='client'));assert.ok(profile.files.every((x:any)=>f.pack.manifest.files.some(f=>f.path===x.path&&f.distribution==='external-only'&&f.sha256===x.sha256)));assert.equal(f.requests(),0);
 }finally{service.dispose();await f.close();}
});
test('public baseline discovery preserves the same-version mutation ledger used by downloads',async()=>{
 const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{await service.download();assert.equal(service.snapshot().phase,'complete');f.pack.manifest.generatedAt=new Date(Date.now()+1000).toISOString();f.pack.envelope=envelope(f.pack.manifest,f.pack.server);f.pack.metadata.assets[0]!.size=Buffer.byteLength(JSON.stringify(f.pack.envelope));await assert.rejects(()=>service.baselineProfile(),/same.version|mutation|content/i);}finally{service.dispose();await f.close();}
});

for(const reopen of [false,true])test('a completely removed temporary acquisition cache is safely replaced '+(reopen?'after restart':'in the same session'),async()=>{
 const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);let active=service;
 try{await service.download();const previous=JSON.parse(await fs.readFile(path.join(f.storage,'production-downloads.json'),'utf8'));
  const directory=path.resolve(previous.directory);assert.match(path.basename(directory),/^frostveil-l4a-[a-z0-9]+$/i);assert.equal(path.dirname(directory).toLowerCase(),(await fs.realpath(path.dirname(directory))).toLowerCase());
  await fs.rm(directory,{recursive:true,force:true});
  if(reopen){service.dispose();active=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);}
  await active.download();assert.equal(active.snapshot().phase,'complete',active.snapshot().message);assert.equal(f.requests(),4);const next=JSON.parse(await fs.readFile(path.join(f.storage,'production-downloads.json'),'utf8'));assert.notEqual(next.id,previous.id);assert.notEqual(next.directory,previous.directory);assert.deepEqual(await fs.readdir(f.pack.grant.installation),f.gameEntries);
 }finally{active.dispose();await f.close();}
});

test('missing authentication evidence in an existing cache remains a refusal, never a cache reset',async()=>{
 const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 try{await service.download();const pointer=await fs.readFile(path.join(f.storage,'production-downloads.json'),'utf8'),p=JSON.parse(pointer);await fs.unlink(path.join(p.directory,'metadata/auth-key'));service.dispose();const reopened=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);try{await reopened.download();assert.equal(reopened.snapshot().phase,'error');assert.equal(await fs.readFile(path.join(f.storage,'production-downloads.json'),'utf8'),pointer);assert.equal(f.requests(),2);}finally{reopened.dispose();}}finally{service.dispose();await f.close();}
});

test('installAndActivate copies verified payloads to game Data and activates plugins in plugins.txt',async()=>{
 const f=await setup(),service=new functions.ProductionDownloads(f.storage,'0.1.7',f.source,f.provider);
 const gameDir=await fs.mkdtemp(path.join(os.tmpdir(),'game-test-'));
 const orderDir=await fs.mkdtemp(path.join(os.tmpdir(),'order-test-'));
 try{
  await fs.cp(f.pack.grant.installation,gameDir,{recursive:true});
  const espFile=f.pack.manifest.files.find(x=>x.package)!;
  espFile.path='Data/SkyUI_SE.esp';
  const header=Buffer.alloc(24);header.write('TES4');espFile.size=header.length;espFile.sha256=createHash('sha256').update(header).digest('hex');Object.assign(espFile.package!,{size:header.length,sha256:espFile.sha256});f.pack.payloads.set(espFile.package!.assetId,header);const asset=f.pack.metadata.assets.find(a=>a.id===espFile.package!.assetId)!;Object.assign(asset,{size:header.length,digest:'sha256:'+espFile.sha256});
  f.pack.envelope=envelope(f.pack.manifest,f.pack.server);
  f.pack.metadata.assets[0]!.size=Buffer.byteLength(JSON.stringify(f.pack.envelope));
  assert.equal(await service.isInstalled(gameDir,orderDir),false);
  const result=await service.installAndActivate(gameDir,orderDir);
  assert.equal(result.installed,true);
  assert.equal(result.phase,'complete');
  assert.ok(await fs.stat(path.join(gameDir,'Data','SkyUI_SE.esp')).then(s=>s.isFile()));
  const pluginsText=await fs.readFile(path.join(orderDir,'plugins.txt'),'utf8');
  assert.ok(pluginsText.includes('*SkyUI_SE.esp'));
  await fs.writeFile(path.join(gameDir,'Data','SkyUI_SE.bsa'),'test');
  assert.equal(await service.isInstalled(gameDir,orderDir),true);
 }finally{
  service.dispose();
  await f.close();
  await fs.rm(gameDir,{recursive:true,force:true});
  await fs.rm(orderDir,{recursive:true,force:true});
 }
});
