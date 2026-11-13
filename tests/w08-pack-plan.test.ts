import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, sign} from 'node:crypto';
import {ProductionDownloads} from '../src/main/management/downloads';
import {GraphicsPackService} from '../src/main/management/graphics-pack';
import {planGraphicsSourcesForWholePlay} from '../src/main/graphics-source-repair';
import {planClientForWholePlay} from '../src/main/client-repair';
import {GitHubDistributionProvider} from '../src/main/distribution/github';
import {DistributionTransport} from '../src/main/distribution/transport';
import {authenticateRuntimeCohort, type RuntimeCohort} from '../src/main/runtime/policy';
import {envelope, fixture, keyId, publicKey, testKey} from './distribution-fixture';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const toBase64 = (text: string) => Buffer.from(text).toString('base64');

type PackFixture = Awaited<ReturnType<typeof fixture>>;

function signFixture(pack: PackFixture) {
  Object.assign(pack.envelope, envelope(pack.manifest, pack.server));
  pack.metadata.assets[0]!.size = Buffer.byteLength(JSON.stringify(pack.envelope));
}

async function withRuntime(pack: PackFixture) {
  const bytes = Buffer.from('inert executable fixture');
  const master = pack.manifest.files.find(file => file.path === 'Data/Skyrim.esm')!;
  for (const file of ['SkyrimSE.exe', 'skse64_loader.exe', 'skse64_1_6_1170.dll']) {
    await fs.writeFile(path.join(pack.grant.installation, file), bytes);
    pack.manifest.files.push({...master, path: file, size: bytes.length, sha256: digest(bytes)});
  }
  signFixture(pack);
  return pack;
}
async function setup(t: TestContext) {
  const pack = await withRuntime(await fixture());
  const game = pack.grant.installation;
  const order = path.join(pack.grant.directory, 'w08-plan-profile');
  const storage = path.join(pack.grant.directory, 'w08-plan-storage');
  await fs.mkdir(order);
  await fs.writeFile(path.join(order, 'plugins.txt'), '# local preimage\r\n');
  let response = pack;
  const requests = {metadata: 0, envelope: 0, payload: 0};
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.endsWith('/releases/latest')) {
      requests.metadata++;
      res.end(JSON.stringify(response.metadata));
    } else if (url.endsWith('/assets/100')) {
      requests.envelope++;
      res.end(JSON.stringify(response.envelope));
    } else {
      requests.payload++;
      res.end(response.payloads.get(Number(url.split('/').at(-1))));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing inert transport address');
  const transport = DistributionTransport.loopback('http://127.0.0.1:' + address.port, 'sandbox-test');
  const source = {mode: 'sandbox-test' as const, packId: pack.manifest.packId, channel: 'stable' as const,
    keys: {[keyId]: {publicKey, environment: 'test' as const, revoked: false}}, permittedReviews: []};
  const service = new ProductionDownloads(storage, '0.1.30', source, () => new GitHubDistributionProvider(transport));
  t.after(async () => {
    service.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const project = async (plugins = '# signed configuration\r\n', orderText = 'Skyrim.esm\r\n') => {
    const runtime = await fs.readFile(path.join(game, 'SkyrimSE.exe'));
    const policy: RuntimeCohort = {
      schemaVersion: 1, kind: 'frostveil-steam-runtime', runtime: '1.6.1170.0', appId: '489830', language: 'english',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      depots: [{id: '489833', manifest: '1914580699073641964'}],
      files: [{path: 'SkyrimSE.exe', size: runtime.length, sha256: digest(runtime), depot: '489833'}],
      creations: [], pluginOrder: [], managedFiles: pack.manifest.files.filter(file => file.path.startsWith('Data/'))
        .map(({path, size, sha256}) => ({path, size, sha256})),
      configuration: {pluginsBase64: toBase64(plugins), loadorderBase64: toBase64(orderText)},
      helper: {version: '3.4.0', size: 1, sha256: digest('inert helper')},
      acquisition: {verified: true, receiptSha256: digest('inert receipt')},
    };
    const payload = Buffer.from(JSON.stringify(policy));
    const verified = authenticateRuntimeCohort({keyId, payloadBase64: payload.toString('base64'),
      signatureBase64: sign(null, payload, testKey).toString('base64')}, source.keys, {fixture: true});
    return {
      policy: verified, signal: new AbortController().signal,
      projectedFile: async (relative: string) => {
        const target = path.join(game, relative);
        try { await fs.lstat(target); return target; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      },
    };
  };
  return {pack, game, order, service, requests, project, select: (next: typeof pack) => {response = next;}};
}

test('whole-Play pack stages signed repairs and keeps its admitted bundle through final verification', async t => {
  const f = await setup(t);
  const projection = await f.project();
  const admitted = await f.service.wholePlayAdmission(projection.signal);
  assert.equal(admitted.packagedTargets.size, 2);
  const plan = await admitted.plan(f.game, f.order, projection);
  assert.equal(plan.writes.length, 2);
  assert.deepEqual(f.requests, {metadata: 1, envelope: 1, payload: 2});
  for (const write of plan.writes) {
    assert.equal(digest(await fs.readFile(write.source)), write.sha256);
    await assert.rejects(fs.stat(path.join(f.game, write.path)), {code: 'ENOENT'});
  }
  await plan.revalidate?.();
  const second = await withRuntime(await fixture(2));
  f.select(second);
  assert.notEqual((await f.service.baselineProfile()).id, plan.baseline.id);
  for (const write of plan.writes) {
    const target = path.join(f.game, write.path);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(write.source, target);
  }
  await fs.writeFile(path.join(f.order, 'plugins.txt'), Buffer.from(projection.policy.configuration.pluginsBase64, 'base64'));
  await fs.writeFile(path.join(f.order, 'loadorder.txt'), Buffer.from(projection.policy.configuration.loadorderBase64, 'base64'));
  await plan.verifyInstalled?.();
  assert.equal(f.service.snapshot().installed, false);
  plan.publishReady?.();
  assert.equal(f.service.snapshot().version, f.pack.manifest.packVersion);
  assert.deepEqual(f.requests, {metadata: 2, envelope: 2, payload: 2});
});

test('whole-Play pack refuses to discard an enabled plugin before payload or profile writes', async t => {
  const f = await setup(t);
  const config = path.join(f.order, 'plugins.txt');
  const current = '# local preimage\r\n*PlayerOwned.esp\r\n';
  await fs.writeFile(config, current);
  await assert.rejects(f.service.planWholePlay(f.game, f.order, await f.project()), /would deactivate.*playerowned/i);
  assert.equal(await fs.readFile(config, 'utf8'), current);
  assert.deepEqual(f.requests, {metadata: 1, envelope: 1, payload: 0});
});

test('whole-Play pack refuses a legacy file-only plugin requiring edits to the signed profile', async t => {
  const f = await setup(t);
  const template = f.pack.manifest.files.find(file => file.distribution === 'allowed')!;
  const bytes = Buffer.alloc(24);
  bytes.write('TES4');
  const filename = 'W08Quest.esp';
  const sha256 = digest(bytes);
  const assetId = 701;
  f.pack.manifest.files.push({...structuredClone(template), path: 'Data/' + filename, size: bytes.length, sha256,
    role: 'visual', package: {...template.package!, assetId, assetName: filename, size: bytes.length, sha256}});
  f.pack.payloads.set(assetId, bytes);
  f.pack.metadata.assets.push({id: assetId, name: filename, size: bytes.length, state: 'uploaded', digest: 'sha256:' + sha256});
  signFixture(f.pack);
  await assert.rejects(f.service.planWholePlay(f.game, f.order, await f.project()), /exact signed runtime profile bytes/i);
  assert.equal(await fs.readFile(path.join(f.order, 'plugins.txt'), 'utf8'), '# local preimage\r\n');
  await assert.rejects(fs.stat(path.join(f.game, 'Data', filename)), {code: 'ENOENT'});
  assert.equal(f.requests.payload, 3);
});


test('whole-Play pack allows an explicitly planned runtime Creation quarantine', async t => {
  const f = await setup(t);
  const file = path.join(f.order, 'plugins.txt');
  const current = '*ccPaid.esl\r\n';
  await fs.writeFile(file, current);
  const projected = await f.project();
  const plan = await f.service.planWholePlay(f.game, f.order, {
    ...projected, isRuntimeRemoval: relative => relative.toLowerCase() === 'data/ccpaid.esl',
  });
  assert.equal(plan.writes.length, 2);
  assert.equal(await fs.readFile(file, 'utf8'), current);
});

test('original-source graphics and pinned client adapters stage exact bytes without game or backup writes', async t => {
  const f = await setup(t);
  const projection = await f.project();
  const storage = path.join(f.pack.grant.directory, 'w08-actual-adapters');
  const bytes = Buffer.from('inert projected graphics configuration');
  const entry = {path: 'Data/SKSE/Plugins/po3_Tweaks.ini', size: bytes.length, sha256: digest(bytes),
    source: {contentBase64: bytes.toString('base64')}};
  const graphics = await planGraphicsSourcesForWholePlay(f.game, storage, async () => false,
    {version: '1.0.20', files: [entry]}, {sourceDirectories: []}, projection);
  assert.equal(graphics.writes.length, 1);
  assert.equal(graphics.writes[0]!.writer, 'source-graphics');
  assert.deepEqual(await fs.readFile(graphics.writes[0]!.source), bytes);
  await assert.rejects(fs.stat(path.join(f.game, entry.path)), {code: 'ENOENT'});

  const relative = 'Data/Platform/Plugins/skymp5-client.js';
  const destination = path.join(f.game, relative);
  const before = await fs.readFile(destination);
  const next = Buffer.from('inert pinned client replacement');
  const pin = {path: relative, sha256: digest(next), size: next.length, url: 'https://example.invalid/inert',
    previous: {sha256: digest(before), size: before.length}};
  let downloads = 0;
  const download = async () => {downloads++; return next;};
  const client = await planClientForWholePlay(storage, projection, async () => false, download, pin);
  const repeat = await planClientForWholePlay(storage, projection, async () => false, download, pin);
  assert.equal(client.writes[0]!.writer, 'client');
  assert.deepEqual(await fs.readFile(client.writes[0]!.source), next);
  assert.equal(repeat.writes[0]!.source, client.writes[0]!.source);
  assert.equal(downloads, 1);
  assert.deepEqual(await fs.readFile(destination), before);
  await assert.rejects(fs.stat(path.join(storage, 'client-repair-backups')), {code: 'ENOENT'});
  await assert.rejects(fs.stat(path.join(storage, 'graphics-source-repair', 'active.json')), {code: 'ENOENT'});
});

test('cold legacy graphics stages signed archive members beyond the marker list and excludes unknown files', async t => {
  const pack = await fixture();
  const root = pack.grant.directory;
  const storage = path.join(root, 'w08-legacy-storage');
  const archiveInput = path.join(root, 'w08-legacy-archive-input');
  const packageName = 'inert-legacy.zip';
  const cache = path.join(storage, 'r2-cache');
  await fs.mkdir(cache, {recursive: true});
  const current = new Map<string, string>();
  const managedFiles: RuntimeCohort['managedFiles'] = [];
  const installed = ['d3dx9_42.dll', 'Data/Lux.esp', 'Data/Ulvenwald.esp', 'Data/BlendedRoads.esp'];
  const archiveFiles = ['Data/textures/W08/ColdAsset.dds', 'Data/textures/W08/Unrelated.dds'];
  for (const name of [...installed, ...archiveFiles]) {
    const bytes = Buffer.from('inert bytes for ' + name);
    const target = path.join(installed.includes(name) ? pack.grant.installation : archiveInput, name);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, bytes);
    if (installed.includes(name)) current.set(name.toLowerCase(), target);
    if (name !== archiveFiles[1]) managedFiles.push({path: name, size: bytes.length, sha256: digest(bytes)});
  }
  const standardOrder = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm',
    'ccBGSSSE001-Fish.esm', 'ccQDRSSE001-SurvivalMode.esl', 'ccBGSSSE037-Curios.esl', 'ccBGSSSE025-AdvDSGS.esm',
    '_ResourcePack.esl'];
  const active = ['FrostveilCourierNavigation.esp', 'SkyUI_SE.esp'];
  for (const name of [...standardOrder, ...active]) {
    const relative = 'Data/' + name;
    if (name.toLowerCase().startsWith('cc') || name.startsWith('_ResourcePack')) continue;
    const target = path.join(pack.grant.installation, relative);
    const bytes = Buffer.from('inert profile member ' + name);
    await fs.writeFile(target, bytes);
    current.set(relative.toLowerCase(), target);
    managedFiles.push({path: relative, size: bytes.length, sha256: digest(bytes)});
  }
  const runtime = Buffer.from('inert executable');
  const policy: RuntimeCohort = {
    schemaVersion: 1, kind: 'frostveil-steam-runtime', runtime: '1.6.1170.0', appId: '489830', language: 'english',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    depots: [{id: '489833', manifest: '1914580699073641964'}],
    files: [{path: 'SkyrimSE.exe', size: runtime.length, sha256: digest(runtime), depot: '489833'},
      ...standardOrder.filter(name => /^(?:cc|_ResourcePack)/i.test(name))
        .map(name => ({path: 'Data/' + name, size: runtime.length, sha256: digest(runtime), depot: '489833'}))],
    creations: standardOrder.filter(name => /^(?:cc|_ResourcePack)/i.test(name)),
    pluginOrder: active, managedFiles,
    configuration: {
      pluginsBase64: toBase64(['# This file is used by Skyrim to keep track of your downloaded content.',
        '# Please do not modify this file.', ...active.map(name => '*' + name), ''].join('\r\n')),
      loadorderBase64: toBase64([...standardOrder, ...active, ''].join('\r\n')),
    },
    helper: {version: '3.4.0', size: 1, sha256: digest('inert helper')},
    acquisition: {verified: true, receiptSha256: digest('inert receipt')},
  };
  const payload = Buffer.from(JSON.stringify(policy));
  const signed = authenticateRuntimeCohort({keyId, payloadBase64: payload.toString('base64'),
    signatureBase64: sign(null, payload, testKey).toString('base64')},
    {[keyId]: {publicKey, environment: 'test', revoked: false}}, {fixture: true});
  const archive = path.join(cache, packageName);
  await promisify(execFile)('tar.exe', ['-a', '-cf', archive, '-C', archiveInput, 'Data'], {windowsHide: true});
  const archiveBytes = await fs.readFile(archive);
  assert.equal(archiveBytes.readUInt32LE(0), 0x04034b50);
  const graphics = new GraphicsPackService(storage);
  graphics.fetchManifest = async () => ({
    version: 'fixture-cold-1', generatedAt: new Date().toISOString(), packageName,
    downloadUrl: 'https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/inert-legacy.zip',
    size: archiveBytes.length, sha256: digest(archiveBytes), integrityFiles: {}, activePlugins: [], masterPlugins: [],
  });
  const plan = await graphics.planWholePlay({
    policy: signed, signal: new AbortController().signal,
    projectedFile: async name => current.get(name.toLowerCase()) ?? null,
  });
  assert.deepEqual(plan.writes.map(write => write.path), [archiveFiles[0]]);
  const write = plan.writes[0]!;
  assert.equal(write.writer, 'legacy-graphics');
  assert.deepEqual(await fs.readFile(write.source), await fs.readFile(path.join(archiveInput, archiveFiles[0]!)));
  for (const name of archiveFiles) await assert.rejects(fs.stat(path.join(pack.grant.installation, name)), {code: 'ENOENT'});
  const originalManifest = await graphics.fetchManifest();
  graphics.fetchManifest = async () => ({...originalManifest, downloadUrl: '', packageName: 'unreachable.zip'});
  const packOnly = await graphics.planWholePlay({
    policy: signed, signal: new AbortController().signal,
    projectedFile: async name => current.get(name.toLowerCase()) ?? null,
  }, new Set([archiveFiles[0]!.toLowerCase()]));
  assert.deepEqual(packOnly.writes, []);
});
