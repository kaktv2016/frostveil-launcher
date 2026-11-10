import assert from 'node:assert/strict';
import {createHash, sign} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {discoverSteam} from '../src/main/discovery';
import {contained} from '../src/main/files';
import {MetadataStore} from '../src/main/installer/metadata';
import {RuntimePreparation} from '../src/main/runtime/service';
import {verifySteamSelection} from '../src/main/runtime/steam';
import {canonicalTemporaryRoot} from '../src/main/temporary-root';
import type {RuntimeCohort} from '../src/main/runtime/policy';
import type {RuntimePreparationState} from '../src/shared/runtime-contracts';
import {bindFixture, fixtureKeys} from './w03-provider-boundaries';

declare const W03_ISOLATED_PROVIDER_BUNDLE: boolean;
assert.ok(typeof W03_ISOLATED_PROVIDER_BUNDLE !== 'undefined' && W03_ISOLATED_PROVIDER_BUNDLE, 'W03 requires its isolated test bundle');

const depots = [
  {id: '489831', manifest: '8442952117333549665'},
  {id: '489832', manifest: '8042843504692938467'},
  {id: '489833', manifest: '1914580699073641964'}
];
const payloads = [
  {path: 'Data/Skyrim.esm', depot: '489831'},
  {path: 'Data/Update.esm', depot: '489831'},
  {path: 'Data/Dawnguard.esm', depot: '489831'},
  {path: 'Data/HearthFires.esm', depot: '489831'},
  {path: 'Data/Dragonborn.esm', depot: '489831'},
  {path: 'Data/Skyrim - Voices_en0.bsa', depot: '489832'},
  {path: 'SkyrimSELauncher.exe', depot: '489833'},
  {path: 'SkyrimSE.exe', depot: '489833'}
].map(f => ({...f, original: Buffer.from('W03 original '+f.path), target: Buffer.from('W03 target '+f.path)}));
const files = payloads.map(f => ({path: f.path, size: f.target.length, sha256: sha(f.target), depot: f.depot}));
const partialFile = files.find(f => f.depot === '489832')!;
const helperBytes = Buffer.from('W03 inert helper marker');
const gameName = 'Skyrim Special Edition';
const policyUrl = 'https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/runtime/steam-1170.json';
const depotsDigest = sha(JSON.stringify({depots, files}));
const qr = ('  ██  ██  \n').repeat(25)+'\n';

function sha(bytes: Buffer | string) { return createHash('sha256').update(bytes).digest('hex'); }
function envelope(policy: RuntimeCohort) {
  const bytes = Buffer.from(JSON.stringify(policy));
  return {keyId: 'w03', payloadBase64: bytes.toString('base64'), signatureBase64: sign(null, bytes, fixtureKeys.privateKey).toString('base64')};
}
function steamAcf(appId = '489830', language = 'english', name = gameName) {
  return `"AppState" { "appid" "${appId}" "installdir" "${name}" "StateFlags" "4" "UserConfig" { "language" "${language}" } }`;
}

