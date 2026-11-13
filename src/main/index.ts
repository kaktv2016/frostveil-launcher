import {RuntimePreparation} from './runtime/service';
import {preparePlay,restorePlay} from './runtime/whole-play';
import {planClientForWholePlay,clientRequirementForScan,nativeRequirementForScan} from './client-repair';
import {clientRepairPin} from './client-repair-pin';
import {planGraphicsSourcesForWholePlay,repairGraphicsSources,type GraphicsSourcePlan} from './graphics-source-repair';
import {sourceVerifiesLegacyTarget} from './navigation-repair-targets';
import {loadGraphicsSourcePlan,graphicsSourceDirectories} from './graphics-source-plan';
import {ProductionDownloads} from './management/downloads';import {inspectSkyUI,SKYUI_SOURCE} from './management/external-mods';
import {GraphicsPackService} from './management/graphics-pack';
import {ManagementService} from './management/service';import {runManagementFixtureDemo} from './management/demo';
import {readTestProfile} from './distribution/level-b';
import {DistributionService} from './distribution/service';
import {app,BrowserWindow,ipcMain,dialog,protocol,net,shell} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {scanInstallation} from './installation';
import {discoverSteam} from './discovery';
import {fileVersion,steamRoots,gameRunning,startSkse} from './windows';
import {createBackup} from './backup';
import {GameLauncher} from './launch';
import {authorize,validateSettings} from './authorization';
import {contained,relativePath,safeDirectory,safeFile,noLinks,checkExistingAncestors} from './files';
import {updateState} from './updates';
import {selectInstallation} from './session-state';
import {createUpdater} from './update-bootstrap';
import {InstallerSandboxDemo} from './installer/demo';
import {durableWrite} from './installer/metadata';
import {ModpackVerifier,mandatoryPackPolicy} from './modpack/service';
import type {Dashboard,Profile,Settings} from '../shared/contracts';

const smoke=process.argv.includes('--smoke');
const fixture=smoke?process.env.SKYRIM_LAUNCHER_FIXTURE:undefined;
if(smoke&&!fixture)throw Error('Smoke mode requires a synthetic fixture directory');
const storage=fixture?path.join(fixture,'app-data'):path.join(process.env.LOCALAPPDATA??app.getPath('userData'),'SkyrimRPLauncher');
checkExistingAncestors(storage);
app.setPath('userData',path.join(storage,'user-data'));
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
if(!app.requestSingleInstanceLock()){app.quit();}else{void start().catch(error=>{console.error('Launcher startup failed:',error instanceof Error?error.message:'Unknown error');app.quit();});}

