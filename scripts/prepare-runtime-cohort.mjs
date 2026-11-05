// Offline operator entry: reuse the existing production identity, never mint keys.
// No upload; the signed candidate still requires the cold transaction/release gates.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';import {createRequire} from 'node:module';import {build} from 'esbuild';
const out=path.resolve('.local/runtime-normalization'),read=async name=>JSON.parse(await fs.readFile(path.join(out,name),'utf8'));
const receiptBytes=await fs.readFile(path.join(out,'acquisition-receipt.json')),receipt=JSON.parse(receiptBytes),bootstrap=await read('bootstrap-result.json');
assert.equal(bootstrap.passed,true);assert.equal(bootstrap.finalScanReady,true);assert.equal(bootstrap.installedGameWrites,0);assert.equal(bootstrap.skyrimLaunched,false);
assert.equal(receipt.runtime,'1.6.1170.0');assert.equal(receipt.depots.length,3);assert.ok(receipt.depots.every(d=>d.exitCode===0));
await build({stdin:{contents:"export {authenticateRuntimeCohort} from './src/main/runtime/policy';export {productionSource} from './src/main/distribution/policy';export {helperPin} from './src/main/runtime/depot';export {hashFile,safeFile} from './src/main/files';",resolveDir:process.cwd()},outfile:path.join(out,'cohort-core.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external'});
const core=createRequire(import.meta.url)(path.join(out,'cohort-core.cjs'));
assert.deepEqual(await core.hashFile(path.join(out,'tools/depot-3.4.0/DepotDownloader.exe'),100*1024**2),{size:core.helperPin.size,sha256:core.helperPin.sha256});
for(const file of bootstrap.managedFiles)assert.deepEqual(await core.hashFile(await core.safeFile(bootstrap.game,file.path),8*1024**3),{size:file.size,sha256:file.sha256});
const privateKey=createPrivateKey(await fs.readFile(path.join(os.homedir(),'.codex/frostveil-signing/production-candidates-20261016/modpack-publisher-private.pem'))),keyId='frostveil-modpack-publisher-20261016';
assert.equal(createPublicKey(privateKey).export({format:'pem',type:'spki'}).toString(),core.productionSource.keys[keyId].publicKey);
const now=Date.now(),createdAt=new Date(now).toISOString(),expiresAt=new Date(now+7*86400000).toISOString();
const policy={schemaVersion:1,kind:'frostveil-steam-runtime',runtime:'1.6.1170.0',appId:'489830',language:'english',createdAt,expiresAt,depots:receipt.depots.map(d=>({id:d.id,manifest:d.manifest})),files:receipt.files,creations:bootstrap.creations,managedFiles:bootstrap.managedFiles,pluginOrder:bootstrap.pluginOrder,configuration:bootstrap.configuration,helper:{version:core.helperPin.version,size:core.helperPin.size,sha256:core.helperPin.sha256},acquisition:{verified:true,receiptSha256:createHash('sha256').update(receiptBytes).digest('hex')}};
const payload=Buffer.from(JSON.stringify(policy)),envelope={keyId,payloadBase64:payload.toString('base64'),signatureBase64:sign(null,payload,privateKey).toString('base64')};
const verified=core.authenticateRuntimeCohort(envelope);assert.equal(verified.runtime,'1.6.1170.0');
const bytes=Buffer.from(JSON.stringify(envelope,null,2)+'\n');await fs.writeFile(path.join(out,'runtime-candidate.json'),bytes);
await fs.writeFile(path.join(out,'cohort-candidate-receipt.json'),JSON.stringify({signed:true,publisher:keyId,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),expiresAt,files:policy.files.length,managedFiles:policy.managedFiles.length,installationWrites:0,published:false},null,2));
console.log(JSON.stringify({signed:true,files:policy.files.length,managedFiles:policy.managedFiles.length,expiresAt,published:false}));
