import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {repairGraphicsSources, type GraphicsSourcePlan} from '../src/main/graphics-source-repair';
import {decodeBsaPayload} from '../src/main/bsa-payload';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fv-graphics-source-'));
 const game=path.join(root,'game'),storage=path.join(root,'storage'),sources=path.join(root,'sources');
 await fs.mkdir(path.join(game,'Data/meshes'),{recursive:true});await fs.mkdir(sources);
 const good=Buffer.from('genuine original flower mesh'),second=Buffer.from('genuine original light mesh');
 await fs.writeFile(path.join(sources,'flower.nif'),good);await fs.writeFile(path.join(sources,'light.nif'),second);
 const archive=path.join(sources,'original.zip');
 execFileSync('tar.exe',['-acf',archive,'flower.nif','light.nif'],{cwd:sources,windowsHide:true});
 const zip=await fs.readFile(archive),source={archiveName:'original.zip',archiveSize:zip.length,archiveSha256:hash(zip)};
 const plan:GraphicsSourcePlan={version:'1.0.7',files:[
  {path:'Data/meshes/flower.nif',size:good.length,sha256:hash(good),source:{...source,member:'flower.nif'}},
  {path:'Data/meshes/light.nif',size:second.length,sha256:hash(second),source:{...source,member:'light.nif'}}]};
 return {root,game,storage,sources,good,second,plan};
}
const options=(dirs:string[])=>({sourceDirectories:dirs});

