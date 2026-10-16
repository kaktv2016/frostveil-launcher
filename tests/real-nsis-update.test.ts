import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {extractFile,listPackage} from '@electron/asar';
import {_electron as electron} from '@playwright/test';
import {InstallerSandboxDemo} from '../src/main/installer/demo';
import {MetadataStore} from '../src/main/installer/metadata';
import {LauncherUpdateService} from '../src/main/launcher-update-service';
import {NsisEngine} from '../src/main/updater-engine';
import {
 LAUNCHER_MANIFEST_ASSET,
 LauncherUpdateTransport,
 signLauncherUpdateManifest,
 validateLauncherUpdateManifest,
 type LauncherUpdateSource
} from '../src/main/update-integrity';

function runProcess(command:string,args:string[],cwd:string):Promise<{code:number|null;stdout:string;stderr:string}>{
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',d=>{stdout+=d.toString();});
  child.stderr.on('data',d=>{stderr+=d.toString();});
  child.once('error',reject);
  child.once('close',code=>resolve({code,stdout,stderr}));
 });
}

interface DisposableBoot {localData:string;profile:string;events:string;closeRequest:string;}
async function buildDisposableNsisInstaller(projectRoot:string,outDir:string,version:string,boot:DisposableBoot):Promise<string>{
 await fs.mkdir(outDir,{recursive:true});
 const injected=path.join(outDir,'disposable-entry');await fs.mkdir(injected);
 // Test-build-only prelude. The fixed temporary storage must survive NSIS's
 // Explorer-based restart, which does not reliably inherit environment overrides.
 // No such entry or private test path is used in production packaging.
 const prelude=`
const __fvBoot=${JSON.stringify(boot)};
process.env.LOCALAPPDATA=__fvBoot.localData;
process.env.FROSTVEIL_DISPOSABLE_UPDATE_TEST='1';
if(!process.argv.includes('--launcher-update-test'))process.argv.push('--launcher-update-test','--launcher-update-test-profile',__fvBoot.profile);
const __fvFs=require('node:fs'),__fvApp=require('electron').app;
function __fvEvent(kind){__fvFs.appendFileSync(__fvBoot.events,JSON.stringify({kind,version:__fvApp.getVersion(),pid:process.pid,argv:process.argv})+String.fromCharCode(10));}
__fvEvent('start');
__fvApp.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',()=>__fvEvent('ready')));
__fvApp.on('before-quit',()=>__fvEvent('quit'));
setInterval(()=>{if(__fvFs.existsSync(__fvBoot.closeRequest))__fvApp.quit();},100).unref();
`;
 await fs.writeFile(path.join(injected,'main.cjs'),prelude+await fs.readFile(path.join(projectRoot,'dist/main.cjs'),'utf8'));
 const configPath=path.join(outDir,`builder-${version}.json`);
 const config={
  appId:'dev.skyrimrp.launcher.disposable-test',
  productName:'Frostveil Disposable Test',
  npmRebuild:false,
  directories:{
   output:outDir
  },
  files:[
   {from:'dist',to:'dist',filter:['**/*','!main.cjs']},
   {from:injected,to:'dist',filter:['main.cjs']},
   'assets/**',
   'package.json'
  ],
  asar:true,
  win:{
   target:['nsis'],
   signAndEditExecutable:false,
   artifactName:'FrostveilDisposable-${version}-${arch}.exe'
  },
  nsis:{
   oneClick:false,
   perMachine:false,
   allowToChangeInstallationDirectory:true,
   createDesktopShortcut:false,
   createStartMenuShortcut:false,
   runAfterFinish:false
  },
  publish:{
   provider:'github',
   owner:'kaktv2016',
   repo:'frostveil-launcher',
   private:false,
   releaseType:'release'
  }
 };
 await fs.writeFile(configPath,JSON.stringify(config,null,2));
 const cli=path.join(projectRoot,'node_modules','electron-builder','cli.js');
 const res=await runProcess(
  process.execPath,
  [cli,'--win','nsis','--publish','never','--config',configPath,`-c.extraMetadata.version=${version}`],
  projectRoot
 );
 if(res.code!==0){
  throw Error(`Disposable NSIS build (${version}) failed: ${res.stderr||res.stdout}`);
 }
 assert.ok(listPackage(path.join(outDir,'win-unpacked/resources/app.asar'),{isPack:false}).some(p=>/node_modules[\\/]electron-updater[\\/]package\.json$/.test(p)),'Installed application requires its production updater dependencies');
 return path.join(outDir,`FrostveilDisposable-${version}-x64.exe`);
}

