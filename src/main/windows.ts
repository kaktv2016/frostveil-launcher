import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
const execute=promisify(execFile);
const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const versionCache=new Map<string,string>();
async function query(script:string,env?:NodeJS.ProcessEnv):Promise<string>{const result=await execute(powershell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:1024*1024,env:{...process.env,...env}});return result.stdout.trim().replace(/^\uFEFF/,'');}
export async function fileVersion(file:string):Promise<string>{
 try{
  const st=await fs.stat(file);
  const key=`${file}:${st.size}:${st.mtimeMs}`;
  const cached=versionCache.get(key);
  if(cached!==undefined)return cached;
  // The path is data in a child-only environment variable, never shell source.
  const text=await query('[Diagnostics.FileVersionInfo]::GetVersionInfo($env:SKYRIM_RP_INSPECT_FILE).FileVersion | ConvertTo-Json -Compress',{SKYRIM_RP_INSPECT_FILE:file});
  const parsed=JSON.parse(text||'null')??'';
  versionCache.set(key,parsed);
  return parsed;
 }catch{
  const text=await query('[Diagnostics.FileVersionInfo]::GetVersionInfo($env:SKYRIM_RP_INSPECT_FILE).FileVersion | ConvertTo-Json -Compress',{SKYRIM_RP_INSPECT_FILE:file});
  return JSON.parse(text||'null')??'';
 }
}
export async function steamRoots():Promise<string[]>{
 const text=await query("@((Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath, (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -ErrorAction SilentlyContinue).InstallPath) | Where-Object { $_ -is [string] } | ConvertTo-Json -Compress");
 const roots=JSON.parse(text||'[]');return [...new Set((Array.isArray(roots)?roots:[roots]).filter((v:unknown)=>typeof v==='string'))] as string[];
}
export async function gameRunning():Promise<boolean>{return (await query("[bool](Get-Process -Name SkyrimSE,skse64_loader -ErrorAction SilentlyContinue) | ConvertTo-Json -Compress"))==='true';}
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
