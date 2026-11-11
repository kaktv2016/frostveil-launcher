import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PackageDownloader} from '../src/main/distribution/download';
import {DistributionTransport} from '../src/main/distribution/transport';
import {MetadataStore} from '../src/main/installer/metadata';
import {fileIdentity} from '../src/main/installer/sandbox';
import {verifyEnvelope} from '../src/main/modpack/trust';
import {envelope,fixture} from './distribution-fixture';

const etag='"signed-fixture"';
const prefixSize=4*64*1024+19;
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const bytes=Buffer.from(Array.from({length:8*64*1024+37},(_,i)=>i%251));

async function signedFixture(){
 const f=await fixture();
 for(const file of f.manifest.files.filter(file=>file.package)){
  Object.assign(file,{sha256:digest(bytes),size:bytes.length});
  Object.assign(file.package!,{sha256:file.sha256,size:file.size});
 }
 const authenticated=verifyEnvelope(envelope(f.manifest,f.server),f.keys,[]);
 assert.equal(authenticated.trust,'AUTHENTICATED');
 const [ref,alternate]=authenticated.manifest!.files.flatMap(file=>file.package?[file.package]:[]);
 assert.ok(ref&&alternate);
 assert.notEqual(ref.assetId,alternate.assetId);
 assert.equal(ref.sha256,alternate.sha256);
 return {grant:f.grant,ref,alternate,target:path.join(f.grant.payloads,ref.sha256+'.bin')};
}

async function seedPartial(f:Awaited<ReturnType<typeof signedFixture>>,tail=0){
 const binding=digest(JSON.stringify(f.ref));
 const partial=path.join(f.grant.payloads,binding+'.partial');
 const meta='downloads/'+binding+'.json';
 const contents=bytes.subarray(0,prefixSize+tail);
 await fs.writeFile(partial,contents,{flag:'wx'});
 const store=await MetadataStore.create(f.grant);
 const saved={binding,etag,bytes:prefixSize,prefixHash:digest(bytes.subarray(0,prefixSize)),identity:await fileIdentity(partial)};
 await store.write(meta,saved);
 const unchanged=async()=>{
  assert.deepEqual(await store.read(meta),saved);
  assert.equal(await fileIdentity(partial),saved.identity);
  assert.deepEqual(await fs.readFile(partial),contents);
  await assert.rejects(fs.lstat(f.target),{code:'ENOENT'});
 };
 return {partial,meta,store,saved,contents,unchanged};
}

