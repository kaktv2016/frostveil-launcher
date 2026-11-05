import fs from 'node:fs/promises';
import path from 'node:path';
import {safeFile,noLinks,relativePath} from '../files';
import type {SandboxGrant} from '../installer/sandbox';
import {readOrderInputs} from '../modpack/plugins';

export interface Isolation {quarantine:string[];writes:{path:string;bytes:Buffer}[];}
/** Known outputs from the installed Community Shaders mechanisms (ShaderCache
 * GetDiskPath/Info.ini and Utils/FileSystem PathHelpers), not mod source code.
 * Leave user settings/logs/caches intact; never treat arbitrary DLL/INI as output. */
function runtimeOutput(p:string){return /\.log$/i.test(p)||/^Data\/ShaderCache\/(?:[A-Za-z0-9 _-]+\/)*[A-Za-z0-9 _-]+\.(?:pso|vso|cso)$/i.test(p)||/^Data\/ShaderCache\/Info\.ini$/i.test(p)||/^Data\/SKSE\/Plugins\/CommunityShaders_ImGui\.ini$/i.test(p)||/^Data\/SKSE\/Plugins\/CommunityShaders\/(?:SettingsUser|SettingsTest|SettingsTheme|AppliedOverrides)\.json$/i.test(p)||/^Data\/SKSE\/Plugins\/CommunityShaders\/UnifiedWaterCache\/[A-Za-z0-9_-]+\.wpc$/i.test(p);}
/** Read-only planner. No paid content is deleted; removals become journaled backups. */
export async function planCreationIsolation(g:SandboxGrant,baseline:readonly string[],approved:readonly string[],iniDirectories:readonly string[]=[g.configDirectory!]):Promise<Isolation>{
 const inputs=await readOrderInputs(g.installation,g.configDirectory!);if(inputs.managed)throw Error('Unverified mod manager/profile; preparation blocked');
 const allowed=new Set(approved.map(n=>relativePath(n).toLowerCase())),base=new Set(baseline.map(n=>n.toLowerCase())),quarantine:string[]=[],unknown:string[]=[];
 let count=0;
 async function walk(folder:string,prefix:string){await noLinks(folder);for(const e of await fs.readdir(folder,{withFileTypes:true})){
  if(++count>30000)throw Error('Installation inventory exceeds bound');const rel=prefix+e.name;
  if(e.isSymbolicLink())throw Error('Redirected installation asset');
  if(e.isDirectory()){await walk(path.join(folder,e.name),rel+'/');continue;}
  const f=await safeFile(g.installation,rel);if((await fs.stat(f)).nlink!==1)throw Error('Hard-linked installation asset');
  if(rel==='Skyrim.ccc'||rel==='installscript.vdf'||runtimeOutput(rel))continue;
  // This newer-runtime index file is absent from the acquired 1170 cohort.
  // Preserve its exact preimage instead of leaving alternate plugin indexing
  // inputs beside an older executable.
  if(rel==='SkyrimReservedAddOnIndexes.txt'&&!allowed.has(rel.toLowerCase())){quarantine.push(rel);continue;}
  if(/^Data\/cc[A-Za-z0-9_-]+(?: - [A-Za-z0-9 _-]+)?\.(?:esm|esp|esl|bsa)$/i.test(rel)){
   const stem=e.name.replace(/(?: - [A-Za-z0-9 _-]+)?\.(?:esm|esp|esl|bsa)$/i,'').toLowerCase();
   if(![...base].some(n=>n.replace(/\.(?:esm|esl)$/i,'')===stem)){quarantine.push(rel);continue;}
  }
  if(!allowed.has(rel.toLowerCase()))unknown.push(rel);
 }}
 // Include root .asi/proxy configuration and non-Data shader/loader folders.
 // Checking only DLL/EXE files would leave other native loading inputs active.
 await walk(g.installation,'');
 for(const directory of iniDirectories)for(const name of ['Skyrim.ini','SkyrimPrefs.ini','SkyrimCustom.ini']){
  let text:string;try{const f=await safeFile(directory,name);if((await fs.stat(f)).size>1024*1024)throw Error('INI exceeds review bound');text=await fs.readFile(f,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
  for(const line of text.split(/\r?\n/)){
   const match=line.match(/^\s*(sResourceArchiveList\d*|sResourceArchiveList2|sResourceStartUpArchiveList|sArchiveToLoadInMemoryList|sTestFile\d+|sResourceDataDirsFinal|sLocalMasterPath)\s*=\s*(.*?)\s*$/i);if(!match||!match[2])continue;
   for(const value of match[2].split(',').map(n=>n.trim()).filter(Boolean))if(!allowed.has(('Data/'+value).toLowerCase()))throw Error('Unreviewed archive or asset override in '+name+': '+match[1]);
  }
 }
 if(unknown.length)throw Error('Unreviewed installation assets: '+unknown.slice(0,12).join(', '));
 const removed=new Set(quarantine.filter(n=>/\.(esm|esp|esl)$/i.test(n)).map(n=>path.basename(n).toLowerCase()));
 const writes:Isolation['writes']=[];
 for(const [target,text] of [['Skyrim.ccc',inputs.cccText],['@config/plugins.txt',inputs.pluginsText],['@config/loadorder.txt',inputs.loadorderText]] as const){
  if(text===null)continue;
  // Configuration outside ASCII must be reviewed instead of lossy re-encoding.
  if(/[^\x09\x0a\x0d\x20-\x7e\uFEFF]/.test(text))throw Error('Unverified plugin configuration encoding');
  const bom=text.startsWith('\uFEFF')?'\uFEFF':'',body=text.slice(bom.length);
  const filtered=bom+body.replace(/([^\r\n]*)(\r\n|\n|$)/g,(all,line:string)=>removed.has(line.trim().replace(/^\*/, '').toLowerCase())?'':all);
  if(filtered!==text)writes.push({path:target,bytes:Buffer.from(filtered)});
 }
 return{quarantine:quarantine.sort(),writes};
}
