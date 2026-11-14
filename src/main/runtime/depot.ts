import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {safeDirectory,safeFile,hashFile,noLinks} from '../files';
import {assertRuntimeCohort,type RuntimeCohort} from './policy';
import {durableWrite} from '../installer/metadata';
const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
export const helperPin=Object.freeze({version:'3.4.0',archiveSize:33474005,archiveSha256:'41c9e9f0df54b3ad02e67a11726756e5c73283bd7c2e1b04acfa5ae4c2ed3767',size:78840739,sha256:'6281279efce8f1e20db9532a58e42382f81afb9e3827a8b965ffcb43fbe4531f',url:'https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_3.4.0/DepotDownloader-windows-x64.zip'});

export async function downloadSteamHelperArchive(signal:AbortSignal,fetcher:typeof fetch=fetch){
 const sources=[
  {label:'GitHub API',url:'https://api.github.com/repos/SteamRE/DepotDownloader/releases/assets/253287195'},
  {label:'GitHub release',url:helperPin.url},
 ];
 const failures:string[]=[];
 for(const source of sources){
  let url=new URL(source.url);
  for(let redirects=0;;redirects++){
   signal.throwIfAborted();
   let response:Response;
   try{
    response=await fetcher(url,{signal,redirect:'manual',credentials:'omit',headers:{
     Accept:'application/octet-stream','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Frostveil-Launcher','Accept-Encoding':'identity',
    }});
   }catch{
    signal.throwIfAborted();failures.push(source.label+' connection failed');break;
   }
   if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location||redirects>=2)throw Error('Steam helper redirect limit exceeded');
    const target=new URL(location,url);
    // Both routes must stay on the official DepotDownloader release CDN.
    if(target.protocol!=='https:'||target.port||target.username||target.password||target.hash||
      !['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(target.hostname)||
      !/^\/github-production-release-asset\/11851957\/[0-9a-f-]{36}$/.test(target.pathname))throw Error('Unapproved Steam helper redirect');
    url=target;continue;
   }
   const metadata=/json/i.test(response.headers.get('content-type')??'');
   if(response.status===200&&response.body&&!metadata)return response;
   await response.body?.cancel();
   failures.push(source.label+(metadata&&response.status===200?' returned metadata':' HTTP '+response.status));
   break;
  }
 }
 throw Error('Steam helper download unavailable ('+failures.join(', ')+')');
}

/** Only QR block glyphs reach UI. Account names, refresh tokens and arbitrary
 * helper output are never forwarded to diagnostics, renderer or filesystem. */
