import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {safeFile,noLinks} from '../files';
import {readPluginHeader,type OrderInputs} from '../modpack/plugins';
import {pluginName} from '../modpack/schema';
import type {PluginRequirement} from '../../shared/modpack-contracts';

export interface ActivationWrite {path:'@config/plugins.txt'|'@config/loadorder.txt';bytesBase64:string;sha256:string;originalHash:string|null;}
export interface ActivationPlan {status:'ready'|'manual'|'blocked';blockers:string[];manual:string[];active:string[];order:string[];configWrites:ActivationWrite[];}
export interface ActivationHeader {master:boolean;light:boolean;masters:string[];}
const OFFICIAL=['Skyrim.esm','Update.esm','Dawnguard.esm','HearthFires.esm','Dragonborn.esm'];
const key=(name:string)=>name.toLowerCase();
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
interface Line {raw:string;end:string;name?:string;enabled?:boolean;}

/**
 * Native Steam SSE uses the asterisk list for both activation and order.
 * Primary reference: Ortham/libloadorder src/game_settings.rs (SkyrimSE ->
 * Asterisk, no loadorder.txt) and src/load_order/asterisk_based.rs.
 * Restrict editable names/text to ASCII, which is byte-identical in the game's
 * Windows-1252 and UTF-8. Preserve an existing UTF-8 BOM and all unrelated lines.
 * This planner never writes; Main binds the resulting bytes to one transaction.
 */
