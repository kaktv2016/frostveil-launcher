import {NsisUpdater} from 'electron-updater';
import {CancellationToken,type UpdateInfo} from 'builder-util-runtime';
import {EventEmitter} from 'node:events';
import type {UpdateEngine} from './launcher-update-service';
import {authenticode} from './windows';
import path from 'node:path';
import {verifyDownloadedInstaller} from './update-integrity';
export class NsisEngine extends EventEmitter implements UpdateEngine {
 readonly updater=new NsisUpdater();private token?:CancellationToken;private info?:UpdateInfo;private files:string[]=[];
 constructor(private readonly publishers:readonly string[]=[]){super();const u=this.updater;u.autoDownload=false;u.autoInstallOnAppQuit=false;u.allowPrerelease=false;u.channel='latest';u.allowDowngrade=false;u.logger=null;
  const verify=u.verifyUpdateCodeSignature;
  u.verifyUpdateCodeSignature=async(publishers,file)=>{const result=await verify(publishers,file);if(result!==null)return result;const signature=await authenticode(file);return signature.valid&&publishers.includes(signature.subject)?null:'Authenticode validation failed closed';};
  // Error events are handled by rejected operation promises, never raw renderer logs.
  u.on('error',error=>this.emit('install-error',error));
 }
 async check(){this.info=(await this.updater.checkForUpdates())?.updateInfo;return this.info??null;}
 private async verifyFiles(){if(!this.info||this.files.length!==1)throw Error('Verified plain NSIS download required');const file=this.files[0]!;const entry=this.info.files.find(f=>path.basename(decodeURIComponent(f.url))===path.basename(file));if(!entry)throw Error('Unexpected update file');await verifyDownloadedInstaller(file,entry.sha512,this.publishers);}
 async download(){this.token=new CancellationToken();const progress=(p:unknown)=>this.emit('progress',p);this.updater.on('download-progress',progress);try{this.files=await this.updater.downloadUpdate(this.token);await this.verifyFiles();this.emit('downloaded',this.info);}finally{this.updater.removeListener('download-progress',progress);this.token=undefined;}}
 async install(){await this.verifyFiles();this.updater.quitAndInstall(false,true);}
 cancel(){this.token?.cancel();}
}
