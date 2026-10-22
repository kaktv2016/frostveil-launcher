import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {ManagementService} from '../src/main/management/service';
import {GitHubDistributionProvider} from '../src/main/distribution/github';
import {DistributionTransport} from '../src/main/distribution/transport';
import {authenticateRelease,canonicalBytes,type DistributionSource} from '../src/main/distribution/policy';
import {
 LAUNCHER_MANIFEST_ASSET,
 authenticateLauncherUpdate,
 signLauncherUpdateManifest,
 validateLauncherUpdateManifest,
 type LauncherUpdateSource
} from '../src/main/update-integrity';
import {scanInstallation} from '../src/main/installation';
import type {Profile} from '../src/shared/contracts';

const sha256=(buf:Buffer|string)=>createHash('sha256').update(buf).digest('hex');

function makeTes4Plugin(master='Skyrim.esm'):Buffer{
 const masterBuf=Buffer.from(master+'\0','utf8');
 const field=Buffer.alloc(6);
 field.write('MAST');
 field.writeUInt16LE(masterBuf.length,4);
 const header=Buffer.alloc(24);
 header.write('TES4');
 header.writeUInt32LE(field.length+masterBuf.length,4);
 return Buffer.concat([header,field,masterBuf]);
}

async function createDisposableSkyrimInstall(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-modpack-delivery-'));
 const storage=path.join(root,'launcher-storage');
 const game=path.join(root,'Skyrim Special Edition');
 const orderDir=path.join(root,'AppData-SkyrimSE');
 const iniDir=path.join(root,'Documents-SkyrimSE');
 await fs.mkdir(storage,{recursive:true});
 await fs.mkdir(orderDir,{recursive:true});
 await fs.mkdir(iniDir,{recursive:true});

 const nativeFiles:Array<{path:string;bytes:Buffer;component:'game'|'skse'|'client'|'configuration'}>=[
  {path:'SkyrimSE.exe',bytes:Buffer.from('MZ-SYNTHETIC-SKYRIM-SE-1.6.1170.0'),component:'game'},
  {path:'skse64_loader.exe',bytes:Buffer.from('MZ-SYNTHETIC-SKSE-LOADER-0.2.2.6'),component:'skse'},
  {path:'skse64_1_6_1170.dll',bytes:Buffer.from('MZ-SYNTHETIC-SKSE-DLL-0.2.2.6'),component:'skse'},
  {path:'Data/SKSE/Plugins/MpClientPlugin.dll',bytes:Buffer.from('SYNTHETIC-MPCLIENTPLUGIN'),component:'client'},
  {path:'Data/SKSE/Plugins/SkyrimPlatform.dll',bytes:Buffer.from('SYNTHETIC-SKYRIMPLATFORM'),component:'client'},
  {path:'Data/SKSE/Plugins/versionlib-1_6_1170_0.bin'.replace(/_/g,'-').replace('versionlib-1-6-1170-0.bin','versionlib-1-6-1170-0.bin'),bytes:Buffer.from('SYNTHETIC-VERSIONLIB'),component:'client'},
  {path:'Data/Platform/Plugins/skymp5-client.js',bytes:Buffer.from('// synthetic skymp5-client.js'),component:'client'},
  {path:'Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll',bytes:Buffer.from('SYNTHETIC-SKYRIMPLATFORMIMPL'),component:'client'}
 ];

 const masters=['Skyrim.esm','Update.esm','Dawnguard.esm','HearthFires.esm','Dragonborn.esm'];
 const masterEntries:Array<{filename:string;bytes:Buffer;sha256:string;order:number;masters:string[]}>=[];
 for(const [idx,name] of masters.entries()){
  const header=Buffer.alloc(24);
  header.write('TES4');
  header.writeUInt32LE(idx+1,8);
  const full=path.join(game,'Data',name);
  await fs.mkdir(path.dirname(full),{recursive:true});
  await fs.writeFile(full,header);
  masterEntries.push({
   filename:name,
   bytes:header,
   sha256:sha256(header),
   order:idx,
   masters:idx===0?[]:idx===1?['Skyrim.esm']:['Skyrim.esm','Update.esm']
  });
 }

 const profileFiles=[];
 for(const nf of nativeFiles){
  const full=path.join(game,nf.path);
  await fs.mkdir(path.dirname(full),{recursive:true});
  await fs.writeFile(full,nf.bytes);
  profileFiles.push({
   path:nf.path,
   size:nf.bytes.length,
   sha256:sha256(nf.bytes),
   component:nf.component
  });
 }

 // Unmanaged user files that must never be modified or deleted
 const userModPath='Data/Textures/UserCustom/armor_custom.dds';
 const userModBytes=Buffer.from('DDS-UNMANAGED-USER-TEXTURE-DO-NOT-TOUCH');
 await fs.mkdir(path.dirname(path.join(game,userModPath)),{recursive:true});
 await fs.writeFile(path.join(game,userModPath),userModBytes);

 await fs.writeFile(path.join(orderDir,'plugins.txt'),'# Disposable user plugins.txt\r\n');
 await fs.writeFile(path.join(game,'Skyrim.ccc'),'');

 const profile:Profile={
  id:'disposable-l1-baseline',
  runtime:'1.6.1170.0',
  skseVersion:'0.2.2.6',
  skseDll:'skse64_1_6_1170.dll',
  evidence:'Disposable test baseline',
  files:profileFiles,
  backupFiles:['Data/Platform/Plugins/skymp5-client.js']
 };

 const versionReader=async(file:string)=>path.basename(file)==='SkyrimSE.exe'?'1.6.1170.0':'0.2.2.6';
 const scan=await scanInstallation(game,profile,versionReader);
 assert.equal(scan.ready,true);

 return{
  root,
  storage,
  game,
  orderDir,
  iniDir,
  profile,
  scan,
  versionReader,
  nativeFiles,
  masterEntries,
  userModPath,
  userModBytes
 };
}

