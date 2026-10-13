import path from 'node:path';
import {safeFile} from './files';
import type {Scan} from '../shared/contracts';
export class GameLauncher {
 private busy=false;
 private startedAt=0;
 constructor(private readonly running:()=>Promise<boolean>,private readonly spawn:(executable:string,cwd:string)=>Promise<void>){}
 async play(revalidate:()=>Promise<Scan>):Promise<void>{
  if(this.busy||Date.now()-this.startedAt<15000)throw Error('A launch is already in progress');this.busy=true;
  try{const scan=await revalidate();if(!scan.ready)throw Error('Installation is incompatible or unverified');if(await this.running())throw Error('Skyrim or SKSE is already running');const executable=await safeFile(scan.directory,'skse64_loader.exe');await this.spawn(executable,path.resolve(scan.directory));this.startedAt=Date.now();}finally{this.busy=false;}
 }
}
