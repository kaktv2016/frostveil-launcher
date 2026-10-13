import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {safeFile,hashFile,contained,noLinks,safeDirectory} from './files';
import type {Profile,BackupResult} from '../shared/contracts';
export async function createBackup(game:string,base:string,profile:Profile,options:{maxBytes?:number;copy?:(a:string,b:string)=>Promise<void>}={}):Promise<BackupResult>{
 if(contained(game,base)||contained(base,game))throw Error('Backup directory must be separate from game');
 await safeDirectory(base);
 const limit=options.maxBytes??32*1024*1024;if(profile.backupFiles.length>32)throw Error('Backup selection too large');
 const directory=path.join(base,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());await fs.mkdir(directory);
 const files:Array<Record<string,unknown>>=[],skipped:string[]=[];let bytes=0;
 const manifest=path.join(directory,'manifest.json');
 const result:BackupResult={directory,manifest,files:0,bytes:0,verified:false,skipped};
 const installationId=createHash('sha256').update(path.resolve(game).toLowerCase()).digest('hex');
 try{
  for(const relative of profile.backupFiles){let source:string;try{source=await safeFile(game,relative);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){skipped.push(relative);continue;}throw error;}
   const before=await hashFile(source,limit);bytes+=before.size;if(bytes>limit)throw Error('Backup total size limit exceeded');
   const target=path.join(directory,...relative.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await noLinks(path.dirname(target));
   await (options.copy??((a,b)=>fs.copyFile(a,b,fs.constants.COPYFILE_EXCL)))(source,target);
   const after=await hashFile(await safeFile(game,relative),limit),copied=await hashFile(await safeFile(directory,relative),limit);
   if(before.sha256!==after.sha256||before.sha256!==copied.sha256||before.size!==copied.size)throw Error('Backup source changed or copy verification failed');
   files.push({relativePath:relative,originalSize:before.size,originalSha256:before.sha256,backupSha256:copied.sha256});
  }
  result.files=files.length;result.bytes=bytes;result.verified=true;
  await fs.writeFile(manifest,JSON.stringify({schemaVersion:1,status:'VERIFIED',timestamp:new Date().toISOString(),installationId,originalInstallation:path.resolve(game),scope:'integration allowlist only; not a game/save backup',files,skipped},null,2),{flag:'wx'});
  return result;
 }catch(error){await fs.writeFile(manifest,JSON.stringify({schemaVersion:1,status:'FAILED',installationId,files,skipped,error:error instanceof Error?error.message:'Backup failed'},null,2),{flag:'wx'}).catch(()=>{});throw error;}
}
