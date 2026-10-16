import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {freezePlan,planDigest,PlanAuthorizer} from '../src/main/management/authorization';
import {managedContentTarget} from '../src/main/management/content-policy';

const plan=()=>({installationId:'fixture-only',intent:'install',operations:[{path:'Data/Frostveil/config.json',sha256:'a'.repeat(64),original:null}]});

test('plan snapshot cannot be changed through its source or nested references',()=>{
 const source=plan(),snapshot=freezePlan(source);
 source.operations[0]!.sha256='b'.repeat(64);
 assert.equal(snapshot.operations[0]!.sha256,'a'.repeat(64));
 assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.operations)&&Object.isFrozen(snapshot.operations[0]));
 assert.throws(()=>{(snapshot.operations[0] as any).sha256='c'.repeat(64);},TypeError);
});

test('plan digest authenticates canonical sorted JSON bytes and ordered operations',()=>{
 const expected=createHash('sha256').update('{"a":[{"x":1,"y":2}],"z":3}').digest('hex');
 assert.equal(planDigest({z:3,a:[{y:2,x:1}]}),expected);
 assert.notEqual(planDigest({operations:['a','b']}),planDigest({operations:['b','a']}));
});

test('non-JSON plans cannot hide unauthenticated values or execute getters',()=>{
 let getterCalled=false;
 const accessor=Object.defineProperty({},'target',{enumerable:true,get(){getterCalled=true;return 'changed';}});
 const cycle:any={};cycle.self=cycle;
 for(const invalid of [undefined,NaN,Infinity,1n,()=>true,{lost:undefined},{lost:()=>true},new Date(),new Map(),accessor,cycle,[,],{[Symbol('hidden')]:true}]){
  assert.throws(()=>freezePlan(invalid));
  assert.throws(()=>planDigest(invalid));
 }
 assert.equal(getterCalled,false);
});

test('authorization confirms an immutable snapshot and consumes its opaque token once',async()=>{
 const source=plan();let reviewed:unknown,reviewedHash='';
 const authorizer=new PlanAuthorizer(async(value,hash)=>{reviewed=value;reviewedHash=hash;return true;});
 const token=await authorizer.request(source);
 assert.deepEqual(reviewed,source);assert.notEqual(reviewed,source);
 assert.equal(reviewedHash,planDigest(source));
 assert.deepEqual(Object.keys(token),[]);assert.ok(Object.isFrozen(token));
 authorizer.consume(structuredClone(source),token);
 assert.throws(()=>authorizer.consume(source,token),/authorization|token|consumed/i);
});

test('forged, serialized and other-authorizer tokens cannot authorize a plan',async()=>{
 const source=plan(),first=new PlanAuthorizer(async()=>true),second=new PlanAuthorizer(async()=>true),token=await first.request(source);
 for(const forged of [{},JSON.parse(JSON.stringify(token)),Object.create(token)])assert.throws(()=>first.consume(source,forged));
 assert.throws(()=>second.consume(source,token));
 first.consume(source,token);
});

test('changed plans are rejected and cannot reuse their burned token',async()=>{
 const source=plan(),authorizer=new PlanAuthorizer(async()=>true),token=await authorizer.request(source);
 const changed=structuredClone(source);changed.operations[0]!.path='Data/Frostveil/other.json';
 assert.throws(()=>authorizer.consume(changed,token),/plan|authorization/i);
 assert.throws(()=>authorizer.consume(source,token));
});

test('plan changes while confirmation is pending invalidate authorization',async()=>{
 const source=plan(),authorizer=new PlanAuthorizer(async()=>{source.operations[0]!.sha256='b'.repeat(64);return true;});
 await assert.rejects(()=>authorizer.request(source),/changed|plan/i);
});

test('cancellation and confirmation errors issue no authorization',async()=>{
 await assert.rejects(()=>new PlanAuthorizer(async()=>false).request(plan()),/declined|cancel|authorization/i);
 await assert.rejects(()=>new PlanAuthorizer(async()=>{throw Error('native dialog unavailable');}).request(plan()));
 await assert.rejects(()=>new PlanAuthorizer(async()=>1 as any).request(plan()));
});

test('authorization expires at its deadline and rejects a clock moving backwards',async()=>{
 let current=1000;const authorizer=new PlanAuthorizer(async()=>true,100,()=>current),source=plan();
 const valid=await authorizer.request(source);current=1099;authorizer.consume(source,valid);
 const expired=await authorizer.request(source);current=1199;assert.throws(()=>authorizer.consume(source,expired),/expired|authorization/i);
 const backwards=await authorizer.request(source);current=1198;assert.throws(()=>authorizer.consume(source,backwards));
});

