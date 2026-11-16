import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {build as viteBuild} from 'vite';
import {encodeW14ContentBuildPin,readW14ContentBuildPin} from './w14-content-build-pin.mjs';
const allArgs=process.argv.slice(2);
const folderArgs=allArgs.filter(arg=>arg.startsWith('--w14-update-folder='));
const w14Folder=folderArgs[0]?.slice('--w14-update-folder='.length);
const contentPinArgs=allArgs.filter(arg=>arg.startsWith('--w14-content-pin='));
const contentPinFile=contentPinArgs[0]?.slice('--w14-content-pin='.length);
if(folderArgs.length>1||(w14Folder!==undefined&&!/^[A-Za-z]:[\\/][^\\/]/.test(w14Folder))){
  throw Error('W14 update folder must be one absolute local Windows path');
}
if(contentPinArgs.length>1||contentPinFile!==undefined&&w14Folder===undefined){
 throw Error('W14 content pin requires one pinned update folder');
}
const contentPin=contentPinFile===undefined?undefined:await readW14ContentBuildPin(contentPinFile);
const args=allArgs.filter(arg=>!arg.startsWith('--w14-update-folder=')&&!arg.startsWith('--w14-content-pin='));
const revision=args[0]===undefined?undefined:Number(args[0].match(/^--p0-cache-policy-revision=([1-9][0-9]*)$/)?.[1]);
const policyFile=args[1]?.match(/^--p0-cache-policy-file=(.+)$/)?.[1];
if ((revision!==undefined&&!Number.isSafeInteger(revision)) || (args.length>1&&!policyFile) || args.length>2) {
  throw Error('Invalid P0 cache accounting build arguments');
}
const cachePin=revision===undefined?{required:false}:{required:true,revision};
if (policyFile) {
  const policy=await fs.readFile(policyFile);
  if (policy.length>64*1024) throw Error('P0 cache policy exceeds build limit');
  cachePin.bytes=policy.toString('utf8');
  cachePin.sha256=createHash('sha256').update(cachePin.bytes).digest('hex');
}
await build({entryPoints:['src/main/index.ts'],outfile:'dist/main.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',
  define:{FROSTVEIL_PACKAGED_CACHE_POLICY:JSON.stringify(cachePin),FROSTVEIL_W14_UPDATE_FOLDER:JSON.stringify(w14Folder)??'undefined',
   FROSTVEIL_W14_CONTENT_PIN:contentPin===undefined?'undefined':JSON.stringify(encodeW14ContentBuildPin(contentPin)),FROSTVEIL_W14_UPDATE_TEST:'false'}});
await build({entryPoints:['src/preload/index.ts'],outfile:'dist/preload.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron']});
await viteBuild();
