import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {LauncherUpdateService} from '../src/main/launcher-update-service';
import {NsisEngine} from '../src/main/updater-engine';
import {
 LAUNCHER_MANIFEST_ASSET,
 LauncherUpdateLedger,
 LauncherUpdateTransport,
 authenticateLauncherUpdate,
 prepareVerifiedInstallHandoff,
 signLauncherUpdateManifest,
 validateLauncherUpdateManifest,
 verifyDownloadedInstaller,
 type LauncherUpdateManifest,
 type LauncherUpdateSource
} from '../src/main/update-integrity';
import {fileIdentity} from '../src/main/installer/sandbox';

function makeKeyPair(){
 const pair=generateKeyPairSync('ed25519');
 const publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString();
 const fingerprint=createHash('sha256').update(pair.publicKey.export({type:'spki',format:'der'})).digest('hex');
 return{privateKey:pair.privateKey,publicKey,fingerprint};
}

function makeFakePeInstaller(label:string):Buffer{
 const body=Buffer.from(`MZ-FROSTVEIL-TEST-INSTALLER-${label}-`+'P'.repeat(512),'utf8');
 return body;
}

function makeFixtureBundle(opts:{
 version?:string;
 minimumLauncherVersion?:string;
 keyId?:string;
 publishedAt?:string;
 expiresAt?:string;
 installerBytes?:Buffer;
 assetName?:string;
 assetId?:number;
}={}){
 const key=makeKeyPair();
 const version=opts.version??'0.1.7';
 const keyId=opts.keyId??'frostveil-launcher-test-20261016';
 const nowMs=Date.parse('2026-10-16T05:00:00.000Z');
 const publishedAt=opts.publishedAt??new Date(nowMs).toISOString();
 const expiresAt=opts.expiresAt??new Date(nowMs+30*86400000).toISOString();
 const installerBytes=opts.installerBytes??makeFakePeInstaller(version);
 const sha512=createHash('sha512').update(installerBytes).digest('base64');
 const sha256=createHash('sha256').update(installerBytes).digest('hex');
 const assetName=opts.assetName??`Skyrim.RP.Launcher.Setup.${version}.exe`;
 const assetId=opts.assetId??3001;

 const manifest:LauncherUpdateManifest=validateLauncherUpdateManifest({
  schemaVersion:1,
  keyId,
  owner:'kaktv2016',
  repo:'frostveil-launcher',
  tag:`v${version}`,
  version,
  channel:'stable',
  minimumLauncherVersion:opts.minimumLauncherVersion??'0.1.5',
  publishedAt,
  expiresAt,
  releaseNotes:`Signed release notes for v${version}`,
  installer:{
   assetId,
   assetName,
   size:installerBytes.length,
   sha512,
   sha256
  }
 });

 const envelope=signLauncherUpdateManifest(manifest,key.privateKey);
 const envelopeBytes=Buffer.from(JSON.stringify(envelope),'utf8');
 const release={
  id:7001,
  tag_name:`v${version}`,
  draft:false,
  prerelease:false,
  published_at:publishedAt,
  body:manifest.releaseNotes,
  assets:[
   {
    id:assetId,
    name:assetName,
    size:installerBytes.length,
    state:'uploaded' as const,
    digest:'sha256:'+sha256
   },
   {
    id:assetId+1,
    name:LAUNCHER_MANIFEST_ASSET,
    size:envelopeBytes.length,
    state:'uploaded' as const,
    digest:'sha256:'+createHash('sha256').update(envelopeBytes).digest('hex')
   }
  ]
 };

 const source:LauncherUpdateSource={
  mode:'disposable-test',
  owner:'kaktv2016',
  repo:'frostveil-launcher',
  channel:'stable',
  keys:{
   [keyId]:{
    publicKey:key.publicKey,
    environment:'test',
    revoked:false,
    expiresAt
   }
  }
 };

 return{key,keyId,nowMs,manifest,envelope,envelopeBytes,release,source,installerBytes,sha512,sha256};
}