function buildSignedModpackRelease(
 env:Awaited<ReturnType<typeof createDisposableSkyrimInstall>>,
 keyPair:{privateKey:any;publicKeyPem:string},
 keyId:string,
 packVersion:string,
 ownedFiles:Array<{path:string;assetName:string;assetId:number;role:'configuration'|'visual';bytes:Buffer}>,
 pluginFile?:{filename:string;assetName:string;assetId:number;bytes:Buffer}
){
 const nowMs=Date.now();
 const generatedAt=new Date(nowMs).toISOString();
 const expiresAt=new Date(nowMs+5*86400000).toISOString();
 const tag=`pack-v${packVersion}`;

 const files:any[]=[
  ...env.nativeFiles.map(nf=>({
   path:nf.path,
   size:nf.bytes.length,
   sha256:sha256(nf.bytes),
   componentId:nf.component==='game'?'native':'client',
   role:nf.component==='game'?'native':nf.component==='skse'?'runtime':'client',
   required:true,
   ownership:'external-install',
   permission:'External baseline only',
   distribution:'external-only'
  })),
  ...env.masterEntries.map(m=>({
   path:'Data/'+m.filename,
   size:m.bytes.length,
   sha256:m.sha256,
   componentId:'native',
   role:'native',
   required:true,
   ownership:'external-install',
   permission:'Official master external only',
   distribution:'external-only'
  }))
 ];

 const assets:any[]=[];
 const assetPayloads=new Map<number,Buffer>();

 for(const f of ownedFiles){
  const digest=sha256(f.bytes);
  files.push({
   path:f.path,
   size:f.bytes.length,
   sha256:digest,
   componentId:'frostveil-rp-owned',
   role:f.role,
   required:true,
   ownership:'custom-rp',
   permission:'First-party Frostveil asset',
   distribution:'allowed',
   package:{
    owner:'kaktv2016',
    repo:'frostveil-distribution',
    tag,
    assetName:f.assetName,
    assetId:f.assetId,
    size:f.bytes.length,
    sha256:digest,
    componentId:'frostveil-rp-owned',
    packVersion,
    rights:{
     kind:'owned',
     evidence:'First-party Frostveil RP asset',
     scope:'redistribution',
     reviewer:'frostveil-owner'
    }
   }
  });
  assets.push({
   id:f.assetId,
   name:f.assetName,
   size:f.bytes.length,
   state:'uploaded',
   digest:'sha256:'+digest
  });
  assetPayloads.set(f.assetId,f.bytes);
 }

 const requiredPlugins:any[]=env.masterEntries.map(m=>({
  filename:m.filename,
  required:true,
  order:m.order,
  masters:m.masters,
  role:'server-required',
  sha256:m.sha256
 }));

 if(pluginFile){
  const digest=sha256(pluginFile.bytes);
  files.push({
   path:'Data/'+pluginFile.filename,
   size:pluginFile.bytes.length,
   sha256:digest,
   componentId:'frostveil-rp-owned',
   role:'visual',
   required:true,
   ownership:'custom-rp',
   permission:'First-party Frostveil client plugin',
   distribution:'allowed',
   package:{
    owner:'kaktv2016',
    repo:'frostveil-distribution',
    tag,
    assetName:pluginFile.assetName,
    assetId:pluginFile.assetId,
    size:pluginFile.bytes.length,
    sha256:digest,
    componentId:'frostveil-rp-owned',
    packVersion,
    rights:{
     kind:'owned',
     evidence:'First-party Frostveil RP plugin',
     scope:'redistribution',
     reviewer:'frostveil-owner'
    }
   }
  });
  requiredPlugins.push({
   filename:pluginFile.filename,
   required:true,
   order:5,
   masters:['Skyrim.esm'],
   role:'client-only',
   sha256:digest
  });
  assets.push({
   id:pluginFile.assetId,
   name:pluginFile.assetName,
   size:pluginFile.bytes.length,
   state:'uploaded',
   digest:'sha256:'+digest
  });
  assetPayloads.set(pluginFile.assetId,pluginFile.bytes);
 }

 const manifest={
  schemaVersion:1,
  packId:'frostveil',
  packVersion,
  channel:'stable',
  generatedAt,
  minimumLauncherVersion:'0.1.6',
  requiredSkyrimRuntime:'1.6.1170.0',
  requiredSKSEVersion:'0.2.2.6',
  requiredSkyMPClientVersion:'explicit-local-client-requirements',
  serverProfileId:'frostveil-production-server',
  serverProfileVersion:packVersion,
  components:[
   {id:'native',name:'Official masters and runtime',category:'native',required:true,dependencies:[]},
   {id:'client',name:'SKSE and SkyMP baseline',category:'skse-skymp',required:true,dependencies:['native']},
   {id:'frostveil-rp-owned',name:'Frostveil RP Client Assets',category:'developer-owned',required:true,dependencies:['client']}
  ],
  files,
  requiredPlugins,
  distribution:{
   source:'signed-release',
   release:{
    owner:'kaktv2016',
    repo:'frostveil-distribution',
    tag
   }
  },
  signing:{
   algorithm:'Ed25519',
   keyId
  },
  skyMPClientRequirements:{
   identity:'explicit-local-client-requirements',
   nativeFiles:[
    'Data/SKSE/Plugins/MpClientPlugin.dll',
    'Data/SKSE/Plugins/SkyrimPlatform.dll',
    'Data/SKSE/Plugins/versionlib-1-6-1170-0.bin',
    'Data/Platform/Plugins/skymp5-client.js',
    'Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll'
   ]
  }
 };

 const server={
  schemaVersion:1,
  id:'frostveil-production-server',
  version:packVersion,
  packId:'frostveil',
  packVersion,
  runtime:'1.6.1170.0',
  skseVersion:'0.2.2.6',
  clientIdentity:'explicit-local-client-requirements',
  generatedAt,
  expiresAt,
  source:'offline-skymp-export',
  engineCommit:'2849e676fe008925384b26f34476e382a30bd877',
  plugins:env.masterEntries.map(m=>({
   filename:m.filename,
   required:true,
   order:m.order,
   masters:m.masters,
   role:'server-required',
   sha256:m.sha256,
   size:m.bytes.length,
   crc32:100+m.order,
   light:false,
   headerVerified:true
  })),
  archives:['Skyrim - Misc.bsa'],
  limitations:[]
 };

 const payloadBytes=canonicalBytes({manifest,server});
 const envelope={
  keyId,
  payloadBase64:payloadBytes.toString('base64'),
  signatureBase64:sign(null,payloadBytes,keyPair.privateKey).toString('base64')
 };
 const envelopeBytes=Buffer.from(JSON.stringify(envelope),'utf8');
 const envelopeAssetId=9000;
 assets.push({
  id:envelopeAssetId,
  name:'frostveil-manifest.json',
  size:envelopeBytes.length,
  state:'uploaded',
  digest:'sha256:'+sha256(envelopeBytes)
 });
 assetPayloads.set(envelopeAssetId,envelopeBytes);

 const release={
  id:5000,
  tag_name:tag,
  draft:false,
  prerelease:false,
  immutable:true,
  published_at:generatedAt,
  body:`Frostveil Modpack ${tag}`,
  assets
 };

 return{manifest,server,envelope,release,assetPayloads};
}

