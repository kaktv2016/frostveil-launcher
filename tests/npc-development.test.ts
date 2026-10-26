import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {createHash}from'node:crypto';
import {createManagedFixture}from'../src/main/installer/managed-target';
import {NpcDevelopmentProfile}from'../src/main/management/npc-development';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function fixture(running=async()=>false){const g=await createManagedFixture();const plugin=Buffer.alloc(24);plugin.write('TES4');
 const files=['FrostveilNPCTest.esp',...['00005901','00005906'].flatMap(n=>['meshes/actors/character/FaceGenData/FaceGeom/FrostveilNPCTest.esp/'+n+'.nif','textures/actors/character/FaceGenData/FaceTint/FrostveilNPCTest.esp/'+n+'.dds'])];
 const assets=[];for(const f of files){const b=f.endsWith('.esp')?plugin:Buffer.from(f);await fs.mkdir(path.dirname(path.join(g.installation,'Data',f)),{recursive:true});await fs.writeFile(path.join(g.installation,'Data',f),b);assets.push({path:'Data/'+f,size:b.length,sha256:hash(b)});}
 for(const name of ['Skyrim.esm','Update.esm','Dawnguard.esm','HearthFires.esm','Dragonborn.esm'])await fs.writeFile(path.join(g.installation,'Data',name),plugin);
 await fs.writeFile(path.join(g.configDirectory!,'plugins.txt'),'# owner\r\n');await fs.mkdir(path.join(g.installation,'Data/Platform/Plugins'),{recursive:true});await fs.writeFile(path.join(g.installation,'Data/Platform/Plugins/skymp5-client-settings.txt'),JSON.stringify({'server-ip':'127.0.0.1','server-port':7777,master:'','server-master-key':null,gameData:{profileId:1}}));
 const policy={version:1 as const,catalogHash:'a'.repeat(64),assets,runtime:[]};
 const profile=await NpcDevelopmentProfile.open(g,policy,running);return{g,profile,policy};}
test('local-only profile pins existing files, deliberately activates and restores exact two-file configuration',async()=>{
 const {g,profile}=await fixture();const original=await fs.readFile(path.join(g.configDirectory!,'plugins.txt'));
 const plan=await profile.prepare();assert.equal(plan.source,'LOCAL OWNED REFERENCE ONLY');await assert.rejects(profile.activate(plan,async()=>false),/declined/);
 await profile.activate(plan,async()=>true);assert.equal((await profile.status()).active,true);assert.match(await fs.readFile(path.join(g.configDirectory!,'plugins.txt'),'utf8'),/\*FrostveilNPCTest.esp/);
 assert.equal(JSON.parse(await fs.readFile(path.join(g.installation,'Data/Platform/Plugins/skymp5-client-settings.txt'),'utf8'))['server-port'],17777);
 await profile.activate(plan,async()=>true);await profile.revert(async()=>true);assert.deepEqual(await fs.readFile(path.join(g.configDirectory!,'plugins.txt')),original);assert.equal((await profile.status()).active,false);
});
test('tampered plan, changed source asset and changed original configuration fail before writes',async()=>{
 const {g,profile}=await fixture();const p=await profile.prepare();await assert.rejects(profile.activate({...p,digest:'f'.repeat(64)},async()=>true));
 await fs.appendFile(path.join(g.installation,'Data/FrostveilNPCTest.esp'),'bad');await assert.rejects(profile.activate(p,async()=>true),/asset/i);
});
test('revert refuses to overwrite a subsequent owner edit; evidence survives',async()=>{
 const {g,profile}=await fixture();await profile.activate(await profile.prepare(),async()=>true);const f=path.join(g.configDirectory!,'plugins.txt');await fs.appendFile(f,'# later owner edit');await assert.rejects(profile.revert(async()=>true),/changed|conflict/i);assert.match(await fs.readFile(f,'utf8'),/later owner edit/);
});
test('a game starting during activation leaves a bounded recoverable journal; closed-game revert restores originals',async()=>{
 let during=false,calls=0;const {g,profile}=await fixture(async()=>during&&++calls>=3);const before=await fs.readFile(path.join(g.configDirectory!,'plugins.txt'));
 const p=await profile.prepare();during=true;await assert.rejects(profile.activate(p,async()=>true),/started/);during=false;assert.equal((await profile.status()).state,'recovery-required');await profile.revert(async()=>true);assert.deepEqual(await fs.readFile(path.join(g.configDirectory!,'plugins.txt')),before);
});
test('external edits after preparation and unauthenticated journal changes cannot activate',async()=>{
 const {g,profile}=await fixture();const plan=await profile.prepare();await fs.appendFile(path.join(g.configDirectory!,'plugins.txt'),'# owner changed');await assert.rejects(profile.activate(plan,async()=>true),/changed|conflict/);
 const journal=path.join(g.metadata,'npc-development/journal.json');const raw=JSON.parse(await fs.readFile(journal,'utf8'));raw.body=raw.body.replace('prepared','active');await fs.writeFile(journal,JSON.stringify(raw));await assert.rejects(profile.status(),/authentication/);
});
