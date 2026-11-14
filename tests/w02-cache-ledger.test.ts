import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {openCacheAccounting, type CacheReservationInput, type CacheObservedFile} from '../src/main/runtime/cache-ledger';

const scope = 'storage:volume/root-id';
const fixtureTest = process.argv[2]==='--accounting-crash-worker' ? (()=>{}) as typeof test : test;
const digest = 'a'.repeat(64);
const charges = [{volumeId: 'raw', rawBytes: 4096n, helperBytes: 0n}, {volumeId: 'tool', rawBytes: 0n, helperBytes: 64n}];
const evidence = {quiescent: true, censusStable: true, rawRootId: 'target-cache', rawVolumeId: 'raw', observed: charges, hostBootId:'boot-2'} as const;
const image: CacheObservedFile = {path: 'Data/Skyrim.esm', size: 70, sha256: digest, fileId: 'file-1', generation: 'fresh-1', links: 1};

function input(change: Partial<CacheReservationInput> = {}): CacheReservationInput {
  return {
    operationId: randomUUID(), policyId: 'p0-1', profileId: 'steam-english', targetId: 'selected-installation',
    rawRootId: 'target-cache', rawVolumeId: 'raw', cohortDigest: digest, hostBootId:'boot-1',
    requested: [{path: image.path, size: image.size, sha256: image.sha256, depot: '489831', manifest: '8442952117333549665', before: null}],
    charges, beforeAllocated:charges, reviewAfterMs: 100, ...change,
  };
}

async function temp(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fv-w02-cache-ledger-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return directory;
}

fixtureTest('W02 scope lease serializes census, reservation and settlement while leaving existing metadata untouched', async t => {
  const directory = await temp(t), request = input();
  const unrelated = path.join(directory, 'sandbox');
  const ledgerDirectory = path.join(directory, 'cache-accounting');
  await fs.writeFile(unrelated, 'preserved');
  await openCacheAccounting(ledgerDirectory, scope, async ledger => {
    assert.equal(await ledger.readActive(), null);
    await assert.rejects(openCacheAccounting(ledgerDirectory, scope, async () => assert.fail('Overlapping lease')), /lock|lease|writer/i);
    await ledger.reserve(request);
    assert.equal((await ledger.readActive())?.operationId, request.operationId);
    await assert.rejects(ledger.reserve(input()), /active|outstanding/i);
    assert.equal(await ledger.settle(request.operationId, {...evidence, outcome:'verified', files:[image]}), 'verified');
    assert.equal(await ledger.readActive(), null);
    const review = await ledger.review(request.operationId);
    assert.equal(review?.disposition, 'VERIFIED_RETAINED');
    assert.equal(review?.files[0]?.ownership, 'PROVEN');
  });
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'preserved');
  await openCacheAccounting(ledgerDirectory, scope, async ledger => {
    await assert.rejects(ledger.reserve(request), /replay|operation id/i);
  });
});

fixtureTest('W02 active reservations survive restart and require exact independent quiescence and census evidence', async t => {
  const directory = await temp(t), request = input();
  await openCacheAccounting(directory, scope, async ledger => { await ledger.reserve(request); });
  await openCacheAccounting(directory, scope, async ledger => {
    const active = await ledger.readActive();
    assert.deepEqual(active?.charges, charges);
    await assert.rejects(ledger.settle(request.operationId, {...evidence,outcome:'verified',files:[image]}), /independent reconciliation/i);
    await assert.rejects(ledger.reconcile(request.operationId, {...evidence, quiescent: false as never}), /quiescence|independent/i);
    await assert.rejects(ledger.reconcile(request.operationId, {...evidence, hostBootId:'boot-1'}), /boot|quiescence/i);
    await assert.rejects(ledger.reconcile(request.operationId, {...evidence, rawRootId: 'wrong'}), /root|independent/i);
    await assert.rejects(ledger.reconcile(randomUUID(), evidence), /operation|active/i);
    await ledger.reconcile(request.operationId, evidence);
    await assert.rejects(ledger.reconcile(request.operationId, evidence), /operation|active/i);
    assert.equal(await ledger.readActive(), null);
    assert.equal((await ledger.review(request.operationId))?.disposition, 'PROTECTED_UNKNOWN');
    assert.equal((await ledger.review(request.operationId))?.resolution?.quiescence, 'changed-boot');
  });
});

