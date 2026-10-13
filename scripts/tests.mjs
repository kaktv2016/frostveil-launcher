import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
await build({entryPoints:['tests/core.test.ts','tests/updater.test.ts'],outdir:'.test-build',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs',packages:'external'});
const result=spawnSync(process.execPath,['--test','.test-build/core.test.cjs','.test-build/updater.test.cjs'],{stdio:'inherit'});
process.exit(result.status??1);
