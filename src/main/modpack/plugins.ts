import fs from 'node:fs/promises';import path from 'node:path';import {safeFile,noLinks} from '../files';import {pluginName} from './schema';
import type {PluginRequirement,PluginEvidence} from '../../shared/modpack-contracts';
const OFFICIAL=['Skyrim.esm','Update.esm','Dawnguard.esm','HearthFires.esm','Dragonborn.esm'];
export async function readPluginHeader(file:string):Promise<{light:boolean;master:boolean;masters:string[]}> {
 await noLinks(file);const handle=await fs.open(file,'r');try{const head=Buffer.alloc(24);if((await handle.read(head,0,24,0)).bytesRead!==24||head.toString('ascii',0,4)!=='TES4')throw Error('Invalid TES4 header');const count=head.readUInt32LE(4),flags=head.readUInt32LE(8);if(count>1024*1024||flags&0x40000)throw Error('Unsupported TES4 header');const body=Buffer.alloc(count);if((await handle.read(body,0,count,24)).bytesRead!==count)throw Error('Truncated TES4');let offset=0,nextSize:number|null=null;const masters:string[]=[];while(offset<body.length){if(offset+6>body.length)throw Error('Truncated field');const type=body.toString('ascii',offset,offset+4);let n=body.readUInt16LE(offset+4);offset+=6;if(nextSize!==null){n=nextSize;nextSize=null;}if(offset+n>body.length)throw Error('Unsupported TES4 field');if(type==='XXXX'){if(n!==4)throw Error('Unsupported TES4 field');nextSize=body.readUInt32LE(offset);offset+=n;continue;}if(type==='MAST'){const b=body.subarray(offset,offset+n);if(!n||b[n-1]!==0)throw Error('Invalid master');const m=b.subarray(0,n-1).toString('utf8');pluginName(m);if(masters.some(x=>x.toLowerCase()===m.toLowerCase()))throw Error('Duplicate master');masters.push(m);}offset+=n;}return{light:!!(flags&0x200),master:!!(flags&1),masters};}finally{await handle.close();}
}
export interface OrderInputs {pluginsText:string|null;loadorderText:string|null;cccText:string|null;managed:boolean;}
function lines(text:string|null,stars=false):{name:string;enabled:boolean}[]{if(text===null)return[];if(Buffer.byteLength(text)>1024*1024)throw Error('Order file exceeds limit');const values=text.replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'));const names=new Set<string>();return values.map(v=>{const enabled=!stars||v.startsWith('*'),name=v.replace(/^\*/,'');pluginName(name);if(names.has(name.toLowerCase()))throw Error('Duplicate plugin in activation/order file');names.add(name.toLowerCase());return{name,enabled};});}
export async function checkPlugins(root:string,requirements:PluginRequirement[],input:OrderInputs):Promise<PluginEvidence> {
 const evidence:PluginEvidence={source:'configuration-derived',active:[],fullOrder:[],issues:[],plugins:[]};
 if(input.managed){evidence.source='unverified';evidence.issues.push('Managed/virtualized runtime view cannot be established');}
 const headers=new Map<string,Awaited<ReturnType<typeof readPluginHeader>>>();
 try{const activation=lines(input.pluginsText,true),order=lines(input.loadorderText),ccc=lines(input.cccText),active:string[]=[];
  // Only known implicit official masters that are physically present; never enumerate Data for order.
  for(const name of OFFICIAL){try{await safeFile(root,'Data/'+name);active.push(name);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){evidence.source='unverified';evidence.issues.push('Official master could not be inspected');}}}
  for(const entry of ccc){try{await safeFile(root,'Data/'+entry.name);if(!active.some(n=>n.toLowerCase()===entry.name.toLowerCase()))active.push(entry.name);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){evidence.source='unverified';evidence.issues.push('Creation Club evidence could not be inspected');}}}
  for(const entry of activation.filter(e=>e.enabled))if(!active.some(n=>n.toLowerCase()===entry.name.toLowerCase()))active.push(entry.name);
  const nonImplicit=active.filter(n=>!OFFICIAL.some(m=>m.toLowerCase()===n.toLowerCase())&&!ccc.some(m=>m.name.toLowerCase()===n.toLowerCase()));
  if(input.pluginsText===null&&requirements.some(p=>!OFFICIAL.some(n=>n.toLowerCase()===p.filename.toLowerCase()))){evidence.source='unverified';evidence.issues.push('Plugin activation evidence unavailable');}
  if(nonImplicit.length&&input.loadorderText===null){evidence.source='unverified';evidence.issues.push('Effective non-official order cannot be established without loadorder.txt');}
  if(input.loadorderText!==null){const indexed=order.map(e=>e.name.toLowerCase());const activeOrder=nonImplicit.map(n=>n.toLowerCase()),configuredOrder=indexed.filter(n=>activeOrder.includes(n));if(activeOrder.join('|')!==configuredOrder.join('|')){evidence.source='unverified';evidence.issues.push('Activation and loadorder.txt disagree; effective precedence unverified');}}
  evidence.active=active;
  for(const name of active){try{headers.set(name.toLowerCase(),await readPluginHeader(await safeFile(root,'Data/'+name)));}catch{evidence.source='unverified';evidence.issues.push('Plugin header unavailable: '+name);}}
  // Master-first reordering by the engine cannot safely be guessed. Conflicting source order stays unverified.
  let seenNonMaster=false;for(const name of active){const h=headers.get(name.toLowerCase());if(h?.light)continue;if(h?.master&&seenNonMaster){evidence.source='unverified';evidence.issues.push('Master-first runtime reorder is ambiguous');}if(h&&!h.master)seenNonMaster=true;}
  evidence.fullOrder=active.filter(n=>!headers.get(n.toLowerCase())?.light&&!n.toLowerCase().endsWith('.esl'));
  for(const p of [...requirements].sort((a,b)=>a.order-b.order)){let status:PluginEvidence['plugins'][number]['status']='verified',reason:string|undefined;const h=headers.get(p.filename.toLowerCase()),index=active.findIndex(n=>n.toLowerCase()===p.filename.toLowerCase());
   try{await safeFile(root,'Data/'+p.filename);}catch(error){status=(error as NodeJS.ErrnoException).code==='ENOENT'?(p.required?'missing':'optional-missing'):'scan-error';reason='Required plugin file unavailable';}
   if(status==='verified'&&index<0){status='incompatible';reason='Installed plugin is inactive';}
   if(status==='verified'&&(!h||evidence.source==='unverified')){status='unknown';reason='Effective runtime order unverified';}
   if(status==='verified'&&p.role==='server-required'&&(h!.light||p.filename.toLowerCase().endsWith('.esl'))){status='unknown';reason='Pinned SkyMP ESL/light mapping is not verified';}
   if(status==='verified'){for(const master of [...new Set([...p.masters,...h!.masters])]){const m=active.findIndex(n=>n.toLowerCase()===master.toLowerCase());if(m<0||m>=index){status='incompatible';reason='Missing/inactive/misordered master: '+master;break;}}
    if(status==='verified'&&p.role==='server-required'&&evidence.fullOrder.findIndex(n=>n.toLowerCase()===p.filename.toLowerCase())!==p.order){status='incompatible';reason='Required full-plugin index differs from server';}
    if(status==='verified'&&p.role==='client-only'){const expected=requirements.filter(x=>x.role==='client-only').sort((a,b)=>a.order-b.order);const observed=active.filter(n=>expected.some(x=>x.filename.toLowerCase()===n.toLowerCase()));if(observed.findIndex(n=>n.toLowerCase()===p.filename.toLowerCase())!==expected.findIndex(x=>x.filename===p.filename)){status='incompatible';reason='Client-only relative order mismatch';}}
   }
   evidence.plugins.push({filename:p.filename,status,light:h?.light,masters:h?.masters,reason});
  }
 }catch{evidence.source='unverified';evidence.issues.push('Invalid/unreadable activation or load-order evidence');evidence.plugins=requirements.map(p=>({filename:p.filename,status:'unknown',reason:'Invalid order evidence'}));}
 return evidence;
}
export async function readOrderInputs(game:string,configDirectory:string):Promise<OrderInputs>{
 let managed=false;for(const [root,file] of [[game,'ModOrganizer.ini'],[game,'usvfs_x64.dll'],[game,'Data/vortex.deployment.json'],[game,'Data/__folder_managed_by_vortex']] as const){try{await safeFile(root,file);managed=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')managed=true;}}
 async function read(root:string,file:string){try{const f=await safeFile(root,file),stat=await fs.stat(f);if(stat.size>1024*1024)throw Error('Metadata too large');return await fs.readFile(f,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;managed=true;return null;}}
 const pluginsText=await read(configDirectory,'plugins.txt'),loadorderText=await read(configDirectory,'loadorder.txt'),cccText=await read(game,'Skyrim.ccc');return{pluginsText,loadorderText,cccText,managed};
}
