import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {createManagedFixture} from '../src/main/installer/managed-target';
import {authenticateRuntimeCohort,type RuntimeCohort} from '../src/main/runtime/policy';
import {RuntimeTransaction} from '../src/main/runtime/transaction';
import {planCreationIsolation} from '../src/main/runtime/creations';
import {assertSteamIdle,verifySteamSelection} from '../src/main/runtime/steam';
import {DepotOutput,depotRequestArguments} from '../src/main/runtime/depot';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const keys=generateKeyPairSync('ed25519');
const trust={test:{publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString(),environment:'test' as const,revoked:false}};
function cohort(overrides:Partial<RuntimeCohort>={}){
 const order=overrides.pluginOrder??[];
 const body:RuntimeCohort={schemaVersion:1,kind:'frostveil-steam-runtime',runtime:'1.6.1170.0',appId:'489830',language:'english',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),depots:[{id:'489833',manifest:'1914580699073641964'}],files:[{path:'SkyrimSE.exe',size:6,sha256:sha('target'),depot:'489833'}],creations:[],managedFiles:[],pluginOrder:[],configuration:{pluginsBase64:Buffer.from(order.map(n=>'*'+n).join('\r\n')+(order.length?'\r\n':'')).toString('base64'),loadorderBase64:Buffer.from(order.join('\r\n')+(order.length?'\r\n':'')).toString('base64')},helper:{version:'3.4.0',size:1,sha256:sha('h')},acquisition:{verified:true,receiptSha256:sha('receipt')},...overrides};
 const payload=Buffer.from(JSON.stringify(body));return {keyId:'test',payloadBase64:payload.toString('base64'),signatureBase64:sign(null,payload,keys.privateKey).toString('base64')};
}
const policy=()=>authenticateRuntimeCohort(cohort(),trust,{fixture:true});
async function fixture(){const grant=await createManagedFixture();await fs.writeFile(path.join(grant.installation,'SkyrimSE.exe'),'before');const source=path.join(grant.payloads,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'SkyrimSE.exe'),'target');return{grant,source,clean:()=>fs.rm(grant.directory,{recursive:true,force:true})};}