test('Real Windows NSIS Update: older installed 0.1.5 NSIS build upgrades to signed 0.1.6 NSIS build in isolated temp directory while preserving user settings and ownership',async()=>{
 const projectRoot=path.resolve('.');
 // Ensure dist/ is built before packaging disposable NSIS installers
 const buildRes=await runProcess(process.execPath,['scripts/build.mjs'],projectRoot);
 assert.equal(buildRes.code,0,`Build failed: ${buildRes.stderr}`);

 const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-real-nsis-'));
 const installDir=path.join(tempRoot,'installed-app');
 const isolatedLocalData=path.join(tempRoot,'isolated-local-app-data'),storage=path.join(isolatedLocalData,'SkyrimRPLauncher');
 const userDataDir=path.join(storage,'user-data');
 const boot:DisposableBoot={localData:isolatedLocalData,profile:path.join(tempRoot,'update-test-profile.json'),events:path.join(tempRoot,'boot-events.jsonl'),closeRequest:path.join(tempRoot,'close-request')};
 await fs.mkdir(installDir,{recursive:true});
 await fs.mkdir(userDataDir,{recursive:true});

 // Snapshot user's real 0.1.4 installation if present to verify zero interference
 const realUserInstallDir=path.join(process.env.LOCALAPPDATA??'','Programs','Skyrim RP Launcher');
 let realExeShaBefore:string|null=null;
 try{
  const realExe=await fs.readFile(path.join(realUserInstallDir,'Skyrim RP Launcher.exe'));
  realExeShaBefore=createHash('sha256').update(realExe).digest('hex');
 }catch{/* Not present on machine */}

 // Seed user settings and Modpack ownership data that must survive Launcher update
 const settingsFile=path.join(storage,'settings.json');
 const ownershipFile=path.join(userDataDir,'ownership.json');
 const settingsContent=JSON.stringify({directory:'C:\\Games\\Skyrim Special Edition',channel:'stable'},null,2);
 const ownershipContent=JSON.stringify({schemaVersion:1,packId:'frostveil',packVersion:'1.0.0',files:['Data/Frostveil/settings.json']},null,2);
 await fs.writeFile(settingsFile,settingsContent);
 await fs.writeFile(ownershipFile,ownershipContent);
 const persisted=new InstallerSandboxDemo(storage);await persisted.run();
 assert.equal(persisted.snapshot().phase,'complete');persisted.dispose();
 const pointer=JSON.parse(await fs.readFile(path.join(storage,'installer-sandbox-session.json'),'utf8'));
 const fixtureStore=await MetadataStore.recover(pointer.directory);
 async function snapshotMetadata(){
  const result:Record<string,string>={};
  async function walk(root:string){for(const e of await fs.readdir(root,{withFileTypes:true})){const file=path.join(root,e.name);if(e.isDirectory())await walk(file);else result[path.relative(fixtureStore.grant.metadata,file)]=createHash('sha256').update(await fs.readFile(file)).digest('hex');}}
  await walk(fixtureStore.grant.metadata);return result;
 }
 const metadataBefore=await snapshotMetadata(),receiptBefore=await fixtureStore.read('ownership.json');
 async function events(){try{return(await fs.readFile(boot.events,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e;}}
 async function until(check:()=>Promise<boolean>,label:string){const deadline=Date.now()+90000;while(!await check()){if(Date.now()>deadline)throw Error('Timed out waiting for '+label);await new Promise(r=>setTimeout(r,100));}}

 let httpServer:http.Server|undefined;
 try{
  const installer015=await buildDisposableNsisInstaller(projectRoot,path.join(tempRoot,'build-015'),'0.1.5',boot);
  const installer016=await buildDisposableNsisInstaller(projectRoot,path.join(tempRoot,'build-016'),'0.1.6',boot);

  // Install 0.1.5 silently into isolated temp installDir
  const install015Res=await runProcess(installer015,['/S',`/D=${installDir}`],tempRoot);
  assert.equal(install015Res.code,0,'NSIS 0.1.5 silent install failed');

  const asarPath=path.join(installDir,'resources','app.asar');
  const pkgBefore=JSON.parse(extractFile(asarPath,'package.json').toString('utf8'));
  assert.equal(pkgBefore.version,'0.1.5');

  // Sign 0.1.6 installer with disposable Ed25519 launcher update key
  const keyPair=generateKeyPairSync('ed25519');
  const publicKey=keyPair.publicKey.export({type:'spki',format:'pem'}).toString();
  const keyId='frostveil-launcher-test-20261016';
  const installer016Bytes=await fs.readFile(installer016);
  const sha512=createHash('sha512').update(installer016Bytes).digest('base64');
  const sha256=createHash('sha256').update(installer016Bytes).digest('hex');
  const nowIso=new Date().toISOString();
  const expiresAt=new Date(Date.now()+7*86400000).toISOString();
  const assetName=path.basename(installer016);

  const manifest=validateLauncherUpdateManifest({
   schemaVersion:1,
   keyId,
   owner:'kaktv2016',
   repo:'frostveil-launcher',
   tag:'v0.1.6',
   version:'0.1.6',
   channel:'stable',
   minimumLauncherVersion:'0.1.5',
   publishedAt:nowIso,
   expiresAt,
   releaseNotes:'Real Windows NSIS upgrade test from 0.1.5 to 0.1.6',
   installer:{
    assetId:6001,
    assetName,
    size:installer016Bytes.length,
    sha512,
    sha256
   }
  });
  const envelope=signLauncherUpdateManifest(manifest,keyPair.privateKey);
  const envelopeBytes=Buffer.from(JSON.stringify(envelope),'utf8');
  const release={
   id:6000,
   tag_name:'v0.1.6',
   draft:false,
   prerelease:false,
   published_at:nowIso,
   body:manifest.releaseNotes,
   assets:[
    {
     id:6001,
     name:assetName,
     size:installer016Bytes.length,
     state:'uploaded' as const,
     digest:'sha256:'+sha256
    },
    {
     id:6002,
     name:LAUNCHER_MANIFEST_ASSET,
     size:envelopeBytes.length,
     state:'uploaded' as const,
     digest:'sha256:'+createHash('sha256').update(envelopeBytes).digest('hex')
    }
   ]
  };

  httpServer=http.createServer((req,res)=>{
   if(req.url==='/repos/kaktv2016/frostveil-launcher/releases/latest'){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(release));
    return;
   }
   if(req.url==='/repos/kaktv2016/frostveil-launcher/releases/assets/6002'){
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(envelopeBytes.length)});
    res.end(envelopeBytes);
    return;
   }
   if(req.url==='/repos/kaktv2016/frostveil-launcher/releases/assets/6001'){
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(installer016Bytes.length)});
    res.end(installer016Bytes);
    return;
   }
   res.writeHead(404).end();
  });
  await new Promise<void>(r=>httpServer!.listen(0,'127.0.0.1',()=>r()));
  const port=(httpServer.address() as {port:number}).port;
  const origin=`http://127.0.0.1:${port}/`;

  const source:LauncherUpdateSource={
   mode:'disposable-test',
   owner:'kaktv2016',
   repo:'frostveil-launcher',
   channel:'stable',
   keys:{
    [keyId]:{
     publicKey,
     environment:'test',
     revoked:false,
     expiresAt
    }
   }
  };

  // Exercise the installed executable and real updater bootstrap (not FixtureEngine).
  const updateProfile=boot.profile;
  await fs.writeFile(updateProfile,JSON.stringify({schemaVersion:1,repository:'kaktv2016/frostveil-launcher',loopbackOrigin:origin,installDirectory:installDir,keyId,publicKey,fingerprint:createHash('sha256').update(keyPair.publicKey.export({type:'spki',format:'der'})).digest('hex'),expiresAt,revoked:false}));
  const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),LOCALAPPDATA:isolatedLocalData,FROSTVEIL_DISPOSABLE_UPDATE_TEST:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const installedApp=await electron.launch({executablePath:path.join(installDir,'Frostveil Disposable Test.exe'),args:['--launcher-update-test','--launcher-update-test-profile',updateProfile],env,timeout:30000});
  try{
   const page=await installedApp.firstWindow();
   await page.waitForFunction(async()=> (await window.launcher.status()).launcherUpdate?.state==='available',undefined,{timeout:30000});
   const state=await page.evaluate(()=>window.launcher.status());
   assert.equal(state.version,'0.1.5');assert.equal(state.launcherUpdate?.publisherTrust,'verified');
   assert.equal(state.launcherUpdate?.keyId,keyId);assert.equal(state.launcherUpdate?.canDownload,true);
   assert.deepEqual(state.settings,JSON.parse(settingsContent));
   await page.evaluate(()=>window.launcher.downloadUpdate());
   assert.equal((await page.evaluate(()=>window.launcher.status())).launcherUpdate?.verification,'installer-verified');
   // No replacement callback: exercise the actual Main IPC -> service -> verified
   // handoff -> spawn (--updated /S --force-run /D) -> installed app restart.
   await page.evaluate(()=>window.launcher.installUpdate());
   await until(async()=> (await events()).some(e=>e.kind==='ready'&&e.version==='0.1.6'),'installed application restart');
   const history=await events();
   assert.ok(history.some(e=>e.kind==='quit'&&e.version==='0.1.5'),'Old installed application exited through its normal quit event');
   assert.ok(history.some(e=>e.kind==='start'&&e.version==='0.1.6'&&e.argv.includes('--updated')),'NSIS force-run restarted the installed new version');
   await fs.writeFile(boot.closeRequest,'close owned disposable test application');
   await until(async()=> (await events()).some(e=>e.kind==='quit'&&e.version==='0.1.6'),'new disposable application close');
   assert.deepEqual(await snapshotMetadata(),metadataBefore,'Authenticated ownership, journals and backup bytes survived the real app update');
   assert.deepEqual(await fixtureStore.read('ownership.json'),receiptBefore);
   assert.equal(await fs.readFile(settingsFile,'utf8'),settingsContent);
  }finally{await fs.writeFile(boot.closeRequest,'close owned disposable test application');await installedApp.close().catch(()=>{});}

  const engine=new NsisEngine([],{
   source,
   transport:LauncherUpdateTransport.loopback(origin,'disposable-test'),
   storageDir:userDataDir,
   installedVersion:'0.1.5',
   installDirectory:installDir,
   runHandoffInstaller:async(handoffFile)=>{
    // Execute the verified handoff NSIS installer synchronously against the isolated installDir
    const upgradeRes=await runProcess(handoffFile,['/S',`/D=${installDir}`],tempRoot);
    assert.equal(upgradeRes.code,0,'NSIS 0.1.6 silent upgrade failed');
   }
  });
  const service=new LauncherUpdateService(engine,{
   version:'0.1.5',
   checkEnabled:true,
   downloadTrusted:true,
   installed:true,
   gameRunning:async()=>false
  });

  await service.check();
  assert.equal(service.snapshot().state,'available');
  assert.equal(service.snapshot().availableVersion,'0.1.6');
  assert.equal(service.snapshot().verification,'manifest-verified');

  await service.download();
  assert.equal(service.snapshot().state,'downloaded');
  assert.equal(service.snapshot().verification,'installer-verified');

  await service.install();
  assert.equal(service.snapshot().state,'installing');

  // Verify the installed app on disk was genuinely upgraded from 0.1.5 to 0.1.6!
  const pkgAfter=JSON.parse(extractFile(asarPath,'package.json').toString('utf8'));
  assert.equal(pkgAfter.version,'0.1.6');

  // Verify user settings and Modpack ownership data survived the upgrade untouched
  assert.equal(await fs.readFile(settingsFile,'utf8'),settingsContent);
  assert.equal(await fs.readFile(ownershipFile,'utf8'),ownershipContent);

  // Verify the user's real 0.1.4 installation was completely untouched
  if(realExeShaBefore!==null){
   const realExeAfter=await fs.readFile(path.join(realUserInstallDir,'Skyrim RP Launcher.exe'));
   assert.equal(createHash('sha256').update(realExeAfter).digest('hex'),realExeShaBefore);
  }
  service.dispose();
 }finally{
  await fs.writeFile(boot.closeRequest,'close owned disposable test application').catch(()=>{});
  if(httpServer){
   await new Promise<void>(r=>httpServer!.close(()=>r()));
  }
  const uninstaller=path.join(installDir,'Uninstall Frostveil Disposable Test.exe');
  try{
   await fs.stat(uninstaller);
   await runProcess(uninstaller,['/currentuser','/S'],tempRoot);
  }catch{/* Ignore if not installed */}
  assert.equal(path.dirname(path.resolve(tempRoot)),path.resolve(os.tmpdir()));
  await fs.rm(tempRoot,{recursive:true,force:true}).catch(()=>{});
 }
});