function parse(text:string|null,stars:boolean):{bom:string;lines:Line[];newline:string}{
 const value=text??'';
 if(Buffer.byteLength(value)>1024*1024)throw Error('Activation configuration exceeds the size limit');
 const bom=value.startsWith('\uFEFF')?'\uFEFF':'',body=value.slice(bom.length);
 if(/[^\x09\x0a\x0d\x20-\x7e]/.test(body))throw Error('Unsupported activation encoding; a byte-safe manual profile review is required');
 if(/\r(?!\n)/.test(body))throw Error('Unsupported activation line endings');
 const names=new Set<string>(),lines:Line[]=[];
 for(const match of body.matchAll(/([^\r\n]*)(\r\n|\n|$)/g)){
  const raw=match[1]!,end=match[2]!;if(!raw&&!end)continue;
  const line:Line={raw,end};
  if(raw.trim()&&!raw.startsWith('#')){
   if(raw.trim()!==raw)throw Error('Ambiguous whitespace in activation entry');
   const enabled=!stars||raw.startsWith('*'),name=stars?raw.replace(/^\*/,''):raw;
   pluginName(name);if(names.has(key(name)))throw Error('Duplicate plugin in activation configuration');names.add(key(name));line.name=name;line.enabled=enabled;
  }
  lines.push(line);
 }
 return{bom,lines,newline:lines.find(l=>l.end)?.end??'\r\n'};
}
function checkedHeader(raw:unknown):ActivationHeader{
 if(!raw||typeof raw!=='object')throw Error('Plugin header unavailable');
 const h=raw as ActivationHeader;
 if(typeof h.master!=='boolean'||typeof h.light!=='boolean'||!Array.isArray(h.masters)||h.masters.length>254)throw Error('Invalid pending plugin header');
 const seen=new Set<string>();for(const m of h.masters){pluginName(m);if(seen.has(key(m)))throw Error('Duplicate plugin master');seen.add(key(m));}
 return{master:h.master,light:h.light,masters:[...h.masters]};
}
export async function planActivation(game:string,requirements:PluginRequirement[],inputs:OrderInputs,options:{pendingHeaders?:Record<string,unknown>;deactivate?:string[]}={}):Promise<ActivationPlan>{
 const plan:ActivationPlan={status:'ready',blockers:[],manual:[],active:[],order:[],configWrites:[]};
 if(inputs.managed){plan.status='manual';plan.manual.push('MO2/Vortex, virtualization, deployment or the effective profile cannot be established. Use the mod manager to apply and verify this plan.');return plan;}
 try{
  await noLinks(game);
  const activation=parse(inputs.pluginsText,true),ccc=parse(inputs.cccText,false),requirementsByName=new Map<string,PluginRequirement>(),required=new Map<string,PluginRequirement>();
  // Internal callers derive this exact list from the selected pack's ownership
  // receipt. It is deliberately absent from renderer-facing input contracts.
  const deactivate=new Set<string>();
  if((options.deactivate?.length??0)>254)throw Error('Too many plugin deactivations');
  for(const name of options.deactivate??[]){pluginName(name);const n=key(name);if(OFFICIAL.some(p=>key(p)===n)||ccc.lines.some(l=>l.name&&key(l.name)===n))throw Error('Implicit official/Creation Club plugins cannot be deactivated');if(deactivate.has(n))throw Error('Duplicate plugin deactivation');deactivate.add(n);}
  if(requirements.length>254)throw Error('Plugin requirement count exceeds the supported full-plugin limit');
  for(const p of requirements){
   pluginName(p.filename);if(/[^\x20-\x7e]/.test(p.filename))throw Error('Unsupported plugin filename encoding');
   if(requirementsByName.has(key(p.filename))||!Number.isInteger(p.order)||p.order<0||p.order>253||!['client-only','server-required'].includes(p.role)||typeof p.required!=='boolean'||!Array.isArray(p.masters))throw Error('Invalid or duplicate plugin requirement');
   const masters=new Set<string>();for(const master of p.masters){pluginName(master);if(masters.has(key(master))||key(master)===key(p.filename))throw Error('Invalid master dependency');masters.add(key(master));}
   requirementsByName.set(key(p.filename),p);if(p.required){if(deactivate.has(key(p.filename)))throw Error('Required plugin cannot be deactivated');required.set(key(p.filename),p);}
  }
  const headers=new Map<string,ActivationHeader>(),names=new Map<string,string>(),implicit:string[]=[];
  const pending=new Map(Object.entries(options.pendingHeaders??{}).map(([n,h])=>[key(n),h]));
  async function header(name:string,allowPending:boolean){
   if(allowPending&&pending.has(key(name))){const h=checkedHeader(pending.get(key(name)));headers.set(key(name),h);names.set(key(name),name);return h;}
   if(headers.has(key(name)))return headers.get(key(name))!;
   let h:ActivationHeader;
   try{const file=await safeFile(game,'Data/'+name);const st=await fs.stat(file);if(st.nlink!==1)throw Error('Hardlinked plugin cannot be used as authoritative evidence: '+name);h=await readPluginHeader(file);}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||!allowPending||!pending.has(key(name)))throw error;h=checkedHeader(pending.get(key(name)));}
   headers.set(key(name),h);names.set(key(name),name);return h;
  }
  for(const name of [...OFFICIAL,...ccc.lines.flatMap(l=>l.name?[l.name]:[])]){
   if(implicit.some(n=>key(n)===key(name)))continue;
   try{await header(name,false);implicit.push(name);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const active=[...implicit];
  for(const line of activation.lines)if(line.enabled&&line.name&&!deactivate.has(key(line.name))&&!active.some(n=>key(n)===key(line.name!))){await header(line.name,required.has(key(line.name)));active.push(line.name);}
  for(const p of required.values()){
   const h=await header(p.filename,true);
   if(p.role==='server-required'&&(h.light||/\.esl$/i.test(p.filename)))throw Error('Pinned SkyMP ESL/light plugin activation is unsupported or unverified: '+p.filename);
   if(!active.some(n=>key(n)===key(p.filename)))active.push(p.filename);
  }
  const nodes=active.map(key),edges=new Map(nodes.map(n=>[n,new Set<string>()])),indegree=new Map(nodes.map(n=>[n,0]));
  function edge(before:string,after:string){if(before===after)throw Error('Plugin dependency cycle');if(!edges.get(before)?.has(after)){edges.get(before)!.add(after);indegree.set(after,indegree.get(after)!+1);}}
  for(const name of active){
   const h=headers.get(key(name))!;
   const masters=new Set([...h.masters,...(requirementsByName.get(key(name))?.masters??[])].map(key));
   for(const m of masters){if(!edges.has(m))throw Error('Missing or inactive master dependency: '+m+' required by '+name);edge(m,key(name));}
  }
  // Implicit official/CCC precedence is fixed. Unrelated active plugins retain
  // their pairwise precedence; impossible engine-hoisting cases are refused.
  for(let i=1;i<implicit.length;i++)edge(key(implicit[i-1]!),key(implicit[i]!));
  const implicitKeys=new Set(implicit.map(key)),dynamic=active.filter(n=>!implicitKeys.has(key(n)));
  for(const name of dynamic)for(const prefix of implicit)edge(key(prefix),key(name));
  const unrelated=dynamic.filter(n=>!required.has(key(n)));
  for(let i=1;i<unrelated.length;i++)edge(key(unrelated[i-1]!),key(unrelated[i]!));
  const isMaster=(n:string)=>headers.get(key(n))!.master||/\.(esm|esl)$/i.test(n);
  for(const master of dynamic.filter(isMaster))for(const plugin of dynamic.filter(n=>!isMaster(n)))edge(key(master),key(plugin));
  for(const role of ['server-required','client-only']){const sequence=[...required.values()].filter(p=>p.role===role).sort((a,b)=>a.order-b.order);for(let i=1;i<sequence.length;i++)edge(key(sequence[i-1]!.filename),key(sequence[i]!.filename));}
  const priority=(n:string)=>{const p=required.get(n);return p?.role==='server-required'?p.order:1000+nodes.indexOf(n);};
  const ordered:string[]=[];
  while(ordered.length<nodes.length){const choices=nodes.filter(n=>!ordered.includes(n)&&indegree.get(n)===0).sort((a,b)=>priority(a)-priority(b));if(!choices.length)throw Error('Plugin dependency/order cycle or incompatible unrelated plugin order');const next=choices[0]!;ordered.push(next);for(const after of edges.get(next)!)indegree.set(after,indegree.get(after)!-1);}
  const resulting=ordered.map(n=>names.get(n)!);
  const full=resulting.filter(n=>!headers.get(key(n))!.light&&!/\.esl$/i.test(n));
  if(full.length>254)throw Error('Full-plugin count exceeds supported SkyMP indices');
  const serverFull=full.filter(n=>OFFICIAL.some(o=>key(o)===key(n))||required.has(key(n)));
  for(const p of required.values())if(p.role==='server-required'&&full.findIndex(n=>key(n)===key(p.filename))!==p.order&&serverFull.findIndex(n=>key(n)===key(p.filename))!==p.order)throw Error('Server-required full-plugin index conflicts with implicit masters or dependencies: '+p.filename);
  plan.active=resulting;plan.order=full;
  const current=active.filter(n=>implicitKeys.has(key(n))||activation.lines.some(l=>l.enabled&&l.name&&key(l.name)===key(n)));
  if(current.map(key).join('|')===resulting.map(key).join('|')&&!activation.lines.some(l=>l.enabled&&l.name&&deactivate.has(key(l.name))))return plan;
  const editable=new Set([...required.keys()].filter(n=>!implicitKeys.has(n)));
  const kept=activation.lines.filter(l=>!l.name||!editable.has(key(l.name))).map(l=>l.enabled&&l.name&&deactivate.has(key(l.name))?{...l,raw:l.raw.slice(1),enabled:false}:l);
  const inserts=new Map<string,Line[]>(),tail:Line[]=[];
  for(let i=0;i<resulting.length;i++){
   const name=resulting[i]!;if(!editable.has(key(name)))continue;
   const previous=activation.lines.find(l=>l.name&&key(l.name)===key(name));
   const line:Line={raw:'*'+(previous?.name??name),end:previous?.end||activation.newline};
   const next=resulting.slice(i+1).find(n=>!editable.has(key(n))&&!implicitKeys.has(key(n)));
   if(next){const list=inserts.get(key(next))??[];list.push(line);inserts.set(key(next),list);}else tail.push(line);
  }
  let text=activation.bom;
  for(const line of kept){if(line.name)for(const insertion of inserts.get(key(line.name))??[])text+=insertion.raw+insertion.end;text+=line.raw+line.end;}
  if(tail.length){if(text&&!text.endsWith('\n')&&text!==activation.bom)text+=activation.newline;for(const line of tail)text+=line.raw+line.end;}
  const bytes=Buffer.from(text,'utf8');
  if(text!==(inputs.pluginsText??''))plan.configWrites.push({path:'@config/plugins.txt',bytesBase64:bytes.toString('base64'),sha256:digest(bytes),originalHash:inputs.pluginsText===null?null:digest(Buffer.from(inputs.pluginsText,'utf8'))});
 }catch(error){plan.status='blocked';plan.blockers.push(error instanceof Error?error.message:'Plugin activation could not be verified');plan.configWrites=[];}
 return plan;
}
