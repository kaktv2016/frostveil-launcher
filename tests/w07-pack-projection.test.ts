import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {ProductionDownloads} from '../src/main/management/downloads';
import {validateManifest} from '../src/main/modpack/schema';
import {GitHubDistributionProvider} from '../src/main/distribution/github';
import {DistributionTransport} from '../src/main/distribution/transport';
import type {DistributionSource} from '../src/main/distribution/policy';
import {fixture, envelope, keyId, publicKey} from './distribution-fixture';

const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function tes4(masters:string[]=[],flags=0){const fields=masters.map(name=>{const value=Buffer.from(name+'\0'),field=Buffer.alloc(6);field.write('MAST');field.writeUInt16LE(value.length,4);return Buffer.concat([field,value]);});const body=Buffer.concat(fields),head=Buffer.alloc(24);head.write('TES4');head.writeUInt32LE(body.length,4);head.writeUInt32LE(flags,8);return Buffer.concat([head,body]);}

async function setup(){
 const pack=await fixture(),storage=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-w07-projection-'));let payloadRequests=0,payloadHook:(()=>Promise<void>)|undefined;
 const server=http.createServer(async(req,res)=>{if(req.url?.endsWith('/releases/latest'))res.end(JSON.stringify(pack.metadata));else if(req.url?.endsWith('/assets/100'))res.end(JSON.stringify(pack.envelope));else{payloadRequests++;await payloadHook?.();res.end(pack.payloads.get(Number(req.url?.split('/').at(-1))));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const transport=DistributionTransport.loopback('http://127.0.0.1:'+(server.address() as any).port,'sandbox-test');
 const source:DistributionSource={mode:'sandbox-test',packId:pack.manifest.packId,channel:'stable',keys:{[keyId]:{publicKey,environment:'test',revoked:false}},permittedReviews:[]};
 const service=new ProductionDownloads(storage,'0.1.30',source,()=>new GitHubDistributionProvider(transport));
 const game=path.join(storage,'player'),order=path.join(storage,'order');await fs.cp(pack.grant.installation,game,{recursive:true});await fs.mkdir(order,{recursive:true});await fs.writeFile(path.join(order,'plugins.txt'),'# W07 inert profile\r\n');
 const pluginBytes=tes4(['Skyrim.esm']);const template=pack.manifest.files.find(x=>x.distribution==='allowed')!;const assetId=701,sha256=hash(pluginBytes);
 const file={...structuredClone(template),path:'Data/W07Quest.esp',size:pluginBytes.length,sha256,role:'shared-plugin' as const,package:{...template.package!,assetId,assetName:'W07Quest.esp',size:pluginBytes.length,sha256}};
 pack.manifest.files.push(file);const requirement={filename:'W07Quest.esp',order:1,masters:['Skyrim.esm'],role:'server-required' as const,required:true,sha256};pack.manifest.requiredPlugins.push(requirement);pack.server.plugins.push({...requirement,size:pluginBytes.length,crc32:0,light:false,headerVerified:true} as (typeof pack.server.plugins)[number]);pack.payloads.set(assetId,pluginBytes);pack.metadata.assets.push({id:assetId,name:'W07Quest.esp',size:pluginBytes.length,state:'uploaded',digest:'sha256:'+sha256});
 Object.assign(pack.envelope,envelope(pack.manifest,pack.server));pack.metadata.assets.find(a=>a.id===100)!.size=Buffer.byteLength(JSON.stringify(pack.envelope));
 return{pack,storage,game,order,service,payloadRequests:()=>payloadRequests,onPayload:(hook:()=>Promise<void>)=>payloadHook=hook,close:async()=>{service.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(storage,{recursive:true,force:true});}};
}

test('Play rejects a full-plugin slot shifted by active extra master before any pack target or profile write',async()=>{
 const f=await setup();try{const extra=path.join(f.game,'Data/Extra.esm');await fs.writeFile(extra,tes4(['Skyrim.esm'],1));await fs.writeFile(path.join(f.order,'plugins.txt'),'# profile\r\n*Extra.esm\r\n');
  const before=await fs.readFile(path.join(f.order,'plugins.txt'));const dataBefore=await fs.readdir(path.join(f.game,'Data'));await assert.rejects(()=>f.service.prepareForPlay(f.game,f.order),/index|slot|compatib|plugin/i);
  assert.deepEqual(await fs.readFile(path.join(f.order,'plugins.txt')),before);assert.deepEqual(await fs.readdir(path.join(f.game,'Data')),dataBefore);assert.equal(f.payloadRequests(),3,'verified staging can be retained after a local slot refusal');assert.equal(await fs.stat(path.join(f.storage,'auto-repair-backups')).then(s=>s.isDirectory(),()=>false),false);assert.equal(f.service.snapshot().installed,false);
 }finally{await f.close();}
});

test('Play detects profile drift after staging but before the first pack target or backup write',async()=>{
 const f=await setup();try{const profile=path.join(f.order,'plugins.txt'),original=await fs.readFile(profile);let changed=false;f.onPayload(async()=>{if(!changed){changed=true;await fs.writeFile(profile,'# concurrent profile drift\r\n*Other.esp\r\n');}});
  await assert.rejects(()=>f.service.prepareForPlay(f.game,f.order),/changed|drift|profile|activation/i);assert.equal(changed,true);assert.equal(await fs.stat(path.join(f.game,'Data/W07Quest.esp')).then(()=>true,()=>false),false);assert.deepEqual(await fs.readdir(path.join(f.storage,'auto-repair-backups')).then(x=>x,()=>[]),[]);assert.equal(f.service.snapshot().installed,false);assert.notDeepEqual(await fs.readFile(profile),original);
 }finally{await f.close();}
});

test('Play preserves a light extra and a trailing full plugin while repairing exact staged TES4 bytes and warming to a no-op',async()=>{
 const f=await setup();try{await fs.writeFile(path.join(f.game,'Data/Extra.esl'),tes4(['Skyrim.esm'],0x200));await fs.writeFile(path.join(f.game,'Data/Trailing.esp'),tes4(['Skyrim.esm']));await fs.writeFile(path.join(f.order,'plugins.txt'),'# profile\r\n*Extra.esl\r\n*Trailing.esp\r\n');
  await f.service.prepareForPlay(f.game,f.order);const target=path.join(f.game,'Data/W07Quest.esp');assert.deepEqual(await fs.readFile(target),f.pack.payloads.get(701));assert.match(await fs.readFile(path.join(f.order,'plugins.txt'),'utf8'),/\*W07Quest\.esp/);assert.equal(f.service.snapshot().installed,true);const first=f.payloadRequests();assert.equal(first,3);
  await f.service.prepareForPlay(f.game,f.order);assert.equal(f.payloadRequests(),first);assert.equal(f.service.snapshot().installed,true);
  const oldBytes=tes4(['Skyrim.esm'],1);await fs.writeFile(target,oldBytes);await f.service.prepareForPlay(f.game,f.order);assert.deepEqual(await fs.readFile(target),f.pack.payloads.get(701),'outdated required TES4 bytes are replaced with the exact signed payload');assert.equal(f.payloadRequests(),first,'repair uses the verified cache without another payload download');
  const backupRoot=path.join(f.storage,'auto-repair-backups'),backups=await fs.readdir(backupRoot,{recursive:true}),preserved=await Promise.all(backups.filter(p=>p.endsWith('W07Quest.esp')).map(p=>fs.readFile(path.join(backupRoot,p))));assert.ok(preserved.some(bytes=>bytes.equals(oldBytes)),'the exact outdated preimage remains in the pack backup');
 }finally{await f.close();}
});

test('Play refuses an exact staged plugin header with invalid master order before writing the pack phase',async()=>{
 const f=await setup();try{const bad=tes4(['MissingMaster.esm']);const digest=hash(bad),file=f.pack.manifest.files.find(x=>x.path==='Data/W07Quest.esp')!;file.sha256=digest;file.package!.sha256=digest;file.package!.size=bad.length;file.size=bad.length;f.pack.manifest.requiredPlugins.find(x=>x.filename==='W07Quest.esp')!.sha256=digest;f.pack.server.plugins.find(x=>x.filename==='W07Quest.esp')!.sha256=digest;f.pack.server.plugins.find(x=>x.filename==='W07Quest.esp')!.size=bad.length;f.pack.payloads.set(701,bad);f.pack.metadata.assets.find(x=>x.id===701)!.size=bad.length;f.pack.metadata.assets.find(x=>x.id===701)!.digest='sha256:'+digest;
  Object.assign(f.pack.envelope,envelope(f.pack.manifest,f.pack.server));f.pack.metadata.assets.find(a=>a.id===100)!.size=Buffer.byteLength(JSON.stringify(f.pack.envelope));const before=await fs.readdir(path.join(f.game,'Data'));
  await assert.rejects(()=>f.service.prepareForPlay(f.game,f.order),/master|depend|order/i);assert.deepEqual(await fs.readdir(path.join(f.game,'Data')),before);assert.equal(f.service.snapshot().installed,false);
 }finally{await f.close();}
});

test('Play projects a staged optional full plugin activated by Skyrim.ccc and refuses its shifted signed slot before writes',async()=>{
 const f=await setup();try{
  const bytes=tes4(['Skyrim.esm'],1),sha256=hash(bytes),template=f.pack.manifest.files.find(x=>x.distribution==='allowed')!,assetId=702;
  const optionalComponent='w07-optional-plugin';f.pack.manifest.components.push({id:optionalComponent,name:'W07 optional plugin fixture',category:'developer-owned',required:false,dependencies:[]});
  const optional={...structuredClone(template),path:'Data/OptionalPack.esm',componentId:optionalComponent,size:bytes.length,sha256,required:false,role:'shared-plugin' as const,package:{...template.package!,assetId,assetName:'OptionalPack.esm',componentId:optionalComponent,size:bytes.length,sha256}};
  f.pack.manifest.files.push(optional);f.pack.manifest.requiredPlugins.push({filename:'OptionalPack.esm',order:2,masters:['Skyrim.esm'],role:'client-only',required:false,sha256});
  assert.doesNotThrow(()=>validateManifest(f.pack.manifest),'optional CCC fixture must remain a valid signed Manifest V1');
  f.pack.payloads.set(assetId,bytes);f.pack.metadata.assets.push({id:assetId,name:'OptionalPack.esm',size:bytes.length,state:'uploaded',digest:'sha256:'+sha256});
  Object.assign(f.pack.envelope,envelope(f.pack.manifest,f.pack.server));f.pack.metadata.assets.find(a=>a.id===100)!.size=Buffer.byteLength(JSON.stringify(f.pack.envelope));
  const ccc=path.join(f.game,'Skyrim.ccc'),profile=path.join(f.order,'plugins.txt');await fs.writeFile(ccc,'OptionalPack.esm\r\n');const profileBefore=await fs.readFile(profile),dataBefore=await fs.readdir(path.join(f.game,'Data'));
  await assert.rejects(()=>f.service.prepareForPlay(f.game,f.order),error=>/Server-required full-plugin index conflicts with implicit masters or dependencies: W07Quest\.esp/.test(String(error)),'the projected full index must refuse the optional CCC replacement');assert.equal(f.payloadRequests(),4,'the signed optional package was acquired for exact-header projection');
  assert.equal(await fs.stat(path.join(f.game,'Data/OptionalPack.esm')).then(()=>true,()=>false),false);assert.equal(await fs.stat(path.join(f.game,'Data/W07Quest.esp')).then(()=>true,()=>false),false);
  assert.deepEqual(await fs.readdir(path.join(f.game,'Data')),dataBefore);assert.deepEqual(await fs.readFile(profile),profileBefore);assert.deepEqual(await fs.readdir(path.join(f.storage,'auto-repair-backups')).then(x=>x,()=>[]),[]);assert.equal(f.service.snapshot().installed,false);
 }finally{await f.close();}
});

test('Play refuses a managed profile marker before pack writes',async()=>{
 const f=await setup();try{await fs.writeFile(path.join(f.game,'ModOrganizer.ini'),'[General]\r\n');const profile=await fs.readFile(path.join(f.order,'plugins.txt')),data=await fs.readdir(path.join(f.game,'Data'));
  await assert.rejects(()=>f.service.prepareForPlay(f.game,f.order),/managed|virtual|profile|activation/i);
  assert.deepEqual(await fs.readFile(path.join(f.order,'plugins.txt')),profile);assert.deepEqual(await fs.readdir(path.join(f.game,'Data')),data);assert.deepEqual(await fs.readdir(path.join(f.storage,'auto-repair-backups')).then(x=>x,()=>[]),[]);assert.equal(f.service.snapshot().installed,false);
 }finally{await f.close();}
});
