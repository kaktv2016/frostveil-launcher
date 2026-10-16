import test from 'node:test';import assert from 'node:assert/strict';
import {validateManifest} from '../src/main/updates';import {packFixture} from './pack-fixture';
test('extended V1 supports native external files, multi-file mods and Thai names read-only',()=>{const p=validateManifest(packFixture(),[]);assert.equal(p.files.length,7);});
for(const [name,mutate] of Object.entries({
 unknown:(p:any):void=>{p.surprise=true;},
 schema:(p:any):void=>{p.schemaVersion=2;},
 semver:(p:any):void=>{p.packVersion='1.0';},
 ids:(p:any):void=>{p.components.push({...p.components[0]});},
 case:(p:any):void=>{p.files.push({...p.files[1],path:'data/platform/plugins/RP.js'});},
 hash:(p:any):void=>{p.files[0].sha256='bad';},
 size:(p:any):void=>{p.files[0].size=-1;},
 cycle:(p:any):void=>{p.components[0].dependencies=['rp'];},
 dependency:(p:any):void=>{p.components[0].dependencies=['absent'];},
 traversal:(p:any):void=>{p.files[0].path='Data/../evil';},
 ads:(p:any):void=>{p.files[0].path='Data/a:secret';},
 location:(p:any):void=>{p.files[0].path='Saves/save.ess';},
 role:(p:any):void=>{p.files[0].distribution='allowed';},
 order:(p:any):void=>{p.requiredPlugins.push({...p.requiredPlugins[0],filename:'Other.esp'});},
 missing:(p:any):void=>{delete p.signing;},
 huge:(p:any):void=>{p.components[0].name='x'.repeat(4*1024*1024);},
 unknownFile:(p:any):void=>{p.files[0].command='run';},
 unknownComponent:(p:any):void=>{p.files[0].componentId='absent';}
}))test('V1 refuses '+name,()=>{const p=packFixture();mutate(p);assert.throws(()=>validateManifest(p,[]));});
test('matching native filenames in wrong loader directories cannot represent a client identity',()=>{const p=packFixture();for(const file of p.files.filter((f:any)=>p.skyMPClientRequirements.nativeFiles.includes(f.path)))file.path='Data/Textures/'+file.path.split('/').at(-1);p.skyMPClientRequirements.nativeFiles=p.files.slice(2).map((f:any)=>f.path);assert.throws(()=>validateManifest(p));});
