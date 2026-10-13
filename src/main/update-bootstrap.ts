import {app} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {load} from 'js-yaml';
import {EventEmitter} from 'node:events';
import {LauncherUpdateService,type UpdateEngine} from './launcher-update-service';
import {NsisEngine} from './updater-engine';
import {authenticode,gameRunning} from './windows';
// Public signer subjects may be pinned here after signing identity is verified.
export const trustedPublisherNames:readonly string[]=[];
class FixtureEngine extends EventEmitter implements UpdateEngine {
 readonly info={version:'0.1.2',files:[{url:'fixture.exe',sha512:'a'.repeat(88),size:10}],releaseNotes:'Synthetic fixture update — never installed'};
 async check(){return this.info;}async download(){this.emit('progress',{percent:50,transferred:5,total:10,bytesPerSecond:5});await new Promise(r=>setTimeout(r,50));this.emit('downloaded',this.info);}
 install(){throw Error('Fixture self-install blocked');}cancel(){}
}
export async function createUpdater(fixture:boolean):Promise<LauncherUpdateService>{
 if(fixture)return new LauncherUpdateService(new FixtureEngine(),{version:app.getVersion(),checkEnabled:true,downloadTrusted:true,installed:false,gameRunning:async()=>false});
 let configured=false,trust=false,installed=false;
 try{const metadata=load(await fs.readFile(path.join(process.resourcesPath,'app-update.yml'),'utf8')) as Record<string,unknown>;
  configured=metadata.provider==='github'&&metadata.owner==='kaktv2016'&&metadata.repo==='frostveil-launcher'&&metadata.private!==true;
  const publishers=Array.isArray(metadata.publisherName)?metadata.publisherName:typeof metadata.publisherName==='string'?[metadata.publisherName]:[];
  trust=publishers.length>0&&publishers.every(p=>typeof p==='string'&&trustedPublisherNames.includes(p));
  const signature=await authenticode(process.execPath);
  const marker=path.join(path.dirname(process.execPath),'Uninstall Skyrim RP Launcher.exe');
  installed=app.isPackaged&&trust&&signature.valid&&trustedPublisherNames.includes(signature.subject)&&(await fs.stat(marker)).isFile();
 }catch{/* Missing metadata/certificate/NSIS marker is an explicit safe capability limit. */}
 return new LauncherUpdateService(new NsisEngine(),{version:app.getVersion(),checkEnabled:app.isPackaged&&configured,downloadTrusted:trust,installed,gameRunning});
}
