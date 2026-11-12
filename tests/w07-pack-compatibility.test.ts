import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {ProductionDownloads} from '../src/main/management/downloads';
import {GameLauncher} from '../src/main/launch';
import {GitHubDistributionProvider} from '../src/main/distribution/github';
import {DistributionTransport} from '../src/main/distribution/transport';
import {authenticateRelease, parseRelease, type DistributionSource} from '../src/main/distribution/policy';
import {fixture, envelope, keyId, publicKey} from './distribution-fixture';

test('Play refuses an authentic signed shared-plugin digest mismatch before payload acquisition or pack writes', async t => {
  const pack = await fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frostveil-w07-red-'));
  const game = path.join(root, 'game');
  const order = path.join(root, 'order');
  const cache = path.join(root, 'cache');
  await fs.cp(pack.grant.installation, game, {recursive: true});
  await fs.mkdir(order, {recursive: true});
  await fs.writeFile(path.join(order, 'plugins.txt'), '# inert W07 fixture\r\n');

  const serverSnapshot = structuredClone(pack.server);
  serverSnapshot.plugins[0]!.sha256 = 'f'.repeat(64);
  let signed = envelope(pack.manifest, serverSnapshot);
  const metadata = structuredClone(pack.metadata);
  metadata.assets[0]!.size = Buffer.byteLength(JSON.stringify(signed));
  const requests = {payload: 0};
  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (requestPath.endsWith('/releases/latest')) {
      metadata.assets[0]!.size = Buffer.byteLength(JSON.stringify(signed));
      response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(metadata));
    } else if (requestPath.endsWith('/assets/100')) {
      response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(signed));
    } else {
      requests.payload++;
      const assetId = Number(requestPath.split('/').at(-1));
      response.writeHead(200).end(pack.payloads.get(assetId));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const transport = DistributionTransport.loopback(`http://127.0.0.1:${address.port}`, 'sandbox-test');
  const source: DistributionSource = {
    mode: 'sandbox-test', packId: pack.manifest.packId, channel: 'stable', permittedReviews: [],
    keys: {[keyId]: {publicKey, environment: 'test', revoked: false}},
  };
  const release = parseRelease(metadata);
  assert.equal(authenticateRelease(signed, source, release).server.plugins[0]!.sha256, 'f'.repeat(64),
    'the candidate remains authentic; compatibility must reject it at pack admission');
  const service = new ProductionDownloads(cache, '0.1.30', source, () => new GitHubDistributionProvider(transport));
  t.after(async () => {
    service.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const temp = await fs.realpath(os.tmpdir());
    for (const child of [root, pack.grant.directory]) {
      const resolved = await fs.realpath(child);
      assert.equal(path.dirname(resolved), temp);
      await fs.rm(resolved, {recursive: true, force: true});
    }
  });

  const before = await fs.readdir(game, {recursive: true});
  await assert.rejects(() => service.prepareForPlay(game, order), /shared plugin|compatib|mismatch/i);
  assert.equal(requests.payload, 0, 'signed mismatch is rejected before acquiring any payload');
  assert.deepEqual(await fs.readdir(game, {recursive: true}), before, 'pack targets remain unchanged');
  assert.equal(service.snapshot().installed, false);
  signed = pack.envelope;
  // A missing external requirement must make explicit Download Server Files
  // reject; it cannot resolve with a stale or success-shaped state.
  const officialMaster = path.join(game, 'Data', 'Skyrim.esm');
  const officialBytes = await fs.readFile(officialMaster);
  await fs.unlink(officialMaster);
  const explicitService = new ProductionDownloads(path.join(root, 'explicit-cache'), '0.1.30', source,
    () => new GitHubDistributionProvider(transport));
  await assert.rejects(() => explicitService.installAndActivate(game, order), /could not be completed|external|Skyrim\.esm/i);
  assert.equal(explicitService.snapshot().installed, false, 'failed explicit install must not claim success');
  explicitService.dispose();
  await fs.writeFile(officialMaster, officialBytes, {flag: 'wx'});

  // Every signed identity field participates in the service admission gate.
  // Each variant is freshly signed, so these are compatibility failures, not
  // signature/schema failures. The latest-release endpoint is loopback only.
  const mismatchCases: Array<[string, (server: typeof pack.server) => void]> = [
    ['filename', s => { s.plugins[0]!.filename = 'Other.esm'; }],
    ['signed size', s => { s.plugins[0]!.size++; }],
    ['light flag', s => { s.plugins[0]!.light = true; }],
    ['header verification', s => { s.plugins[0]!.headerVerified = false; }],
  ];
  for (const [field, mutate] of mismatchCases) {
    const candidate = structuredClone(pack.server);
    mutate(candidate);
    signed = envelope(pack.manifest, candidate);
    metadata.assets[0]!.size = Buffer.byteLength(JSON.stringify(signed));
    assert.equal(authenticateRelease(signed, source, release).server.plugins[0]!.filename,
      candidate.plugins[0]!.filename, `${field} candidate is authentic`);
    await assert.rejects(() => service.prepareForPlay(game, order), /shared plugin|compatib|mismatch/i,
      `${field} mismatch must be refused`);
    assert.equal(requests.payload, 0, `${field} mismatch must be refused before payload acquisition`);
    assert.deepEqual(await fs.readdir(game, {recursive: true}), before,
      `${field} mismatch must not write game pack/profile data`);
    assert.equal(service.snapshot().installed, false, `${field} mismatch must not report installed`);
  }

  // Schema-valid profile pairs allow exercising order and ordered-master
  // comparison. The manifest permits sparse original full indices; the signed
  // server snapshot has its own contiguous exported slot sequence.
  for (const mismatch of ['full index', 'ordered masters'] as const) {
    const manifest: any = structuredClone(pack.manifest);
    const serverProfile: any = structuredClone(pack.server);
    const fileTemplate = structuredClone(manifest.files.find((file: any) => file.path === 'Data/Skyrim.esm'));
    manifest.components.push({id: 'fixture-shared', name: 'Inert shared plugin fixtures',
      category: 'shared-plugin', required: true, dependencies: []});
    const addPlugin = (filename: string, order: number, masters: string[]) => {
      manifest.requiredPlugins.push({filename, required: true, order, masters, role: 'server-required', sha256: fileTemplate.sha256});
      const file = {...structuredClone(fileTemplate), path: `Data/${filename}`, componentId: 'fixture-shared',
        role: 'shared-plugin', ownership: 'external-install', distribution: 'external-only'};
      manifest.files.push(file);
      return {filename, required: true, order, masters, role: 'server-required', sha256: file.sha256,
        size: file.size, crc32: 0, light: false, headerVerified: true};
    };
    const updateManifestOrder = mismatch === 'full index' ? 2 : 1;
    const update = addPlugin('Update.esm', updateManifestOrder, ['Skyrim.esm']);
    serverProfile.plugins.push({...update, order: 1});
    if (mismatch === 'ordered masters') {
      const dragon = addPlugin('Dragonborn.esp', 2, ['Skyrim.esm', 'Update.esm']);
      serverProfile.plugins.push({...dragon, order: 2, masters: ['Update.esm', 'Skyrim.esm']});
    }
    const candidate = envelope(manifest, serverProfile);
    metadata.assets[0]!.size = Buffer.byteLength(JSON.stringify(candidate));
    assert.doesNotThrow(() => authenticateRelease(candidate, source, release), `${mismatch} candidate passes signed schema authentication`);
    signed = candidate;
    await assert.rejects(() => service.prepareForPlay(game, order), /shared plugin|compatib|mismatch/i,
      `${mismatch} incompatibility must be refused`);
    assert.equal(requests.payload, 0, `${mismatch} mismatch must be refused before payload acquisition`);
    assert.equal(service.snapshot().installed, false);
  }

  // These pairs are schema-valid and freshly authenticated too. The first
  // keeps a server-required slot whose manifest declaration has been changed
  // to client-only; the second adds a server slot absent from the signed pack.
  // Both must be stopped by the normal consumer's cross-document admission.
  const roleMismatchManifest: any = structuredClone(pack.manifest);
  roleMismatchManifest.requiredPlugins[0]!.role = 'client-only';
  const roleMismatch = envelope(roleMismatchManifest, structuredClone(pack.server));
  metadata.assets[0]!.size = Buffer.byteLength(JSON.stringify(roleMismatch));
  assert.doesNotThrow(() => authenticateRelease(roleMismatch, source, release),
    'role mismatch candidate remains authentic and schema-valid');
  signed = roleMismatch;
  await assert.rejects(() => service.prepareForPlay(game, order), /shared plugin|compatib|mismatch/i,
    'manifest/server role mismatch must be refused');
  assert.equal(requests.payload, 0, 'role mismatch is refused before payload acquisition');
  assert.deepEqual(await fs.readdir(game, {recursive: true}), before,
    'role mismatch must not write game pack/profile data');

  // Optional server-required declarations are structurally valid in the
  // signed manifest, while the server export still requires its slot. The
  // pack component and bound file are both optional to satisfy manifest rules.
  const optionalManifest: any = structuredClone(pack.manifest);
  const optionalServer: any = structuredClone(pack.server);
  optionalManifest.components.push({id: 'fixture-optional-shared', name: 'Optional inert plugin',
    category: 'shared-plugin', required: false, dependencies: []});
  const optionalTemplate = structuredClone(optionalManifest.files.find((file: any) => file.path === 'Data/Skyrim.esm'));
  optionalManifest.requiredPlugins.push({filename: 'Optional.esp', required: false, order: 1,
    masters: [], role: 'server-required', sha256: optionalTemplate.sha256});
  optionalManifest.files.push({...optionalTemplate, path: 'Data/Optional.esp', componentId: 'fixture-optional-shared',
    role: 'shared-plugin', required: false, ownership: 'external-install', distribution: 'external-only'});
  optionalServer.plugins.push({...structuredClone(pack.server.plugins[0]!), filename: 'Optional.esp', order: 1, masters: []});
  const optionalMismatch = envelope(optionalManifest, optionalServer);
  metadata.assets[0]!.size = Buffer.byteLength(JSON.stringify(optionalMismatch));
  assert.doesNotThrow(() => authenticateRelease(optionalMismatch, source, release),
    'optional manifest requirement and required server slot candidate authenticate');
  signed = optionalMismatch;
  await assert.rejects(() => service.prepareForPlay(game, order), /shared plugin|compatib|mismatch/i,
    'optional manifest/server-required role mismatch must be refused');
  assert.equal(requests.payload, 0, 'optional role mismatch is refused before payload acquisition');
  assert.deepEqual(await fs.readdir(game, {recursive: true}), before,
    'optional role mismatch must not write game pack/profile data');

  const setMismatchProfile: any = structuredClone(pack.server);
  setMismatchProfile.plugins.push({...structuredClone(pack.server.plugins[0]!),
    filename: 'Extra.esp', order: 1, masters: []});
  const setMismatch = envelope(structuredClone(pack.manifest), setMismatchProfile);
  metadata.assets[0]!.size = Buffer.byteLength(JSON.stringify(setMismatch));
  assert.doesNotThrow(() => authenticateRelease(setMismatch, source, release),
    'server-only plugin slot candidate remains authentic and schema-valid');
  signed = setMismatch;
  await assert.rejects(() => service.prepareForPlay(game, order), /shared plugin|compatib|mismatch/i,
    'server-only plugin slot must be refused');
  assert.equal(requests.payload, 0, 'plugin-set mismatch is refused before payload acquisition');
  assert.deepEqual(await fs.readdir(game, {recursive: true}), before,
    'plugin-set mismatch must not write game pack/profile data');

  // Exercise the actual GameLauncher seam with an inert executable fixture.
  // Refusal must short-circuit before its spawn callback; the matching signed
  // recovery below must reach that callback exactly once.
  const loader = path.join(game, 'skse64_loader.exe');
  await fs.writeFile(loader, 'INERT W07 TEST EXECUTABLE\n', {flag: 'wx'});
  let spawnCount = 0;
  const launcher = new GameLauncher(async () => false, async executable => {
    assert.equal(executable, loader);
    spawnCount++;
  });
  signed = envelope(pack.manifest, {...structuredClone(pack.server), plugins: [
    {...pack.server.plugins[0]!, sha256: 'f'.repeat(64)},
  ]});
  metadata.assets[0]!.size = Buffer.byteLength(JSON.stringify(signed));
  await assert.rejects(() => launcher.play(async () => {
    await service.prepareForPlay(game, order);
    return {directory: game, ready: true, runtime: '', skseLoader: '', skseRuntime: '', nativeLauncherAvailable: true, files: [], errors: [], scannedAt: new Date().toISOString()};
  }));
  assert.equal(spawnCount, 0, 'incompatible signed metadata never reaches GameLauncher spawn');

  assert.deepEqual(await fs.readdir(cache).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }), [], 'incompatible signed metadata must not create cache or ledger admission');

  // A rejected compatible-version candidate must not poison the version ledger
  // or a remembered bundle; a valid signature at that same version can recover.
  signed = pack.envelope;
  const recovered = await service.prepareForPlay(game, order);
  assert.equal(recovered.installed, true);
  assert.ok(requests.payload > 0, 'the valid recovery reaches payload acquisition');
  await launcher.play(async () => {
    await service.prepareForPlay(game, order);
    return {directory: game, ready: true, runtime: '', skseLoader: '', skseRuntime: '', nativeLauncherAvailable: true, files: [], errors: [], scannedAt: new Date().toISOString()};
  });
  assert.equal(spawnCount, 1, 'matching signed metadata reaches GameLauncher exactly once');

  // Exercise deterministic post-write drift through the real Play preparation
  // path. A missing allowed target causes prepareForPlay to repair it; the
  // rename hook then changes a watched external master before final verification.
  const repair = pack.manifest.files.find(file => file.distribution === 'allowed')!;
  const repairTarget = path.join(game, ...repair.path.split('/'));
  const masterBytesForPlayDrift = await fs.readFile(officialMaster);
  await fs.unlink(repairTarget);
  const originalRenameForPlayDrift = fs.rename.bind(fs);
  let playDriftInjected = false;
  let driftSpawnCount = 0;
  const driftLauncher = new GameLauncher(async () => false, async () => { driftSpawnCount++; });
  (fs as any).rename = async (from: string, to: string) => {
    await originalRenameForPlayDrift(from, to);
    if (!playDriftInjected && path.resolve(to) === path.resolve(repairTarget)) {
      playDriftInjected = true;
      await fs.writeFile(officialMaster, Buffer.from('INERT PLAY-PATH POST-WRITE DRIFT'));
    }
  };
  try {
    await assert.rejects(() => driftLauncher.play(async () => {
      await service.prepareForPlay(game, order);
      return {directory: game, ready: true, runtime: '', skseLoader: '', skseRuntime: '', nativeLauncherAvailable: true, files: [], errors: [], scannedAt: new Date().toISOString()};
    }), /changed|verification incomplete|external|Skyrim\.esm/i);
    assert.equal(playDriftInjected, true, 'Play fixture injected drift immediately after its pack target write');
    assert.equal(driftSpawnCount, 0, 'post-write readiness drift prevents GameLauncher spawn');
    assert.equal(service.snapshot().installed, false, 'post-write Play drift cannot report installed');
  } finally {
    (fs as any).rename = originalRenameForPlayDrift;
    await fs.writeFile(officialMaster, masterBytesForPlayDrift);
  }

  // Deterministically change an already observed external dependency immediately
  // after the explicit installer publishes one pack target. Final verification
  // must reject, and the operation must not return installed:true.
  const masterBeforeDrift = await fs.readFile(officialMaster);
  await fs.unlink(repairTarget);
  const originalRename = fs.rename.bind(fs);
  let injectedDrift = false;
  (fs as any).rename = async (from: string, to: string) => {
    await originalRename(from, to);
    if (!injectedDrift && path.resolve(to) === path.resolve(repairTarget)) {
      injectedDrift = true;
      await fs.writeFile(officialMaster, Buffer.from('INERT POST-WRITE DRIFT'));
    }
  };
  try {
    await assert.rejects(() => service.installAndActivate(game, order), /changed|verification incomplete|external|Skyrim\.esm/i);
    assert.equal(service.snapshot().installed, false, 'final-readiness failure cannot resolve as installed');
    assert.equal(injectedDrift, true, 'fixture injected drift after the target rename');
  } finally {
    (fs as any).rename = originalRename;
    await fs.writeFile(officialMaster, masterBeforeDrift);
  }
});
