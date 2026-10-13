import {contextBridge,ipcRenderer} from 'electron';
import type {LauncherApi,Dashboard,Channel,LauncherUpdate} from '../shared/contracts';
const call=(name:string,arg?:unknown):Promise<Dashboard>=>ipcRenderer.invoke('launcher:'+name,arg);
const api:LauncherApi={status:()=>call('status'),scan:()=>call('scan'),chooseDirectory:()=>call('choose'),setChannel:(channel:Channel)=>call('channel',channel),backup:()=>call('backup'),play:()=>call('play'),checkUpdate:()=>call('check-update'),downloadUpdate:()=>call('download-update'),installUpdate:()=>call('install-update'),deferUpdate:()=>call('defer-update'),onUpdate(listener){if(typeof listener!=='function')throw Error('Listener required');const handler=(_event:unknown,state:LauncherUpdate)=>listener(state);ipcRenderer.on('launcher:update-state',handler);return()=>{ipcRenderer.removeListener('launcher:update-state',handler);};}};
contextBridge.exposeInMainWorld('launcher',Object.freeze(api));