async function identity(file: string) {
  try {
    const stat = await fs.lstat(file, {bigint: true});
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    return {ino: stat.ino, mtime: stat.mtimeNs, ctime: stat.ctimeNs, sha256: sha(await fs.readFile(file))};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function entries(directory: string) {
  try { return (await fs.readdir(directory)).sort(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function fixture(t: TestContext, start: 'cold' | 'warm' = 'cold') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(await canonicalTemporaryRoot(), 'fv-w03-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const steamRoot = path.join(root, 'Steam');
  const library = path.join(root, 'Library');
  const alternate = path.join(root, 'Alternate');
  const install = (base: string) => path.join(base, 'steamapps', 'common', gameName);
  const acf = (base: string) => path.join(base, 'steamapps', 'appmanifest_489830.acf');
  const game = install(library), otherGame = install(alternate);
  const config = path.join(root, 'profile'), storage = path.join(root, 'storage');
  const helper = path.join(root, 'inert-helper.bin'), bundled = path.join(root, 'bundled.json');
  const dir = path.join(storage, 'managed-installations', sha(game.toLowerCase()+'\n'+config.toLowerCase()));
  const packages = path.join(dir, 'packages'), raw = path.join(packages, 'steam-depots', depotsDigest, 'cohort');
  const metadata = path.join(dir, 'metadata'), runtimeMetadata = path.join(metadata, 'runtime-preparation');
  const journalFile = path.join(runtimeMetadata, 'journal.json'), ledgerFile = path.join(runtimeMetadata, 'policy-ledger.json');
  const backupDir = path.join(packages, 'runtime-backups'), historyDir = path.join(runtimeMetadata, 'history');
  const now = Date.now();
  const policy: RuntimeCohort = {
    schemaVersion: 1, kind: 'frostveil-steam-runtime', runtime: '1.6.1170.0', appId: '489830', language: 'english',
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now+3600000).toISOString(),
    depots, files, creations: [], managedFiles: [], pluginOrder: [], configuration: {pluginsBase64: '', loadorderBase64: ''},
    helper: {version: '3.4.0', size: helperBytes.length, sha256: sha(helperBytes)},
    acquisition: {verified: true, receiptSha256: sha('W03 synthetic receipt')}
  };
  const writeBundled = (value: unknown) => fs.writeFile(bundled, JSON.stringify(value));
  for (const dir of [path.join(steamRoot, 'steamapps'), path.join(game, 'Data'), path.join(otherGame, 'Data'), config, storage]) {
    await fs.mkdir(dir, {recursive: true});
  }
  const libraryVdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  await fs.writeFile(libraryVdf, `"libraryfolders" { "0" { "path" ${JSON.stringify(library)} } "1" { "path" ${JSON.stringify(alternate)} } }`);
  await fs.writeFile(acf(library), steamAcf());
  await fs.writeFile(acf(alternate), steamAcf());
  const targetPaths = payloads.map(f => path.join(game, f.path));
  for (const [i, f] of payloads.entries()) await fs.writeFile(targetPaths[i]!, start === 'warm' ? f.target : f.original);
  const pluginFile = path.join(config, 'plugins.txt');
  await fs.writeFile(pluginFile, '# W03 original profile\r\n');
  await fs.writeFile(helper, helperBytes);
  await writeBundled(envelope(policy));

  let response = () => Response.json(envelope(policy));
  let mode: 'success' | 'disconnect' | 'cancel' = 'success';
  let version = policy.runtime as string;
  const requests: string[] = [], targetWrites: string[] = [], faults: unknown[] = [];
  const states: RuntimePreparationState[] = [];
  const invocations: {ids: string[]; manifests: string[]; requested: string[]; challenges: number}[] = [];
  const versionChecks: {phase: RuntimePreparationState['phase']; bytes: Buffer[]}[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), policyUrl);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    requests.push(String(input));
    return response();
  });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    await rename(...args);
    const destination = args[1];
    if (typeof destination === 'string' && [...targetPaths, pluginFile].includes(destination)) targetWrites.push(destination);
  });
  const service = new RuntimePreparation(storage, bundled);
  t.after(service.subscribe(s => states.push(s)));
  t.after(bindFixture({root, steamRoot, game, storage, helper, faults,
    version: async () => {
      versionChecks.push({phase: service.snapshot().phase, bytes: await Promise.all(targetPaths.map(file => fs.readFile(file)))});
      return version;
    },
    invoke: async (child, args, cwd) => {
      const manifestStart = args.indexOf('-manifest'), qrStart = args.indexOf('-qr');
      assert.deepEqual(args.slice(0, 3), ['-app', '489830', '-depot']);
      assert.deepEqual(args.slice(qrStart), ['-qr', '-dir', raw, '-filelist', path.join(cwd, 'cohort-files.txt'), '-validate']);
      assert.ok(manifestStart > 3 && qrStart > manifestStart);
      const requested = (await fs.readFile(path.join(cwd, 'cohort-files.txt'), 'utf8')).split('\n');
      invocations.push({ids: args.slice(3, manifestStart), manifests: args.slice(manifestStart+1, qrStart), requested, challenges: args.filter(a => a === '-qr').length});
      assert.ok(mode === 'success' || requested.includes(partialFile.path));
      for (const name of mode === 'success' ? requested : [partialFile.path]) {
        const f = payloads.find(f => f.path === name);
        assert.ok(f, 'fixture requests must stay in the signed inventory');
        const file = path.join(raw, f.path);
        await fs.mkdir(path.dirname(file), {recursive: true});
        await fs.writeFile(file, f.target, {flag: 'wx'});
      }
      child.stdout.write('synthetic helper diagnostic\n'+qr);
      if (mode === 'disconnect') child.stderr.write('Lost connection to Steam\n');
      if (mode === 'cancel') assert.ok(child.killed, 'the challenge subscriber must cancel this helper');
      child.finish(mode === 'success' ? 0 : mode === 'cancel' ? null : 1);
    }
  }));

  return {
    service, game, otherGame, steamRoot, storage, root, libraryVdf, selectedAcf: acf(library), policy, bundled, states, invocations, versionChecks, faults, requests, targetWrites,
    prepare: (selected = game) => {
      assert.ok(selected !== root && contained(root, selected), 'W03 refuses targets outside its disposable root');
      return service.prepare(selected, config);
    },
    inspect: () => service.inspect(game, config),
    restore: () => service.restore(game, config),
    setMode: (value: typeof mode) => { mode = value; },
    setVersion: (value: string) => { version = value; },
    setResponse: (value: typeof response) => { response = value; },
    writeBundled,
    targets: () => Promise.all([...targetPaths, pluginFile].map(identity)),
    rawFiles: () => Promise.all(payloads.map(f => identity(path.join(raw, f.path)))),
    withoutRawCopies: async (run: () => Promise<void>) => {
      const held = raw+'.held';
      await fs.rename(raw, held);
      try { await run(); } finally { await fs.rename(held, raw); }
    },
    backups: async () => ({generations: await entries(historyDir), blobs: await Promise.all((await entries(backupDir)).map(async name => [name, await identity(path.join(backupDir, name))] as const))}),
    journal: () => identity(journalFile),
    ledger: () => identity(ledgerFile),
    readJournal: async () => await MetadataStore.readAuthenticated(journalFile, await fs.readFile(path.join(metadata, 'auth-key'))) as {
      state: string; files: {path: string; before: {size: number; sha256: string}; after: {size: number; sha256: string}}[];
    }
  };
}

