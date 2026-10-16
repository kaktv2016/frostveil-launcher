import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import http from 'node:http';
import * as api from '../src/main/updates';import {fixture,keyId,publicKey,envelope} from './distribution-fixture';
const functions=api as any;
async function setup(){
 const pack=await fixture(),storage=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-player-downloads-'));let requests=0;
 const server=http.createServer((req,res)=>{if(req.url?.endsWith('/releases/latest'))res.end(JSON.stringify(pack.metadata));else if(req.url?.endsWith('/assets/100'))res.end(JSON.stringify(pack.envelope));else{requests++;res.end(pack.payloads.get(Number(req.url?.split('/').at(-1))));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const transport=functions.DistributionTransport.loopback('http://127.0.0.1:'+(server.address() as any).port,'sandbox-test');
 const source={mode:'sandbox-test',packId:pack.manifest.packId,channel:'stable',keys:{[keyId]:{publicKey,environment:'test',revoked:false}},permittedReviews:[]};
 return{pack,storage,source,gameEntries:await fs.readdir(pack.grant.installation),provider:()=>new functions.GitHubDistributionProvider(transport),requests:()=>requests,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(storage,{recursive:true,force:true});}};
}
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