test('Modpack Delivery #1–#5: valid Ed25519 manifest accepted; tampered manifest, wrong key, cross-channel Launcher key, and expired Level B test key rejected',async()=>{
 const env=await createDisposableSkyrimInstall();
 try{
  const modpackPair=generateKeyPairSync('ed25519');
  const modpackPub=modpackPair.publicKey.export({type:'spki',format:'pem'}).toString();
  const launcherPair=generateKeyPairSync('ed25519');
  const launcherPub=launcherPair.publicKey.export({type:'spki',format:'pem'}).toString();

  const modpackKeyId='frostveil-modpack-publisher-20261016';
  const launcherKeyId='frostveil-launcher-update-20261016';

  const bundle=buildSignedModpackRelease(
   env,
   {privateKey:modpackPair.privateKey,publicKeyPem:modpackPub},
   modpackKeyId,
   '1.0.0',
   [{path:'Data/Frostveil/settings.json',assetName:'frostveil-client-settings.json',assetId:1001,role:'configuration',bytes:Buffer.from('{"version":"1.0.0"}\n')}]
  );

  const validSource:DistributionSource={
   mode:'production',
   contentPolicy:'skyrim-mod-content',
   packId:'frostveil',
   channel:'stable',
   keys:{
    [modpackKeyId]:{
     publicKey:modpackPub,
     environment:'production',
     revoked:false,
     expiresAt:'2027-10-16T00:00:00.000Z'
    }
   },
   permittedReviews:[]
  };

  // #1: Valid signed Modpack manifest accepted
  const auth=authenticateRelease(bundle.envelope,validSource,bundle.release);
  assert.equal(auth.manifest.packVersion,'1.0.0');

  // #2: Tampered manifest rejected
  const tamperedPayload=Buffer.from(JSON.stringify({manifest:{...bundle.manifest,packVersion:'1.0.1'},server:bundle.server}),'utf8').toString('base64');
  assert.throws(()=>authenticateRelease({...bundle.envelope,payloadBase64:tamperedPayload},validSource,bundle.release));

  // #3: Wrong publisher key rejected
  const wrongKeySource:DistributionSource={
   ...validSource,
   keys:{
    [modpackKeyId]:{
     publicKey:launcherPub,
     environment:'production',
     revoked:false,
     expiresAt:'2027-10-16T00:00:00.000Z'
    }
   }
  };
  assert.throws(()=>authenticateRelease(bundle.envelope,wrongKeySource,bundle.release));

  // #4: Cross-channel key separation:
  // (a) Modpack signed with Launcher Update key is rejected by Modpack channel
  const crossSignedModpack=buildSignedModpackRelease(
   env,
   {privateKey:launcherPair.privateKey,publicKeyPem:launcherPub},
   launcherKeyId,
   '1.0.0',
   [{path:'Data/Frostveil/settings.json',assetName:'frostveil-client-settings.json',assetId:1001,role:'configuration',bytes:Buffer.from('{"version":"1.0.0"}\n')}]
  );
  assert.throws(()=>authenticateRelease(crossSignedModpack.envelope,validSource,crossSignedModpack.release));

  // (b) Launcher update signed with Modpack key is rejected by Launcher Update channel
  const installerBytes=Buffer.from('MZ-FAKE-INSTALLER-'+'A'.repeat(200));
  const updManifest=validateLauncherUpdateManifest({
   schemaVersion:1,
   keyId:modpackKeyId,
   owner:'kaktv2016',
   repo:'frostveil-launcher',
   tag:'v0.1.7',
   version:'0.1.7',
   channel:'stable',
   minimumLauncherVersion:'0.1.5',
   publishedAt:new Date().toISOString(),
   expiresAt:'2027-10-16T00:00:00.000Z',
   releaseNotes:'Cross-key test',
   installer:{
    assetId:2001,
    assetName:'setup.exe',
    size:installerBytes.length,
    sha512:createHash('sha512').update(installerBytes).digest('base64'),
    sha256:sha256(installerBytes)
   }
  });
  const updEnvelopeWithModpackKey=signLauncherUpdateManifest(updManifest,modpackPair.privateKey);
  const launcherSource:LauncherUpdateSource={
   mode:'production',
   owner:'kaktv2016',
   repo:'frostveil-launcher',
   channel:'stable',
   keys:{
    [launcherKeyId]:{
     publicKey:launcherPub,
     environment:'production',
     revoked:false,
     expiresAt:'2027-10-16T00:00:00.000Z'
    }
   }
  };
  const updRelease={
   id:8001,
   tag_name:'v0.1.7',
   draft:false,
   prerelease:false,
   published_at:updManifest.publishedAt,
   body:'notes',
   assets:[
    {id:2001,name:'setup.exe',size:installerBytes.length,state:'uploaded' as const,digest:null},
    {id:2002,name:LAUNCHER_MANIFEST_ASSET,size:100,state:'uploaded' as const,digest:null}
   ]
  };
  assert.throws(()=>authenticateLauncherUpdate(updEnvelopeWithModpackKey,launcherSource,updRelease,'0.1.6'));

  // #5: Expired or test-environment Level B key rejected for production
  const levelBTestSource:DistributionSource={
   ...validSource,
   keys:{
    [modpackKeyId]:{
     publicKey:modpackPub,
     environment:'test',
     revoked:false,
     expiresAt:new Date(Date.now()+86400000).toISOString()
    }
   }
  };
  assert.throws(()=>authenticateRelease(bundle.envelope,levelBTestSource,bundle.release),/environment mismatch/i);
  const expiredProdSource:DistributionSource={
   ...validSource,
   keys:{
    [modpackKeyId]:{
     publicKey:modpackPub,
     environment:'production',
     revoked:false,
     expiresAt:'2020-01-01T00:00:00.000Z'
    }
   }
  };
  assert.throws(()=>authenticateRelease(bundle.envelope,expiredProdSource,bundle.release),/Expired publisher key/i);
 }finally{
  await fs.rm(env.root,{recursive:true,force:true});
 }
});

