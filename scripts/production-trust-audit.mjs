// Parse literal trust declarations from the actual shipped bundle without executing it.
import assert from 'node:assert/strict';
import {createHash,createPublicKey} from 'node:crypto';
const expected={
 productionSource:{keyId:'frostveil-modpack-publisher-20261016',fingerprint:'7eded189b364ffc31c5c9730c7b73c0b13424b60576313a0197a6327b5633369'},
 productionLauncherUpdateSource:{keyId:'frostveil-launcher-update-20261016',fingerprint:'44b402b99394515908c10c72d2e6e77ad210a1b36248e5bafe991b59183b0fea'}
};
// A deliberately narrow data grammar: objects, arrays, strings, booleans only.
// Never eval/vm/import the shipped main bundle. Expressions/accessors/spreads and
// computed keys are rejected. No compiler API or extra dependency is required.
function literal(text,start){
 let index=start,nodes=0;
 function skip(){for(;;){const m=/^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(text.slice(index));if(!m)return;index+=m[0].length;}}
 function quoted(){
  const remaining=text.slice(index),double=/^"(?:[^"\\\r\n]|\\.)*"/.exec(remaining);
  if(double){index+=double[0].length;return JSON.parse(double[0]);}
  const single=/^'[^'\\\r\n]*'/.exec(remaining);assert.ok(single,'Unsupported trust string literal');
  index+=single[0].length;return single[0].slice(1,-1);
 }
 function read(depth=0){
  assert.ok(++nodes<1000&&depth<12,'Trust literal exceeds bounds');skip();const ch=text[index];
  if(ch==='"'||ch==="'")return quoted();
  if(text.startsWith('true',index)){index+=4;return true;}
  if(text.startsWith('false',index)){index+=5;return false;}
  assert.ok(ch==='{'||ch==='[','Trust configuration must contain literal data');index++;
  const array=ch==='[',end=array?']':'}',value=array?[]:Object.create(null);skip();
  while(text[index]!==end){
   if(array)value.push(read(depth+1));
   else{
    skip();let name;
    if(text[index]==='"'||text[index]==="'")name=quoted();
    else{const m=/^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(index));assert.ok(m,'Dynamic trust property');name=m[0];index+=name.length;}
    skip();assert.equal(text[index++],':','Trust property must be a data assignment');
    assert.equal(Object.hasOwn(value,name),false,'Duplicate trust property');value[name]=read(depth+1);
   }
   skip();if(text[index]===end)break;assert.equal(text[index++],',','Invalid trust literal separator');skip();
  }
  index++;return value;
 }
 const result=read();skip();assert.equal(text[index],';','Trust initializer must end as a literal declaration');return result;
}
export function assertProductionTrust(text){
 const values=new Map(),declarations=/\b(?:var|let|const)\s+(productionSource|productionLauncherUpdateSource)(?:\s*:[^=;\n]+)?\s*=\s*/g;
 for(const match of text.matchAll(declarations)){
  assert.equal(values.has(match[1]),false,'Duplicate production trust declaration');
  values.set(match[1],literal(text,match.index+match[0].length));
 }
 assert.equal(values.size,2,'Both production trust declarations must be present');
 for(const [name,pin] of Object.entries(expected)){
  const config=values.get(name);assert.equal(config.mode,'production');assert.equal(config.channel,'stable');
  assert.deepEqual(Object.keys(config.keys),[pin.keyId],'Unexpected production publisher set');
  const key=config.keys[pin.keyId];assert.equal(key.environment,'production');assert.equal(key.revoked,false);
  assert.equal(key.expiresAt,'2027-10-16T00:00:00.000Z');assert.ok(Date.parse(key.expiresAt)>Date.now(),'Expired production key');
  const publicKey=createPublicKey(key.publicKey);assert.equal(publicKey.asymmetricKeyType,'ed25519');
  assert.equal(createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex'),pin.fingerprint,'Unapproved production public fingerprint');
 }
 const pack=values.get('productionSource'),launcher=values.get('productionLauncherUpdateSource');
 assert.equal(pack.packId,'frostveil-rp-pack');assert.equal(pack.contentPolicy,'skyrim-mod-content');
 assert.deepEqual(pack.permittedReviews,[],'No third-party redistribution permission was approved');
 assert.equal(launcher.owner,'kaktv2016');assert.equal(launcher.repo,'frostveil-launcher');
 return Object.fromEntries(Object.entries(expected).map(([name,pin])=>[name,{...pin,verified:true}]));
}
