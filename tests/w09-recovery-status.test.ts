import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {createManagedFixture} from '../src/main/installer/managed-target';
import {RuntimePreparation} from '../src/main/runtime/service';
import type {RuntimePreparationState} from '../src/shared/runtime-contracts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(t: TestContext) {
  const root = await createManagedFixture();
  t.after(() => fs.rm(root.directory, {recursive: true, force: true}));
  const storage = path.join(root.directory, 'launcher-storage');
  const other = path.join(root.directory, 'other-installation');
  const absent = path.join(root.directory, 'absent-profile');
  await fs.mkdir(other);
  const game = await fs.realpath(root.installation);
  const config = await fs.realpath(root.configDirectory!);
  const registry = path.join(storage, 'managed-installations', sha(game.toLowerCase() + '\n' + config.toLowerCase()));
  const metadata = path.join(registry, 'metadata');
  const payloads = path.join(registry, 'packages');
  await fs.mkdir(path.join(metadata, 'runtime-preparation'), {recursive: true});
  await fs.mkdir(payloads);
  const roots: Record<string, string> = {};
  for (const folder of [registry, game, path.join(game, 'Data'), config, metadata, payloads]) {
    const info = await fs.lstat(folder, {bigint: true});
    roots[folder] = info.dev + ':' + info.ino;
  }
  const installationId = randomUUID();
  const key = Buffer.alloc(32, 41);
  await fs.writeFile(path.join(metadata, 'auth-key'), key);
  const sign = (value: unknown) => {
    const body = JSON.stringify(value);
    return JSON.stringify({body, mac: createHmac('sha256', key).update(body).digest('hex')});
  };
  await fs.writeFile(path.join(metadata, 'sandbox.json'), sign({
    targetClass: 'real-skyrim', directory: registry, installation: game, configDirectory: config, metadata, payloads,
    id: installationId, roots,
  }));
  const journalPath = path.join(metadata, 'runtime-preparation', 'journal.json');
  const journal = {
    schemaVersion: 2, installationId, policyHash: sha('fixture policy'), state: 'applying',
    files: [{path: '@config/plugins.txt', writer: 'profile', before: null, after: {size: 1, sha256: sha('x')}}],
    wholePlay: {cohortId: sha('fixture cohort'), directories: []},
  };
  const seed = (value: unknown = journal) => fs.writeFile(journalPath, sign(value));
  class LocalOnly extends RuntimePreparation {
    protected override async runtimeTarget(): Promise<never> { throw Error('unexpected Steam or fixture target provisioning'); }
    protected override async loadPolicy(): Promise<never> { throw Error('unexpected runtime policy request'); }
    protected override async acquire(): Promise<never> { throw Error('unexpected payload acquisition'); }
  }
  const service = new LocalOnly(storage, 'unused');
  return {service, game, config, other, absent, metadata, journalPath, journal, seed};
}

test('local recovery status binds the selected installation and does not modify its journal or absent profile', async t => {
  const f = await fixture(t);
  await f.seed();
  const before = await fs.readFile(f.journalPath);
  const original = await fs.stat(f.journalPath, {bigint: true});
  const states: RuntimePreparationState[] = [];
  const unsubscribe = f.service.subscribe(state => states.push(state));
  t.after(unsubscribe);
  await f.service.refreshRecovery(f.game, f.config);
  const first = f.service.snapshot();
  assert.equal(first.recovery, 'recoverable');
  assert.equal(first.canRestore, true);
  assert.equal(first.recoveryRequired, true);
  await f.service.refreshRecovery(f.other, f.config);
  const second = f.service.snapshot();
  assert.equal(second.recovery, 'foreign');
  assert.equal(second.canRestore, false);
  assert.ok(second.selectionRevision! > first.selectionRevision!);
  await f.service.refreshRecovery(f.game, f.config);
  assert.equal(f.service.snapshot().canRestore, true);
  assert.ok(states.some(state => state.recovery === 'checking' && !state.canRestore));
  assert.ok(states.every((state, index) => index === 0 || state.revision! > states[index - 1]!.revision!));
  assert.deepEqual(await fs.readFile(f.journalPath), before);
  assert.equal((await fs.stat(f.journalPath, {bigint: true})).ino, original.ino);
  await f.seed({...f.journal, state: 'restored'});
  await f.service.refreshRecovery(f.game, f.absent);
  assert.equal(f.service.snapshot().canRestore, false);
  await assert.rejects(fs.stat(f.absent), {code: 'ENOENT'});
});

test('authenticated malformed journal paths, body, and identity never enable Restore', async t => {
  const f = await fixture(t);
  const malformed = [
    {...f.journal, files: [{...f.journal.files[0], path: '../outside.ini'}]},
    {...f.journal, wholePlay: {cohortId: sha('fixture cohort'), directories: [{path: '../outside', owned: true, identity: null}]}},
    {...f.journal, installationId: randomUUID()},
    {...f.journal, policyHash: [f.journal.policyHash]},
    {...f.journal, wholePlay: {...f.journal.wholePlay, cohortId: [f.journal.wholePlay.cohortId]}},
    {...f.journal, files: []},
    {...f.journal, files: [{...f.journal.files[0], path: 'Data/sub/file.ini', writer: 'pack', kind: 'modpack'}]},
  ];
  for (const record of malformed) {
    await f.seed();
    await f.service.refreshRecovery(f.game, f.config);
    assert.equal(f.service.snapshot().canRestore, true);
    await f.seed(record);
    const before = await fs.readFile(f.journalPath);
    await f.service.refreshRecovery(f.game, f.config);
    const status = f.service.snapshot();
    assert.equal(status.recovery, 'unsafe');
    assert.equal(status.canRestore, false);
    assert.equal(status.authQr, undefined);
    assert.deepEqual(await fs.readFile(f.journalPath), before);
  }
});

test('late recovery completion does not replace the current target', async t => {
  const f = await fixture(t);
  await f.seed();
  const earlier = f.service.refreshRecovery(f.game, f.config);
  const later = f.service.refreshRecovery(f.other, f.config);
  await Promise.all([earlier, later]);
  const selected = f.service.snapshot();
  assert.equal(selected.recovery, 'foreign');
  assert.equal(selected.canRestore, false);
});
