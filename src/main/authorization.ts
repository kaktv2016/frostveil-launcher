import type {Settings} from '../shared/contracts';
import path from 'node:path';
export function authorize(url:string,isMainFrame:boolean):boolean{return isMainFrame&&url==='app://launcher/index.html';}
export function validateSettings(raw:unknown):Settings{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid settings');const value=raw as Record<string,unknown>;
 if(Object.keys(value).some(k=>!['directory','channel'].includes(k))||typeof value.directory!=='string'||(value.directory!==''&&!path.isAbsolute(value.directory))||value.directory.length>4096||/[\x00-\x1f]/.test(value.directory)||!['stable','beta'].includes(value.channel as string))throw Error('Invalid settings');
 return{directory:value.directory,channel:value.channel as Settings['channel']};
}
