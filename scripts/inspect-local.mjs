// Explicit developer verification: read-only scan and optional bounded backup.
// No executable launch, server control or game write.
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
await fs.mkdir('.local',{recursive:true});
await build({stdin:{contents:"export {scanInstallation} from './src/main/installation';export {discoverSteam} from './src/main/discovery';export {steamRoots,fileVersion} from './src/main/windows';export {createBackup} from './src/main/backup';",resolveDir:process.cwd()},outfile:'.local/inspection.cjs',bundle:true,platform:'node',format:'cjs',packages:'external'});
const {scanInstallation,discoverSteam,steamRoots,fileVersion,createBackup}=createRequire(import.meta.url)(path.resolve('.local/inspection.cjs'));
const privateProfile=path.join(process.env.LOCALAPPDATA,'SkyrimRPLauncher/compatibility-profile.json');
const profile=JSON.parse((await fs.readFile(privateProfile,'utf8')).replace(/^\uFEFF/,''));
const choices=await discoverSteam(await steamRoots());
if(!choices.length)throw Error('No Steam installation detected; use manual folder selection in app');
const directory=choices[0],scan=await scanInstallation(directory,profile,fileVersion);
if(!scan.ready)throw Error('Real installation failed compatibility checks: '+scan.errors.join('; '));
let backup=null;
if(process.argv.includes('--backup'))backup=await createBackup(directory,path.join(process.env.LOCALAPPDATA,'SkyrimRPLauncher/backups'),profile);
const after=await scanInstallation(directory,profile,fileVersion);
if(!after.ready)throw Error('Protected integration files changed during verification');
await fs.writeFile('.local/local-integration.json',JSON.stringify({scan,backup,protectedBaselineFilesUnchanged:true,realGameLaunched:false},null,2));
console.log(JSON.stringify({ready:scan.ready,runtime:scan.runtime,skse:scan.skseRuntime,baselineFiles:scan.files.length,backup,protectedBaselineFilesUnchanged:true,realGameLaunched:false},null,2));
