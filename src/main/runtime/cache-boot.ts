import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const report=String.raw`
$ErrorActionPreference = 'Stop'
$machine=Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid
$boot=Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime
$event=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-General';Id=12} -MaxEvents 1
$eventTime=$event.TimeCreated.ToUniversalTime()
$bootTime=$boot.LastBootUpTime.ToUniversalTime()
if ([Math]::Abs(($eventTime-$bootTime).TotalSeconds) -gt 120 -or $event.RecordId -le 0) {
 throw 'Current boot is unverified'
}
[ordered]@{machine=$machine;record=[string]$event.RecordId;boot=$bootTime.ToString('o')} | ConvertTo-Json -Compress
`;

export type CacheBoot = {hostId:string;record:string;bootMs:number};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

export async function readCacheBoot():Promise<CacheBoot>{
 if(process.platform!=='win32')throw Error('Cache accounting can only verify boot identity on Windows');
 const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 try{
  const {stdout}=await execute(executable,['-NoProfile','-NonInteractive','-Command',report],{
   windowsHide:true,timeout:10000,maxBuffer:16*1024,
  });
  const row=JSON.parse(stdout),bootMs=Date.parse(row.boot);
  if(typeof row.machine!=='string'||!/^[a-f0-9-]{36}$/i.test(row.machine)||
     typeof row.record!=='string'||!/^\d{1,20}$/.test(row.record)||
     !Number.isFinite(bootMs)||bootMs>Date.now())throw Error('Invalid boot observation');
  return {hostId:hash(row.machine.toLowerCase()),record:row.record,bootMs};
 }catch{throw Error('Cache accounting cannot verify the current Windows boot');}
}

export function encodeCacheBoot(boot:CacheBoot){
 return [boot.hostId,boot.record,boot.bootMs].join(':');
}

export function verifiedLaterCacheBoot(boot:CacheBoot,before:string,operationCreatedAt:number){
 const [host,record='',timestamp='',...extra]=before.split(':');
 return extra.length===0 && boot.hostId===host && /^\d{1,20}$/.test(record) && /^\d{1,16}$/.test(timestamp) &&
  BigInt(boot.record)>BigInt(record) && boot.bootMs>Number(timestamp) && boot.bootMs>operationCreatedAt;
}
