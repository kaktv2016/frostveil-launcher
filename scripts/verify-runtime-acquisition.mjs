// Local release gate only. Reads owned Steam staging, never the player install.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const root=path.resolve('.local/runtime-normalization'),source=path.resolve(process.argv[2]??'');
if(process.argv.length!==3||source===path.parse(source).root)throw Error('Usage: node scripts/verify-runtime-acquisition.mjs <owned-steam-staging>');
await fs.mkdir(root,{recursive:true});
await build({entryPoints:['src/main/files.ts','src/main/windows.ts','src/main/runtime/policy.ts','src/main/runtime/depot.ts','src/main/modpack/plugins.ts'],outdir:path.join(root,'verify-harness'),bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},packages:'external'});
const require=createRequire(import.meta.url),{safeFile,hashFile,noLinks}=require(path.join(root,'verify-harness/files.cjs')),{fileVersion}=require(path.join(root,'verify-harness/windows.cjs')),{runtimePath}=require(path.join(root,'verify-harness/runtime/policy.cjs')),{helperPin}=require(path.join(root,'verify-harness/runtime/depot.cjs')),{readPluginHeader}=require(path.join(root,'verify-harness/modpack/plugins.cjs'));
const pins=[{id:'489831',manifest:'8442952117333549665'},{id:'489832',manifest:'8042843504692938467'},{id:'489833',manifest:'1914580699073641964'}];
const files=[],proof=[],names=new Set();await noLinks(source);
for(const pin of pins){
 const readResult=async name=>JSON.parse((await fs.readFile(await safeFile(source,name),'utf8')).replace(/^\uFEFF/,''));
 let result;try{result=await readResult(pin.id+'-retry-result.json');}catch(e){if(e.code!=='ENOENT')throw e;result=await readResult(pin.id+'-result.json');}
 if(result.exitCode!==0||result.depot!==pin.id||result.manifest!==pin.manifest)throw Error('Steam acquisition did not pass for depot '+pin.id);
 const base=await safeFile(source,pin.id+'/.DepotDownloader/'+pin.id+'_'+pin.manifest+'.manifest');
 proof.push({...pin,manifestFile:await hashFile(base,32*1024**2),exitCode:0,finishedAt:result.finishedAt});
 async function walk(folder,prefix=''){
  await noLinks(folder);for(const entry of await fs.readdir(folder,{withFileTypes:true})){
   if(entry.name==='.DepotDownloader')continue;const rel=prefix+entry.name;if(entry.isSymbolicLink())throw Error('Redirected acquired payload');
   if(entry.isDirectory()){await walk(path.join(folder,entry.name),rel+'/');continue;}
   if(['installscript.vdf','Skyrim.ccc'].includes(rel))continue;
   runtimePath(rel);if(names.has(rel.toLowerCase()))throw Error('Conflicting depot payload path '+rel);names.add(rel.toLowerCase());
   const f=await safeFile(source,pin.id+'/'+rel);if((await fs.stat(f)).nlink!==1)throw Error('Hard-linked acquired payload');files.push({path:rel,...await hashFile(f,8*1024**3),depot:pin.id});
  }
 }
 await walk(path.join(source,pin.id));
}
if(await fileVersion(await safeFile(source,'489833/SkyrimSE.exe'))!=='1.6.1170.0')throw Error('Acquired EXE runtime is not 1.6.1170.0');
const official=['Skyrim.esm','Update.esm','Dawnguard.esm','HearthFires.esm','Dragonborn.esm'];
for(const name of official)if(!names.has(('Data/'+name).toLowerCase()))throw Error('Missing acquired master '+name);
const headers=[];for(const file of files.filter(f=>/\.(?:esm|esl)$/i.test(f.path)))headers.push({path:file.path,...await readPluginHeader(await safeFile(source,file.depot+'/'+file.path))});
const receipt={schemaVersion:1,verifiedAt:new Date().toISOString(),runtime:'1.6.1170.0',acquiredFrom:'Steam authenticated owned-account depot downloads',helper:helperPin,depots:proof,files,headers,totalBytes:files.reduce((n,f)=>n+f.size,0),installationWrites:0};
const bytes=Buffer.from(JSON.stringify(receipt,null,2));await fs.writeFile(path.join(root,'acquisition-receipt.json'),bytes);
console.log(JSON.stringify({passed:true,files:files.length,totalBytes:receipt.totalBytes,runtime:receipt.runtime,receiptSha256:createHash('sha256').update(bytes).digest('hex'),depots:pins,installationWrites:0}));