interface RequestRecord {url:string|undefined;range:string|undefined;ifRange:string|string[]|undefined;}
async function loopback(t:TestContext,respond:(req:http.IncomingMessage,res:http.ServerResponse,number:number)=>void){
 const requests:RequestRecord[]=[];
 const server=http.createServer((req,res)=>{
  requests.push({url:req.url,range:req.headers.range,ifRange:req.headers['if-range']});
  respond(req,res,requests.length);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>((resolve,reject)=>{
  server.closeAllConnections();
  server.close(error=>error?reject(error):resolve());
 }));
 const addr=server.address();
 assert.ok(addr&&typeof addr!=='string');
 return {transport:DistributionTransport.loopback('http://127.0.0.1:'+addr.port,'sandbox-test',2000),requests};
}

function unsatisfied(res:http.ServerResponse,range?:string){
 if(range!==undefined)res.setHeader('content-range',range);
 res.writeHead(416).end();
}

function full(res:http.ServerResponse,headers:Record<string,string>={}){
 res.writeHead(200,{'content-length':String(bytes.length),etag,...headers}).end(bytes);
}

function assertRequests(requests:RequestRecord[],assetId:number,ranges:(number|null)[]){
 assert.deepEqual(requests,ranges.map(offset=>({
  url:'/repos/kaktv2016/frostveil-distribution/releases/assets/'+assetId,
  range:offset===null?undefined:'bytes='+offset+'-',
  ifRange:offset===null?undefined:etag,
 })));
}

test('authenticated Range 416 retries the same signed asset once as a verified full transfer',async t=>{
 const f=await signedFixture();
 const offered=structuredClone(f.ref);
 await seedPartial(f,37);
 const s=await loopback(t,(_req,res,n)=>{
  if(n===1){
   Object.assign(offered,{assetId:f.alternate.assetId,sha256:'0'.repeat(64),size:bytes.length+1});
   unsatisfied(res,'bytes */'+bytes.length);
  }else full(res);
 });
 const attempts:number[]=[];
 const downloader=new PackageDownloader(f.grant,s.transport,{attempts:2,onProgress:p=>{if(p.state==='verified')attempts.push(p.attempt);}});
 const target=await downloader.acquire(offered);
 assert.equal(target,f.target);
 assert.equal((await fs.stat(target)).size,f.ref.size);
 assert.equal(digest(await fs.readFile(target)),f.ref.sha256);
 assertRequests(s.requests,f.ref.assetId,[prefixSize,null]);
 assert.deepEqual(attempts,[2]);
});

for(const behavior of ['missing-length','wrong-length','repeated-416','attempt-cap','malformed-full','full-request-416'] as const){
 test('416 '+behavior+' refuses without replacing the authenticated checkpoint',async t=>{
  const f=await signedFixture();
  const seed=behavior==='full-request-416'?undefined:await seedPartial(f,37);
  const s=await loopback(t,(_req,res,n)=>{
   if(n===2&&behavior==='malformed-full')full(res,{'content-range':'bytes 0-'+(bytes.length-1)+'/'+bytes.length});
   else unsatisfied(res,behavior==='missing-length'?undefined:'bytes */'+(bytes.length+(behavior==='wrong-length'?1:0)));
  });
  const downloader=new PackageDownloader(f.grant,s.transport,{attempts:behavior==='attempt-cap'?1:4});
  await assert.rejects(downloader.acquire(f.ref),behavior==='malformed-full'?/Unexpected Content-Range/:/416/);
  assertRequests(s.requests,f.ref.assetId,behavior==='malformed-full'||behavior==='repeated-416'
   ?[prefixSize,null]:[behavior==='full-request-416'?null:prefixSize]);
  await seed?.unchanged();
  await assert.rejects(fs.lstat(f.target),{code:'ENOENT'});
 });
}

test('a transient full-restart failure cannot authorize a second 416 restart',async t=>{
 const f=await signedFixture();
 const seed=await seedPartial(f);
 const s=await loopback(t,(_req,res,n)=>{
  if(n===2)res.writeHead(503).end();
  else unsatisfied(res,'bytes */'+bytes.length);
 });
 await assert.rejects(new PackageDownloader(f.grant,s.transport,{attempts:4,backoffMs:1}).acquire(f.ref),/416/);
 assertRequests(s.requests,f.ref.assetId,[prefixSize,null,prefixSize]);
 await seed.unchanged();
});

test('cancellation after accepted full response headers preserves the old authenticated state',async t=>{
 const f=await signedFixture();
 const seed=await seedPartial(f,37);
 const controller=new AbortController();
 const s=await loopback(t,(_req,res,n)=>{
  if(n===1)unsatisfied(res,'bytes */'+bytes.length);
  else full(res);
 });
 const request=s.transport.request.bind(s.transport);
 s.transport.request=async(...args)=>{
  const response=await request(...args);
  if(response.status===200)controller.abort();
  return response;
 };
 await assert.rejects(new PackageDownloader(f.grant,s.transport).acquire(f.ref,controller.signal),/cancel/i);
 assertRequests(s.requests,f.ref.assetId,[prefixSize,null]);
 await seed.unchanged();
});

for(const interruption of ['error','cancel'] as const){
 test(interruption==='cancel'?'cancellation during reset restores the prior checkpoint before truncation':
  'an interruption after reset commit leaves an authenticated zero checkpoint and resumes from zero',async t=>{
  const f=await signedFixture();
  const seed=await seedPartial(f,37);
  const controller=new AbortController();
  const s=await loopback(t,(_req,res,n)=>{
   if(n===1)unsatisfied(res,'bytes */'+bytes.length);
   else full(res);
  });
  const write=MetadataStore.prototype.write;
  let injected=false;
  MetadataStore.prototype.write=async function(relative,value){
   await write.call(this,relative,value);
   if(relative!==seed.meta||typeof value!=='object'||value===null||!('bytes' in value)||value.bytes!==0||injected)return;
   injected=true;
   if(interruption==='cancel')controller.abort();
   else throw Error('Injected stop after checkpoint and before truncation');
  };
  try{
   await assert.rejects(new PackageDownloader(f.grant,s.transport).acquire(f.ref,controller.signal),
    interruption==='cancel'?/cancel/i:/Injected stop after checkpoint/);
  }finally{MetadataStore.prototype.write=write;}
  assert.equal(injected,true);
  assert.deepEqual(await seed.store.read(seed.meta),interruption==='cancel'?seed.saved:
   {...seed.saved,bytes:0,prefixHash:digest('')});
  assert.equal(await fileIdentity(seed.partial),seed.saved.identity);
  assert.deepEqual(await fs.readFile(seed.partial),seed.contents);
  await assert.rejects(fs.lstat(f.target),{code:'ENOENT'});
  assert.equal(await new PackageDownloader(f.grant,s.transport).acquire(f.ref),f.target);
  assert.deepEqual(await fs.readFile(f.target),bytes);
  assertRequests(s.requests,f.ref.assetId,[prefixSize,null,interruption==='cancel'?prefixSize:null]);
 });
}

test('two signed references to one digest share the payload writer even while the installer lease is held',async t=>{
 const f=await signedFixture();
 const store=await MetadataStore.create(f.grant);
 const release=await store.lease();
 let firstResponse:http.ServerResponse|undefined;
 let entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const s=await loopback(t,(req,res)=>{
  if(req.url?.endsWith('/'+f.ref.assetId)){
   firstResponse=res;
   entered();
  }else full(res);
 });
 const first=new PackageDownloader(f.grant,s.transport).acquire(f.ref);
 try{
  await Promise.race([started,first]);
  assert.ok(firstResponse);
  await assert.rejects(new PackageDownloader(f.grant,s.transport).acquire(f.alternate),/Concurrent package acquisition/);
  assertRequests(s.requests,f.ref.assetId,[null]);
 }finally{
  if(firstResponse)full(firstResponse);
  try{await first;}finally{await release();}
 }
 assert.equal(await new PackageDownloader(f.grant,s.transport).acquire(f.alternate),f.target);
 assertRequests(s.requests,f.ref.assetId,[null]);
});

test('authenticated resume hashes positioned chunks of at most 64 KiB and retains valid 206 behavior',async t=>{
 const f=await signedFixture();
 const seed=await seedPartial(f,37);
 const s=await loopback(t,(_req,res)=>{
  res.writeHead(206,{'content-length':String(bytes.length-prefixSize),
   'content-range':'bytes '+prefixSize+'-'+(bytes.length-1)+'/'+bytes.length,etag}).end(bytes.subarray(prefixSize));
 });
 const open=fs.open;
 const readFile=fs.readFile;
 const observed:number[]=[];
 fs.open=async (...args)=>{
  const handle=await open(...args);
  if(args[0]===seed.partial){
   const read=handle.read.bind(handle);
   handle.read=((buffer:Buffer,offset:number,length:number,position:number)=>{
    observed.push(length);
    return read(buffer,offset,length,position);
   }) as typeof handle.read;
  }
  return handle;
 };
 fs.readFile=((...args:Parameters<typeof fs.readFile>)=>{
  assert.notEqual(args[0],seed.partial,'a partial must never use a whole-file buffer');
  return readFile(...args);
 }) as typeof fs.readFile;
 try{assert.equal(await new PackageDownloader(f.grant,s.transport).acquire(f.ref),f.target);}
 finally{fs.open=open;fs.readFile=readFile;}
 assert.ok(observed.length>1);
 assert.equal(Math.max(...observed),64*1024);
 assertRequests(s.requests,f.ref.assetId,[prefixSize]);
 assert.deepEqual(await fs.readFile(f.target),bytes);
});

for(const changed of ['content','identity','hardlink'] as const){
 test('an authenticated partial with changed '+changed+' refuses transport',async t=>{
  const f=await signedFixture();
  const seed=await seedPartial(f);
  if(changed==='content')await fs.writeFile(seed.partial,Buffer.alloc(prefixSize,0xff));
  if(changed==='identity'){
   await fs.rename(seed.partial,seed.partial+'.original');
   await fs.writeFile(seed.partial,seed.contents,{flag:'wx'});
  }
  if(changed==='hardlink')await fs.link(seed.partial,seed.partial+'.alias');
  const s=await loopback(t,(_req,res)=>full(res));
  await assert.rejects(new PackageDownloader(f.grant,s.transport).acquire(f.ref),/Partial|Unsafe download cache/);
  assert.deepEqual(s.requests,[]);
  assert.deepEqual(await seed.store.read(seed.meta),seed.saved);
  await assert.rejects(fs.lstat(f.target),{code:'ENOENT'});
 });
}

test('an existing corrupt final cache object is kept and reports recovery with zero transport',async t=>{
 const f=await signedFixture();
 const corrupt=Buffer.from(bytes);
 corrupt[0]=corrupt[0]!^0xff;
 await fs.writeFile(f.target,corrupt,{flag:'wx'});
 const identity=await fileIdentity(f.target);
 const s=await loopback(t,(_req,res)=>full(res));
 await assert.rejects(new PackageDownloader(f.grant,s.transport).acquire(f.ref),/verified.*cache.*ownership/i);
 assert.deepEqual(s.requests,[]);
 assert.equal(await fileIdentity(f.target),identity);
 assert.deepEqual(await fs.readFile(f.target),corrupt);
});

test('promotion rechecks a final cache conflict that appears while copying the verified temporary',async t=>{
 const f=await signedFixture();
 const corrupt=Buffer.from('concurrent cache identity');
 let conflictingIdentity:string|undefined;
 const s=await loopback(t,(_req,res)=>full(res));
 const copy=fs.copyFile;
 fs.copyFile=async (...args)=>{
  await copy(...args);
  if(typeof args[1]==='string'&&args[1].startsWith(f.target+'.verified-')){
   await fs.writeFile(f.target,corrupt,{flag:'wx'});
   conflictingIdentity=await fileIdentity(f.target);
  }
 };
 try{
  await assert.rejects(new PackageDownloader(f.grant,s.transport).acquire(f.ref),/cache.*conflict/i);
 }finally{fs.copyFile=copy;}
 assert.ok(conflictingIdentity);
 assert.equal(await fileIdentity(f.target),conflictingIdentity);
 assert.deepEqual(await fs.readFile(f.target),corrupt);
 assertRequests(s.requests,f.ref.assetId,[null]);
});

test('body disposal failure does not retry a refused 416',async t=>{
 const f=await signedFixture();
 const seed=await seedPartial(f);
 const s=await loopback(t,(_req,res)=>unsatisfied(res,'bytes */'+(bytes.length+1)));
 let disposed=0;
 replaceBody(s.transport,()=>new ReadableStream({
  cancel(){disposed++;throw new TypeError('Injected failed body disposal');},
 }));
 await assert.rejects(new PackageDownloader(f.grant,s.transport,{attempts:4,backoffMs:1}).acquire(f.ref),/416/);
 assert.equal(disposed,1);
 assertRequests(s.requests,f.ref.assetId,[prefixSize]);
 await seed.unchanged();
});

test('terminal transport failure after the signed bytes does not issue an end Range',async t=>{
 const f=await signedFixture();
 const s=await loopback(t,(req,res)=>{
  if(req.headers.range)unsatisfied(res,'bytes */'+bytes.length);
  else res.writeHead(200,{etag,'transfer-encoding':'chunked'}).end(bytes);
 });
 let sent=false;
 replaceBody(s.transport,()=>new ReadableStream({
  pull(controller){
   if(sent)controller.error(new TypeError('Injected terminal response failure'));
   else{
    sent=true;
    controller.enqueue(new Uint8Array(bytes));
   }
  },
 },{highWaterMark:0}));
 assert.equal(await new PackageDownloader(f.grant,s.transport,{attempts:2,backoffMs:1}).acquire(f.ref),f.target);
 assert.equal(sent,true);
 assert.deepEqual(await fs.readFile(f.target),bytes);
 assertRequests(s.requests,f.ref.assetId,[null]);
});

test('a hard link added during the first response-body read prevents mutation of the partial',async t=>{
 const f=await signedFixture();
 const seed=await seedPartial(f);
 const alias=seed.partial+'.alias';
 const s=await loopback(t,(_req,res)=>{
  res.writeHead(206,{'content-length':String(bytes.length-prefixSize),
   'content-range':'bytes '+prefixSize+'-'+(bytes.length-1)+'/'+bytes.length,etag}).end(bytes.subarray(prefixSize));
 });
 replaceBody(s.transport,()=>new ReadableStream({
  async pull(controller){
   await fs.link(seed.partial,alias);
   controller.enqueue(new Uint8Array(bytes.subarray(prefixSize)));
   controller.close();
  },
 },{highWaterMark:0}));
 await assert.rejects(new PackageDownloader(f.grant,s.transport).acquire(f.ref),/Unsafe download cache|Partial/);
 assert.equal(await fileIdentity(alias),seed.saved.identity);
 assert.equal(digest(await fs.readFile(alias)),digest(seed.contents));
 await seed.unchanged();
 assertRequests(s.requests,f.ref.assetId,[prefixSize]);
});

test('final target absence cannot conceal an unavailable grant root before promotion',async t=>{
 const f=await signedFixture();
 const s=await loopback(t,(_req,res)=>full(res));
 const copy=fs.copyFile;
 const lstat=fs.lstat;
 let copied=false;
 let rootUnavailable=false;
 fs.copyFile=async (...args)=>{
  await copy(...args);
  if(typeof args[1]==='string'&&args[1].startsWith(f.target+'.verified-'))copied=true;
 };
 fs.lstat=(async(...args:Parameters<typeof fs.lstat>)=>{
  if(copied&&args[0]===f.target){
   rootUnavailable=true;
   throw Object.assign(Error('Injected absent final target'),{code:'ENOENT'});
  }
  if(rootUnavailable&&args[0]===f.grant.payloads)
   throw Object.assign(Error('Injected unavailable grant root'),{code:'ENOENT'});
  return lstat(...args);
 }) as typeof fs.lstat;
 try{
  await assert.rejects(new PackageDownloader(f.grant,s.transport).acquire(f.ref),/Injected unavailable grant root/);
 }finally{fs.copyFile=copy;fs.lstat=lstat;}
 assert.equal(copied,true);
 assert.equal(rootUnavailable,true);
 await assert.rejects(fs.lstat(f.target),{code:'ENOENT'});
});

function replaceBody(transport:DistributionTransport,make:()=>ReadableStream<Uint8Array>){
 const request=transport.request.bind(transport);
 transport.request=async(...args)=>{
  const response=await request(...args);
  await response.body?.cancel();
  return new Response(make(),{status:response.status,headers:response.headers});
 };
}

test('a matching final cache object does not bypass tampered sandbox metadata',async t=>{
 const f=await signedFixture();
 await MetadataStore.create(f.grant);
 const metadata=path.join(f.grant.metadata,'sandbox.json');
 const saved=JSON.parse(await fs.readFile(metadata,'utf8'));
 saved.mac=(saved.mac[0]==='0'?'1':'0')+saved.mac.slice(1);
 await fs.writeFile(metadata,JSON.stringify(saved));
 await fs.writeFile(f.target,bytes,{flag:'wx'});
 const identity=await fileIdentity(f.target);
 const s=await loopback(t,(_req,res)=>full(res));
 await assert.rejects(new PackageDownloader(f.grant,s.transport).acquire(f.ref),/Metadata authentication failed/);
 assert.deepEqual(s.requests,[]);
 assert.equal(await fileIdentity(f.target),identity);
 assert.equal(digest(await fs.readFile(f.target)),f.ref.sha256);
});
