import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {noLinks,safeFile} from '../files';
import {readOrderInputs,readPluginHeader,type OrderInputs} from '../modpack/plugins';
import {planActivation} from './activation';
import type {Scan} from '../../shared/contracts';
import {EXISTING_LIGHT_NOTICE} from './eligibility';

export interface ManagedFileEvidence {name:string;path:string;size:number;mtimeMs:number;device:number;inode:number;links:number;light?:boolean;master?:boolean;masters?:string[];}
export interface ManagedPreflight {
 status:'READY'|'CONFLICT'|'UNVERIFIED'|'BLOCKED'|'MANUAL ACTION REQUIRED';root:string;configDirectory:string;blockers:string[];manual:string[];
 processActive:boolean;managerDetected:boolean;diskFreeBytes:number|null;
 permissions:{gameReadable:boolean;gameWriteAccess:boolean;configReadable:boolean;configWriteAccess:boolean;method:'read-only-os-access-check';writeProbePerformed:false};
 pluginInputs:OrderInputs;plugins:ManagedFileEvidence[];files:ManagedFileEvidence[];runtime:Scan|null;
 rootIdentities:Array<{role:'game'|'data'|'config';path:string;device:number;inode:number;mtimeMs:number}>;
 activation?:Awaited<ReturnType<typeof planActivation>>;
}
const MAX_INVENTORY=10000;
const MANAGER_MARKERS=['ModOrganizer.ini','usvfs_x64.dll','usvfs_x86.dll','Data/vortex.deployment.json','Data/vortex.deployment.msg','Data/__folder_managed_by_vortex'];