export class DepotOutput {
 private pending='';private rows:string[]=[];private qrContext=false;
 failureReason:'manifest-401'|'connection-lost'|'authentication'|undefined;
 constructor(private emit:(qr:string|undefined)=>void){}
 push(chunk:string){
  this.pending=(this.pending+chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'')).slice(-32768);
  const lines=this.pending.split(/\r?\n/);this.pending=lines.pop()??'';
  for(const line of lines){if(/Use the Steam Mobile App to sign in with this QR code:/i.test(line))this.qrContext=true;
   // With redirected handles, the reviewed Windows helper can emit an ASCII
   // replacement '?' for every full block. Spaces/module positions are intact.
   // Accept this only within its explicit QR prompt, never arbitrary diagnostics.
   const fallback=this.qrContext&&line.length>=32&&line.length<256&&/\?/.test(line)&&/^[ ?\t]+$/.test(line);
   if((/[█▀▄]/.test(line)&&/^[ █▀▄\t]+$/.test(line)&&line.length<256)||fallback){this.rows.push(fallback?line.replace(/\?/g,'█'):line);if(this.rows.length>80)this.rows=[];}
   else if(this.rows.length){if(this.rows.length>=20)this.emit(this.rows.join('\n'));this.rows=[];}
   if(/Logged (?:in|on)|Downloading depot|Disconnected|Lost connection|Logging in|QR code has changed/i.test(line)){this.qrContext=false;this.emit(undefined);}
   if(/Encountered 401|Unable to download manifest/i.test(line))this.failureReason='manifest-401';else if(/Failed to authenticate/i.test(line)&&this.failureReason!=='manifest-401')this.failureReason='authentication';else if(/Lost connection|TryAnotherCM/i.test(line)&&!this.failureReason)this.failureReason='connection-lost';
  }
 }
 clear(){this.pending='';this.rows=[];this.qrContext=false;this.emit(undefined);}
}
export async function ensureDepotHelper(storage:string,policy:Readonly<RuntimeCohort>,signal:AbortSignal){
 assertRuntimeCohort(policy,false);
 if(policy.helper.version!==helperPin.version||policy.helper.sha256!==helperPin.sha256||policy.helper.size!==helperPin.size)throw Error('Runtime helper pin differs from reviewed release');
 const root=path.join(storage,'runtime-tools',helperPin.archiveSha256);await safeDirectory(root);
 const exe=path.join(root,'DepotDownloader.exe');
 try{const f=await safeFile(root,'DepotDownloader.exe'),h=await hashFile(f,100*1024**2);if(h.size===helperPin.size&&h.sha256===helperPin.sha256&&(await fs.stat(f)).nlink===1)return f;throw Error('Installed Steam helper integrity mismatch');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const archive=path.join(root,'helper.zip');
 let valid=false;try{const h=await hashFile(await safeFile(root,'helper.zip'),helperPin.archiveSize);valid=h.sha256===helperPin.archiveSha256&&h.size===helperPin.archiveSize;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 if(!valid){
  const res=await downloadSteamHelperArchive(AbortSignal.any([signal,AbortSignal.timeout(15*60*1000)]));
  if(!res.body)throw Error('Steam helper response missing archive');
  const temp=archive+'.'+randomUUID(),h=await fs.open(temp,'wx');let size=0;const sha=createHash('sha256');
  try{for await(const bytes of res.body){size+=bytes.length;if(size>helperPin.archiveSize)throw Error('Steam helper size exceeded');sha.update(bytes);await h.write(bytes);}await h.sync();}catch(e){await h.close();await fs.unlink(temp);throw e;}
  await h.close();if(size!==helperPin.archiveSize||sha.digest('hex')!==helperPin.archiveSha256){await fs.unlink(temp);throw Error('Steam helper download integrity failure');}
  await fs.rename(temp,archive);
 }
 // The reviewed archive contains one executable. Extract into a fresh staging
 // directory, verify the executable, then copy only that verified member.
 const extraction=path.join(root,'extract-'+randomUUID());await safeDirectory(extraction);
 await new Promise<void>((resolve,reject)=>{
  let failure:Error|null=null;
  const child=execFile(powershell,['-NoProfile','-NonInteractive','-Command',
   'Expand-Archive -LiteralPath $env:FV_RUNTIME_ZIP -DestinationPath $env:FV_RUNTIME_EXTRACT'],
   {windowsHide:true,timeout:60000,signal,env:{...process.env,FV_RUNTIME_ZIP:archive,FV_RUNTIME_EXTRACT:extraction}},
   error=>{failure=error;});
  child.once('close',code=>{
   if(signal.aborted)reject(signal.reason);
   else if(failure||code!==0)reject(Error('Verified helper archive extraction failed'));
   else resolve();
  });
 });
 const source=await safeFile(extraction,'DepotDownloader.exe'),h=await hashFile(source,100*1024**2);
 if(h.size!==helperPin.size||h.sha256!==helperPin.sha256)throw Error('Extracted Steam helper integrity failure');await fs.copyFile(source,exe,fs.constants.COPYFILE_EXCL);return exe;
}
/** DepotDownloader 3.4.0 Program.cs zips the two parameter lists. One helper
 * invocation keeps all missing depots in one authenticated Steam session. */
export function depotRequestArguments(policy:Readonly<RuntimeCohort>,requested:readonly string[],folder:string,filelist:string){
 assertRuntimeCohort(policy,true);
 if(!requested.length||new Set(requested).size!==requested.length||requested.some(n=>!policy.files.some(f=>f.path===n))||!path.isAbsolute(folder)||!path.isAbsolute(filelist))throw Error('Unapproved runtime download selection');
 const depots=policy.depots.filter(d=>policy.files.some(f=>f.depot===d.id&&requested.includes(f.path)));
 return ['-app','489830','-depot',...depots.map(d=>d.id),'-manifest',...depots.map(d=>d.manifest),'-qr','-dir',folder,'-filelist',filelist,'-validate'];
}
async function verifiedRawFile(root:string,relative:string,file:RuntimeCohort['files'][number]){
 try{
  const value=await safeFile(root,relative),image=await hashFile(value,8*1024**3);
  return image.sha256===file.sha256&&image.size===file.size&&(await fs.stat(value)).nlink===1;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}

function requestedFiles(policy:Readonly<RuntimeCohort>,requested:readonly string[]){
 assertRuntimeCohort(policy,false);
 if(new Set(requested).size!==requested.length||requested.some(relative=>!policy.files.some(file=>file.path===relative))){
  throw Error('Unapproved runtime download selection');
 }
 return policy.files.filter(file=>requested.includes(file.path));
}

export async function inspectDepotReuse(policy:Readonly<RuntimeCohort>,cache:string,requested:readonly string[]){
 const folder=path.join(cache,'cohort');
 const missing:string[]=[],legacy:RuntimeCohort['files']=[];
 for(const file of requestedFiles(policy,requested)){
  if(await verifiedRawFile(folder,file.path,file))continue;
  let absent=false;
  try{await fs.lstat(path.join(folder,...file.path.split('/')));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;absent=true;}
  if(absent&&await verifiedRawFile(cache,file.depot+'/'+file.path,file))legacy.push(file);
  else if(!absent){
   const legacyPath=path.join(cache,file.depot,...file.path.split('/'));
   const dest=await safeFile(folder,file.path),to=await fs.lstat(dest,{bigint:true});
   let from;
   try{await noLinks(legacyPath);from=await fs.lstat(legacyPath,{bigint:true});}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(from?.isFile()&&from.nlink===2n&&to.nlink===2n&&from.dev===to.dev&&from.ino===to.ino){
    const image=await hashFile(dest,8*1024**3);
    if(image.size===file.size&&image.sha256===file.sha256){legacy.push(file);continue;}
   }
   if(to.nlink!==1n)throw Error('Unsafe raw depot file alias: '+file.path);
   missing.push(file.path);
  }else missing.push(file.path);
 }
 return {folder,legacy,missing};
}

export async function promoteLegacyDepots(cache:string,files:readonly RuntimeCohort['files'][number][]){
 const folder=path.join(cache,'cohort');
 for(const file of files){
  if(await verifiedRawFile(folder,file.path,file))continue;
  const relative=file.depot+'/'+file.path;
  const legacy=await safeFile(cache,relative),destination=path.join(folder,...file.path.split('/'));
  const image=await hashFile(legacy,8*1024**3),original=await fs.lstat(legacy,{bigint:true});
  if(image.size!==file.size||image.sha256!==file.sha256||original.nlink>2n)throw Error('Verified legacy payload changed: '+file.path);
  if(original.nlink===1n){
   await safeDirectory(path.dirname(destination));
   // Publish without replacement. An interrupted promotion can leave both
   // names for the same verified file and be resumed under the accounting lease.
   await fs.link(legacy,destination);
  }
  await noLinks(destination);
  const from=await fs.lstat(legacy,{bigint:true}),to=await fs.lstat(destination,{bigint:true});
  if(from.dev!==to.dev||from.ino!==to.ino||from.nlink!==2n||to.nlink!==2n)throw Error('Legacy depot promotion identity changed');
  await fs.unlink(legacy);
  if(!await verifiedRawFile(folder,file.path,file))throw Error('Legacy depot promotion verification failed: '+file.path);
 }
 return folder;
}

export async function acquireDepots(policy:Readonly<RuntimeCohort>,helper:string,cache:string,signal:AbortSignal,onState:(phase:'authentication'|'downloading',message:string,qr?:string)=>void,requested:readonly string[]=policy.files.map(f=>f.path)){
 const expected=requestedFiles(policy,requested);
 await noLinks(helper);
 if((await fs.stat(helper)).nlink!==1||(await hashFile(helper,100*1024**2)).sha256!==policy.helper.sha256)throw Error('Steam helper executable changed');
 const {folder,missing,legacy}=await inspectDepotReuse(policy,cache,requested);
 await promoteLegacyDepots(cache,legacy);
 if(missing.length){
  await safeDirectory(folder);
  signal.throwIfAborted();const filelist=path.join(cache,'cohort-files.txt');await durableWrite(filelist,Buffer.from(missing.join('\n')));
  const parser=new DepotOutput(qr=>onState(qr?'authentication':'downloading',qr?'สแกน QR ด้วย Steam Guard บนมือถือ':'Steam กำลังเชื่อมต่อ/ดาวน์โหลดชุดเกมในเซสชันเดียว',qr));
  onState('authentication','ยืนยันบัญชีเจ้าของเกมกับ Steam เมื่อ QR ปรากฏ');
  const args=depotRequestArguments(policy,missing,folder,filelist);
  await new Promise<void>((resolve,reject)=>{
   const child=spawn(helper,args,{cwd:cache,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
   let settled=false,timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},30*60*1000);
   const abort=()=>child.kill();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',data=>parser.push(data));child.stderr.on('data',data=>parser.push(data));
   const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);parser.clear();error?reject(error):resolve();};
   let processError=false;
   child.once('error',()=>{processError=true;});
   child.once('close',code=>finish(signal.aborted?Error('Runtime acquisition cancelled'):code!==0||timedOut||processError?Error('Steam cohort acquisition failed (exit '+code+', stage '+(timedOut?'timeout':parser.failureReason??'process')+'); verified files retained, no game files changed'):undefined));
  });
 }
 for(const f of expected){signal.throwIfAborted();const source=await safeFile(folder,f.path),h=await hashFile(source,8*1024**3);if(h.sha256!==f.sha256||h.size!==f.size||(await fs.stat(source)).nlink!==1)throw Error('Steam cohort identity mismatch: '+f.path);}
 return folder;
}
