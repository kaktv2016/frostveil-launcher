import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decodeGraphicsSourcePlan} from '../src/main/graphics-source-plan';
const payload=Buffer.from(JSON.stringify({version:'1.0.7',files:[]}));
const pin={size:payload.length,sha256:createHash('sha256').update(payload).digest('hex')};

test('terrain restore recipe 1.0.16 retains exact hash authentication',()=>{
 const bytes=Buffer.from(JSON.stringify({version:'1.0.16',files:[]})),identity={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 assert.equal(decodeGraphicsSourcePlan(bytes,identity).version,'1.0.16');
 assert.throws(()=>decodeGraphicsSourcePlan(Buffer.from(bytes.toString().replace('1.0.16','1.0.17')),identity),/hash/i);
});
test('source recipe must match bundled content hash before use',()=>{
 assert.equal(decodeGraphicsSourcePlan(payload,pin).version,'1.0.7');
 assert.throws(()=>decodeGraphicsSourcePlan(Buffer.from(payload.toString().replace('1.0.7','1.0.8')),pin),/hash|identity/i);
 assert.throws(()=>decodeGraphicsSourcePlan(payload.subarray(1),pin),/hash|identity/i);
});

test('navigation recipe 1.0.13 is accepted only with its exact bundled hash',()=>{
 const bytes=Buffer.from(JSON.stringify({version:'1.0.13',files:[]})),identity={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 assert.equal(decodeGraphicsSourcePlan(bytes,identity).version,'1.0.13');
 assert.throws(()=>decodeGraphicsSourcePlan(Buffer.from(bytes.toString().replace('1.0.13','1.0.14')),identity),/hash/i);
});

test('container repair recipe 1.0.14 retains exact hash authentication',()=>{
 const bytes=Buffer.from(JSON.stringify({version:'1.0.14',files:[]})),identity={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 assert.equal(decodeGraphicsSourcePlan(bytes,identity).version,'1.0.14');
 assert.throws(()=>decodeGraphicsSourcePlan(Buffer.from(bytes.toString().replace('1.0.14','1.0.15')),identity),/hash/i);
});