function assertHelper(f: Awaited<ReturnType<typeof fixture>>, call: number, requested: string[]) {
  const expected = depots.filter(d => payloads.some(p => p.depot === d.id && requested.includes(p.path)));
  assert.deepEqual(f.invocations[call], {ids: expected.map(d => d.id), manifests: expected.map(d => d.manifest), requested, challenges: 1});
  assert.deepEqual(f.faults, []);
}

function assertNoAcquisition(states: RuntimePreparationState[]) {
  assert.ok(states.every(s => !s.authQr && s.phase !== 'authentication' && s.phase !== 'downloading'));
}

test('W03 selects the explicit canonical Steam library and refuses invalid targets before writes', async t => {
  const f = await fixture(t, 'warm');
  const untouched = await f.targets(), libraryVdf = await identity(f.libraryVdf);
  assert.throws(() => f.prepare(path.dirname(f.root)), /outside its disposable root/);
  const unlisted = path.join(f.root, 'Unlisted');
  await fs.mkdir(unlisted);
  await assert.rejects(f.prepare(unlisted), /Select a verified Steam Skyrim installation/);
  for (const [text, error] of [
    [steamAcf('1946180'), /App 489830/],
    [steamAcf('489830', 'french'), /English/],
    [steamAcf('489830', 'english', 'Skyrim/../'+gameName), /App 489830/]
  ] as const) {
    await fs.writeFile(f.selectedAcf, text);
    const before = await identity(f.selectedAcf);
    await assert.rejects(f.prepare(), error);
    assert.deepEqual(await identity(f.selectedAcf), before);
    assert.deepEqual(await f.targets(), untouched);
    assert.deepEqual(await fs.readdir(f.storage), []);
  }
  assert.deepEqual(await identity(f.libraryVdf), libraryVdf);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.invocations, []);
  await fs.writeFile(f.selectedAcf, steamAcf());
  assert.deepEqual(new Set(await discoverSteam([f.steamRoot])), new Set([f.game, f.otherGame]));
  const selected = await verifySteamSelection(path.dirname(f.game)+path.sep+'.'+path.sep+gameName, [f.steamRoot]);
  assert.equal(selected.game, f.game);
  assert.equal(selected.manifest, f.selectedAcf);
  assert.equal(selected.language, 'english');
  assert.equal((await verifySteamSelection(f.otherGame, [f.steamRoot])).game, f.otherGame);
  const acf = await identity(f.selectedAcf);
  await f.inspect();
  assert.equal(f.service.snapshot().changedFiles, 0);
  assert.deepEqual(f.versionChecks, [], 'Inspect does not probe the Windows version boundary');
  f.setVersion('1.6.640.0');
  await assert.rejects(f.prepare(), /Final runtime version verification failed/);
  assert.equal(f.service.snapshot().phase, 'blocked');
  assert.deepEqual(await f.targets(), untouched);
  assert.deepEqual(await identity(f.selectedAcf), acf);
  assert.equal(await f.journal(), null);
  assert.deepEqual(f.invocations, []);
  assert.deepEqual(f.targetWrites, []);
  assert.deepEqual(f.versionChecks, [{phase: 'checking', bytes: payloads.map(p => p.target)}]);
});

