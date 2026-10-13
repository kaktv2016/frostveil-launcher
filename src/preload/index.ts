import {contextBridge,ipcRenderer} from 'electron';
import type {LauncherApi,Dashboard,Channel} from '../shared/contracts';
const call=(name:string,arg?:unknown):Promise<Dashboard>=>ipcRenderer.invoke('launcher:'+name,arg);
const api:LauncherApi={status:()=>call('status'),scan:()=>call('scan'),chooseDirectory:()=>call('choose'),setChannel:(channel:Channel)=>call('channel',channel),backup:()=>call('backup'),play:()=>call('play')};
contextBridge.exposeInMainWorld('launcher',Object.freeze(api));