test('navigation ESP and additive tint download through R2, repair together and need zero writes on second Play',async(t)=>{
 const f=await fixture();try{
  const zip=await fs.readFile(path.join(f.sources,'original.zip'));let requests=0;
  const plan:GraphicsSourcePlan={version:'1.0.13',files:[{...f.plan.files[0]!,path:'Data/FrostveilCourierNavigation.esp'},{...f.plan.files[1]!,path:'Data/Interface/Frostveil/CourierQuestTint.swf'}]};
  for(const entry of plan.files)Object.assign(entry.source,{downloadUrl:`https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/sources/${hash(zip)}.zip`});
  t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(zip);});
  await fs.writeFile(path.join(f.game,plan.files[0]!.path),'old broken ESP');
  const result=await repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([]));assert.equal(result.changed,2);assert.equal(requests,1);
  assert.deepEqual(await fs.readFile(path.join(f.game,plan.files[0]!.path)),f.good);assert.deepEqual(await fs.readFile(path.join(f.game,plan.files[1]!.path)),f.second);
  assert.equal(await fs.readFile(path.join(result.backupDirectory!,'before/0'),'utf8'),'old broken ESP');
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([]))).changed,0);assert.equal(requests,1);
  for(const p of ['Data/Other.esp','Data/Interface/map.swf','Data/Interface/hudmenu.swf']){const bad=structuredClone(plan);bad.files[0]!.path=p;await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,bad,options([])),/target/i);}
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('container repair recipe 1.0.14 replaces only the ESP and remains idempotent',async()=>{
 const f=await fixture();try{
  const plan:GraphicsSourcePlan={version:'1.0.14',files:[{...f.plan.files[0]!,path:'Data/FrostveilCourierNavigation.esp'}]};
  await fs.writeFile(path.join(f.game,plan.files[0]!.path),'previous navigation ESP');
  const result=await repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([f.sources]));
  assert.equal(result.changed,1);assert.deepEqual(await fs.readFile(path.join(f.game,plan.files[0]!.path)),f.good);
  assert.equal(await fs.readFile(path.join(result.backupDirectory!,'before/0'),'utf8'),'previous navigation ESP');
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([]))).changed,0);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('quest tint recipe 1.0.15 accepts only the pinned previous Frostveil SWF',async()=>{
 const f=await fixture();try{
  const target='Data/Interface/Frostveil/CourierQuestTint.swf',before=Buffer.from('previous Frostveil tint SWF');await fs.mkdir(path.dirname(path.join(f.game,target)),{recursive:true});await fs.writeFile(path.join(f.game,target),before);
  const plan:GraphicsSourcePlan={version:'1.0.15',files:[{...f.plan.files[0]!,path:target,previous:[{size:before.length,sha256:hash(before)}]}]};
  const result=await repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([f.sources]));assert.equal(result.changed,1);assert.deepEqual(await fs.readFile(path.join(f.game,target)),f.good);
  const bad=structuredClone(plan);bad.files[0]!.path='Data/Interface/Frostveil/Other.swf';await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,bad,options([f.sources])),/(unsupported graphics repair target|previous recovery identity)/i);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('interrupted 1.0.13 ESP transaction recovers through exactly pinned prior bytes before 1.0.14',async()=>{
 const f=await fixture();try{
  const target='Data/FrostveilCourierNavigation.esp',old:GraphicsSourcePlan={version:'1.0.13',files:[{...f.plan.files[0]!,path:target}]};
  let running=false;
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>running,old,{sourceDirectories:[f.sources],progress:p=>{if(p==='applied'){running=true;throw Error('interrupted ESP repair');}}}),/interrupted/);
  assert.deepEqual(await fs.readFile(path.join(f.game,target)),f.good,'pending old bytes must remain until the next Play recovers them');
  const next:GraphicsSourcePlan={version:'1.0.14',files:[{...f.plan.files[1]!,path:target,previous:[{size:f.good.length,sha256:hash(f.good)}]}]};
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,next,options([f.sources]))).changed,1);
  assert.deepEqual(await fs.readFile(path.join(f.game,target)),f.second);
  const bad=structuredClone(next);bad.files[0]!.path='Data/Other.esp';await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,bad,options([f.sources])),/target/i);
  bad.files[0]!.path='Data/meshes/flower.nif';await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,bad,options([f.sources])),/previous recovery identity/i);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('interrupted 1.0.12 repairs recover before a 1.0.13 navigation upgrade without downgrading client security',async()=>{
 const f=await fixture();try{
  const name='Data/Platform/Plugins/skymp5-client.js',old:GraphicsSourcePlan={version:'1.0.12',files:[{...f.plan.files[0]!,path:name}]};
  let running=false;await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>running,old,{sourceDirectories:[f.sources],progress:p=>{if(p==='applied'){running=true;throw Error('interrupted 0.1.17 Play');}}}),/interrupted/);
  const next:GraphicsSourcePlan={version:'1.0.13',files:[{...f.plan.files[1]!,path:name,previous:[{size:f.good.length,sha256:hash(f.good)}]}]};
  await repairGraphicsSources(f.game,f.storage,async()=>false,next,options([f.sources]));assert.deepEqual(await fs.readFile(path.join(f.game,name)),f.second);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('source import repairs missing/corrupt assets, retains backup and needs no archive on second Play',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.game,'Data/meshes/flower.nif'),'opaque bad plane');
  const result=await repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([f.sources]));
  assert.equal(result.changed,2);assert.deepEqual(await fs.readFile(path.join(f.game,f.plan.files[0]!.path)),f.good);
  assert.deepEqual(await fs.readFile(path.join(result.backupDirectory!,'before/0')),Buffer.from('opaque bad plane'));
  assert.deepEqual(await fs.readFile(path.join(f.game,f.plan.files[1]!.path)),f.second);
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([]))).changed,0);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('wrong/missing source archive refuses repair before writing any target',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.game,f.plan.files[0]!.path),'before');
  await fs.writeFile(path.join(f.sources,'original.zip'),'corrupted download');
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([f.sources])),/source|archive|hash/i);
  assert.equal(await fs.readFile(path.join(f.game,f.plan.files[0]!.path),'utf8'),'before');
  await assert.rejects(fs.access(path.join(f.game,f.plan.files[1]!.path)));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('running game and a game started during preparation block every write',async()=>{
 const f=await fixture();try{
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>true,f.plan,options([f.sources])),/running/i);
  let started=false;
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>started,f.plan,{...options([f.sources]),progress:phase=>{if(phase==='prepared')started=true;}}),/running/i);
  await assert.rejects(fs.access(path.join(f.game,f.plan.files[0]!.path)));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('failed apply restores both replaced and originally absent files',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.game,f.plan.files[0]!.path),'before');
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,{...options([f.sources]),progress:phase=>{if(phase==='applied')throw Error('interrupted');}}),/interrupted/);
  assert.equal(await fs.readFile(path.join(f.game,f.plan.files[0]!.path),'utf8'),'before');
  await assert.rejects(fs.access(path.join(f.game,f.plan.files[1]!.path)));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('interrupted repair recovers next Play before completing verified assets',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.game,f.plan.files[0]!.path),'before');let started=false;
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>started,f.plan,{...options([f.sources]),progress:phase=>{if(phase==='applied'){started=true;throw Error('game started');}}}),/game started/);
  assert.deepEqual(await fs.readFile(path.join(f.game,f.plan.files[0]!.path)),f.good);
  started=false;await repairGraphicsSources(f.game,f.storage,async()=>started,f.plan,options([f.sources]));
  assert.deepEqual(await fs.readFile(path.join(f.game,f.plan.files[1]!.path)),f.second);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('unsafe paths and hardlinked destinations are refused without touching another file',async()=>{
 const f=await fixture();try{
  const bad=structuredClone(f.plan);bad.files[0]!.path='../outside.nif';
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,bad,options([f.sources])),/path|target/i);
  const outside=path.join(f.root,'outside');await fs.writeFile(outside,'untouched');await fs.link(outside,path.join(f.game,f.plan.files[0]!.path));
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([f.sources])),/link/i);
  assert.equal(await fs.readFile(outside,'utf8'),'untouched');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('installed BSA recipe restores only hash-verified local bytes without game assets in a download',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from('embedded vanilla asset');await fs.writeFile(path.join(f.game,'Data/local.bsa'),Buffer.concat([Buffer.from('header'),bytes]));
  const plan:GraphicsSourcePlan={version:'1.0.7',files:[{path:'Data/meshes/native.nif',size:bytes.length,sha256:hash(bytes),source:{installedArchive:'Data/local.bsa',bsa:{offset:6,storedSize:bytes.length,compressed:false,embeddedName:false,bsaVersion:105}}}]};
  await repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([]));assert.deepEqual(await fs.readFile(path.join(f.game,plan.files[0]!.path)),bytes);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('BSA decoder supports raw LZ4, dependent frame blocks and rejects invalid back-references',()=>{
 const prefix=Buffer.alloc(4);prefix.writeUInt32LE(6);const raw=Buffer.from([0x60,65,66,67,68,69,70]);
 assert.equal(decodeBsaPayload(Buffer.concat([prefix,raw]),{compressed:true,embeddedName:false,bsaVersion:105},6).toString(),'ABCDEF');
 const prefix8=Buffer.alloc(4);prefix8.writeUInt32LE(8);
 const frame=Buffer.from([4,34,77,24,0x40,0x40,0,4,0,0,128,65,66,67,68,3,0,0,0,0,4,0,0,0,0,0]);
 assert.equal(decodeBsaPayload(Buffer.concat([prefix8,frame]),{compressed:true,embeddedName:false,bsaVersion:105},8).toString(),'ABCDABCD');
 assert.throws(()=>decodeBsaPayload(Buffer.concat([prefix,Buffer.from([0,0,0])]),{compressed:true,embeddedName:false,bsaVersion:105},6),/LZ4|size|offset/i);
});