test('verified updater completes a slow installer body beyond its short metadata deadline',async()=>{
 const fx=makeFixtureBundle(),root=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-slow-installer-'));
 const server=http.createServer((req,res)=>{
  if(req.url?.endsWith('/latest'))return void res.end(JSON.stringify(fx.release));
  if(req.url?.endsWith('/'+(fx.manifest.installer.assetId+1)))return void res.end(fx.envelopeBytes);
  res.writeHead(200,{'content-length':String(fx.installerBytes.length)});res.flushHeaders();
  const timer=setTimeout(()=>res.end(fx.installerBytes),1200);res.once('close',()=>clearTimeout(timer));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
 try{
  const engine=new NsisEngine([],{source:fx.source,storageDir:root,installedVersion:'0.1.6',now:()=>fx.nowMs,transport:LauncherUpdateTransport.loopback(`http://127.0.0.1:${(server.address() as {port:number}).port}/`,'disposable-test',500,5000)});
  await engine.check();await engine.download();
  assert.deepEqual(await fs.readFile(engine.getVerifiedFilePath()!),fx.installerBytes);
 }finally{
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  await fs.rm(root,{recursive:true,force:true});
 }
});

test('installer transfer outlives the metadata deadline while preserving cancellation and a bounded transfer deadline',async()=>{
 const bytes=Buffer.from('MZ-inert-streamed-installer');
 const server=http.createServer((_req,res)=>{
  res.writeHead(200,{'content-length':String(bytes.length)});
  res.flushHeaders();
  const timer=setTimeout(()=>res.end(bytes),1200);
  res.once('close',()=>clearTimeout(timer));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 const transport=LauncherUpdateTransport.loopback(origin,'disposable-test',500,5000);
 try{
  await assert.rejects(async()=>{
   const response=await transport.request('/releases/assets/1');
   await response.arrayBuffer();
  });
  const response=await transport.installer(1);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  const controller=new AbortController();
  const cancelled=await transport.installer(1,controller.signal);
  controller.abort();
  await assert.rejects(()=>cancelled.arrayBuffer());
  const bounded=LauncherUpdateTransport.loopback(origin,'disposable-test',500,800);
  await assert.rejects(async()=>Buffer.from(await(await bounded.installer(1)).arrayBuffer()));
 }finally{
  server.closeAllConnections();
  await new Promise<void>(r=>server.close(()=>r()));
 }
});

test('L2-Ed25519 #1: valid Ed25519 signed update manifest and installer bytes are accepted end-to-end',async()=>{
 const fx=makeFixtureBundle();
 const auth=authenticateLauncherUpdate(fx.envelope,fx.source,fx.release,'0.1.6',()=>fx.nowMs);
 assert.equal(auth.manifest.version,'0.1.7');
 assert.equal(auth.manifest.keyId,fx.keyId);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-upd-sec1-'));
 try{
  const file=path.join(dir,fx.manifest.installer.assetName);
  await fs.writeFile(file,fx.installerBytes);
  await verifyDownloadedInstaller(file,fx.sha512,[],undefined,{
   envelope:fx.envelope,
   source:fx.source,
   release:fx.release,
   installedVersion:'0.1.6',
   now:()=>fx.nowMs
  });
 }finally{
  await fs.rm(dir,{recursive:true,force:true});
 }
});

test('L2-Ed25519 #2: unsigned latest.yml-only release without signed manifest is rejected',async()=>{
 const fx=makeFixtureBundle();
 const unsignedRelease={
  ...fx.release,
  assets:[
   fx.release.assets[0]!,
   {
    id:9999,
    name:'latest.yml',
    size:128,
    state:'uploaded' as const,
    digest:null
   }
  ]
 };
 assert.throws(
  ()=>authenticateLauncherUpdate(fx.envelope,fx.source,unsignedRelease,'0.1.6',()=>fx.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_UNSIGNED_METADATA'
 );
 assert.throws(
  ()=>authenticateLauncherUpdate({version:'0.1.7',path:'latest.yml'},fx.source,fx.release,'0.1.6',()=>fx.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_UNSIGNED_METADATA'
 );
});

test('L2-Ed25519 #3 & #4: tampered manifest payload and invalid Ed25519 signature are rejected',()=>{
 const fx=makeFixtureBundle();
 const tamperedPayload=Buffer.from(JSON.stringify({...fx.manifest,releaseNotes:'Tampered notes'}),'utf8').toString('base64');
 assert.throws(
  ()=>authenticateLauncherUpdate({...fx.envelope,payloadBase64:tamperedPayload},fx.source,fx.release,'0.1.6',()=>fx.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_INVALID_SIGNATURE'
 );
 const flippedSig=Buffer.from(fx.envelope.signatureBase64,'base64');
 flippedSig[0]=(flippedSig[0]??0)^0xff;
 assert.throws(
  ()=>authenticateLauncherUpdate({...fx.envelope,signatureBase64:flippedSig.toString('base64')},fx.source,fx.release,'0.1.6',()=>fx.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_INVALID_SIGNATURE'
 );
});

test('L2-Ed25519 #5, #6, #7: unknown keyId, revoked keyId, and expired key/manifest are rejected',()=>{
 const fx=makeFixtureBundle();
 const unknownSource:LauncherUpdateSource={...fx.source,keys:{}};
 assert.throws(
  ()=>authenticateLauncherUpdate(fx.envelope,unknownSource,fx.release,'0.1.6',()=>fx.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_UNKNOWN_PUBLISHER'
 );

 const revokedSource:LauncherUpdateSource={
  ...fx.source,
  keys:{[fx.keyId]:{...fx.source.keys[fx.keyId]!,revoked:true}}
 };
 assert.throws(
  ()=>authenticateLauncherUpdate(fx.envelope,revokedSource,fx.release,'0.1.6',()=>fx.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_REVOKED_KEY'
 );

 const futureNow=Date.parse(fx.manifest.expiresAt)+1000;
 assert.throws(
  ()=>authenticateLauncherUpdate(fx.envelope,fx.source,fx.release,'0.1.6',()=>futureNow),
  (err:any)=>err?.code==='ERR_UPDATER_EXPIRED_KEY'
 );
});

test('L2-Ed25519 #8: wrong repository, tag, draft, or prerelease channel is rejected',()=>{
 const fx=makeFixtureBundle();
 assert.throws(
  ()=>validateLauncherUpdateManifest({...fx.manifest,repo:'frostveil-distribution'}),
  (err:any)=>err?.code==='ERR_UPDATER_INVALID_MANIFEST'
 );
 assert.throws(
  ()=>authenticateLauncherUpdate(fx.envelope,fx.source,{...fx.release,tag_name:'v0.1.8'},'0.1.6',()=>fx.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_WRONG_RELEASE'
 );
 assert.throws(
  ()=>authenticateLauncherUpdate(fx.envelope,fx.source,{...fx.release,draft:true},'0.1.6',()=>fx.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_WRONG_RELEASE'
 );
 assert.throws(
  ()=>authenticateLauncherUpdate(fx.envelope,fx.source,{...fx.release,prerelease:true},'0.1.6',()=>fx.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_WRONG_RELEASE'
 );
});

test('L2-Ed25519 #9, #10, #11: downgrade, same-version payload mutation, and minimumLauncherVersion enforcement',async()=>{
 const fxOld=makeFixtureBundle({version:'0.1.5'});
 assert.throws(
  ()=>authenticateLauncherUpdate(fxOld.envelope,fxOld.source,fxOld.release,'0.1.6',()=>fxOld.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_DOWNGRADE'
 );

 const fxMin=makeFixtureBundle({version:'0.2.0',minimumLauncherVersion:'0.1.8'});
 assert.throws(
  ()=>authenticateLauncherUpdate(fxMin.envelope,fxMin.source,fxMin.release,'0.1.6',()=>fxMin.nowMs),
  (err:any)=>err?.code==='ERR_UPDATER_MINIMUM_VERSION'
 );

 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-upd-ledger-'));
 try{
  const ledger=new LauncherUpdateLedger(dir);
  const fx1=makeFixtureBundle({version:'0.1.7',installerBytes:makeFakePeInstaller('v0.1.7-a')});
  const auth1=authenticateLauncherUpdate(fx1.envelope,fx1.source,fx1.release,'0.1.6',()=>fx1.nowMs);
  await ledger.accept(auth1);

  // Same version with mutated installer bytes must be rejected by ledger
  const fx1Mutated=makeFixtureBundle({version:'0.1.7',installerBytes:makeFakePeInstaller('v0.1.7-mutated')});
  const auth1Mutated=authenticateLauncherUpdate(fx1Mutated.envelope,fx1Mutated.source,fx1Mutated.release,'0.1.6',()=>fx1Mutated.nowMs);
  await assert.rejects(
   ()=>ledger.check(auth1Mutated),
   (err:any)=>err?.code==='ERR_UPDATER_SAME_VERSION_MUTATION'
  );

  // Older version than ledger record must be rejected
  const fxDowngrade=makeFixtureBundle({version:'0.1.6'});
  const authDowngrade=authenticateLauncherUpdate(fxDowngrade.envelope,fxDowngrade.source,fxDowngrade.release,'0.1.5',()=>fxDowngrade.nowMs);
  await assert.rejects(
   ()=>ledger.check(authDowngrade),
   (err:any)=>err?.code==='ERR_UPDATER_DOWNGRADE'
  );
 }finally{
  await fs.rm(dir,{recursive:true,force:true});
 }
});

test('L2-Ed25519 #12, #13, #14: installer SHA-512/SHA-256 mismatch, size mismatch, non-PE header, and TOCTOU replacement before execution are rejected',async()=>{
 const fx=makeFixtureBundle();
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-upd-toctou-'));
 try{
  const file=path.join(dir,fx.manifest.installer.assetName);
  // Wrong bytes (same length, wrong hash)
  const wrongBytes=Buffer.from(fx.installerBytes);
  wrongBytes[wrongBytes.length-1]=(wrongBytes[wrongBytes.length-1]??0)^0xff;
  await fs.writeFile(file,wrongBytes);
  await assert.rejects(
   ()=>verifyDownloadedInstaller(file,fx.sha512,[],undefined,{
    envelope:fx.envelope,
    source:fx.source,
    release:fx.release,
    installedVersion:'0.1.6',
    now:()=>fx.nowMs
   }),
   (err:any)=>err?.code==='ERR_UPDATER_CHECKSUM_MISMATCH'
  );

  // Wrong size
  await fs.writeFile(file,Buffer.concat([fx.installerBytes,Buffer.from('extra')]));
  await assert.rejects(
   ()=>verifyDownloadedInstaller(file,fx.sha512,[],undefined,{
    envelope:fx.envelope,
    source:fx.source,
    release:fx.release,
    installedVersion:'0.1.6',
    now:()=>fx.nowMs
   }),
   (err:any)=>err?.code==='ERR_UPDATER_CHECKSUM_MISMATCH'
  );

  // Non-PE header (missing MZ)
  const nonPe=Buffer.from('NOPE-NOT-AN-EXE-HEADER-000000000');
  const fxNonPe=makeFixtureBundle({installerBytes:nonPe});
  const nonPeFile=path.join(dir,'nonpe.exe');
  await fs.writeFile(nonPeFile,nonPe);
  await assert.rejects(
   ()=>verifyDownloadedInstaller(nonPeFile,fxNonPe.sha512,[],undefined,{
    envelope:fxNonPe.envelope,
    source:fxNonPe.source,
    release:fxNonPe.release,
    installedVersion:'0.1.6',
    now:()=>fxNonPe.nowMs
   }),
   (err:any)=>err?.code==='ERR_UPDATER_INVALID_INSTALLER'
  );

  // Valid cached installer, then replaced (new inode/identity or hardlink) before prepareVerifiedInstallHandoff
  await fs.writeFile(file,fx.installerBytes);
  const stat=await fs.lstat(file);
  const id=await fileIdentity(file);
  const binding={
   envelope:fx.envelope,
   source:fx.source,
   release:fx.release,
   installedVersion:'0.1.6',
   expectedIdentity:id,
   expectedMtimeMs:stat.mtimeMs,
   now:()=>fx.nowMs
  };
  const handoffOk=await prepareVerifiedInstallHandoff(file,binding,dir);
  assert.equal((await fs.readFile(handoffOk)).equals(fx.installerBytes),true);

  // Now create a hardlink to simulate link attack -> nlink > 1 rejected
  const hardlinkPath=path.join(dir,'linked.exe');
  await fs.link(file,hardlinkPath);
  await assert.rejects(
   ()=>prepareVerifiedInstallHandoff(file,binding,dir),
   (err:any)=>err?.code==='ERR_UPDATER_INSTALLER_REPLACED'
  );
  await fs.unlink(hardlinkPath);

  // Now replace file via rename/unlink+write -> identity/timestamp change rejected
  await new Promise(r=>setTimeout(r,20));
  await fs.unlink(file);
  await fs.writeFile(file,fx.installerBytes);
  await assert.rejects(
   ()=>prepareVerifiedInstallHandoff(file,{...binding,expectedMtimeMs:stat.mtimeMs-5000},dir),
   (err:any)=>err?.code==='ERR_UPDATER_INSTALLER_REPLACED'
  );
 }finally{
  await fs.rm(dir,{recursive:true,force:true});
 }
});

test('L2-Ed25519 #15 & #16: unapproved redirect host is rejected and active Skyrim/SKSE blocks update install',async()=>{
 const fx=makeFixtureBundle();
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-upd-net-'));
 let redirectToEvil=false;
 const server=http.createServer((req,res)=>{
  if(req.url==='/repos/kaktv2016/frostveil-launcher/releases/latest'){
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify(fx.release));
   return;
  }
  if(req.url===`/repos/kaktv2016/frostveil-launcher/releases/assets/${fx.manifest.installer.assetId+1}`){
   res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(fx.envelopeBytes.length)});
   res.end(fx.envelopeBytes);
   return;
  }
  if(req.url===`/repos/kaktv2016/frostveil-launcher/releases/assets/${fx.manifest.installer.assetId}`){
   if(redirectToEvil){
    res.writeHead(302,{location:'https://evil.example.com/malicious-installer.exe'});
    res.end();
    return;
   }
   res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(fx.installerBytes.length)});
   res.end(fx.installerBytes);
   return;
  }
  res.writeHead(404);
  res.end();
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
 const addr=server.address() as {port:number};
 const origin=`http://127.0.0.1:${addr.port}/`;
 try{
  const transport=LauncherUpdateTransport.loopback(origin,'disposable-test');
  let handoffExecuted=false;
  let skyrimRunning=true;
  let clock=fx.nowMs;
  const engine=new NsisEngine([],{
   source:fx.source,
   transport,
   storageDir:dir,
   installedVersion:'0.1.6',
   now:()=>clock,
   runHandoffInstaller:async()=>{handoffExecuted=true;}
  });
  const service=new LauncherUpdateService(engine,{
   version:'0.1.6',
   checkEnabled:true,
   downloadTrusted:true,
   installed:true,
   now:()=>clock,
   gameRunning:async()=>skyrimRunning
  });

  await service.check();
  assert.equal(service.snapshot().state,'available');
  assert.equal(service.snapshot().verification,'manifest-verified');
  assert.equal(service.snapshot().publisherTrust,'verified');
  assert.equal(service.snapshot().keyId,fx.keyId);

  // Test redirect to unapproved host during download
  redirectToEvil=true;
  await service.download();
  assert.equal(service.snapshot().state,'error');
  assert.match(service.snapshot().message,/redirect/i);

  // Advance clock, re-check, and download from approved loopback
  redirectToEvil=false;
  clock+=31000;
  await service.check();
  assert.equal(service.snapshot().state,'available');
  await service.download();
  assert.equal(service.snapshot().state,'downloaded');
  assert.equal(service.snapshot().verification,'installer-verified');

  // Active Skyrim/SKSE blocks install without terminating or running installer
  await assert.rejects(()=>service.install(),/Skyrim\/SKSE is running/);
  assert.equal(handoffExecuted,false);
  assert.equal(service.snapshot().state,'downloaded');

  // Once Skyrim is closed, install succeeds via verified handoff
  skyrimRunning=false;
  await service.install();
  assert.equal(handoffExecuted,true);
  service.dispose();
 }finally{
  await new Promise<void>(r=>server.close(()=>r()));
  await fs.rm(dir,{recursive:true,force:true});
 }
});