test('runtime metadata requires a signature, expiry, reviewed source and narrow targets',()=>{
 assert.equal(policy().runtime,'1.6.1170.0');
 assert.throws(()=>authenticateRuntimeCohort({...cohort(),signatureBase64:''},trust,{fixture:true}));
 for(const patch of [{expiresAt:'2020-01-01T00:00:00Z'},{files:[{path:'../SkyrimSE.exe',size:6,sha256:sha('target'),depot:'489833'}]},{files:[{path:'Data/SKSE/Plugins/arbitrary.dll',size:6,sha256:sha('target'),depot:'489833'}]},{files:[{path:'SkyrimSE.exe',size:6,sha256:sha('target'),depot:'999'}]},{acquisition:{verified:false,receiptSha256:sha('r')}}] as Partial<RuntimeCohort>[])
  assert.throws(()=>authenticateRuntimeCohort(cohort(patch),trust,{fixture:true}));
 assert.throws(()=>authenticateRuntimeCohort(cohort(),trust)); // fixture trust never authorizes production
});
test('stage all bytes, deduplicate backups, apply once, restore exact originals',async()=>{const f=await fixture();try{
 const tx=await RuntimeTransaction.open(f.grant,policy(),async()=>false);
 const plan=await tx.inspect();assert.equal(plan.changedFiles,1);assert.equal(plan.backupBytes,6);
 await tx.apply(f.source);assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'target');
 await tx.apply(f.source);assert.equal((await tx.inspect()).changedFiles,0);
 assert.equal((await fs.readdir(path.join(f.grant.payloads,'runtime-backups'))).length,1);
 await tx.restore();assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'before');
}finally{await f.clean();}});
test('wrong target-cohort bytes, active game, insufficient space never mutate originals',async()=>{for(const mode of ['corrupt','running','space']){const f=await fixture();try{
 const tx=await RuntimeTransaction.open(f.grant,policy(),async()=>mode==='running',{freeBytes:async()=>mode==='space'?0:Number.MAX_SAFE_INTEGER});
 if(mode==='corrupt')await fs.writeFile(path.join(f.source,'SkyrimSE.exe'),'broken');
 await assert.rejects(tx.apply(f.source));assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'before');
}finally{await f.clean();}}});
test('restore refuses subsequent external edits and keeps original backup',async()=>{const f=await fixture();try{
 const tx=await RuntimeTransaction.open(f.grant,policy(),async()=>false);await tx.apply(f.source);
 await fs.writeFile(path.join(f.grant.installation,'SkyrimSE.exe'),'external');await assert.rejects(tx.restore(),/conflict/i);
 assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'external');
 assert.equal(await fs.readFile(path.join(f.grant.payloads,'runtime-backups',sha('before')),'utf8'),'before');
}finally{await f.clean();}});
test('interruption after write is recoverable with authenticated journal and no second write',async()=>{const f=await fixture();try{
 let once=true;const tx=await RuntimeTransaction.open(f.grant,policy(),async()=>false,{checkpoint:async(stage)=>{if(stage==='file-applied'&&once){once=false;throw Error('simulated power loss');}}});
 await assert.rejects(tx.apply(f.source),/power loss/);
 const recovered=await RuntimeTransaction.open(f.grant,policy(),async()=>false);await recovered.recover();await recovered.restore();
 assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'before');
}finally{await f.clean();}});
test('creation isolation handles implicit CCC, preserves baseline, and refuses unknown loose assets',async()=>{const f=await fixture();try{
 await fs.writeFile(path.join(f.grant.installation,'Skyrim.ccc'),'ccBase.esm\r\nccPaid.esl\r\n');
 await fs.writeFile(path.join(f.grant.configDirectory!,'plugins.txt'),'*ccPaid.esl\n');
 for(const name of ['ccBase.esm','ccPaid.esl','ccPaid.bsa'])await fs.writeFile(path.join(f.grant.installation,'Data',name),'owned');
 const p=await planCreationIsolation(f.grant,['ccBase.esm'],['Data/ccBase.esm','Data/ccPaid.esl','Data/ccPaid.bsa','SkyrimSE.exe','Skyrim.ccc']);
 assert.deepEqual(p.quarantine,['Data/ccPaid.bsa','Data/ccPaid.esl']);
 assert.equal(p.writes.find(w=>w.path==='Skyrim.ccc')?.bytes.toString(),'ccBase.esm\r\n');
 await fs.mkdir(path.join(f.grant.installation,'Data/textures'));await fs.writeFile(path.join(f.grant.installation,'Data/textures/unknown.dds'),'unknown');
 await assert.rejects(planCreationIsolation(f.grant,['ccBase.esm'],['Data/ccBase.esm','SkyrimSE.exe','Skyrim.ccc']),/unknown|unreviewed/i);
}finally{await f.clean();}});