test('authorization defaults to two minutes and never accepts a TTL above five minutes',async()=>{
 let current=10;const source=plan(),authorizer=new PlanAuthorizer(async()=>true,undefined,()=>current),token=await authorizer.request(source);
 current=120010;assert.throws(()=>authorizer.consume(source,token));
 for(const ttl of [0,-1,300001,NaN,Infinity])assert.throws(()=>new PlanAuthorizer(async()=>true,ttl));
 const maximum=new PlanAuthorizer(async()=>true,300000,()=>current),maximumToken=await maximum.request(source);
 current+=300000;assert.throws(()=>maximum.consume(source,maximumToken));
});

for(const target of [
 'Data/Frostveil.esm','Data/Frostveil.esp','Data/Frostveil.bsa',
 'Data/Meshes/Frostveil/armor.nif','Data/Meshes/Frostveil/head.tri','Data/Meshes/Frostveil/idle.hkx',
 'Data/Textures/Frostveil/armor.dds','Data/Textures/Frostveil/banner.png','Data/Textures/Frostveil/icon.tga',
 'Data/Interface/Frostveil/menu.swf','Data/Interface/Frostveil/menu.xml','Data/Interface/Frostveil/menu.html',
 'Data/Interface/Frostveil/menu.css','Data/Interface/Frostveil/menu.json','Data/Interface/Frostveil/menu.png',
 'Data/Scripts/FrostveilQuest.pex','Data/Scripts/Source/FrostveilQuest.psc',
 'Data/Sound/Voice/Frostveil/line.fuz','Data/Sound/Frostveil/step.wav','Data/Sound/Frostveil/step.xwm',
 'Data/Music/Frostveil/theme.mp3','Data/Music/Frostveil/theme.ogg',
 'Data/Frostveil/launcher.ini','Data/Frostveil/settings.json','Data/Frostveil/readme.txt'
])test('managed mod content permits '+target,()=>assert.equal(managedContentTarget(target),target));

for(const target of [
 '../Data/Frostveil.esp','/Data/Frostveil.esp','C:/Games/Data/Frostveil.esp','//server/share/Data/Frostveil.esp',
 'Data\\Frostveil.esp','Data//Frostveil.esp','Data/./Frostveil.esp','Data/../Frostveil.esp',
 'Data/%2e%2e/Frostveil.esp','Data/%2fFrostveil.esp','Data/%252e%252e/Frostveil.esp','Data/Frostveil%2eesp',
 'Data/Textures/Frostveil/CON.dds','Data/Textures/Frostveil/lpt1.dds','Data/Textures/Frostveil/foo.dds.',
 'Data/Textures/Frostveil/foo.dds ','Data/Textures/Frostveil/foo:stream.dds','Data/Textures/Frostveil/Ａ.dds',
 'Data/Skyrim.esm','Data/UPDATE.ESM','Data/Dawnguard.esm','Data/HearthFires.esm','Data/Dragonborn.esm',
 'Data/Skyrim - Meshes0.bsa','Data/Skyrim - Textures9.bsa','Data/Update.bsa','Data/Dawnguard.bsa',
 'Data/HearthFires.bsa','Data/Dragonborn.bsa','Data/ccBGSSSE001-Fish.esm','Data/ccAsset.bsa',
 'Data/Frostveil.esl','Data/Plugins/Frostveil.esp','Data/SKSE/Plugins/Frostveil.dll',
 'Data/Platform/UI/frostveil-sandbox/notice.txt','Data/Platform/Plugins/Frostveil.js',
 'Data/SkyrimPlatformRuntimeDependencies/foo.bin','SkyrimSE.exe','skse64_loader.exe',
 'Data/Frostveil/tool.exe','Data/Interface/tool.dll','Data/Meshes/tool.bin','Data/Scripts/tool.js',
 'Data/Textures/tool.dll.png','Data/Meshes/tool.exe.nif','Data/Scripts/Source/tool.bat.psc',
 'Data/Steam/steam_api64.dll','Data/Frostveil/readme.md','Data/Frostveil/foo.ps1','Data/Frostveil/plugins.txt/child.json',
 'Data/Textures/Frostveil/foo\u0000.dds','data/Textures/Frostveil/foo.dds/','Data/Frostveil/ config.json'
])test('managed mod content rejects '+JSON.stringify(target),()=>assert.throws(()=>managedContentTarget(target)));

test('managed content policy rejects non-path inputs',()=>{
 for(const value of [null,undefined,{},1,Buffer.from('Data/Frostveil.esp')])assert.throws(()=>managedContentTarget(value));
});