fixtureTest('W02 overrun retains evidence and blocks growth until reconciled', async t => {
  const directory = await temp(t), request = input();
  const observed = charges.map(charge => ({...charge, rawBytes: charge.rawBytes + (charge.volumeId === 'raw' ? 1n : 0n)}));
  await openCacheAccounting(directory, scope, async ledger => {
    await ledger.reserve(request);
    assert.equal(await ledger.settle(request.operationId, {...evidence, observed, outcome:'verified', files:[image]}), 'overrun');
    assert.equal((await ledger.readActive())?.state, 'overrun');
    assert.deepEqual((await ledger.review(request.operationId))?.observed, observed);
    await assert.rejects(ledger.reserve(input()), /active|outstanding/i);
    await ledger.reconcile(request.operationId, {...evidence, observed});
  });
});

fixtureTest('W02 TTL is review-only and reuse cannot claim an unrelated pre-existing or linked file', async t => {
  const directory = await temp(t), request = input({reviewAfterMs: 50});
  await openCacheAccounting(directory, scope, async ledger => {
    const reservation = await ledger.reserve(request);
    assert.equal((await ledger.review(request.operationId, reservation.createdAt + 1000))?.disposition, 'RESERVED');
    await assert.rejects(ledger.settle(request.operationId, {...evidence, outcome:'verified', files:[{...image, links:2}]}), /verified|identity/i);
    await ledger.settle(request.operationId, {...evidence, outcome:'verified', files:[image]});
    const initial = await ledger.review(request.operationId, reservation.createdAt + 1000);
    assert.equal(initial?.disposition, 'REVIEW_DUE');
    await assert.rejects(ledger.recordVerifiedReuse(request.operationId, [{...image, fileId:'substituted'}], true), /reuse|identity/i);
    await ledger.recordVerifiedReuse(request.operationId, [image], false);
    assert.equal((await ledger.review(request.operationId, reservation.createdAt + 1000))?.reviewAt, initial?.reviewAt);
    assert.ok((await ledger.review(request.operationId, reservation.createdAt + 1000))?.files[0]?.ownership === 'PROVEN');
  });
});

fixtureTest('W02 blocks a substituted scope and missing or damaged authenticated state', async t => {
  const directory = await temp(t), request = input();
  await openCacheAccounting(directory, scope, async ledger => { await ledger.reserve(request); });
  await assert.rejects(openCacheAccounting(directory, 'replaced-storage', async () => assert.fail()), /scope/i);
  const head = path.join(directory, 'head.json');
  await fs.writeFile(head, '{"body":"{}","mac":"0"}');
  await assert.rejects(openCacheAccounting(directory, scope, async () => assert.fail()), /metadata|authentication|envelope/i);
  await fs.unlink(head);
  await assert.rejects(openCacheAccounting(directory, scope, async () => assert.fail()), /metadata|missing|ENOENT/i);
});

fixtureTest('W02 dead writer and recovery marker do not prevent exclusive reopen or settle interrupted work', async t => {
  const directory = await temp(t), request = input();
  await openCacheAccounting(directory, scope, async ledger => { await ledger.reserve(request); });
  const {stdout} = await promisify(execFile)(process.execPath, ['-p', 'process.pid'], {windowsHide:true});
  await fs.writeFile(path.join(directory, 'cache-writer.lock'), JSON.stringify({pid:Number(stdout.trim()),token:randomUUID()}), {flag:'wx'});
  const recoveryMarker=path.join(directory, 'cache-reaper.lock');
  const recoveryBytes=JSON.stringify({pid:Number(stdout.trim()),token:randomUUID()});
  await fs.writeFile(recoveryMarker,recoveryBytes,{flag:'wx'});
  await openCacheAccounting(directory, scope, async ledger => {
    assert.equal((await ledger.readActive())?.operationId, request.operationId);
    await assert.rejects(ledger.reserve(input()), /outstanding|active/i);
    await assert.rejects(ledger.reconcile(request.operationId,{...evidence,hostBootId:request.hostBootId}), /boot|quiescence/i);
  });
  assert.equal(await fs.readFile(recoveryMarker,'utf8'),recoveryBytes);
});