async function start(){
 await app.whenReady();await safeDirectory(storage);
 const settingsPath=path.join(storage,'settings.json');
 let profileFile=fixture?path.join(fixture,'profile.json'):path.join(storage,'compatibility-profile.json');
 if(!fixture){try{await noLinks(profileFile);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;profileFile=path.join(__dirname,'../assets/local-baseline.json');}}
 let profile:Profile=JSON.parse((await fs.readFile(profileFile,'utf8')).replace(/^\uFEFF/,''));
 let settings:Settings={directory:fixture?path.join(fixture,'game'):'',channel:'stable'};
 try{settings=validateSettings(JSON.parse(await fs.readFile(settingsPath,'utf8')));}catch{/* first start or invalid local settings: safe defaults */}
 const state:Dashboard={version:app.getVersion(),settings,scan:null,backup:null,updates:updateState(settings.channel),server:'NOT TESTED',events:[]};
 const runtimePreparation=new RuntimePreparation(storage,path.join(__dirname,'../assets/runtime-1170.json'),path.join(app.getPath('documents'),'My Games','Skyrim Special Edition'));state.runtimePreparation=runtimePreparation.snapshot();
 const downloads=new ProductionDownloads(storage,app.getVersion(),undefined,undefined,fixture?async()=>false:gameRunning);state.productionDownloads=downloads.snapshot();
 const graphicsPack=new GraphicsPackService(storage);state.graphicsPack=graphicsPack.snapshot();
 const writeLocal=async(file:string,data:unknown)=>{try{await noLinks(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await fs.writeFile(file,JSON.stringify(data,null,2));};
 const log=async(message:string)=>{state.events.unshift(new Date().toISOString()+' '+message);state.events=state.events.slice(0,60);await writeLocal(path.join(storage,'diagnostics.json'),state.events);};
 const version=fixture?async(file:string)=>path.basename(file)==='SkyrimSE.exe'?profile.runtime:profile.skseVersion:fileVersion;
 const launch=new GameLauncher(fixture?async()=>false:gameRunning,fixture?async()=>{throw Error('Real game launch blocked in fixture smoke');}:startSkse);
 let graphicsPreparation:AbortController|undefined;
 const prepareGraphics=async(orderDirectory:string)=>{
  if(graphicsPreparation)throw Error('Graphics preparation is already running');
  const preparation=new AbortController();graphicsPreparation=preparation;
  try{
  if(await gameRunning())throw Error('Skyrim/SKSE is running; close it before graphics preparation');
  if(await fileVersion(await safeFile(settings.directory,'SkyrimSE.exe'))!=='1.6.1170.0')throw Error('Original-source graphics repair requires the pinned Skyrim 1.6.1170.0 runtime');
  const plan=await loadGraphicsSourcePlan(storage);
  preparation.signal.throwIfAborted();
  graphicsPack.setSourceRepairTargets(plan.files.map(f=>f.path).filter(sourceVerifiesLegacyTarget));
  await graphicsPack.downloadAndInstall(settings.directory,orderDirectory);
  preparation.signal.throwIfAborted();
  const result=await repairGraphicsSources(settings.directory,storage,gameRunning,plan,{
   sourceDirectories:await graphicsSourceDirectories(storage),
   signal:preparation.signal,
   progress:(phase,done,total)=>{const count=total?(phase.startsWith('downloading ')?` ${((done??0)/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`:` ${done}/${total}`):'';graphicsPack.reportSourceRepair(`Preparing player files · ${phase}${count}`);},
  });
  graphicsPack.reportSourceRepair(`Original mod assets verified · repair ${plan.version} · ${result.changed} files restored`,true);
  await log(`Graphics source repair ${plan.version}: ${result.changed} files restored; verified R2 source cache available for automatic repairs`);
  preparation.signal.throwIfAborted();
  }finally{graphicsPreparation=undefined;}
 };
 let busy=false;
 let scanRevision=0;
 let providerQueue=Promise.resolve();
 let settingsQueue=Promise.resolve();
 let packInspection:Promise<unknown>|undefined;
 const saveSettings=()=>{
  const bytes=Buffer.from(JSON.stringify(settings,null,2));
  const saved=settingsQueue.then(()=>durableWrite(settingsPath,bytes));
  settingsQueue=saved.catch(()=>{});
  return saved;
 };
 // The shared download service publishes inspection results internally. Let
 // its current read finish before another pack operation publishes state.
 const waitForPackInspection=async(signal:AbortSignal)=>{
  const inspection=packInspection;
  if(!inspection)return;
  signal.throwIfAborted();
  let abort=()=>{};
  try{
   await Promise.race([inspection.catch(()=>{}),new Promise<never>((_,reject)=>{
    abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
   })]);
  }finally{signal.removeEventListener('abort',abort);}
 };
 const orderDirectory=()=>fixture?path.join(fixture,'order'):path.join(process.env.LOCALAPPDATA??'','Skyrim Special Edition');
 const refreshRecovery=()=>smoke?Promise.resolve():runtimePreparation.refreshRecovery(settings.directory,orderDirectory());
 const localScan=async(directory:string,baseline:Profile)=>{
  const files=fixture?baseline.files:await Promise.all(baseline.files.map(async file=>
   nativeRequirementForScan(await clientRequirementForScan(file,directory),directory)));
  return scanInstallation(directory,{...baseline,files},version);
 };
 const setSelection=async(directory:string)=>{
  scanRevision++;
  selectInstallation(state,directory);
  await refreshRecovery();
 };
 const scan=async(localOnly=false)=>{
  let revision=++scanRevision;
  if(!localOnly&&!settings.directory){
   const choices=await discoverSteam(await steamRoots());
   if(revision!==scanRevision)return state.scan;
   if(choices[0]){
    const selected=setSelection(choices[0]);
    revision=scanRevision;
    await Promise.all([selected,saveSettings()]);
    if(revision!==scanRevision)return state.scan;
   }
  }
  const directory=settings.directory;
  const current=()=>revision===scanRevision&&directory===settings.directory;
  await refreshRecovery();
  if(!current())return state.scan;
  let baseline=profile;
  const commitLocal=async()=>{
   const result=directory?await localScan(directory,baseline):null;
   if(current())state.scan=result;
  };
  await commitLocal();
  if(!current())return state.scan;
  const allowProviders=!localOnly&&!!directory&&!fixture&&!smoke&&
   !(process.argv.includes('--launcher-update-test')&&process.env.FROSTVEIL_DISPOSABLE_UPDATE_TEST==='1');
  if(allowProviders){
   state.verificationWarning=undefined;
   const providerUnavailable=()=>{
    if(current())state.verificationWarning='ตรวจข้อมูลยืนยันชุดเกมออนไลน์ไม่ได้ ลองกด Re-scan อีกครั้งเมื่อบริการพร้อม';
   };
   const verify=providerQueue.then(async()=>{
    if(!current())return;
    if(!baseline.files.length){
     try{
      const signedBaseline=await downloads.baselineProfile();
      if(!current())return;
      baseline=signedBaseline;
      profile=baseline;
      await commitLocal();
     }catch{
      providerUnavailable();
     }
    }
    if(!current())return;
    const inspection=downloads.inspectInstallation(directory,orderDirectory());
    packInspection=inspection;
    try{await inspection;}
    catch{providerUnavailable();}
    finally{
     if(current())state.productionDownloads=downloads.snapshot();
     else downloads.setInstalled(false);
     packInspection=undefined;
    }
    if(!current())return;
    try{
     const graphics=await new GraphicsPackService(storage).inspect(directory);
     if(current())state.graphicsPack=graphics;
    }catch{providerUnavailable();}
   });
   providerQueue=verify.catch(()=>{});
   await verify;
  }
  if(current()&&!localOnly){
   await log(!directory?'No Steam installation detected; select a game folder':
    state.scan?.ready?'Installation matches local baseline; server connection NOT TESTED':'Installation incompatible/unverified — Play blocked');
  }
  return state.scan;
 };
 const root=path.join(__dirname,'renderer');
 protocol.handle('app',async(request)=>{
  try{const url=new URL(request.url);if(url.host!=='launcher')return new Response('Forbidden',{status:403});const relative=relativePath(decodeURIComponent(url.pathname.slice(1)||'index.html'));const file=path.join(root,...relative.split('/'));if(!contained(root,file))return new Response('Forbidden',{status:403});
   const response=await net.fetch(pathToFileURL(file).href);const headers=new Headers(response.headers);headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");return new Response(response.body,{status:response.status,headers});
  }catch{return new Response('Not found',{status:404});}
 });
 const updater=await createUpdater(!!fixture);
 const modpack=new ModpackVerifier(fixture??storage,app.getVersion(),fixture?path.join(fixture,'order'):path.join(process.env.LOCALAPPDATA??'','Skyrim Special Edition'),version);
 const levelBEnabled=process.argv.includes('--distribution-level-b'),profileIndex=process.argv.indexOf('--level-b-profile'),levelBProfileFile=levelBEnabled&&profileIndex>=0?process.argv[profileIndex+1]:undefined;if(levelBEnabled&&(!levelBProfileFile||!path.isAbsolute(levelBProfileFile)))throw Error('Explicit absolute public test profile required');const levelBProfile=levelBProfileFile?await readTestProfile(levelBProfileFile):undefined;
 const distribution=new DistributionService(storage,levelBProfile);await distribution.initialize();state.distribution=distribution.snapshot();
 const management=new ManagementService(storage,app.getVersion(),()=>({directory:settings.directory,orderDirectory:fixture?path.join(fixture,'order'):path.join(process.env.LOCALAPPDATA??'','Skyrim Special Edition'),runtime:state.scan,channel:settings.channel,iniDirectory:fixture?path.join(fixture,'ini'):path.join(app.getPath('documents'),'My Games','Skyrim Special Edition')}),async(plan,hash)=>{if(smoke)return false;const answer=await dialog.showMessageBox(window,{type:'warning',title:'Review exact Skyrim modpack plan',message:'Authorize this exact installation transaction?',detail:hash+'\n'+JSON.stringify(plan,null,2),buttons:['Cancel','Authorize this plan'],defaultId:0,cancelId:0,noLink:true});return answer.response===1;},version,undefined,undefined,(grant,ref,signal)=>downloads.stage(grant,ref,signal));await management.initialize();state.management=management.snapshot();
 const installer=new InstallerSandboxDemo(storage);await installer.initialize();state.installer=installer.snapshot();
 state.modpack=modpack.snapshot();
 state.launcherUpdate=updater.snapshot();
 const window=new BrowserWindow({width:1180,height:780,minWidth:960,minHeight:680,show:true,backgroundColor:'#101310',title:'Frostveil Launcher',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 const unsubscribeRuntime=runtimePreparation.subscribe(snapshot=>{state.runtimePreparation=snapshot;if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('launcher:runtime-preparation-state',snapshot);});
 const unsubscribeDownloads=downloads.subscribe(snapshot=>{if(packInspection)return;state.productionDownloads=snapshot;if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('launcher:production-downloads-state',snapshot);});
 const unsubscribeGraphicsPack=graphicsPack.subscribe(snapshot=>{state.graphicsPack=snapshot;if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('launcher:graphics-pack-state',snapshot);});
 const unsubscribeUpdate=updater.subscribe(snapshot=>{state.launcherUpdate=snapshot;if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('launcher:update-state',snapshot);});
 const unsubscribePack=modpack.subscribe(snapshot=>{state.modpack=snapshot;if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('launcher:modpack-state',snapshot);});
 const unsubscribeDistribution=distribution.subscribe(snapshot=>{state.distribution=snapshot;if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('launcher:distribution-state',snapshot);});
 const unsubscribeManagement=management.subscribe(snapshot=>{state.management=snapshot;if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('launcher:management-state',snapshot);});
 const unsubscribeInstaller=installer.subscribe(snapshot=>{state.installer=snapshot;if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('launcher:installer-state',snapshot);});
 window.once('closed',()=>{unsubscribeRuntime();runtimePreparation.cancel();unsubscribeGraphicsPack();unsubscribeDownloads();downloads.dispose();unsubscribeManagement();management.dispose();unsubscribeDistribution();distribution.dispose();unsubscribeInstaller();installer.dispose();unsubscribeUpdate();unsubscribePack();modpack.dispose();updater.dispose();});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(event,url)=>{if(url!=='app://launcher/index.html')event.preventDefault();});
 window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 window.webContents.session.setPermissionCheckHandler(()=>false);
 window.webContents.on('will-attach-webview',event=>event.preventDefault());
 const handler=(name:string,fn:(arg:unknown)=>Promise<void>)=>ipcMain.handle('launcher:'+name,async(event,arg)=>{
  if(event.sender!==window.webContents||!authorize(event.senderFrame?.url??'',event.senderFrame===window.webContents.mainFrame))throw Error('Unauthorized IPC sender');
  if(name==='scan'&&busy){noArgument(arg);return structuredClone(state);}
  if(name==='status'||name==='scan'||name==='cancel-runtime'||name==='cancel-server-files'||name==='cancel-graphics-pack'||name==='cancel-management'||name==='cancel-distribution'||name==='cancel-modpack'||name==='cancel-installer-sandbox'){await fn(arg);return structuredClone(state);}
  if(busy)throw Error('Another operation is in progress');
  busy=true;
  scanRevision++;
  try{await fn(arg);return structuredClone(state);}
  catch(error){
   if(name==='inspect-runtime'||name==='prepare-runtime'||name==='restore-runtime'||name==='play'){
    const status=runtimePreparation.snapshot();
    const recoveryAction=status.canRestore
     ?'ลองตรวจใหม่ หรือกดคืนชุดก่อนติดตั้ง Frostveil'
     :'ตรวจ installation ที่เลือก แล้วลองตรวจหรือเตรียมเกมอีกครั้ง';
    const message=status.recovery==='foreign'||status.recovery==='unsafe'
     ?status.recoveryMessage??recoveryAction
     :status.phase==='blocked'||status.phase==='cancelled'?status.message:recoveryAction;
    await log('Runtime operation refused: '+name).catch(()=>{});
    throw Error(message);
   }
   const message=error instanceof Error?error.message:'Operation failed';
   await log(message);
   throw Error(message);
  }finally{busy=false;}
 });
 const noArgument=(arg:unknown)=>{if(arg!==undefined)throw Error('Unexpected IPC input');};
 const runtimeDirectories=()=>{if(smoke)throw Error('Real runtime preparation disabled in fixture smoke');if(!settings.directory)throw Error('Select your Steam Skyrim installation first');return{game:settings.directory,config:path.join(process.env.LOCALAPPDATA??'','Skyrim Special Edition')};};
 handler('inspect-runtime',async arg=>{noArgument(arg);const d=runtimeDirectories();await runtimePreparation.inspect(d.game,d.config);});
 handler('prepare-runtime',async arg=>{noArgument(arg);const d=runtimeDirectories();await runtimePreparation.prepare(d.game,d.config);await scan(true);});
 handler('restore-runtime',async arg=>{
  noArgument(arg);
  const {game,config}=runtimeDirectories();
  await restorePlay(runtimePreparation,game,config,async()=>{
   downloads.setInstalled(false);
   graphicsPack.invalidateInstalled();
   state.productionDownloads={...(state.productionDownloads??downloads.snapshot()),installed:false};
   state.graphicsPack=graphicsPack.snapshot();
   await scan(true);
  });
 });
 const standaloneWrite=async(operation:()=>Promise<unknown>)=>{
  if(fixture||!settings.directory)return operation();
  const {game,config}=runtimeDirectories();
  await runtimePreparation.withStandaloneWrite(game,config,operation);
 };
 handler('cancel-runtime',async arg=>{noArgument(arg);runtimePreparation.cancel();graphicsPreparation?.abort(Error('Runtime preparation cancelled'));graphicsPack.cancel();downloads.cancel();});
 let packInstall:AbortController|undefined;
 handler('download-server-files',async arg=>{
  noArgument(arg);
  if(smoke)throw Error('Production download is disabled in fixture smoke');
  if(!settings.directory)throw Error('Select a game folder first');
  const install=new AbortController();packInstall=install;
  try{
   await waitForPackInspection(install.signal);
   install.signal.throwIfAborted();
   await standaloneWrite(async()=>{install.signal.throwIfAborted();await downloads.installAndActivate(settings.directory,orderDirectory());});
   await scan();
   await log('Server files and SkyUI installed and activated in plugins.txt');
  }finally{packInstall=undefined;}
 });
 handler('cancel-server-files',async arg=>{noArgument(arg);packInstall?.abort(Error('Server file preparation cancelled'));downloads.cancel();});
 handler('download-graphics-pack',async arg=>{noArgument(arg);if(smoke)throw Error('Graphics download is disabled in fixture smoke');if(!settings.directory)throw Error('Select a game folder first');const orderDirectory=fixture?path.join(fixture,'order'):path.join(process.env.LOCALAPPDATA??'','Skyrim Special Edition');await standaloneWrite(()=>prepareGraphics(orderDirectory));await scan();await log('Graphics pack and original-source assets verified');});
 handler('cancel-graphics-pack',async arg=>{noArgument(arg);graphicsPreparation?.abort(Error('Graphics preparation cancelled'));graphicsPack.cancel();});
 handler('open-skyui-source',async arg=>{noArgument(arg);if(smoke)throw Error('External navigation is disabled in fixture smoke');await shell.openExternal(SKYUI_SOURCE);});
 handler('inspect-skyui',async arg=>{noArgument(arg);if(smoke)throw Error('External folders are disabled in fixture smoke');const selected=(await dialog.showOpenDialog(window,{properties:['openDirectory'],title:'Choose extracted SkyUI folder (read-only verification)'})).filePaths[0];if(selected)state.externalMod=await inspectSkyUI(selected);});
 handler('status',async arg=>{noArgument(arg);await refreshRecovery();});
 handler('inspect-management',async arg=>{noArgument(arg);await scan();await management.inspect();});
 handler('prepare-management',async arg=>{await scan();await management.prepare(arg);});
 handler('apply-management',async arg=>{await scan();await standaloneWrite(()=>management.apply(arg));});
 handler('cancel-management',async arg=>{noArgument(arg);management.cancel();});
 handler('rollback-management',async arg=>{noArgument(arg);await scan();await standaloneWrite(()=>management.rollback());});
 handler('recover-management',async arg=>{noArgument(arg);await scan();await standaloneWrite(()=>management.recover());});
 handler('management-fixture',async arg=>{noArgument(arg);state.managementFixture={phase:'running',message:'Disposable installation fixture running',stage:'starting',checks:[]};const emit=()=>window.webContents.send('launcher:management-fixture-state',state.managementFixture);emit();try{const result=await runManagementFixtureDemo(stage=>{state.managementFixture!.stage=stage;emit();});state.managementFixture={phase:'complete',message:'REALISTIC SANDBOX VERIFIED — real Skyrim not modified',stage:'complete',checks:result.checks};}catch(error){state.managementFixture={phase:'error',message:error instanceof Error?error.message:'Fixture failed',stage:'error',checks:[]};throw error;}finally{emit();}});

 handler('scan',async arg=>{noArgument(arg);await scan();});
 handler('choose',async arg=>{noArgument(arg);const selected=fixture?path.join(fixture,'game'):(await dialog.showOpenDialog(window,{properties:['openDirectory'],title:'Select folder containing SkyrimSE.exe'})).filePaths[0];if(selected){
  await setSelection(selected);
  modpack.invalidate();
  downloads.setInstalled(false);
  graphicsPack.invalidateInstalled();
  state.productionDownloads={...(state.productionDownloads??downloads.snapshot()),installed:false};
  state.graphicsPack=graphicsPack.snapshot();
  await saveSettings();
  await scan(true);
 }});
 handler('channel',async arg=>{if(arg!=='stable')throw Error('Beta is disabled until channel isolation is verified');settings.channel=validateSettings({directory:settings.directory,channel:arg}).channel;state.updates=updateState(settings.channel);await saveSettings();});
 handler('check-update',async arg=>{noArgument(arg);await updater.check();state.launcherUpdate=updater.snapshot();});
 handler('download-update',async arg=>{noArgument(arg);await updater.download();state.launcherUpdate=updater.snapshot();});
 handler('install-update',async arg=>{noArgument(arg);await updater.install();state.launcherUpdate=updater.snapshot();});
 handler('defer-update',async arg=>{noArgument(arg);updater.defer();state.launcherUpdate=updater.snapshot();});
 handler('scan-modpack',async arg=>{noArgument(arg);if(!settings.directory)throw Error('Select a game installation first');await scan();await modpack.scan(settings.directory,settings.channel,state.scan);});
 handler('level-b-sandbox',async arg=>{noArgument(arg);if(!levelBProfileFile)throw Error('TEST DISTRIBUTION disabled in ordinary mode');await distribution.runGitHubTest(await readTestProfile(levelBProfileFile));});
 handler('check-distribution',async arg=>{noArgument(arg);await distribution.check();});
 handler('preview-distribution',async arg=>{noArgument(arg);state.distribution=distribution.snapshot();});
 handler('distribution-sandbox',async arg=>{noArgument(arg);await distribution.runLocal();});
 handler('cancel-distribution',async arg=>{noArgument(arg);distribution.cancel();});
 handler('rollback-distribution',async arg=>{noArgument(arg);await distribution.rollback();});
 handler('recover-distribution',async arg=>{noArgument(arg);await distribution.recover();});
 handler('installer-sandbox',async arg=>{noArgument(arg);await installer.run();});
 handler('cancel-installer-sandbox',async arg=>{noArgument(arg);installer.cancel();});
 handler('cancel-modpack',async arg=>{noArgument(arg);modpack.cancel();});
 handler('backup',async arg=>{noArgument(arg);if(!settings.directory)throw Error('Select a game installation first');state.backup=null;state.backup=await createBackup(settings.directory,path.join(storage,'backups'),profile);await log(`Verified integration backup: ${state.backup.files} files (${state.backup.skipped.length} skipped); not a full game backup`);});
 handler('play',async arg=>{
  noArgument(arg);
  if(['downloading','installing'].includes(updater.snapshot().state))throw Error('Finish launcher update operation first');
  if(!settings.directory)throw Error('Select your Skyrim installation first');
  await launch.play(async()=>{
   if(smoke){
    const current=await scan();
    if(!current)throw Error('No installation selected');
    return current;
   }
   if(mandatoryPackPolicy)throw Error('The additional pack verifier has no pinned whole-Play admission');
   const {game,config}=runtimeDirectories();
   let graphicsSourcePlan:GraphicsSourcePlan;
   let packAdmission:Awaited<ReturnType<ProductionDownloads['wholePlayAdmission']>>;
   let verifiedBaseline:Profile|undefined;
   try{
   const current=await preparePlay(runtimePreparation,game,config,{
    legacyGraphics:async projection=>{
     await waitForPackInspection(projection.signal);
     packAdmission=await downloads.wholePlayAdmission(projection.signal);
     graphicsSourcePlan=await loadGraphicsSourcePlan(storage);
     projection.signal.throwIfAborted();
     graphicsPack.setSourceRepairTargets(graphicsSourcePlan.files.map(file=>file.path).filter(sourceVerifiesLegacyTarget));
     const reserved=new Set([...packAdmission.packagedTargets,clientRepairPin.path.toLowerCase(),
      ...graphicsSourcePlan.files.map(file=>file.path.toLowerCase())]);
     return graphicsPack.planWholePlay(projection,reserved);
    },
    sourceGraphics:async projection=>planGraphicsSourcesForWholePlay(game,storage,gameRunning,graphicsSourcePlan,{
     sourceDirectories:await graphicsSourceDirectories(storage),
     progress:(phase,done,total)=>{
      const count=total?(phase.startsWith('downloading ')?` ${((done??0)/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`:` ${done}/${total}`):'';
      graphicsPack.reportSourceRepair(`Preparing player files · ${phase}${count}`);
     },
    },projection),
    client:projection=>planClientForWholePlay(storage,projection,gameRunning),
    pack:projection=>packAdmission.plan(game,config,projection),
    scan:async baseline=>{
     const current=await localScan(game,baseline);
     if(!current.ready)throw Error('Final installation scan did not verify the signed Play profile');
     verifiedBaseline=baseline;
     return current;
    },
   });
   if(verifiedBaseline)profile=verifiedBaseline;
   state.scan=current;
   state.productionDownloads=downloads.snapshot();
   state.graphicsPack=graphicsPack.snapshot();
   return current;
   }catch(error){
    state.scan=null;
    downloads.setInstalled(false);
    graphicsPack.invalidateInstalled();
    state.productionDownloads={...(state.productionDownloads??downloads.snapshot()),installed:false};
    state.graphicsPack=graphicsPack.snapshot();
    throw error;
   }
  });
  await log('SKSE process started; in-game/server connection still requires manual verification');
 });
 app.on('second-instance',()=>{window.show();if(window.isMinimized())window.restore();window.focus();});
 window.once('ready-to-show',()=>{window.show();});
 await window.loadURL('app://launcher/index.html');window.show();window.focus();
 if(!fixture)void updater.check();
 app.on('window-all-closed',()=>app.quit());
}
