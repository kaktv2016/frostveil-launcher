import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
const tests=(await fs.readdir('tests')).filter(f=>f.endsWith('.test.ts')).map(f=>'tests/'+f);
await build({entryPoints:[...tests,'tests/installer-worker.ts'],outdir:'.test-build',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs',packages:'external'});
const result=spawnSync(process.execPath,['--test',...tests.map(f=>'.test-build/'+f.slice(6).replace(/\.ts$/,'.cjs'))],{stdio:'inherit'});
process.exit(result.status??1);