test('Steam app identity, language and update state are checked without modifying the ACF',async()=>{const f=await fixture();try{
 const library=path.join(f.grant.directory,'steam'),game=path.join(library,'steamapps/common/Skyrim Special Edition');await fs.mkdir(game,{recursive:true});
 const acf=path.join(library,'steamapps/appmanifest_489830.acf');
 const text=(flags='4',language='english')=>'"AppState" { "appid" "489830" "installdir" "Skyrim Special Edition" "StateFlags" "'+flags+'" "UserConfig" { "language" "'+language+'" } }';
 await fs.writeFile(acf,text());const selected=await verifySteamSelection(game,[library]);await assertSteamIdle(selected);assert.equal(await fs.readFile(acf,'utf8'),text());
 await fs.writeFile(acf,text('1024'));await assert.rejects(assertSteamIdle(selected),/updating|incomplete/);
 await fs.writeFile(acf,text('4','french'));await assert.rejects(verifySteamSelection(game,[library]),/English/);
 await assert.rejects(assertSteamIdle({...selected}),/capability|selection/i);
}finally{await f.clean();}});
test('QR handling emits only bounded block glyphs and clears them after disconnect',()=>{
 const events:(string|undefined)[]=[];const output=new DepotOutput(v=>events.push(v));
 output.push('user=private-account token=secret\n'+('  ██  ██  \n').repeat(25)+'\n');
 assert.equal(events.length,1);assert.match(events[0]!,/█/);assert.doesNotMatch(events[0]!,/private|token|secret/);
 output.push('Lost connection to Steam. Reconnecting\n');assert.equal(events.at(-1),undefined);
});
test('redirected Windows QR fallback retains its module pattern without exposing other output',()=>{
 const events:(string|undefined)[]=[],output=new DepotOutput(qr=>events.push(qr));
 output.push('Use the Steam Mobile App to sign in with this QR code:\n'+('    ??????    ??????    ??????    ??????    \n').repeat(25)+'\n');
 assert.ok(events.some(qr=>qr?.includes('█')));assert.ok(events.filter(Boolean).every(qr=>!qr?.includes('?')));
 output.clear();const count=events.length;output.push(('????????????????????????????????\n').repeat(25)+'\n');assert.equal(events.length,count,'ASCII fallback requires a QR prompt context');
});
test('cancel before staging leaves no active journal or game modifications',async()=>{const f=await fixture();try{
 const tx=await RuntimeTransaction.open(f.grant,policy(),async()=>false),controller=new AbortController();controller.abort();await assert.rejects(tx.apply(f.source,controller.signal));
 assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'before');
 assert.equal((await tx.inspect()).canRestore,false);
}finally{await f.clean();}});
test('corrupt rollback bytes and authenticated journal tampering fail closed',async()=>{for(const mode of ['blob','journal']){const f=await fixture();try{
 const tx=await RuntimeTransaction.open(f.grant,policy(),async()=>false);await tx.apply(f.source);
 if(mode==='blob')await fs.writeFile(path.join(f.grant.payloads,'runtime-backups',sha('before')),'tamper');
 else await fs.writeFile(path.join(f.grant.metadata,'runtime-preparation/journal.json'),'{}');
 await assert.rejects(tx.restore());assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'target');
}finally{await f.clean();}}});
test('creation restoration keeps paid content, original CCC bytes and plugin order',async()=>{const f=await fixture();try{
 const ccc='\uFEFFccPaid.esl\r\n# baseline\r\n';await fs.writeFile(path.join(f.grant.installation,'Skyrim.ccc'),ccc);await fs.writeFile(path.join(f.grant.installation,'Data/ccPaid.esl'),'paid');await fs.writeFile(path.join(f.grant.configDirectory!,'plugins.txt'),'*ccPaid.esl\r\n');
 const tx=await RuntimeTransaction.open(f.grant,policy(),async()=>false);await tx.apply(f.source);
 assert.equal(await fs.readFile(path.join(f.grant.installation,'Skyrim.ccc'),'utf8'),'\uFEFF# baseline\r\n');
 await assert.rejects(fs.stat(path.join(f.grant.installation,'Data/ccPaid.esl')),e=>(e as NodeJS.ErrnoException).code==='ENOENT');
 await tx.restore();assert.equal(await fs.readFile(path.join(f.grant.installation,'Data/ccPaid.esl'),'utf8'),'paid');assert.equal(await fs.readFile(path.join(f.grant.installation,'Skyrim.ccc'),'utf8'),ccc);
 assert.equal(await fs.readFile(path.join(f.grant.configDirectory!,'plugins.txt'),'utf8'),'*ccPaid.esl\r\n');
}finally{await f.clean();}});
test('foreign root DLLs and custom archive configuration cannot silently affect RP',async()=>{const f=await fixture();try{
 await fs.writeFile(path.join(f.grant.installation,'dxgi.dll'),'foreign');await assert.rejects(planCreationIsolation(f.grant,[],['SkyrimSE.exe']),/unreviewed/i);
 await fs.unlink(path.join(f.grant.installation,'dxgi.dll'));
 await fs.writeFile(path.join(f.grant.configDirectory!,'SkyrimCustom.ini'),'[Archive]\nsResourceArchiveList=foreign.bsa\n');
 await assert.rejects(planCreationIsolation(f.grant,[],['SkyrimSE.exe']),/archive|unreviewed/i);
}finally{await f.clean();}});
test('Steam first-run INI may reference the absent vanilla Skyrim - Patch.bsa',async()=>{const f=await fixture();try{
 const ini=path.join(f.grant.configDirectory!,'Skyrim.ini');
 const stock=['Skyrim - Voices_en0.bsa',...Array.from({length:9},(_,i)=>`Skyrim - Textures${i}.bsa`)];
 const approved=['SkyrimSE.exe',...stock.map(name=>'Data/'+name)];
 const write=(key:string,archives:string[])=>fs.writeFile(ini,`[Archive]\r\n${key}=${archives.join(', ')}\r\n`);
 const inspect=()=>planCreationIsolation(f.grant,[],approved);
 const archive='Skyrim - Patch.bsa';
 await write('sResourceArchiveList2',[...stock,archive]);
 assert.deepEqual(await inspect(),{quarantine:[],writes:[]});
 await write('sResourceArchiveList2',[...stock,archive,'Unreviewed.bsa']);
 await assert.rejects(inspect(),/Unreviewed archive or asset override/);
 await write('sResourceArchiveList',[archive]);
 await assert.rejects(inspect(),/Unreviewed archive or asset override/);
 await write('sResourceArchiveList2',[...stock,archive]);
 await fs.writeFile(path.join(f.grant.installation,'Data',archive),'unreviewed');
 await assert.rejects(inspect(),/Unreviewed archive or asset override|Unreviewed installation assets/);
}finally{await f.clean();}});
test('root ASI, shader/config inputs and newer indexing files are handled explicitly',async()=>{const f=await fixture();try{
 for(const name of ['SkyrimSE.asi','dxgi.ini']){await fs.writeFile(path.join(f.grant.installation,name),'unreviewed');await assert.rejects(planCreationIsolation(f.grant,[],['SkyrimSE.exe']),/unreviewed/i);await fs.unlink(path.join(f.grant.installation,name));}
 await fs.writeFile(path.join(f.grant.installation,'SkyrimReservedAddOnIndexes.txt'),'new-runtime-index');
 const tx=await RuntimeTransaction.open(f.grant,policy(),async()=>false);await tx.apply(f.source);await assert.rejects(fs.stat(path.join(f.grant.installation,'SkyrimReservedAddOnIndexes.txt')));
 await tx.restore();assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimReservedAddOnIndexes.txt'),'utf8'),'new-runtime-index');
}finally{await f.clean();}});
test('Creation Kit source and editor data can coexist without admitting game overrides',async()=>{const f=await fixture();try{
 const add=async(rel:string)=>{const file=path.join(f.grant.installation,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'test content');return file;};
 const inspect=()=>planCreationIsolation(f.grant,[],['SkyrimSE.exe']);
 const editorFiles=['CreationKit.ini','CreationKitPrefs.ini','Data/DialogueViews/0000081B.xml','Data/Source/Scripts/TestScript.psc','Data/Source/Scripts/TESV_Papyrus_Flags.flg','lex/User/userdic.tlx'];
 for(const rel of editorFiles)await add(rel);
 assert.deepEqual(await inspect(),{quarantine:[],writes:[]});
 for(const rel of ['CreationKit.exe','flowchartx64.dll','Tools/Archive/Archive.exe','Tools/injected.dll','Data/Source/Scripts/Injected.pex','Data/Scripts/Injected.pex','Data/DialogueViews/Injected.esp','Data/CreationKit.bsa']){
  const file=await add(rel);
  await assert.rejects(inspect(),error=>error instanceof Error&&error.message.includes(rel));
  await fs.unlink(file);
 }
 for(const rel of editorFiles)assert.equal(await fs.readFile(path.join(f.grant.installation,rel),'utf8'),'test content');
}finally{await f.clean();}});
test('whole Play records modpack preimages, restores added files and preserves original plugin bytes',async()=>{const f=await fixture();try{
 const p=authenticateRuntimeCohort(cohort({managedFiles:[{path:'Data/example.esp',size:7,sha256:sha('modpack')}],pluginOrder:['example.esp']}),trust,{fixture:true});
 await fs.writeFile(path.join(f.grant.configDirectory!,'plugins.txt'),'# original\r\n');
 const tx=await RuntimeTransaction.open(f.grant,p,async()=>false);await tx.apply(f.source);await tx.beginModpack();
 await fs.writeFile(path.join(f.grant.installation,'Data/example.esp'),'modpack');await tx.completeModpack();
 assert.equal(await fs.readFile(path.join(f.grant.configDirectory!,'plugins.txt'),'utf8'),'*example.esp\r\n');
 await tx.restore();await assert.rejects(fs.stat(path.join(f.grant.installation,'Data/example.esp')),e=>(e as NodeJS.ErrnoException).code==='ENOENT');
 assert.equal(await fs.readFile(path.join(f.grant.configDirectory!,'plugins.txt'),'utf8'),'# original\r\n');
 assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'before');
}finally{await f.clean();}});
test('interrupted modpack cannot be completed with wrong bytes; resume or restore remain safe',async()=>{const f=await fixture();try{
 const p=authenticateRuntimeCohort(cohort({managedFiles:[{path:'Data/example.esp',size:7,sha256:sha('modpack')}],pluginOrder:['example.esp']}),trust,{fixture:true});
 const tx=await RuntimeTransaction.open(f.grant,p,async()=>false);await tx.apply(f.source);await tx.beginModpack();
 await assert.rejects(tx.completeModpack(),/incomplete|integrity/i);
 const recovered=await RuntimeTransaction.forRecovery(f.grant,async()=>false);await recovered.recover();await recovered.restore();
 assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'before');
}finally{await f.clean();}});
test('legitimate zero-byte Engine Fixes marker files retain exact signed identities',async()=>{const f=await fixture();try{
 const p=authenticateRuntimeCohort(cohort({managedFiles:[{path:'Data/EngineFixes_preload.txt',size:0,sha256:sha('')}]}),trust,{fixture:true});
 const tx=await RuntimeTransaction.open(f.grant,p,async()=>false);await tx.apply(f.source);await tx.beginModpack();await fs.writeFile(path.join(f.grant.installation,'Data/EngineFixes_preload.txt'),'');await tx.completeModpack();await tx.restore();await assert.rejects(fs.stat(path.join(f.grant.installation,'Data/EngineFixes_preload.txt')));
}finally{await f.clean();}});
test('verified Steam depot update creates a bounded generation and restores latest pre-normalization runtime',async()=>{const f=await fixture();try{
 const p=policy();let tx=await RuntimeTransaction.open(f.grant,p,async()=>false,{steamStamp:sha('steam-v1')});await tx.apply(f.source);
 await fs.writeFile(path.join(f.grant.installation,'SkyrimSE.exe'),'update');
 tx=await RuntimeTransaction.open(f.grant,p,async()=>false,{steamStamp:sha('steam-v2')});await tx.apply(f.source);assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'target');
 await tx.restore();assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'update');
 assert.equal(await fs.readFile(path.join(f.grant.payloads,'runtime-backups',sha('before')),'utf8'),'before');assert.equal((await fs.readdir(path.join(f.grant.metadata,'runtime-preparation/history'))).length,1);
}finally{await f.clean();}});
test('unchanged Steam depot stamp or managed modpack drift never permits silent overwrite',async()=>{const f=await fixture();try{
 const p=policy();let tx=await RuntimeTransaction.open(f.grant,p,async()=>false,{steamStamp:sha('steam-v1')});await tx.apply(f.source);await fs.writeFile(path.join(f.grant.installation,'SkyrimSE.exe'),'update');
 tx=await RuntimeTransaction.open(f.grant,p,async()=>false,{steamStamp:sha('steam-v1')});await assert.rejects(tx.apply(f.source),/conflict/i);
}finally{await f.clean();}});
test('known generated shader/UI outputs survive preparation while injected cache DLLs are rejected',async()=>{const f=await fixture();try{
 const generated=['Data/ShaderCache/Lighting/ABC.pso','Data/ShaderCache/Info.ini','Data/SKSE/Plugins/CommunityShaders_ImGui.ini','Data/SKSE/Plugins/CommunityShaders/SettingsUser.json'];
 for(const rel of generated){await fs.mkdir(path.dirname(path.join(f.grant.installation,rel)),{recursive:true});await fs.writeFile(path.join(f.grant.installation,rel),'generated');}
 const p=await planCreationIsolation(f.grant,[],['SkyrimSE.exe']);assert.equal(p.quarantine.length,0);
 await fs.writeFile(path.join(f.grant.installation,'Data/ShaderCache/evil.dll'),'injected');await assert.rejects(planCreationIsolation(f.grant,[],['SkyrimSE.exe']),/unreviewed/i);
}finally{await f.clean();}});
test('missing depots are batched into one nonpersistent Steam QR session with aligned manifests',()=>{
 const p=authenticateRuntimeCohort(cohort({depots:[{id:'489831',manifest:'8442952117333549665'},{id:'489832',manifest:'8042843504692938467'},{id:'489833',manifest:'1914580699073641964'}],files:[{path:'Data/Skyrim.esm',size:1,sha256:sha('s'),depot:'489831'},{path:'SkyrimSELauncher.exe',size:1,sha256:sha('l'),depot:'489832'},{path:'SkyrimSE.exe',size:6,sha256:sha('target'),depot:'489833'}]}),trust,{fixture:true});
 const folder=path.resolve('fixture-output'),list=path.resolve('fixture-files.txt');const args=depotRequestArguments(p,p.files.map(f=>f.path),folder,list);
 assert.deepEqual(args.slice(args.indexOf('-depot')+1,args.indexOf('-manifest')),['489831','489832','489833']);assert.deepEqual(args.slice(args.indexOf('-manifest')+1,args.indexOf('-qr')),p.depots.map(d=>d.manifest));assert.equal(args.filter(a=>a==='-qr').length,1);assert.ok(!args.some(a=>/password|username/.test(a)));
 assert.deepEqual(depotRequestArguments(p,['SkyrimSE.exe'],folder,list).slice(3,4),['489833']);
 assert.throws(()=>depotRequestArguments(p,['../outside'],folder,list));
});
test('verified raw download copies are removed without losing target cache or original rollback bytes',async()=>{const f=await fixture();try{
 const p=policy(),key=sha(JSON.stringify({depots:p.depots,files:p.files})),source=path.join(f.grant.payloads,'steam-depots',key,'cohort');await fs.mkdir(source,{recursive:true});await fs.writeFile(path.join(source,'SkyrimSE.exe'),'target');
 const tx=await RuntimeTransaction.open(f.grant,p,async()=>false);await tx.apply(source);await tx.clearAcquiredCopies(source,['SkyrimSE.exe']);await assert.rejects(fs.stat(path.join(source,'SkyrimSE.exe')));assert.deepEqual(await tx.neededPayloads(),[]);await tx.restore();assert.equal(await fs.readFile(path.join(f.grant.installation,'SkyrimSE.exe'),'utf8'),'before');
 await assert.rejects(tx.clearAcquiredCopies(f.source,['SkyrimSE.exe']),/unsafe/i);
}finally{await f.clean();}});
