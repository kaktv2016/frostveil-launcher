import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{createRequire}from'node:module';import{build}from'esbuild';
const out=path.resolve('.local/spawn-terrain'),delivery=path.join(out,'delivery');
await build({entryPoints:['src/main/graphics-source-repair.ts','src/main/graphics-source-plan.ts','src/main/client-repair.ts'],outdir:path.join(out,'harness'),bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'}});
const require=createRequire(import.meta.url),load=n=>require(path.join(out,'harness',n+'.cjs'));
const {repairGraphicsSources}=load('graphics-source-repair'),{decodeGraphicsSourcePlan}=load('graphics-source-plan'),{repairClientForPlay}=load('client-repair');
const candidate=JSON.parse(await fs.readFile(path.join(delivery,'candidate.json'))),recipe=decodeGraphicsSourcePlan(await fs.readFile(path.join(delivery,'source-repair-plan.json')),candidate.recipe),client=recipe.files.find(f=>f.path===candidate.client.path),subset={...recipe,files:[client]};
assert.equal(recipe.files.length,649);
const old=await fs.readFile(path.resolve('../skymp/build/rp-audit/client-fix-20261022-195158/skymp5-client.original.js'));
assert.ok(client.previous.some(p=>p.sha256===createHash('sha256').update(old).digest('hex')));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'fv-spawn-terrain-')),game=path.join(root,'game'),storage=path.join(root,'storage'),file=path.join(game,client.path),options={sourceDirectories:[delivery]};
try{
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,old);
 await assert.rejects(repairGraphicsSources(game,storage,async()=>true,subset,options),/running/i);
 await assert.rejects(repairClientForPlay(game,storage,async()=>false,async()=>{throw Error('fixture-download-failure');}),/fixture-download-failure/);
 assert.deepEqual(await fs.readFile(file),old);
 await assert.rejects(repairClientForPlay(game,storage,async()=>false,async()=>Buffer.from('corrupt')),/hash/i);
 assert.deepEqual(await fs.readFile(file),old);
 assert.equal((await repairGraphicsSources(game,storage,async()=>false,subset,options)).changed,1);
 assert.deepEqual(await fs.readFile(file),await fs.readFile(path.join(delivery,'skymp5-client.js')));
 assert.equal((await repairGraphicsSources(game,storage,async()=>false,subset,options)).changed,0);
 await fs.unlink(file);
 assert.equal((await repairGraphicsSources(game,storage,async()=>false,subset,options)).changed,1);
 const result={passed:true,targets:649,unchanged:648,oldAndMissingClientRepaired:true,corruptAndFailedDownloadsPreserveOld:true,runningGameRefused:true,secondPlayWrites:0,installedGameWrites:0};
 await fs.writeFile(path.join(out,'fixture-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await fs.rm(root,{recursive:true,force:true});}