/** No writes, probes, process changes, server queries or profile/database edits. */
export async function inspectManagedInstallation(game:string,orderDirectory:string,runtime:Scan|null,options:{processActive:()=>Promise<boolean>;storage?:string;iniDirectory?:string}):Promise<ManagedPreflight>{
 const result:ManagedPreflight={status:'UNVERIFIED',root:path.resolve(game),configDirectory:path.resolve(orderDirectory),blockers:[],manual:[],processActive:false,managerDetected:false,diskFreeBytes:null,permissions:{gameReadable:false,gameWriteAccess:false,configReadable:false,configWriteAccess:false,method:'read-only-os-access-check',writeProbePerformed:false},pluginInputs:{pluginsText:null,loadorderText:null,cccText:null,managed:false},plugins:[],files:[],runtime:runtime?structuredClone(runtime):null,rootIdentities:[]};
 const block=(message:string)=>result.blockers.push(message);
 try{result.processActive=await options.processActive();if(result.processActive)block('Skyrim/SKSE game process is active; refuse installation until it exits.');}catch{block('Running game process state could not be verified.');}
 for(const [role,directory] of [['game',result.root],['data',path.join(result.root,'Data')],['config',result.configDirectory]] as const){
  try{await noLinks(directory);const st=await fs.lstat(directory);if(!st.isDirectory())throw Error('Expected directory');result.rootIdentities.push({role,path:await fs.realpath(directory),device:st.dev,inode:st.ino,mtimeMs:st.mtimeMs});}
  catch{block('Missing, unreadable or redirected '+role+' directory; filesystem containment is unverified.');}
 }
 if(result.rootIdentities.length<3){result.status='BLOCKED';return result;}
 async function accessible(directory:string,mode:number){try{await fs.access(directory,mode);return true;}catch{return false;}}
 result.permissions.gameReadable=await accessible(result.root,constants.R_OK);result.permissions.gameWriteAccess=await accessible(path.join(result.root,'Data'),constants.W_OK);
 result.permissions.configReadable=await accessible(result.configDirectory,constants.R_OK);result.permissions.configWriteAccess=await accessible(result.configDirectory,constants.W_OK);
 if(!result.permissions.gameReadable||!result.permissions.configReadable)block('Installation/profile read permissions are unavailable.');
 if(!result.permissions.gameWriteAccess||!result.permissions.configWriteAccess)block('Installation/profile write access is denied by the read-only OS check; no elevation or probe was attempted.');
 try{const space=await fs.statfs(result.root);const available=Number(space.bavail)*Number(space.bsize);if(!Number.isSafeInteger(available)||available<0)throw Error('Invalid volume capacity');result.diskFreeBytes=available;}catch{block('Available disk capacity could not be verified.');}
 try{await safeFile(result.root,'SkyrimSE.exe');}catch{block('SkyrimSE.exe is missing or cannot be safely inspected.');}
 for(const marker of MANAGER_MARKERS){try{await fs.lstat(path.join(result.root,...marker.split('/')));result.managerDetected=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')result.managerDetected=true;}}
 for(const [root,file] of [[result.root,'Skyrim.ccc'],[result.configDirectory,'plugins.txt'],[result.configDirectory,'loadorder.txt']] as const){try{const filePath=await safeFile(root,file),st=await fs.stat(filePath);if(st.nlink!==1)block('Hardlinked activation configuration cannot be managed safely: '+file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')block('Activation configuration identity is unreadable or redirected: '+file);}}
 try{
  result.pluginInputs=await readOrderInputs(result.root,result.configDirectory);
  if(/mod\s*organizer|generated by (?:vortex|mo2)|automatically generated by vortex/i.test([result.pluginInputs.pluginsText,result.pluginInputs.loadorderText].join('\n')))result.managerDetected=true;
  result.managerDetected||=result.pluginInputs.managed;
  // INI-based implicit plugins are outside the native activation adapter. Inspect
  // known locations without reading arbitrary user profile contents into output.
  const documents=options.iniDirectory??(process.env.USERPROFILE?path.join(process.env.USERPROFILE,'Documents','My Games','Skyrim Special Edition'):null);
  const iniPaths=[path.join(result.root,'Skyrim.ini'),...(documents?[path.join(documents,'Skyrim.ini'),path.join(documents,'SkyrimCustom.ini')]:[])];
  for(const ini of iniPaths){try{await noLinks(ini);const stat=await fs.stat(ini);if(!stat.isFile()||stat.size>1024*1024)throw Error('INI cannot be bounded');const text=await fs.readFile(ini,'utf8');for(const match of text.matchAll(/^\s*sTestFile\d+\s*=\s*([^;\r\n]*)/gim)){const plugin=match[1]!.trim();if(plugin&&!/^(?:Skyrim|Update|Dawnguard|HearthFires|Dragonborn)\.esm$/i.test(plugin)){result.managerDetected=true;result.manual.push('Additional INI test-plugin activation requires manual effective-profile verification.');}}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){result.managerDetected=true;result.manual.push('INI activation evidence is unreadable or redirected.');}}}
  result.pluginInputs.managed||=result.managerDetected;
 }catch{block('Plugin activation configuration could not be read safely.');}
 try{
  const data=path.join(result.root,'Data'),entries=await fs.readdir(data,{withFileTypes:true});
  if(entries.length>MAX_INVENTORY)throw Error('Data directory exceeds bounded inventory limit');
  for(const entry of entries){
   if(!entry.isFile()&&!entry.isSymbolicLink())continue;
   const relative='Data/'+entry.name,absolute=await safeFile(result.root,relative),stat=await fs.stat(absolute);
   if(stat.nlink!==1){block('Hardlinked Data file cannot be managed safely: '+entry.name);continue;}
   const item:ManagedFileEvidence={name:entry.name,path:relative,size:stat.size,mtimeMs:stat.mtimeMs,device:stat.dev,inode:stat.ino,links:stat.nlink};result.files.push(item);
   if(/\.(esm|esp|esl)$/i.test(entry.name)){try{Object.assign(item,await readPluginHeader(absolute));result.plugins.push(item);}catch{block('Invalid or unreadable TES4 plugin header: '+entry.name);}}
  }
 }catch{block('Bounded Data inventory failed; a link, permission issue or unsupported path requires review.');}
 if(!result.managerDetected){result.activation=await planActivation(result.root,[],result.pluginInputs);if(result.activation.status==='blocked')for(const problem of result.activation.blockers)block(problem);}
 else result.manual.push('Mod manager or external profile indications detected. Physical Data and native plugins.txt are not assumed authoritative; manager integration is required.');
 if(!runtime?.ready)result.manual.push('Skyrim/SKSE/SkyMP runtime baseline is unverified.');
 if(runtime&&path.resolve(runtime.directory).toLowerCase()!==result.root.toLowerCase())block('Runtime evidence is bound to another installation.');
 const activeLight=result.activation?.active.some(name=>result.plugins.some(p=>p.name.toLowerCase()===name.toLowerCase()&&(p.light||/\.esl$/i.test(p.name))));
 if(activeLight)result.manual.push(EXISTING_LIGHT_NOTICE);
 result.status=result.blockers.length?'BLOCKED':result.managerDetected?'MANUAL ACTION REQUIRED':!runtime?.ready||activeLight?'UNVERIFIED':'READY';
 return result;
}