fixtureTest('W02 recovers a published authenticated event after crash but refuses a replayed head with later history', async t => {
  const directory = await temp(t), request = input();
  const head = path.join(directory, 'head.json');
  let initial = Buffer.alloc(0);
  await openCacheAccounting(directory, scope, async ledger => {
    initial = await fs.readFile(head);
    await ledger.reserve(request);
  });
  await fs.writeFile(head,initial);
  await openCacheAccounting(directory, scope, async ledger => {
    assert.equal((await ledger.readActive())?.operationId, request.operationId);
    await ledger.reconcile(request.operationId,evidence);
  });
  await fs.writeFile(head,initial);
  await assert.rejects(openCacheAccounting(directory,scope,async () => assert.fail('Replayed head accepted')), /replay/i);
});

fixtureTest('W02 resumes provably empty enrollment after first-use interruption and refuses a missing established anchor',async t=>{
  const root=await temp(t), directory=path.join(root,'ledger');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,'auth-key'),Buffer.alloc(32,0x46),{flag:'wx'});
  await openCacheAccounting(directory,scope,async ledger=>{
    assert.equal(await ledger.readActive(),null);
    await ledger.reserve(input());
  });
  const anchor=directory+'.anchor';
  const bytes=await fs.readFile(anchor);
  await fs.rename(anchor,anchor+'.fixture-kept');
  await assert.rejects(openCacheAccounting(directory,scope,async()=>assert.fail()),/anchor/i);
  assert.deepEqual(await fs.readFile(anchor+'.fixture-kept'),bytes);
});
fixtureTest('W02 a second process can reopen accounting after the owner is terminated inside the lease',async t=>{
  const directory=await temp(t), request=input(), worker=path.join(directory,'accounting-crash-worker.json');
  const bytes=JSON.stringify(request,(_key,value)=>typeof value==='bigint'?value.toString()+'n':value);
  await fs.writeFile(worker,bytes,{flag:'wx'});
  const child=spawn(process.execPath,[__filename,'--accounting-crash-worker',path.join(directory,'ledger'),worker],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const close=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});
  t.after(async()=>{if(child.exitCode===null&&!child.killed)child.kill();await close;});
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Timed out waiting for fixture reservation')),5000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('W02_RESERVED')){clearTimeout(timer);resolve();}});
    close.then(()=>{clearTimeout(timer);reject(Error('Fixture process exited before reservation'));},reject);
  });
  await assert.rejects(openCacheAccounting(path.join(directory,'ledger'),scope,async()=>assert.fail()),/lock|lease|writer/i);
  assert.equal(child.kill('SIGKILL'),true);
  await close;
  await openCacheAccounting(path.join(directory,'ledger'),scope,async ledger=>{
    assert.equal((await ledger.readActive())?.operationId,request.operationId);
    await assert.rejects(ledger.reconcile(request.operationId,{...evidence,hostBootId:request.hostBootId}),/boot|quiescence/i);
  });
});

if(process.argv[2]==='--accounting-crash-worker'){
  void (async()=>{
    const [directory,file]=process.argv.slice(3);
    assert.ok(directory&&file);
    const request=JSON.parse(await fs.readFile(file,'utf8'),(_key,value)=>
      typeof value==='string'&&/^\d+n$/.test(value)?BigInt(value.slice(0,-1)):value) as CacheReservationInput;
    await openCacheAccounting(directory,scope,async ledger=>{
      await ledger.reserve(request);
      console.log('W02_RESERVED');
      await new Promise(resolve=>setTimeout(resolve,8000));
    });
  })().catch(error=>{console.error(error);process.exit(1);});
}