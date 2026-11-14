import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {build as viteBuild} from 'vite';
const args=process.argv.slice(2);
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
  define:{FROSTVEIL_PACKAGED_CACHE_POLICY:JSON.stringify(cachePin)}});
await build({entryPoints:['src/preload/index.ts'],outfile:'dist/preload.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron']});
await viteBuild();
