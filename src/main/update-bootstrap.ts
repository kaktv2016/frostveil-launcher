import {app} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {load} from 'js-yaml';
import {EventEmitter} from 'node:events';
import {LauncherUpdateService,type UpdateEngine} from './launcher-update-service';
import {NsisEngine} from './updater-engine';
import {
 LauncherUpdateTransport,
 hasActiveLauncherUpdateKey,
 productionLauncherUpdateSource,
 validateLauncherUpdateTestProfile,
 type LauncherUpdateSource
} from './update-integrity';
import {authenticode,gameRunning} from './windows';
// Public signer subjects may be pinned here if Authenticode is ever used in addition to Ed25519 manifests.
export const trustedPublisherNames:readonly string[]=[];
class FixtureEngine extends EventEmitter implements UpdateEngine {
 readonly info={version:'0.1.7',files:[{url:'fixture.exe',sha512:'a'.repeat(88),size:10}],releaseNotes:'Synthetic fixture update — never installed',keyId:'fixture-ed25519',minimumLauncherVersion:'0.1.0'};
 async check(){return this.info;}async download(){this.emit('progress',{percent:50,transferred:5,total:10,bytesPerSecond:5});await new Promise(r=>setTimeout(r,50));this.emit('downloaded',this.info);}
 install(){throw Error('Fixture self-install blocked');}cancel(){}
}
async function hasNsisUninstaller(dir:string):Promise<boolean>{
 try{
  const entries=await fs.readdir(dir);
  for(const entry of entries){
   if(/^Uninstall .+\.exe$/i.test(entry)&&(await fs.stat(path.join(dir,entry))).isFile())return true;
  }
 }catch{/* Ignore missing directory */}
 return false;
}
export async function createUpdater(fixture:boolean):Promise<LauncherUpdateService>{
 if(fixture)return new LauncherUpdateService(new FixtureEngine(),{version:app.getVersion(),checkEnabled:true,downloadTrusted:true,installed:false,gameRunning:async()=>false});
 let source:LauncherUpdateSource=productionLauncherUpdateSource;
 let transport:LauncherUpdateTransport|undefined;
 let installDirectory:string|undefined;
 const testIndex=process.argv.indexOf('--launcher-update-test-profile');
 const testProfileArg=testIndex>=0?process.argv[testIndex+1]:undefined;
 if(process.argv.includes('--launcher-update-test')&&typeof testProfileArg==='string'&&process.env.FROSTVEIL_DISPOSABLE_UPDATE_TEST==='1'){
  const profile=validateLauncherUpdateTestProfile(JSON.parse(await fs.readFile(path.resolve(testProfileArg),'utf8')));
  source={
   mode:'disposable-test',
   owner:'kaktv2016',
   repo:'frostveil-launcher',
   channel:'stable',
   keys:{
    [profile.keyId]:{
     publicKey:profile.publicKey,
     environment:'test',
     revoked:false,
     expiresAt:profile.expiresAt
    }
   }
  };
  transport=LauncherUpdateTransport.loopback(profile.loopbackOrigin,source.mode);
  installDirectory=profile.installDirectory;
 }
 let configured=false,trust=false,installed=false;
 const ed25519Trust=hasActiveLauncherUpdateKey(source);
 try{
  const metadata=load(await fs.readFile(path.join(process.resourcesPath,'app-update.yml'),'utf8')) as Record<string,unknown>;
  configured=metadata.provider==='github'&&metadata.owner==='kaktv2016'&&metadata.repo==='frostveil-launcher'&&metadata.private!==true;
  const publishers=Array.isArray(metadata.publisherName)?metadata.publisherName:typeof metadata.publisherName==='string'?[metadata.publisherName]:[];
  const authenticodeTrust=publishers.length>0&&publishers.every(p=>typeof p==='string'&&trustedPublisherNames.includes(p));
  trust=ed25519Trust||authenticodeTrust;
  const uninstallerPresent=await hasNsisUninstaller(path.dirname(process.execPath));
  if(ed25519Trust){
   installed=app.isPackaged&&trust&&uninstallerPresent;
  }else{
   const signature=await authenticode(process.execPath);
   installed=app.isPackaged&&trust&&signature.valid&&trustedPublisherNames.includes(signature.subject)&&uninstallerPresent;
  }
 }catch{/* Missing metadata/certificate/NSIS marker is an explicit safe capability limit. */}
 const userData=app.getPath('userData');
 return new LauncherUpdateService(
  new NsisEngine(trustedPublisherNames,{
   source,
   transport,
   storageDir:userData,
   installedVersion:app.getVersion(),
   installDirectory
  }),
  {version:app.getVersion(),checkEnabled:app.isPackaged&&configured,downloadTrusted:trust,installed,gameRunning}
 );
}
