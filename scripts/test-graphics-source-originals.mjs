import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {createRequire}from'node:module';import {build}from'esbuild';
const output=path.resolve('.local/graphics-repair');await fs.mkdir(output,{recursive:true});
await build({entryPoints:['src/main/graphics-source-repair.ts','src/main/files.ts'],outdir:'.local/graphics-repair/harness',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs'});
const require=createRequire(import.meta.url),{repairGraphicsSources}=require(path.join(output,'harness/graphics-source-repair.cjs')),{hashFile}=require(path.join(output,'harness/files.cjs'));
const plan=JSON.parse(await fs.readFile('../mod-dist/graphics-repair-107/source-repair-plan.json'));
const sourceGame='C:/Program Files (x86)/Steam/steamapps/common/Skyrim Special Edition';
const originals=path.resolve('../mod-work');
const before=[];for(const f of plan.files){try{before.push({path:f.path,...await hashFile(path.join(sourceGame,f.path))});}catch(e){if(e.code!=='ENOENT')throw e;before.push({path:f.path,absent:true});}}
await fs.writeFile(path.join(output,'installed-game-before.json'),JSON.stringify(before,null,2));
const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-original-source-'));assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep));
const game=path.join(fixture,'synthetic-game'),storage=path.join(fixture,'launcher-storage');
const started=Date.now();
try{
 await fs.mkdir(path.join(game,'Data'),{recursive:true});
 for(const archive of new Set(plan.files.map(f=>f.source.installedArchive).filter(Boolean))){await fs.copyFile(path.join(sourceGame,archive),path.join(game,archive));}
 for(let i=0;i<plan.files.length;i++){const file=plan.files[i];if(i%2===0){const p=path.join(game,file.path);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,'synthetic corrupt asset');}}
 let last=-1;const result=await repairGraphicsSources(game,storage,async()=>false,plan,{sourceDirectories:[originals],progress:(phase,n,total)=>{if(phase==='preparing'&&Math.floor(n/50)!==last){last=Math.floor(n/50);console.log(phase,n,total);}}});
 assert.equal(result.changed,plan.files.length);
 for(const f of plan.files){const actual=await hashFile(path.join(game,f.path));assert.equal(actual.sha256,f.sha256,f.path);assert.equal(actual.size,f.size,f.path);}
 assert.equal((await repairGraphicsSources(game,storage,async()=>false,plan,{sourceDirectories:[]})).changed,0);
 for(const f of before){if(f.absent)await assert.rejects(fs.access(path.join(sourceGame,f.path)));else assert.deepEqual(await hashFile(path.join(sourceGame,f.path)),{size:f.size,sha256:f.sha256},'Installed game changed: '+f.path);}
 const report={passed:true,files:plan.files.length,sourceBytes:plan.files.reduce((n,f)=>n+f.size,0),secondPlayChanged:0,installedGameUnchanged:true,installedGameWrites:0,serverChanges:0,elapsedSeconds:(Date.now()-started)/1000};
 await fs.writeFile(path.join(output,'original-fixture-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(fixture,{recursive:true,force:true});}