test('W03 cold trio verifies before Ready and two warm runs plus staged reuse need no new helper', async t => {
  const f = await fixture(t);
  f.setResponse(() => new Response(null, {status: 404}));
  const originals = await f.targets();
  await f.prepare();
  assert.equal(f.service.snapshot().phase, 'ready');
  assert.equal(f.service.snapshot().changedFiles, 0);
  assert.deepEqual(f.versionChecks, [{phase: 'applying', bytes: payloads.map(p => p.target)}], 'the cold version probe happens after target Apply');
  assert.equal(f.invocations.length, 1);
  assertHelper(f, 0, payloads.map(p => p.path));
  const challenges = f.states.filter(s => s.authQr);
  assert.equal(challenges.length, 1);
  assert.match(challenges[0]!.authQr!, /^[ █\n]+$/);
  assert.ok(f.states.findIndex(s => s.authQr) < f.states.findIndex(s => s.phase === 'applying'));
  assert.ok(f.states.findIndex(s => s.phase === 'applying') < f.states.findIndex(s => s.phase === 'ready'));
  const raw = await f.rawFiles(), backups = await f.backups(), prepared = await f.targets(), journal = await f.journal();
  assert.deepEqual(raw.map(f => f?.sha256), files.map(f => f.sha256));
  const recovery = await f.readJournal();
  assert.equal(recovery.state, 'active');
  assert.deepEqual(recovery.files, payloads.map(f => ({path: f.path,
    before: {size: f.original.length, sha256: sha(f.original)}, after: {size: f.target.length, sha256: sha(f.target)}
  })));
  assert.deepEqual(backups.blobs.map(([name]) => name), payloads.map(p => sha(p.original)).sort());
  assert.deepEqual(backups.generations, []);
  for (const [name, blob] of backups.blobs) assert.equal(blob?.sha256, name);
  const writes = payloads.map(p => path.join(f.game, p.path));
  assert.deepEqual(f.targetWrites, writes);

  const count = () => ({
    helperInvocations: f.invocations.length,
    challenges: f.states.filter(s => s.authQr).length,
    payloadFiles: f.invocations.reduce((sum, entry) => sum+entry.requested.length, 0),
    targetWrites: f.targetWrites.length,
    metadataRequests: f.requests.length
  });
  const cold = count();
  const warm = [];
  for (let run = 0; run < 2; run++) {
    const from = f.states.length;
    await f.prepare();
    assert.equal(f.service.snapshot().phase, 'ready');
    assert.equal(f.service.snapshot().changedFiles, 0);
    assertNoAcquisition(f.states.slice(from));
    assert.deepEqual(await f.targets(), prepared);
    assert.deepEqual(await f.backups(), backups);
    assert.deepEqual(await f.journal(), journal);
    assert.deepEqual(f.targetWrites, writes);
    warm.push(count());
  }
  await f.restore();
  assert.equal((await f.readJournal()).state, 'restored');
  assert.deepEqual((await f.targets()).map(v => v?.sha256), originals.map(v => v?.sha256));
  const from = f.states.length;
  const restored = count();
  await f.withoutRawCopies(f.prepare);
  assert.equal(f.service.snapshot().phase, 'ready');
  assertNoAcquisition(f.states.slice(from));
  assert.deepEqual((await f.targets()).map(v => v?.sha256), prepared.map(v => v?.sha256));
  assert.deepEqual(await f.backups(), backups);
  assert.deepEqual(await f.rawFiles(), raw);
  assert.equal(f.targetWrites.length, writes.length*3, 'one write per changed target per Apply or Restore');
  assert.equal(f.invocations.length, 1);
  assert.equal(f.requests.length, 4, 'each Prepare checks policy metadata separately from payload acquisition');
  t.diagnostic(JSON.stringify({cumulative: {cold, warm, restored, staged: count()}, newBackupGenerations: (await f.backups()).generations.length}));
});

