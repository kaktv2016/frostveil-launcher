// Explicit offline CLI. Writes launcher-private metadata only; no server/game setup or runtime changes.
import fs from 'node:fs/promises';import path from 'node:path';import {build} from 'esbuild';import {createRequire} from 'node:module';
const flags=new Map();for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];if(!['--settings','--manifest','--requirements','--output','--engine-commit'].includes(k)||!v||flags.has(k))throw Error('Invalid export arguments');flags.set(k,v);}
for(const key of ['--settings','--manifest','--requirements','--output','--engine-commit'])if(!flags.has(key))throw Error('Required: --settings --manifest --requirements --output --engine-commit');
await fs.mkdir('.local',{recursive:true});await build({stdin:{contents:"export {exportServerProfile} from './src/main/modpack/server-profile';export {validateManifest,MAX_METADATA} from './src/main/modpack/schema';export {noLinks,safeDirectory,contained,checkExistingAncestors} from './src/main/files';",resolveDir:process.cwd()},outfile:'.local/profile-export.cjs',bundle:true,platform:'node',format:'cjs',packages:'external'});
const {exportServerProfile,validateManifest,MAX_METADATA,noLinks,safeDirectory,contained,checkExistingAncestors}=createRequire(import.meta.url)(path.resolve('.local/profile-export.cjs'));
try{
 const settings=path.resolve(flags.get('--settings')),output=path.resolve(flags.get('--output')),local=path.resolve('.local'),storage=path.join(process.env.LOCALAPPDATA??'','SkyrimRPLauncher');
 if(!contained(local,output)&&!contained(storage,output)||contained(path.dirname(settings),output))throw Error('Output must be launcher-private metadata outside server');
 async function json(file){const resolved=path.resolve(file);await noLinks(resolved);if((await fs.stat(resolved)).size>MAX_METADATA)throw Error('Metadata size limit');return JSON.parse((await fs.readFile(resolved,'utf8')).replace(/^\uFEFF/,''));}
 const config=await json(settings),existing=await json(flags.get('--manifest')),manifest=validateManifest(await json(flags.get('--requirements')));if(manifest.distribution.source!=='local-development')throw Error('Local export is development-only');
 const server=await exportServerProfile(config,existing,manifest,path.dirname(settings),flags.get('--engine-commit'));
 checkExistingAncestors(output);await safeDirectory(path.dirname(output));await fs.writeFile(output,JSON.stringify({manifest,server},null,2));
 console.log(JSON.stringify({status:'EXPORTED OFFLINE DEVELOPMENT SNAPSHOT',plugins:server.plugins.length,files:manifest.files.length,liveServerVerified:false}));
}catch{console.error('Offline export failed: check profile schema, config/manifest consistency, input access and safe output location.');process.exitCode=1;}
