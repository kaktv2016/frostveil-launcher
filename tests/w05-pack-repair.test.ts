import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {ProductionDownloads} from '../src/main/management/downloads';
import type {DistributionSource} from '../src/main/distribution/policy';
import {GitHubDistributionProvider} from '../src/main/distribution/github';
import {DistributionTransport} from '../src/main/distribution/transport';
import {canonicalTemporaryRoot} from '../src/main/temporary-root';
import {fixture, keyId, publicKey} from './distribution-fixture';

type Pack = Awaited<ReturnType<typeof fixture>>;

interface FileSnapshot {
  path: string;
  bytes: Buffer;
  identity: string;
  mtimeMs: number;
}

async function filesUnder(root: string): Promise<FileSnapshot[]> {
  const result: FileSnapshot[] = [];
  for (const name of await fs.readdir(root, {recursive: true})) {
    const target = path.join(root, name);
    if ((await fs.lstat(target)).isFile()) {
      const stat = await fs.stat(target, {bigint: true});
      result.push({
        path: name,
        bytes: await fs.readFile(target),
        identity: `${stat.dev}:${stat.ino}`,
        mtimeMs: Number(stat.mtimeMs),
      });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function fileSnapshot(file: string): Promise<FileSnapshot> {
  const stat = await fs.stat(file, {bigint: true});
  return {
    path: file,
    bytes: await fs.readFile(file),
    identity: `${stat.dev}:${stat.ino}`,
    mtimeMs: Number(stat.mtimeMs),
  };
}

async function retainedTreeMetrics(roots: string[]) {
  const identities = new Set<string>();
  const metrics = {logicalBytes: 0, uniqueBytes: 0, partialBytes: 0, partialFiles: 0, promotionTemporaryBytes: 0, promotionTemporaryFiles: 0, finalPayloadBytes: 0, finalPayloadFiles: 0, hardLinkedFiles: 0};
  for (const root of roots) {
    for (const name of await fs.readdir(root, {recursive: true})) {
      const target = path.join(root, name);
      const item = await fs.lstat(target, {bigint: true});
      if (!item.isFile()) continue;
      const identity = `${item.dev}:${item.ino}`;
      metrics.logicalBytes += Number(item.size);
      if (!identities.has(identity)) {
        identities.add(identity);
        metrics.uniqueBytes += Number(item.size);
      }
      if (item.nlink > 1n) metrics.hardLinkedFiles++;
      if (name.endsWith('.partial')) {
        metrics.partialBytes += Number(item.size);
        metrics.partialFiles++;
      } else if (name.includes('.verified-') || name.includes('.frostveil-')) {
        metrics.promotionTemporaryBytes += Number(item.size);
        metrics.promotionTemporaryFiles++;
      } else if (name.endsWith('.bin')) {
        metrics.finalPayloadBytes += Number(item.size);
        metrics.finalPayloadFiles++;
      }
    }
  }
  return metrics;
}

function testSource(pack: Pack): DistributionSource {
  return {
    mode: 'sandbox-test',
    packId: pack.manifest.packId,
    channel: 'stable',
    permittedReviews: [],
    keys: {[keyId]: {publicKey, environment: 'test', revoked: false}},
  };
}

async function makeServer(pack: Pack) {
  const requests = {metadata: 0, envelope: 0, payload: new Map<number, number>()};
  const server = http.createServer((req, res) => {
    const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (requestPath === '/repos/kaktv2016/frostveil-distribution/releases/latest') {
      requests.metadata++;
      res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(pack.metadata));
      return;
    }
    if (requestPath === '/repos/kaktv2016/frostveil-distribution/releases/assets/100') {
      requests.envelope++;
      res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(pack.envelope));
      return;
    }
    const match = /^\/repos\/kaktv2016\/frostveil-distribution\/releases\/assets\/(\d+)$/.exec(requestPath);
    const id = match ? Number(match[1]) : 0;
    const bytes = pack.payloads.get(id);
    if (!bytes) {
      res.writeHead(404).end();
      return;
    }
    requests.payload.set(id, (requests.payload.get(id) ?? 0) + 1);
    res.writeHead(200, {'content-length': String(bytes.length)}).end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const transport = DistributionTransport.loopback(
    'http://127.0.0.1:' + (server.address() as {port: number}).port,
    'sandbox-test',
  );
  return {
    requests,
    provider: () => new GitHubDistributionProvider(transport),
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function snapshotPayloadRequests(requests: Map<number, number>) {
  return new Map(requests);
}

function assertNoPayloadRequest(
  before: Map<number, number>,
  after: Map<number, number>,
  assetId: number,
) {
  assert.equal(after.get(assetId) ?? 0, before.get(assetId) ?? 0);
}

test('W05 Play repair protects corrupt cache, verifies installs, and reuses unchanged payloads', async t => {
  const pack = await fixture();
  const temp = await canonicalTemporaryRoot();
  const root = await fs.mkdtemp(path.join(temp, 'frostveil-w05-pack-repair-'));
  const corruptStorage = path.join(root, 'corrupt-cache');
  const sentinelPaths = [
    path.join(corruptStorage, 'unknown-cache-entry.bin'),
    path.join(corruptStorage, 'auto-repair-backups', 'owner-backup-sentinel.bin'),
    path.join(corruptStorage, 'transactions', 'owner-journal-sentinel.json'),
  ];
  for (const file of sentinelPaths) {
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, Buffer.from('W05 protected fixture sentinel: ' + path.basename(file)), {flag: 'wx'});
  }
  const sentinelBefore = await Promise.all(sentinelPaths.map(fileSnapshot));
  const game = path.join(root, 'game');
  const order = path.join(root, 'order');
  await fs.cp(pack.grant.installation, game, {recursive: true});
  await fs.mkdir(order);
  await fs.writeFile(path.join(order, 'plugins.txt'), '# existing profile\r\n');
  const server = await makeServer(pack);
  const promotions: Array<{bytes: number; retainedPayloadBytesBefore: number; concurrentPayloadBytes: number; source: string; destination: string}> = [];
  const promotionCopies: Array<{bytes: number; retainedPayloadBytesBefore: number; concurrentPayloadBytes: number; source: string; destination: string}> = [];
  const destinationCopies: Array<{bytes: number; concurrentPayloadBytes: number; source: string; destination: string}> = [];
  const targetRenames: Array<{source: string; destination: string}> = [];
  const targetWrites: string[] = [];
  const originalRename = fs.rename.bind(fs);
  const originalCopyFile = fs.copyFile.bind(fs);
  const originalWriteFile = fs.writeFile.bind(fs);
  t.mock.method(fs, 'rename', async (source: Parameters<typeof originalRename>[0], destination: Parameters<typeof originalRename>[1]) => {
    let sourceBytes = 0;
    try {
      sourceBytes = (await fs.stat(source)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let retainedPayloadBytesBefore = 0;
    if (String(source).includes('.bin.verified-')) {
      for (const name of await fs.readdir(path.dirname(String(source)))) {
        if (name.endsWith('.bin') || name.endsWith('.partial')) retainedPayloadBytesBefore += (await fs.stat(path.join(path.dirname(String(source)), name))).size;
      }
    }
    await originalRename(source, destination);
    if ([game, order].some(root => String(destination).toLowerCase().startsWith(root.toLowerCase() + path.sep))) {
      targetRenames.push({source: String(source), destination: String(destination)});
    }
    if (String(source).includes('.bin.verified-') && String(destination).endsWith('.bin')) {
      promotions.push({bytes: sourceBytes, retainedPayloadBytesBefore, concurrentPayloadBytes: retainedPayloadBytesBefore + sourceBytes, source: path.basename(String(source)), destination: path.basename(String(destination))});
    }
  });
  t.mock.method(fs, 'copyFile', async (source: Parameters<typeof originalCopyFile>[0], destination: Parameters<typeof originalCopyFile>[1], mode: Parameters<typeof originalCopyFile>[2]) => {
    await originalCopyFile(source, destination, mode);
    if (String(source).endsWith('.partial') && String(destination).includes('.bin.verified-')) {
      const bytes = (await fs.stat(destination)).size;
      let retainedPayloadBytesBefore = 0;
      for (const name of await fs.readdir(path.dirname(String(source)))) {
        if (name.endsWith('.bin') || name.endsWith('.partial')) retainedPayloadBytesBefore += (await fs.stat(path.join(path.dirname(String(source)), name))).size;
      }
      promotionCopies.push({bytes, retainedPayloadBytesBefore, concurrentPayloadBytes: retainedPayloadBytesBefore + bytes, source: path.basename(String(source)), destination: path.basename(String(destination))});
    }
    if (String(source).includes(`${path.sep}packages${path.sep}`) && String(destination).includes('.frostveil-')) {
      const bytes = (await fs.stat(destination)).size;
      let retainedFinalBytes = 0;
      for (const name of await fs.readdir(path.dirname(String(source)))) {
        if (name.endsWith('.bin') || name.endsWith('.partial')) retainedFinalBytes += (await fs.stat(path.join(path.dirname(String(source)), name))).size;
      }
      destinationCopies.push({bytes, concurrentPayloadBytes: retainedFinalBytes + bytes, source: path.basename(String(source)), destination: path.basename(String(destination))});
    }
  });
  t.mock.method(fs, 'writeFile', async (file: Parameters<typeof originalWriteFile>[0], data: Parameters<typeof originalWriteFile>[1], options: Parameters<typeof originalWriteFile>[2]) => {
    await originalWriteFile(file, data, options);
    if ([game, order].some(root => String(file).toLowerCase().startsWith(root.toLowerCase() + path.sep))) {
      targetWrites.push(String(file));
    }
  });
  const service = new ProductionDownloads(
    path.join(root, 'corrupt-cache'),
    '0.1.9',
    testSource(pack),
    server.provider,
  );
  const independent = new ProductionDownloads(
    path.join(root, 'recovery-cache'),
    '0.1.9',
    testSource(pack),
    server.provider,
  );
  t.after(async () => {
    service.dispose();
    independent.dispose();
    await server.close();
    for (const child of [root, pack.grant.directory]) {
      const resolved = await fs.realpath(child);
      assert.equal(path.dirname(resolved), temp);
      await fs.rm(resolved, {recursive: true, force: true});
    }
  });

  const packageFile = pack.manifest.files.find(file => file.package)!;
  const reference = packageFile.package!;
  const downloaded = await service.download();
  assert.equal(downloaded.phase, 'complete', downloaded.message);
  assert.ok(reference.size > 0);

  const pointer = JSON.parse(await fs.readFile(path.join(root, 'corrupt-cache', 'production-downloads.json'), 'utf8'));
  const cacheRoot = pointer.directory as string;
  assert.equal(path.dirname(await fs.realpath(cacheRoot)), temp);
  const corruptPath = path.join(cacheRoot, 'packages', reference.sha256 + '.bin');
  const corruptBytes = Buffer.from('protected corrupt fixture bytes');
  await fs.writeFile(corruptPath, corruptBytes);
  const corruptId = await fs.stat(corruptPath, {bigint: true}).then(stat => `${stat.dev}:${stat.ino}`);
  const targetBefore = await filesUnder(game);
  const orderBefore = await filesUnder(order);
  const requestsBefore = snapshotPayloadRequests(server.requests.payload);
  const metadataBefore = server.requests.metadata;
  const envelopeBefore = server.requests.envelope;
  const promotionsBeforeRefusal = promotions.length;
  const promotionCopiesBeforeRefusal = promotionCopies.length;
  const copiesBeforeRefusal = destinationCopies.length;
  const targetRenamesBeforeRefusal = targetRenames.length;
  const targetWritesBeforeRefusal = targetWrites.length;

  await assert.rejects(
    () => service.prepareForPlay(game, order),
    /protected cache integrity conflict.*(?:independently verified cache|ownership assessment)/i,
  );

  assert.deepEqual(await fs.readFile(corruptPath), corruptBytes);
  assert.equal(await fs.stat(corruptPath, {bigint: true}).then(stat => `${stat.dev}:${stat.ino}`), corruptId);
  assert.deepEqual(await filesUnder(game), targetBefore);
  assert.deepEqual(await filesUnder(order), orderBefore);
  assert.deepEqual(await Promise.all(sentinelPaths.map(fileSnapshot)), sentinelBefore);
  assertNoPayloadRequest(requestsBefore, server.requests.payload, reference.assetId);
  assert.equal(promotions.length, promotionsBeforeRefusal);
  assert.equal(promotionCopies.length, promotionCopiesBeforeRefusal);
  assert.equal(destinationCopies.length, copiesBeforeRefusal);
  assert.equal(targetRenames.length, targetRenamesBeforeRefusal);
  assert.equal(targetWrites.length, targetWritesBeforeRefusal);
  const requestsAfterRefusal = snapshotPayloadRequests(server.requests.payload);
  const requestsDuringRefusalByAsset: Record<string, number> = {};
  for (const assetId of new Set([...requestsBefore.keys(), ...requestsAfterRefusal.keys()])) {
    requestsDuringRefusalByAsset[String(assetId)] = (requestsAfterRefusal.get(assetId) ?? 0) - (requestsBefore.get(assetId) ?? 0);
  }
  const metadataDuringRefusal = server.requests.metadata - metadataBefore;
  const envelopeDuringRefusal = server.requests.envelope - envelopeBefore;
  const targetRenamesDuringRefusal = targetRenames.length - targetRenamesBeforeRefusal;
  const targetWritesDuringRefusal = targetWrites.length - targetWritesBeforeRefusal;
  assert.equal(targetRenamesDuringRefusal, 0);
  assert.equal(targetWritesDuringRefusal, 0);

  const recovery = await independent.prepareForPlay(game, order);
  assert.equal(recovery.installed, true);
  for (const file of pack.manifest.files.filter(value => value.distribution === 'allowed')) {
    const expected = pack.payloads.get(file.package!.assetId)!;
    assert.deepEqual(await fs.readFile(path.join(game, file.path)), expected);
  }
  assert.equal(promotions.length - promotionsBeforeRefusal, pack.manifest.files.filter(file => file.package).length);
  assert.equal(promotionCopies.length - promotionCopiesBeforeRefusal, pack.manifest.files.filter(file => file.package).length);
  assert.equal(destinationCopies.length, pack.manifest.files.filter(file => file.distribution === 'allowed').length);
  assert.ok([...server.requests.payload.values()].some(count => count > 0));

  const requestCountsAfterInstall = snapshotPayloadRequests(server.requests.payload);
  const unchanged = await independent.prepareForPlay(game, order);
  assert.equal(unchanged.installed, true);
  assert.deepEqual(snapshotPayloadRequests(server.requests.payload), requestCountsAfterInstall);

  const repairedPath = packageFile.path;
  const installedPath = path.join(game, repairedPath);
  const companionFile = pack.manifest.files.find(file => file.distribution === 'allowed' && file.path !== repairedPath)!;
  const companionSnapshot = await fileSnapshot(path.join(game, companionFile.path));
  await fs.unlink(installedPath);
  const copiesBeforeRepair = destinationCopies.length;
  const repaired = await independent.prepareForPlay(game, order);
  assert.equal(repaired.installed, true);
  assert.deepEqual(await fs.readFile(installedPath), pack.payloads.get(reference.assetId));
  assert.deepEqual(await fileSnapshot(path.join(game, companionFile.path)), companionSnapshot);
  assert.deepEqual(snapshotPayloadRequests(server.requests.payload), requestCountsAfterInstall);
  assert.equal(destinationCopies.length - copiesBeforeRepair, 1);
  assert.equal(destinationCopies.at(-1)?.bytes, reference.size);
  assert.deepEqual(await Promise.all(sentinelPaths.map(fileSnapshot)), sentinelBefore);

  const downloadedBytes = pack.manifest.files
    .filter(file => file.package)
    .reduce((total, file) => total + file.package!.size, 0);
  const recoveryPointer = JSON.parse(await fs.readFile(path.join(root, 'recovery-cache', 'production-downloads.json'), 'utf8')) as {directory: string};
  const recoveryPayloadRoot = path.join(recoveryPointer.directory, 'packages');
  let cachePayloadBytes = 0;
  for (const name of await fs.readdir(recoveryPayloadRoot)) {
    if (name.endsWith('.bin')) cachePayloadBytes += (await fs.stat(path.join(recoveryPayloadRoot, name))).size;
  }
  assert.equal(cachePayloadBytes, downloadedBytes);
  const retained = await retainedTreeMetrics([cacheRoot, recoveryPointer.directory]);
  assert.equal(retained.hardLinkedFiles, 0);
  assert.equal(retained.uniqueBytes, retained.logicalBytes);
  assert.equal(retained.partialFiles, pack.manifest.files.filter(file => file.package).length * 2);
  assert.equal(retained.partialBytes, downloadedBytes * 2);
  assert.equal(retained.promotionTemporaryFiles, 0);
  const peakMeasuredTemporaryBytes = Math.max(
    0,
    ...promotionCopies.map(event => event.concurrentPayloadBytes),
    ...promotions.map(event => event.concurrentPayloadBytes),
    ...destinationCopies.map(event => event.concurrentPayloadBytes),
  );
  assert.ok(server.requests.metadata >= 1);
  assert.ok(server.requests.envelope >= 1);
  assert.equal(service.snapshot().phase, 'error');
  assert.equal(service.snapshot().installed, false);
  const metrics = {
    signedPackageCount: pack.manifest.files.filter(file => file.package).length,
    signedPackageBytes: downloadedBytes,
    retainedVerifiedCacheBytes: cachePayloadBytes,
    measuredRetainedCacheTree: retained,
    protectedSentinels: sentinelBefore.map(file => ({path: path.relative(root, file.path), bytes: file.bytes.length, identity: file.identity})),
    protectedSentinelBytesCountedSeparately: sentinelBefore.reduce((total, file) => total + file.bytes.length, 0),
    networkPayloadRequestsByAsset: Object.fromEntries(server.requests.payload),
    networkPayloadRequests: [...server.requests.payload.values()].reduce((total, count) => total + count, 0),
    packageRequestsDuringRefusalByAsset: requestsDuringRefusalByAsset,
    metadataRequestsDuringRefusal: metadataDuringRefusal,
    envelopeRequestsDuringRefusal: envelopeDuringRefusal,
    affectedCorruptAssetRequestsDuringRefusal: (requestsAfterRefusal.get(reference.assetId) ?? 0) - (requestsBefore.get(reference.assetId) ?? 0),
    installationWritesOnRefusal: 0,
    measuredCachePromotions: promotions.slice(promotionsBeforeRefusal),
    measuredCachePromotionCopies: promotionCopies.slice(promotionCopiesBeforeRefusal),
    measuredDestinationCopies: destinationCopies,
    measuredPeakOverlappingPayloadBytes: peakMeasuredTemporaryBytes,
    observedTargetRenameCountOnRefusal: targetRenamesDuringRefusal,
    observedTargetWriteFileCountOnRefusal: targetWritesDuringRefusal,
    observedTargetRenameCountAcrossSuccessfulRuns: targetRenames.length,
    observedDestinationCopiesOnOneFileRepair: destinationCopies.length - copiesBeforeRepair,
    fixtureDownloadSerializationBound: 'Package references are acquired sequentially. Completed partial files remain for recovery, so retained final files plus partials are counted without cleanup credit. At most one partial is actively written, with one verified promotion copy during publication.',
    fixturePeakPartialBytesBound: downloadedBytes * 2,
    fixtureActivePartialFilesBound: 1,
    fixtureRetainedPartialFiles: pack.manifest.files.filter(file => file.package).length,
    destinationRepairBytes: reference.size,
    measuredCandidateVolume: false,
    measuredCandidatePeakMemory: false,
  };
  t.diagnostic('W05 pack repair metrics ' + JSON.stringify(metrics));
});