for (const failure of ['disconnect', 'cancel'] as const) {
  test(`W03 ${failure} retains verified partial data and a bounded retry fills only the missing files`, async t => {
    const f = await fixture(t);
    f.setMode(failure);
    const stop = f.service.subscribe(s => { if (failure === 'cancel' && s.authQr) f.service.cancel(); });
    t.after(stop);
    const originals = await f.targets();
    await assert.rejects(f.prepare(), failure === 'cancel' ? /Runtime acquisition cancelled/ : /connection-lost/);
    stop();
    assert.equal(f.service.snapshot().phase, failure === 'cancel' ? 'cancelled' : 'blocked');
    assert.equal(f.service.snapshot().authQr, undefined);
    assert.equal(await f.journal(), null);
    assert.deepEqual(f.targetWrites, []);
    assert.deepEqual(await f.targets(), originals);
    assert.deepEqual(await f.backups(), {generations: [], blobs: []});
    assertHelper(f, 0, payloads.map(p => p.path));
    const partial = await f.rawFiles();
    assert.deepEqual(partial.map(v => v?.sha256 ?? null), files.map(file => file === partialFile ? file.sha256 : null));

    f.setMode('success');
    await f.prepare();
    assert.equal(f.service.snapshot().phase, 'ready');
    assert.equal(f.invocations.length, 2);
    assertHelper(f, 1, files.filter(file => file !== partialFile).map(p => p.path));
    const raw = await f.rawFiles();
    assert.deepEqual(raw[files.indexOf(partialFile)], partial[files.indexOf(partialFile)]);
    assert.deepEqual(raw.map(v => v?.sha256), files.map(p => p.sha256));
    assert.equal(f.states.filter(s => s.authQr).length, 2);
    await f.restore();
    assert.equal((await f.readJournal()).state, 'restored');
    assert.deepEqual((await f.targets()).map(v => v?.sha256), originals.map(v => v?.sha256));
    assert.deepEqual(await f.rawFiles(), raw);
    t.diagnostic(JSON.stringify({failure, invocations: f.invocations.length, challenges: f.states.filter(s => s.authQr).length, requestedDepots: f.invocations.map(call => call.ids), requestedFiles: f.invocations.map(call => call.requested.length)}));
  });
}

test('W03 policy accepts authenticated fallback only on 404 and refuses stale, conflicting and tampered metadata', async t => {
  const f = await fixture(t, 'warm');
  await f.prepare();
  const ledger = await f.ledger(), originals = await f.targets();
  assert.ok(ledger);
  const good = envelope(f.policy);
  const tampered = {...good, signatureBase64: (good.signatureBase64[0] === 'A' ? 'B' : 'A')+good.signatureBase64.slice(1)};
  const expired = envelope({...f.policy, createdAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-02T00:00:00Z'});
  const older = envelope({...f.policy, createdAt: new Date(Date.parse(f.policy.createdAt)-1000).toISOString()});
  const conflict = envelope({...f.policy, acquisition: {verified: true, receiptSha256: sha('conflicting receipt')}});
  for (const [respond, expected] of [
    [() => new Response(null, {status: 401}), /HTTP 401/],
    [() => new Response(null, {status: 503}), /HTTP 503/],
    [() => Response.json(tampered), /signature invalid/],
    [() => Response.json(expired), /expired runtime policy/],
    [() => Response.json(older), /Stale\/conflicting runtime metadata/],
    [() => Response.json(conflict), /Stale\/conflicting runtime metadata/]
  ] as const) {
    f.setResponse(respond);
    await assert.rejects(f.prepare(), expected);
    assert.equal(f.service.snapshot().phase, 'blocked');
    assert.deepEqual(await f.ledger(), ledger);
    assert.deepEqual(await f.targets(), originals);
  }
  f.setResponse(() => new Response(null, {status: 404}));
  await f.writeBundled(tampered);
  await assert.rejects(f.prepare(), /signature invalid/);
  await fs.unlink(f.bundled);
  await assert.rejects(f.prepare(), {code: 'ENOENT'});
  assert.deepEqual(await f.ledger(), ledger);
  assert.deepEqual(await f.targets(), originals);
  assert.equal(await f.journal(), null);
  assert.deepEqual(f.invocations, []);
  assert.deepEqual(f.targetWrites, []);
  assert.equal(f.requests.length, 9);
  assertNoAcquisition(f.states);
});
