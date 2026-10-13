import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
await build({entryPoints:['tests/core.test.ts'],outfile:'.test-build/core.test.cjs',bundle:true,platform:'node',format:'cjs',packages:'external'});
const result=spawnSync(process.execPath,['--test','.test-build/core.test.cjs'],{stdio:'inherit'});
process.exit(result.status??1);
