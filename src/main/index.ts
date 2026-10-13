import {app,BrowserWindow,ipcMain,dialog,protocol,net} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {scanInstallation} from './installation';
import {discoverSteam} from './discovery';
import {fileVersion,steamRoots,gameRunning,startSkse} from './windows';
import {createBackup} from './backup';
import {GameLauncher} from './launch';
import {authorize,validateSettings} from './authorization';
import {contained,relativePath,safeDirectory,noLinks,checkExistingAncestors} from './files';
import {updateState} from './updates';
import {selectInstallation} from './session-state';
import {createUpdater} from './update-bootstrap';
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
 const profile:Profile=JSON.parse((await fs.readFile(profileFile,'utf8')).replace(/^\uFEFF/,''));
 let settings:Settings={directory:fixture?path.join(fixture,'game'):'',channel:'stable'};
 try{settings=validateSettings(JSON.parse(await fs.readFile(settingsPath,'utf8')));}catch{/* first start or invalid local settings: safe defaults */}
 const state:Dashboard={version:app.getVersion(),settings,scan:null,backup:null,updates:updateState(settings.channel),server:'NOT TESTED',events:[]};
 const writeLocal=async(file:string,data:unknown)=>{try{await noLinks(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await fs.writeFile(file,JSON.stringify(data,null,2));};
 const log=async(message:string)=>{state.events.unshift(new Date().toISOString()+' '+message);state.events=state.events.slice(0,60);await writeLocal(path.join(storage,'diagnostics.json'),state.events);};
 const version=fixture?async(file:string)=>path.basename(file)==='SkyrimSE.exe'?profile.runtime:profile.skseVersion:fileVersion;
 const launch=new GameLauncher(fixture?async()=>false:gameRunning,fixture?async()=>{throw Error('Real game launch blocked in fixture smoke');}:startSkse);
 let busy=false;
 const scan=async()=>{
  if(!settings.directory){const choices=await discoverSteam(await steamRoots());settings.directory=choices[0]??'';}
  state.scan=settings.directory?await scanInstallation(settings.directory,profile,version):null;
  if(!settings.directory)await log('No Steam installation detected; select a game folder');else await log(state.scan?.ready?'Installation matches local baseline; server connection NOT TESTED':'Installation incompatible/unverified — Play blocked');
  await writeLocal(settingsPath,settings);return state.scan;
 };
 const root=path.join(__dirname,'renderer');
 protocol.handle('app',async(request)=>{
  try{const url=new URL(request.url);if(url.host!=='launcher')return new Response('Forbidden',{status:403});const relative=relativePath(decodeURIComponent(url.pathname.slice(1)||'index.html'));const file=path.join(root,...relative.split('/'));if(!contained(root,file))return new Response('Forbidden',{status:403});
   const response=await net.fetch(pathToFileURL(file).href);const headers=new Headers(response.headers);headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");return new Response(response.body,{status:response.status,headers});
  }catch{return new Response('Not found',{status:404});}
 });
 const updater=await createUpdater(!!fixture);
 state.launcherUpdate=updater.snapshot();
 const window=new BrowserWindow({width:1180,height:780,minWidth:960,minHeight:680,show:false,backgroundColor:'#101310',title:'Frostveil Launcher',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 const unsubscribeUpdate=updater.subscribe(snapshot=>{state.launcherUpdate=snapshot;if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('launcher:update-state',snapshot);});
 window.once('closed',()=>{unsubscribeUpdate();updater.dispose();});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(event,url)=>{if(url!=='app://launcher/index.html')event.preventDefault();});
 window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 window.webContents.session.setPermissionCheckHandler(()=>false);
 window.webContents.on('will-attach-webview',event=>event.preventDefault());
 const handler=(name:string,fn:(arg:unknown)=>Promise<void>)=>ipcMain.handle('launcher:'+name,async(event,arg)=>{
  if(event.sender!==window.webContents||!authorize(event.senderFrame?.url??'',event.senderFrame===window.webContents.mainFrame))throw Error('Unauthorized IPC sender');
  if(name==='status'){await fn(arg);return structuredClone(state);}
  if(busy)throw Error('Another operation is in progress');busy=true;
  try{await fn(arg);return structuredClone(state);}catch(error){const message=error instanceof Error?error.message:'Operation failed';await log(message);throw Error(message);}finally{busy=false;}
 });
 const noArgument=(arg:unknown)=>{if(arg!==undefined)throw Error('Unexpected IPC input');};
 handler('status',async arg=>{noArgument(arg);});
 handler('scan',async arg=>{noArgument(arg);await scan();});
 handler('choose',async arg=>{noArgument(arg);const selected=fixture?path.join(fixture,'game'):(await dialog.showOpenDialog(window,{properties:['openDirectory'],title:'Select folder containing SkyrimSE.exe'})).filePaths[0];if(selected){selectInstallation(state,selected);await scan();}});
 handler('channel',async arg=>{if(arg!=='stable')throw Error('Beta is disabled until channel isolation is verified');settings.channel=validateSettings({directory:settings.directory,channel:arg}).channel;state.updates=updateState(settings.channel);await writeLocal(settingsPath,settings);});
 handler('check-update',async arg=>{noArgument(arg);await updater.check();state.launcherUpdate=updater.snapshot();});
 handler('download-update',async arg=>{noArgument(arg);await updater.download();state.launcherUpdate=updater.snapshot();});
 handler('install-update',async arg=>{noArgument(arg);await updater.install();state.launcherUpdate=updater.snapshot();});
 handler('defer-update',async arg=>{noArgument(arg);updater.defer();state.launcherUpdate=updater.snapshot();});
 handler('backup',async arg=>{noArgument(arg);if(!settings.directory)throw Error('Select a game installation first');state.backup=null;state.backup=await createBackup(settings.directory,path.join(storage,'backups'),profile);await log(`Verified integration backup: ${state.backup.files} files (${state.backup.skipped.length} skipped); not a full game backup`);});
 handler('play',async arg=>{noArgument(arg);if(['downloading','installing'].includes(updater.snapshot().state))throw Error('Finish launcher update operation first');await launch.play(async()=>{const current=await scan();if(!current)throw Error('No installation selected');return current;});await log('SKSE process started; in-game/server connection still requires manual verification');});
 app.on('second-instance',()=>{if(window.isMinimized())window.restore();window.focus();});
 window.once('ready-to-show',()=>{window.show();});
 await window.loadURL('app://launcher/index.html');
 if(!fixture)void updater.check();
 app.on('window-all-closed',()=>app.quit());
}
