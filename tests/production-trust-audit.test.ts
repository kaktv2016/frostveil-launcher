import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const script=pathToFileURL(path.resolve('scripts/production-trust-audit.mjs')).href;
const publicKeys={
 launcher:'-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAefA1Vf7n7EuJNWgpa4wl4OyjCPKCpi5KKTZ5QfXSV4M=\n-----END PUBLIC KEY-----\n',
 modpack:'-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAaNHbDEdtpOmB8SWYSETPFln1eGAUjoU+eoYcxyBlhbE=\n-----END PUBLIC KEY-----\n'
};
function configs(){return{
 productionSource:{mode:'production',contentPolicy:'skyrim-mod-content',packId:'frostveil-rp-pack',channel:'stable',permittedReviews:[],keys:{'frostveil-modpack-publisher-20261016':{publicKey:publicKeys.modpack,environment:'production',revoked:false,expiresAt:'2027-10-16T00:00:00.000Z'}}},
 productionLauncherUpdateSource:{mode:'production',owner:'kaktv2016',repo:'frostveil-launcher',channel:'stable',keys:{'frostveil-launcher-update-20261016':{publicKey:publicKeys.launcher,environment:'production',revoked:false,expiresAt:'2027-10-16T00:00:00.000Z'}}}
};}
const bundle=(value:ReturnType<typeof configs>)=>Object.entries(value).map(([name,v])=>'var '+name+' = '+JSON.stringify(v)+';').join('\n');
test('artifact audit accepts exactly the approved independent production fingerprints',async()=>{
 const {assertProductionTrust}=await import(script);assertProductionTrust(bundle(configs()));
});
test('artifact audit rejects cross-channel key substitution and unreviewed extra pins',async()=>{
 const {assertProductionTrust}=await import(script),c=configs();
 c.productionSource.keys['frostveil-modpack-publisher-20261016'].publicKey=publicKeys.launcher;
 assert.throws(()=>assertProductionTrust(bundle(c)));
 const extra=configs();Object.assign(extra.productionSource.keys,{'frostveil-level-b-test-20261015':extra.productionSource.keys['frostveil-modpack-publisher-20261016']});
 assert.throws(()=>assertProductionTrust(bundle(extra)));
});
test('artifact audit rejects missing trust, altered pack identity, revocation and expiry',async()=>{
 const {assertProductionTrust}=await import(script);
 for(const mutate of [(c:any)=>c.productionSource.keys={},(c:any)=>c.productionSource.packId='frostveil',(c:any)=>c.productionLauncherUpdateSource.keys['frostveil-launcher-update-20261016'].revoked=true,(c:any)=>c.productionLauncherUpdateSource.keys['frostveil-launcher-update-20261016'].expiresAt='2026-01-01T00:00:00.000Z']){
  const c=configs();mutate(c);assert.throws(()=>assertProductionTrust(bundle(c)));
 }
});
test('artifact audit does not execute an initializer or accept duplicate trust declarations',async()=>{
 const {assertProductionTrust}=await import(script);
 assert.throws(()=>assertProductionTrust('var productionSource = process.exit(99);'));
 assert.throws(()=>assertProductionTrust(bundle(configs()).replace('};','}.mutate();')));
 assert.throws(()=>assertProductionTrust(bundle(configs())+'var productionSource = {};'));
});
test('shipped source pins pass the same artifact identity audit',async()=>{
 const {assertProductionTrust}=await import(script);
 assertProductionTrust(await fs.readFile('src/main/distribution/policy.ts','utf8')+'\n'+await fs.readFile('src/main/update-integrity.ts','utf8'));
});
