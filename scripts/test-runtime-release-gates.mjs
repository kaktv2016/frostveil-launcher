import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';
const out=path.resolve('.local/runtime-normalization');await fs.mkdir(out,{recursive:true});
const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');await fs.access(npm);
const stages=[],started=Date.now();
async function runtimeDigest(){const inputs=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Redirected release input');const file=path.join(dir,e.name);if(e.isDirectory())await walk(file);else inputs.push(file);}}
 await walk('src');await walk('assets');for(const file of ['package.json','package-lock.json','tsconfig.json','vite.config.ts','scripts/build.mjs'])try{await fs.access(file);inputs.push(file);}catch(e){if(e.code!=='ENOENT')throw e;}
 const digest=createHash('sha256');for(const file of inputs.sort()){digest.update(file.replaceAll('\\','/'));digest.update('\0');digest.update(await fs.readFile(file));}return digest.digest('hex');}
const beforeDigest=await runtimeDigest();
for(const name of ['typecheck','build','smoke','test']){
 const at=Date.now(),log=path.join(out,'release-'+name+'.log'),handle=await fs.open(log,'w');console.log('GATE '+name+' START');
 const exit=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[npm,'run',name],{cwd:process.cwd(),shell:false,windowsHide:true,stdio:['ignore',handle.fd,handle.fd]});child.once('error',reject);child.once('close',resolve);});await handle.close();
 stages.push({name,exit,elapsedMs:Date.now()-at,log});await fs.writeFile(path.join(out,'release-gates.json'),JSON.stringify({passed:false,stages},null,2));
 if(exit!==0)throw Error('Release gate failed: '+name+'; complete diagnostics: '+log);console.log('GATE '+name+' PASS '+(Date.now()-at)+'ms');
}
const tests=await fs.readFile(path.join(out,'release-test.log'),'utf8'),count=Number(tests.match(/ℹ tests (\d+)/)?.[1]);
if(count<519||!/ℹ fail 0\b/.test(tests)||!/ℹ skipped 0\b/.test(tests)||!/NSIS_STAGE .*"name":"handoff-install","phase":"done"/.test(tests)||!/NSIS_STAGE .*"name":"new-app-ready","phase":"done"/.test(tests))throw Error('Missing regression or real NSIS handoff/ready evidence');
const read=async n=>JSON.parse(await fs.readFile(path.join(out,n),'utf8'));
for(const name of ['bootstrap-result.json','transaction-result.json','pipe-result.json'])if((await read(name)).passed!==true)throw Error('Missing actual integration gate: '+name);
const afterDigest=await runtimeDigest();if(afterDigest!==beforeDigest)throw Error('Runtime source changed during release gates; rerun against a frozen input set');
const result={passed:true,version:JSON.parse(await fs.readFile('package.json')).version,tests:count,stages,runtimeSourceDigest:afterDigest,elapsedMs:Date.now()-started,skyrimGameplay:'PENDING_OWNER',protectedDataWrites:0};await fs.writeFile(path.join(out,'release-gates.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
