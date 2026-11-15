import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
const execute=promisify(execFile);
const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const versionCache=new Map<string,string>();
async function query(script:string,env?:NodeJS.ProcessEnv):Promise<string>{const result=await execute(powershell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:1024*1024,env:{...process.env,...env}});return result.stdout.trim().replace(/^\uFEFF/,'');}
export async function fileVersion(file:string,fresh=false):Promise<string>{
 if(fresh){
  // Admission uses the fixed numeric PE resource rather than the localized display string.
  const text=await query("$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:SKYRIM_RP_INSPECT_FILE); @($v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart,$v.FilePrivatePart) | ConvertTo-Json -Compress",{SKYRIM_RP_INSPECT_FILE:file});
  const parts:unknown=JSON.parse(text||'null');
  return Array.isArray(parts)&&parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=65535)?parts.join('.'):'';
 }
 const read=async()=>{
  // The path is data in a child-only environment variable, never shell source.
  const text=await query('[Diagnostics.FileVersionInfo]::GetVersionInfo($env:SKYRIM_RP_INSPECT_FILE).FileVersion | ConvertTo-Json -Compress',{SKYRIM_RP_INSPECT_FILE:file});
  const value:unknown=JSON.parse(text||'null');
  return typeof value==='string'?value:'';
 };
 const key=await fs.stat(file,{bigint:true})
  .then(stat=>[file,stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':'))
  .catch(()=>undefined);
 if(!key)return read();
 const cached=versionCache.get(key);
 if(cached!==undefined)return cached;
 const value=await read();
 versionCache.set(key,value);
 return value;
}
export async function steamRoots():Promise<string[]>{
 const text=await query("@((Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath, (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -ErrorAction SilentlyContinue).InstallPath) | Where-Object { $_ -is [string] } | ConvertTo-Json -Compress");
 const roots=JSON.parse(text||'[]');return [...new Set((Array.isArray(roots)?roots:[roots]).filter((v:unknown)=>typeof v==='string'))] as string[];
}
export async function gameRunning():Promise<boolean>{return (await query("[bool](Get-Process -Name SkyrimSE,skse64_loader -ErrorAction SilentlyContinue) | ConvertTo-Json -Compress"))==='true';}
export async function verifyW14UpdateAcl(root:string,parent:string,file:string):Promise<boolean>{
 try{
  const result=await query(`
   $ErrorActionPreference = 'Stop'
   $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
   $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:FROSTVEIL_FEED_ROOT))
   if ($drive.DriveType -notin 'Fixed','Removable','Ram') { throw 'Expected local volume' }
   $paths = @($env:FROSTVEIL_FEED_ROOT, $env:FROSTVEIL_FEED_PARENT, $env:FROSTVEIL_FEED_FILE) | Select-Object -Unique
   foreach ($source in $paths) {
     $attrs = [IO.File]::GetAttributes($source)
     if ($attrs -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
     $acl = if ($attrs -band [IO.FileAttributes]::Directory) {
       [IO.Directory]::GetAccessControl($source)
     } else {
       [IO.File]::GetAccessControl($source)
     }
     if (($source -eq $env:FROSTVEIL_FEED_ROOT -and !$acl.AreAccessRulesProtected) -or
         $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Untrusted descriptor' }
     $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
     if ($null -eq $raw.DiscretionaryAcl) { throw 'Missing DACL' }
     foreach ($ace in $raw.DiscretionaryAcl) {
       if ($ace.AceType -notin 'AccessAllowed','AccessDenied' -or
           ($ace.AceType -eq 'AccessAllowed' -and $ace.SecurityIdentifier.Value -notin $allowed)) { throw 'Untrusted ACE' }
     }
   }
   'true'
  `,{FROSTVEIL_FEED_ROOT:root,FROSTVEIL_FEED_PARENT:parent,FROSTVEIL_FEED_FILE:file});
  return result==='true';
 }catch{return false;}
}
export async function authenticode(file:string):Promise<{valid:boolean;subject:string}>{
 try{const result=JSON.parse(await query("$s=Get-AuthenticodeSignature -LiteralPath $env:FROSTVEIL_SIGNATURE_FILE; @{valid=($s.Status -eq 'Valid');subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress",{FROSTVEIL_SIGNATURE_FILE:file}));return{valid:result.valid===true,subject:typeof result.subject==='string'?result.subject:''};}catch{return{valid:false,subject:''};}
}
export async function startSkse(executable:string,cwd:string):Promise<void>{
 await observeStartup(spawn(executable,[],{cwd,shell:false,detached:true,stdio:'ignore',windowsHide:false}));
}
/** Catch spawn failure and early nonzero loader exit, without claiming game login. */
export function observeStartup(child:ChildProcess,delay=1200):Promise<void>{
 return new Promise((resolve,reject)=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const cleanup=()=>{if(timer)clearTimeout(timer);child.removeListener('error',failed);child.removeListener('exit',exited);child.removeListener('spawn',started);};
  const done=()=>{cleanup();child.unref();resolve();};
  const failed=(error:Error)=>{cleanup();reject(error);};
  const exited=(code:number|null,signal:NodeJS.Signals|null)=>{if(code===0)done();else failed(Error('SKSE loader exited during startup: '+(signal??code??'unknown')));};
  const started=()=>{timer=setTimeout(done,delay);};
  child.once('error',failed);child.once('exit',exited);child.once('spawn',started);
 });
}
