import {NsisUpdater} from 'electron-updater';
import {CancellationToken} from 'builder-util-runtime';
import {EventEmitter} from 'node:events';
import type {UpdateEngine} from './launcher-update-service';
import {authenticode} from './windows';
export class NsisEngine extends EventEmitter implements UpdateEngine {
 readonly updater=new NsisUpdater();private token?:CancellationToken;
 constructor(){super();const u=this.updater;u.autoDownload=false;u.autoInstallOnAppQuit=false;u.allowPrerelease=false;u.channel='latest';u.allowDowngrade=false;u.logger=null;
  const verify=u.verifyUpdateCodeSignature;
  u.verifyUpdateCodeSignature=async(publishers,file)=>{const result=await verify(publishers,file);if(result!==null)return result;const signature=await authenticode(file);return signature.valid&&publishers.includes(signature.subject)?null:'Authenticode validation failed closed';};
  // Error events are handled by rejected operation promises, never raw renderer logs.
  u.on('error',error=>this.emit('install-error',error));
 }
 async check(){return(await this.updater.checkForUpdates())?.updateInfo??null;}
 async download(){this.token=new CancellationToken();const progress=(p:unknown)=>this.emit('progress',p);const downloaded=(info:unknown)=>this.emit('downloaded',info);this.updater.on('download-progress',progress);this.updater.on('update-downloaded',downloaded);try{await this.updater.downloadUpdate(this.token);}finally{this.updater.removeListener('download-progress',progress);this.updater.removeListener('update-downloaded',downloaded);this.token=undefined;}}
 install(){this.updater.quitAndInstall(false,true);}
 cancel(){this.token?.cancel();}
}