for(const preserveLight of [false,true]) test('Modpack Delivery #6–#13: ManagementService end-to-end corrupt download rejection, install, update, repair, conflict refusal, unmanaged/official file preservation, and rollback'+(preserveLight?' [existing ESL preserved]':''),async()=>{
 const env=await createDisposableSkyrimInstall();
 const corruptEnv=await createDisposableSkyrimInstall();
 const existingLight=makeTes4Plugin();existingLight.writeUInt32LE(0x200,8);
 if(preserveLight)for(const install of [env,corruptEnv]){await fs.writeFile(path.join(install.game,'Data/ccExisting.esl'),existingLight);await fs.writeFile(path.join(install.game,'Skyrim.ccc'),'ccExisting.esl\r\n');}
 const modpackPair=generateKeyPairSync('ed25519');
 const modpackPub=modpackPair.publicKey.export({type:'spki',format:'pem'}).toString();
 const keyId='frostveil-modpack-publisher-20261016';

 const source:DistributionSource={
  mode:'production',
  contentPolicy:'skyrim-mod-content',
  packId:'frostveil',
  channel:'stable',
  keys:{
   [keyId]:{
    publicKey:modpackPub,
    environment:'production',
    revoked:false,
    expiresAt:'2027-10-16T00:00:00.000Z'
   }
  },
  permittedReviews:[]
 };

 const v1Settings=Buffer.from('{"packVersion":"1.0.0","feature":"initial"}\n','utf8');
 const v1Readme=Buffer.from('Frostveil RP Readme v1.0.0\r\n','utf8');
 const v1Hud=Buffer.from('<html><body>Frostveil HUD v1.0.0</body></html>\n','utf8');

 const bundleV1=buildSignedModpackRelease(
  env,
  {privateKey:modpackPair.privateKey,publicKeyPem:modpackPub},
  keyId,
  '1.0.0',
  [
   {path:'Data/Frostveil/settings.json',assetName:'frostveil-client-settings.json',assetId:1001,role:'configuration',bytes:v1Settings},
   {path:'Data/Frostveil/readme.txt',assetName:'frostveil-client-readme.txt',assetId:1002,role:'configuration',bytes:v1Readme},
   {path:'Data/Interface/Frostveil/hud-reference.html',assetName:'frostveil-hud-reference.html',assetId:1003,role:'visual',bytes:v1Hud}
  ]
 );

 const v2Settings=Buffer.from('{"packVersion":"1.1.0","feature":"upgraded"}\n','utf8');
 const v2Hud=Buffer.from('<html><body>Frostveil HUD v1.1.0 — Updated</body></html>\n','utf8');
 // v1.1.0 updates settings.json and hud-reference.html, and removes obsolete readme.txt
 const bundleV2=buildSignedModpackRelease(
  env,
  {privateKey:modpackPair.privateKey,publicKeyPem:modpackPub},
  keyId,
  '1.1.0',
  [
   {path:'Data/Frostveil/settings.json',assetName:'frostveil-client-settings.json',assetId:2001,role:'configuration',bytes:v2Settings},
   {path:'Data/Interface/Frostveil/hud-reference.html',assetName:'frostveil-hud-reference.html',assetId:2003,role:'visual',bytes:v2Hud}
  ]
 );

 let activeBundle=bundleV1;
 let corruptAssetId:number|null=null;

 const httpServer=http.createServer((req,res)=>{
  if(req.url==='/repos/kaktv2016/frostveil-distribution/releases/latest'){
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify(activeBundle.release));
   return;
  }
  const m=/^\/repos\/kaktv2016\/frostveil-distribution\/releases\/assets\/(\d+)$/.exec(req.url??'');
  if(m){
   const id=Number(m[1]);
   const bytes=activeBundle.assetPayloads.get(id);
   if(!bytes){res.writeHead(404).end();return;}
   const out=corruptAssetId===id?Buffer.from(bytes.map(b=>b^0xff)):bytes;
   res.writeHead(200,{
    'content-type':'application/octet-stream',
    'content-length':String(out.length),
    'etag':`"${sha256(bytes)}"`
   });
   res.end(out);
   return;
  }
  res.writeHead(404).end();
 });

 await new Promise<void>(r=>httpServer.listen(0,'127.0.0.1',()=>r()));
 const port=(httpServer.address() as {port:number}).port;
 const origin=`http://127.0.0.1:${port}`;

 const corruptService=new ManagementService(
  corruptEnv.storage,
  '0.1.6',
  ()=>({
   directory:corruptEnv.game,
   orderDirectory:corruptEnv.orderDir,
   runtime:corruptEnv.scan,
   channel:'stable',
   iniDirectory:corruptEnv.iniDir
  }),
  async()=>true,
  corruptEnv.versionReader,
  source,
  ()=>new GitHubDistributionProvider(DistributionTransport.loopback(origin,'sandbox-test'))
 );

 const service=new ManagementService(
  env.storage,
  '0.1.6',
  ()=>({
   directory:env.game,
   orderDirectory:env.orderDir,
   runtime:env.scan,
   channel:'stable',
   iniDirectory:env.iniDir
  }),
  async()=>true,
  env.versionReader,
  source,
  ()=>new GitHubDistributionProvider(DistributionTransport.loopback(origin,'sandbox-test'))
 );

 try{
  // #6: Corrupt downloaded file is rejected before any game write
  await corruptService.initialize();
  corruptAssetId=1001;
  const corruptState=await corruptService.prepare('install');
  assert.equal(corruptState.phase,'error');
  assert.match(corruptState.message,/SHA256|mismatch/i);
  await assert.rejects(()=>fs.stat(path.join(corruptEnv.game,'Data/Frostveil/settings.json')));

  // #7: Install into disposable Skyrim-shaped directory succeeds
  corruptAssetId=null;
  await service.initialize();
  const inspected=await service.inspect();
  assert.equal(inspected.phase,preserveLight?'blocked':'complete',inspected.message);
  if(preserveLight)assert.equal(inspected.status,'UNVERIFIED');
  assert.equal(inspected.productionConfigured,true);

  const preparedInstall=await service.prepare('install');
  assert.equal(preparedInstall.phase,'awaiting-review',`Expected awaiting-review, got ${preparedInstall.phase}: ${preparedInstall.message}`);
  assert.equal(preparedInstall.availableVersion,'1.0.0');
  assert.equal(preparedInstall.requiredServerVersion,'1.0.0');
  assert.ok((preparedInstall.downloadBytes??0)>0);
  assert.ok(preparedInstall.planHash);

  const installed=await service.apply(preparedInstall.planHash);
  assert.equal(installed.phase,'complete',JSON.stringify({message:installed.message,selection:env.game,canonicalSelection:await fs.realpath(env.game)}));
  assert.equal(installed.installedVersion,'1.0.0');
  assert.equal(await fs.readFile(path.join(env.game,'Data/Frostveil/settings.json'),'utf8'),v1Settings.toString('utf8'));
  assert.equal(await fs.readFile(path.join(env.game,'Data/Frostveil/readme.txt'),'utf8'),v1Readme.toString('utf8'));
  assert.equal(await fs.readFile(path.join(env.game,'Data/Interface/Frostveil/hud-reference.html'),'utf8'),v1Hud.toString('utf8'));

  // #9: Missing managed file is repaired cleanly
  await fs.unlink(path.join(env.game,'Data/Interface/Frostveil/hud-reference.html'));
  const preparedRepair=await service.prepare('repair');
  assert.equal(preparedRepair.phase,'awaiting-review');
  const repaired=await service.apply(preparedRepair.planHash);
  assert.equal(repaired.phase,'complete');
  assert.equal(await fs.readFile(path.join(env.game,'Data/Interface/Frostveil/hud-reference.html'),'utf8'),v1Hud.toString('utf8'));

  // #10: Modified managed file requires explicit conflict handling (blocks silent overwrite)
  await fs.writeFile(path.join(env.game,'Data/Frostveil/settings.json'),'USER EDITED MANAGED FILE');
  const conflictPlan=await service.prepare('update');
  assert.equal(conflictPlan.phase,'conflict');
  assert.ok(conflictPlan.conflicts.length>0);
  await assert.rejects(()=>service.apply(conflictPlan.planHash));
  // Restore valid v1 bytes before testing v1 -> v2 upgrade
  await fs.writeFile(path.join(env.game,'Data/Frostveil/settings.json'),v1Settings);

  // #8: Update replaces owned files and removes obsolete owned files
  activeBundle=bundleV2;
  const preparedUpdate=await service.prepare('update');
  assert.equal(preparedUpdate.phase,'awaiting-review');
  assert.equal(preparedUpdate.availableVersion,'1.1.0');
  const updated=await service.apply(preparedUpdate.planHash);
  assert.equal(updated.phase,'complete');
  assert.equal(updated.installedVersion,'1.1.0');
  assert.equal(await fs.readFile(path.join(env.game,'Data/Frostveil/settings.json'),'utf8'),v2Settings.toString('utf8'));
  assert.equal(await fs.readFile(path.join(env.game,'Data/Interface/Frostveil/hud-reference.html'),'utf8'),v2Hud.toString('utf8'));
  await assert.rejects(()=>fs.stat(path.join(env.game,'Data/Frostveil/readme.txt')));

  // #11 & #12: Unmanaged user file and official Bethesda/SKSE/SkyMP files are untouched
  assert.equal((await fs.readFile(path.join(env.game,env.userModPath))).equals(env.userModBytes),true);
  for(const nf of env.nativeFiles){
   assert.equal((await fs.readFile(path.join(env.game,nf.path))).equals(nf.bytes),true);
  }
  for(const m of env.masterEntries){
   assert.equal((await fs.readFile(path.join(env.game,'Data',m.filename))).equals(m.bytes),true);
  }
  assert.equal(await fs.readFile(path.join(env.orderDir,'plugins.txt'),'utf8'),'# Disposable user plugins.txt\r\n');

  // #13: Rollback restores exact pre-update v1.0.0 files (including removed readme.txt)
  const rolledBack=await service.rollback();
  assert.equal(rolledBack.phase,'complete');
  assert.equal(rolledBack.installedVersion,'1.0.0');
  if(preserveLight){assert.deepEqual(await fs.readFile(path.join(env.game,'Data/ccExisting.esl')),existingLight);assert.equal(await fs.readFile(path.join(env.game,'Skyrim.ccc'),'utf8'),'ccExisting.esl\r\n');assert.ok(rolledBack.plan===undefined);}
  assert.equal(await fs.readFile(path.join(env.game,'Data/Frostveil/settings.json'),'utf8'),v1Settings.toString('utf8'));
  assert.equal(await fs.readFile(path.join(env.game,'Data/Frostveil/readme.txt'),'utf8'),v1Readme.toString('utf8'));
  assert.equal(await fs.readFile(path.join(env.game,'Data/Interface/Frostveil/hud-reference.html'),'utf8'),v1Hud.toString('utf8'));
 }finally{
  corruptService.dispose();
  service.dispose();
  await new Promise<void>(r=>httpServer.close(()=>r()));
  await fs.rm(corruptEnv.root,{recursive:true,force:true});
  await fs.rm(env.root,{recursive:true,force:true});
 }
});
