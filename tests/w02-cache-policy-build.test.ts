import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {encodeCacheBoot,verifiedLaterCacheBoot} from '../src/main/runtime/cache-boot';
import {admitPackagedCachePolicy} from '../src/main/runtime/cache-policy';

const scope = {scopeId:'a'.repeat(64), profileId:'b'.repeat(64), cohortDigest:'c'.repeat(64)};
const now = Date.parse('2030-01-01T00:00:00.000Z');
const candidate = {
  schemaVersion:1,
  revision:2,
  ...scope,
  expiresAt:'2030-01-02T00:00:00.000Z',
  reviewAfterMs:86400000,
  volumes:[{volumeId:'volume-a',rawCapBytes:'50000',recoveryBytes:'1000',stagingBytes:'700',helperBytes:'800'}]
};
const seal = (policy:unknown) => {
  const bytes = JSON.stringify(policy);
  return {required:true,revision:2,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
};

test('W02 candidate build binds required policy to exact profile, cohort, roots, revision and volume',()=>{
  const accepted=admitPackagedCachePolicy(seal(candidate),scope,now);
  assert.equal(accepted?.volumes.get('volume-a')?.rawCapBytes,50000n);
  for (const invalid of [
    {required:true,revision:2},
    {...seal(candidate),sha256:'0'.repeat(64)},
    seal({...candidate,revision:1}),
    seal({...candidate,enabled:false}),
    seal({...candidate,scopeId:'d'.repeat(64)}),
    seal({...candidate,profileId:'d'.repeat(64)}),
    seal({...candidate,cohortDigest:'d'.repeat(64)}),
    seal({...candidate,expiresAt:'2029-12-31T00:00:00.000Z'}),
    seal({...candidate,volumes:[...candidate.volumes,...candidate.volumes]}),
    seal({...candidate,volumes:[{...candidate.volumes[0],rawCapBytes:'-1'}]}),
  ]) assert.throws(()=>admitPackagedCachePolicy(invalid,scope,now),/Cache accounting policy/);
  assert.equal(admitPackagedCachePolicy({required:false},scope,now),null);
});

test('W02 restart reconciliation requires a newer boot record from the same host after reservation',()=>{
  const before={hostId:'a'.repeat(64),record:'80',bootMs:1000};
  const serialized=encodeCacheBoot(before);
  assert.equal(verifiedLaterCacheBoot(before,serialized,1200),false);
  assert.equal(verifiedLaterCacheBoot({...before,record:'81',bootMs:1400},serialized,1200),true);
  assert.equal(verifiedLaterCacheBoot({...before,record:'81',bootMs:1100},serialized,1200),false);
  assert.equal(verifiedLaterCacheBoot({...before,record:'79',bootMs:1400},serialized,1200),false);
  assert.equal(verifiedLaterCacheBoot({hostId:'b'.repeat(64),record:'81',bootMs:1400},serialized,1200),false);
});