test('stale process lock is recovered after process exit',async()=>{
 const f=await fixture();try{
  const base=path.join(f.storage,'graphics-source-repair');await fs.mkdir(base,{recursive:true});
  await fs.writeFile(path.join(base,'operation.lock'),JSON.stringify({pid:2147483647,token:'previous-process'}));
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([f.sources]))).changed,2);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('last running-game check cannot overwrite a concurrently edited asset',async()=>{
 const f=await fixture();try{
  const target=path.join(f.game,f.plan.files[0]!.path);await fs.writeFile(target,'before');let calls=0;
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>{calls++;if(calls===6)await fs.writeFile(target,'external newer version');return false;},f.plan,options([f.sources])),/changed|recovery/i);
  assert.equal(await fs.readFile(target,'utf8'),'external newer version');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('matched Grass Lighting descriptor and shader repair together, remain idempotent and block unrelated shader targets',async()=>{
 const f=await fixture();try{
  const paths=['Data/Shaders/Features/GrassLighting.ini','Data/Shaders/GrassLighting/GrassLighting.hlsli'];
  const contents=[Buffer.from('[Info]\nVersion = 2-0-3\n'),Buffer.from('// Matching upstream complex grass atlas helper\n')];
  const plan:GraphicsSourcePlan={version:'1.0.8',files:paths.map((p,i)=>({path:p,size:contents[i]!.length,sha256:hash(contents[i]!),source:{contentBase64:contents[i]!.toString('base64')}}))};
  for(const p of paths){await fs.mkdir(path.dirname(path.join(f.game,p)),{recursive:true});await fs.writeFile(path.join(f.game,p),'obsolete standalone override');}
  const result=await repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([]));assert.equal(result.changed,2);
  for(let i=0;i<paths.length;i++)assert.deepEqual(await fs.readFile(path.join(f.game,paths[i]!)),contents[i]);
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([]))).changed,0);
  plan.files[0]!.path='Data/Shaders/Unreviewed.hlsl';await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([])),/target|configuration/i);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('an interrupted 1.0.7 repair recovers after the compatible 1.0.8 upgrade',async()=>{
 const f=await fixture();try{
  let started=false;await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>started,f.plan,{...options([f.sources]),progress:phase=>{if(phase==='applied'){started=true;throw Error('interrupted old version');}}}),/interrupted/);
  const upgraded=structuredClone(f.plan);upgraded.version='1.0.8';started=false;
  await repairGraphicsSources(f.game,f.storage,async()=>false,upgraded,options([f.sources]));
  assert.deepEqual(await fs.readFile(path.join(f.game,f.plan.files[1]!.path)),f.second);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('fresh player downloads a pinned R2 source once, repairs from cache and never needs Downloads',async(t)=>{
 const f=await fixture();try{
  const zip=await fs.readFile(path.join(f.sources,'original.zip'));let requests=0;
  for(const file of f.plan.files)Object.assign(file.source,{downloadUrl:`https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/sources/${hash(zip)}.zip`});
  t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(zip);});
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([]))).changed,2);
  assert.equal(requests,1);assert.deepEqual(await fs.readFile(path.join(f.game,f.plan.files[0]!.path)),f.good);
  await fs.writeFile(path.join(f.game,f.plan.files[0]!.path),'damaged after first install');
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([]))).changed,1);assert.equal(requests,1);
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([]))).changed,0);assert.equal(requests,1);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('corrupt, oversized, failed and redirected source downloads never change game assets',async(t)=>{
 const f=await fixture();try{
  const zip=await fs.readFile(path.join(f.sources,'original.zip'));
  for(const file of f.plan.files)Object.assign(file.source,{downloadUrl:`https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/sources/${hash(zip)}.zip`});
  await fs.writeFile(path.join(f.game,f.plan.files[0]!.path),'before');
  for(const response of [new Response(Buffer.alloc(zip.length)),new Response(Buffer.alloc(zip.length+1)),new Response('offline',{status:503}),new Response(null,{status:302,headers:{location:'https://example.com/'}})]){
   const mock=t.mock.method(globalThis,'fetch',async()=>response);
   await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([])),/hash|size|download|HTTP/i);mock.mock.restore();
   assert.equal(await fs.readFile(path.join(f.game,f.plan.files[0]!.path),'utf8'),'before');
   await assert.rejects(fs.access(path.join(f.game,f.plan.files[1]!.path)));
  }
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('untrusted source URL is rejected before network or game writes',async(t)=>{
 const f=await fixture();try{
  let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw Error('must not fetch');});
  for(const url of ['http://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/a.zip','https://example.com/a.zip','https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/sources/wrong.zip']){
   Object.assign(f.plan.files[0]!.source,{downloadUrl:url});
   await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,options([])),/source|URL|identity/i);
  }
  assert.equal(requests,0);await assert.rejects(fs.access(path.join(f.game,f.plan.files[0]!.path)));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('an interrupted old repair recovers after the remote 1.0.9 upgrade',async()=>{
 const f=await fixture();try{
  let started=false;await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>started,f.plan,{...options([f.sources]),progress:phase=>{if(phase==='applied'){started=true;throw Error('old interrupted');}}}),/interrupted/);
  const upgraded=structuredClone(f.plan);upgraded.version='1.0.9';
  await repairGraphicsSources(f.game,f.storage,async()=>false,upgraded,options([f.sources]));
  assert.deepEqual(await fs.readFile(path.join(f.game,f.plan.files[1]!.path)),f.second);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('reviewed bootstrap installs missing SKSE for a clean player but refuses Bethesda executable targets',async(t)=>{
 const f=await fixture();try{
  const zip=await fs.readFile(path.join(f.sources,'original.zip'));
  const plan:GraphicsSourcePlan={version:'1.0.9',files:[{...f.plan.files[0]!,path:'skse64_loader.exe',source:{...f.plan.files[0]!.source,downloadUrl:`https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/sources/${hash(zip)}.zip`}}]};
  t.mock.method(globalThis,'fetch',async()=>new Response(zip));
  assert.equal((await repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([]))).changed,1);
  assert.deepEqual(await fs.readFile(path.join(f.game,'skse64_loader.exe')),f.good);
  plan.files[0]!.path='SkyrimSE.exe';await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,plan,options([])),/target/i);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('Cancel during a source download stops before writes and Cancel during apply restores previous assets',async(t)=>{
 const f=await fixture();try{
  const zip=await fs.readFile(path.join(f.sources,'original.zip'));for(const entry of f.plan.files)Object.assign(entry.source,{downloadUrl:`https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/sources/${hash(zip)}.zip`});
  const target=path.join(f.game,f.plan.files[0]!.path);await fs.writeFile(target,'before');
  t.mock.method(globalThis,'fetch',async()=>new Response(zip));let controller=new AbortController();
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,{sourceDirectories:[],signal:controller.signal,progress:p=>{if(p.startsWith('downloading '))controller.abort(Error('Download cancelled'));}}),/cancelled/);
  assert.equal(await fs.readFile(target,'utf8'),'before');await assert.rejects(fs.access(path.join(f.game,f.plan.files[1]!.path)));
  controller=new AbortController();await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,{sourceDirectories:[f.sources],signal:controller.signal,progress:p=>{if(p==='applied')controller.abort(Error('Apply cancelled'));}}),/cancelled/);
  assert.equal(await fs.readFile(target,'utf8'),'before');await assert.rejects(fs.access(path.join(f.game,f.plan.files[1]!.path)));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('Cancel aborts an active streamed download and leaves no partial archive or game writes',async(t)=>{
 const f=await fixture();try{
  const zip=await fs.readFile(path.join(f.sources,'original.zip')),controller=new AbortController();
  for(const entry of f.plan.files)Object.assign(entry.source,{downloadUrl:`https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/sources/${hash(zip)}.zip`});
  let transferred=false;
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(stream){stream.enqueue(new Uint8Array(zip.subarray(0,zip.length/2)));},cancel(){transferred=true;}})));
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,f.plan,{sourceDirectories:[],signal:controller.signal,progress:(p,n)=>{if(p.startsWith('downloading ')&&(n??0)>0)controller.abort();}}),/abort|cancel/i);
  assert.equal(transferred,true);assert.deepEqual(await fs.readdir(path.join(f.storage,'graphics-source-downloads')),[]);
  await assert.rejects(fs.access(path.join(f.game,f.plan.files[0]!.path)));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('interrupted 1.0.9 client bootstrap recovers using the pinned previous client before installing 1.0.10',async()=>{
 const f=await fixture();try{
  const name='Data/Platform/Plugins/skymp5-client.js';
  const old:GraphicsSourcePlan={version:'1.0.9',files:[{...f.plan.files[0]!,path:name}]};
  let running=false;await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>running,old,{sourceDirectories:[f.sources],progress:p=>{if(p==='applied'){running=true;throw Error('interrupted old client');}}}),/interrupted/);
  const next:GraphicsSourcePlan={version:'1.0.10',files:[{...f.plan.files[1]!,path:name,previous:[{size:f.good.length,sha256:hash(f.good)}]}]};
  await repairGraphicsSources(f.game,f.storage,async()=>false,next,options([f.sources]));
  assert.deepEqual(await fs.readFile(path.join(f.game,name)),f.second);
  const unsafe=structuredClone(next);unsafe.files[0]!.path='Data/meshes/unreviewed.nif';
  await assert.rejects(repairGraphicsSources(f.game,f.storage,async()=>false,unsafe,options([f.sources])),/previous|identity|target/i);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
