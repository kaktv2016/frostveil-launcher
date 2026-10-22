import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const tests=(await fs.readdir('tests')).filter(f=>f.endsWith('.test.ts')).map(f=>'tests/'+f);
const syntheticDelivery='tests/modpack-delivery.test.ts';
const options={outdir:'.test-build',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs',packages:'external'};
await build({...options,entryPoints:[...tests.filter(f=>f!==syntheticDelivery),'tests/installer-worker.ts']});
// This entry uses inert Skyrim-shaped fixture directories. The owner's actual
// Skyrim process must not block its synthetic transaction tests. Scope the
// dependency replacement to this bundle; all process-guard security tests and
// every production build retain the real Windows process provider.
const windows=path.resolve('src/main/windows.ts');
await build({...options,entryPoints:[syntheticDelivery],plugins:[{name:'synthetic-delivery-process',setup(builder){
 builder.onResolve({filter:/windows$/},args=>args.namespace==='synthetic-process'?undefined:{path:windows,namespace:'synthetic-process'});
 builder.onLoad({filter:/.*/,namespace:'synthetic-process'},()=>({contents:'export * from '+JSON.stringify(windows)+'; export const gameRunning=async()=>false;',resolveDir:path.dirname(windows)}));
}}]});
const result=spawnSync(process.execPath,['--test',...tests.map(f=>'.test-build/'+f.slice(6).replace(/\.ts$/,'.cjs'))],{stdio:'inherit'});
process.exit(result.status??1);
