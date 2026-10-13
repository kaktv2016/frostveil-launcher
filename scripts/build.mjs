import {build} from 'esbuild';
import {build as viteBuild} from 'vite';
await build({entryPoints:['src/main/index.ts'],outfile:'dist/main.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external'});
await build({entryPoints:['src/preload/index.ts'],outfile:'dist/preload.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron']});
await viteBuild();
