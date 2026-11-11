import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ProductionDownloads} from '../src/main/management/downloads';
import {API, type DistributionSource} from '../src/main/distribution/policy';
import {canonicalTemporaryRoot} from '../src/main/temporary-root';
import {envelope, fixture, keyId, publicKey} from './distribution-fixture';

type Pack = Awaited<ReturnType<typeof fixture>>;
const now = Date.parse('2026-11-11T00:00:00.000Z');

function resign(pack: Pack, server: unknown = pack.server) {
  pack.envelope = envelope(pack.manifest, server);
  pack.metadata.assets.find(asset => asset.id === 100)!.size = Buffer.byteLength(JSON.stringify(pack.envelope));
}

async function readLedger(storage: string) {
  try {
    return await fs.readFile(path.join(storage, 'production-download-history', 'trusted-versions.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function harness(t: TestContext) {
  t.mock.timers.enable({apis: ['Date'], now});
  const temp = await canonicalTemporaryRoot();
  const storage = await fs.mkdtemp(path.join(temp, 'frostveil-w04-pack-cache-'));
  const roots = new Set([storage]);
  let current: Pack | undefined;
  let onEnvelope: (() => void) | undefined;
  let onPayload: (() => Promise<void>) | undefined;
  const payloads = new Map<number, Buffer>();
  const requests = {metadata: 0, envelope: 0, payload: 0};
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    init.signal?.throwIfAborted();
    const url = input.href;
    if (url === API + '/releases/latest') {
      requests.metadata++;
      return current ? Response.json(current.metadata) : new Response(null, {status: 404});
    }
    if (url === API + '/releases/assets/100') {
      assert.ok(current, 'The fixture must select a release before responding with its envelope');
      requests.envelope++;
      const response = Response.json(current.envelope);
      onEnvelope?.();
      return response;
    }
    const match = new RegExp('^' + API.replaceAll('.', '\\.') + '/releases/assets/(\\d+)$').exec(url);
    const bytes = match && payloads.get(Number(match[1]));
    assert.ok(bytes, 'No request outside the exact signed fixture assets is permitted');
    requests.payload++;
    await onPayload?.();
    return new Response(new Uint8Array(bytes));
  });
  t.after(async () => {
    try {
      const pointer = JSON.parse(await fs.readFile(path.join(storage, 'production-downloads.json'), 'utf8'));
      assert.match(path.basename(pointer.directory), /^frostveil-l4a-[a-z0-9]+$/i);
      roots.add(pointer.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const root of roots) {
      const resolved = await fs.realpath(root);
      assert.equal(resolved, root);
      assert.equal(path.dirname(resolved), temp);
      await fs.rm(resolved, {recursive: true, force: true});
    }
  });
  async function pack(generation = 1, assetOffset = 0) {
    const value = await fixture(generation);
    roots.add(value.grant.directory);
    if (assetOffset) {
      for (const file of value.manifest.files) {
        if (file.package) file.package.assetId += assetOffset;
      }
      for (const asset of value.metadata.assets) {
        if (asset.id !== 100) asset.id += assetOffset;
      }
      value.payloads = new Map([...value.payloads].map(([id, bytes]) => [id + assetOffset, bytes]));
      resign(value);
    }
    for (const [id, bytes] of value.payloads) payloads.set(id, bytes);
    return value;
  }
  async function player(value: Pack, includeOwnedFiles = true) {
    const game = await fs.mkdtemp(path.join(storage, 'player-'));
    const order = await fs.mkdtemp(path.join(storage, 'order-'));
    await fs.cp(value.grant.installation, game, {recursive: true});
    if (includeOwnedFiles) {
      for (const file of value.manifest.files) {
        if (!file.package) continue;
        const target = path.join(game, file.path);
        await fs.mkdir(path.dirname(target), {recursive: true});
        await fs.writeFile(target, value.payloads.get(file.package.assetId)!);
      }
    }
    await fs.writeFile(path.join(order, 'plugins.txt'), '# existing order\r\n');
    async function fingerprint() {
      const result = new Map<string, Buffer>();
      for (const dir of [game, order]) {
        for (const name of await fs.readdir(dir, {recursive: true})) {
          const target = path.join(dir, name);
          if ((await fs.lstat(target)).isFile()) result.set(target, await fs.readFile(target));
        }
      }
      return result;
    }
    return {game, order, fingerprint};
  }
  function service(value: Pack, keyExpiry?: string) {
    const source: DistributionSource = {
      mode: 'sandbox-test', channel: 'stable', packId: value.manifest.packId, permittedReviews: [],
      keys: {[keyId]: {publicKey, environment: 'test', revoked: false, expiresAt: keyExpiry}},
    };
    // An omitted providerFactory exercises the real default provider cache branch.
    const result = new ProductionDownloads(storage, '0.1.9', source);
    t.after(() => result.dispose());
    return result;
  }
  return {
    storage, pack, player, service, requests,
    select: (value?: Pack) => { current = value; },
    setEnvelopeHook: (hook: () => void) => { onEnvelope = hook; },
    setPayloadHook: (hook: () => Promise<void>) => { onPayload = hook; },
  };
}

test('W04 default-provider Play refuses a signed minimum-version rejection without touching target files or ledger', async t => {
  const h = await harness(t);
  const incompatible = await h.pack();
  incompatible.manifest.minimumLauncherVersion = '0.2.0';
  resign(incompatible);
  h.select(incompatible);
  const player = await h.player(incompatible);
  const before = await player.fingerprint();
  const service = h.service(incompatible);

  const download = await service.download();
  assert.equal(download.phase, 'error');
  assert.match(download.message, /Update Launcher/);
  await assert.rejects(() => service.prepareForPlay(player.game, player.order), /Update Launcher/);
  assert.equal(await readLedger(h.storage), null);
  assert.deepEqual(await player.fingerprint(), before);
  assert.equal(h.requests.payload, 0);
});

for (const rejection of ['older release', 'same-version mutation'] as const) {
  test('W04 default-provider Play refuses ' + rejection + ' and preserves accepted state', async t => {
    const h = await harness(t);
    const accepted = await h.pack(2);
    h.select(accepted);
    const service = h.service(accepted);
    const admittedPlayer = await h.player(accepted);
    assert.equal((await service.prepareForPlay(admittedPlayer.game, admittedPlayer.order)).installed, true);
    const ledger = await readLedger(h.storage);
    assert.ok(ledger);

    t.mock.timers.setTime(now + 15000);

    const rejected = rejection === 'older release' ? await h.pack(1, 1000) : structuredClone(accepted);
    if (rejection === 'same-version mutation') {
      resign(rejected, {...rejected.server, limitations: ['Different signed profile with the same release version']});
    }
    h.select(rejected);
    const player = await h.player(rejected);
    const before = await player.fingerprint();
    const download = await service.download();
    assert.equal(download.phase, 'error');
    assert.match(download.message, /replay\/downgrade or same-version mutation/);
    await assert.rejects(() => service.prepareForPlay(player.game, player.order), /replay\/downgrade or same-version mutation/);
    assert.deepEqual(await readLedger(h.storage), ledger);
    assert.deepEqual(await player.fingerprint(), before);
    assert.equal(h.requests.payload, 0);
  });
}

for (const expiry of ['publisher key', 'signed server profile'] as const) {
  test('W04 default-provider Play revalidates ' + expiry + ' at the exact expiry instant', async t => {
    const h = await harness(t);
    const pack = await h.pack();
    const expiryAt = new Date(now + 1000).toISOString();
    if (expiry === 'signed server profile') {
      pack.server.expiresAt = expiryAt;
      resign(pack);
    }
    h.select(pack);
    const service = h.service(pack, expiry === 'publisher key' ? expiryAt : undefined);
    const player = await h.player(pack);
    const before = await player.fingerprint();
    assert.equal((await service.prepareForPlay(player.game, player.order)).installed, true);
    const ledger = await readLedger(h.storage);
    assert.ok(ledger);
    const acceptedRequests = h.requests.metadata;

    t.mock.timers.setTime(now + 1000);
    await assert.rejects(() => service.prepareForPlay(player.game, player.order), /Expired publisher key|Stale or conflicting server profile/);
    assert.equal(h.requests.metadata, acceptedRequests + 1);
    assert.deepEqual(await readLedger(h.storage), ledger);
    assert.deepEqual(await player.fingerprint(), before);
    assert.equal(h.requests.payload, 0);
  });
}

test('W04 default-provider Play reuses a fresh admitted bundle without transport', async t => {
  const h = await harness(t);
  const pack = await h.pack();
  h.select(pack);
  const service = h.service(pack, new Date(now + 20000).toISOString());
  const player = await h.player(pack);
  const before = await player.fingerprint();
  assert.equal((await service.prepareForPlay(player.game, player.order)).installed, true);
  const ledger = await readLedger(h.storage);
  assert.ok(ledger);
  const requests = {...h.requests};

  t.mock.timers.setTime(now + 14999);
  h.select();
  assert.equal((await service.prepareForPlay(player.game, player.order)).installed, true);
  assert.deepEqual(h.requests, requests);
  assert.deepEqual(await readLedger(h.storage), ledger);
  assert.deepEqual(await player.fingerprint(), before);
});

test('W04 a backward clock step cannot extend the default provider cache', async t => {
  const h = await harness(t);
  const pack = await h.pack();
  h.select(pack);
  const service = h.service(pack);
  const player = await h.player(pack);
  assert.equal((await service.prepareForPlay(player.game, player.order)).installed, true);
  const ledger = await readLedger(h.storage);
  assert.ok(ledger);

  t.mock.timers.setTime(now - 1);
  h.select();
  await assert.rejects(() => service.prepareForPlay(player.game, player.order), /404/);
  assert.equal(h.requests.metadata, 2);
  assert.deepEqual(await readLedger(h.storage), ledger);
});

test('W04 cancellation before admission cannot make the signed release reusable at Play', async t => {
  const h = await harness(t);
  const pack = await h.pack();
  h.select(pack);
  const service = h.service(pack);
  const player = await h.player(pack);
  const before = await player.fingerprint();
  h.setEnvelopeHook(() => service.cancel());

  assert.equal((await service.download()).phase, 'cancelled');
  h.select();
  await assert.rejects(() => service.prepareForPlay(player.game, player.order), /404/);
  assert.equal(await readLedger(h.storage), null);
  assert.deepEqual(await player.fingerprint(), before);
  assert.equal(h.requests.payload, 0);
});

test('W04 cancellation after durable admission invalidates the older reusable release', async t => {
  const h = await harness(t);
  const accepted = await h.pack(1);
  const next = await h.pack(2, 1000);
  h.select(accepted);
  const service = h.service(accepted);
  const player = await h.player(accepted);
  assert.equal((await service.prepareForPlay(player.game, player.order)).installed, true);
  const before = await player.fingerprint();

  const rename = fs.rename;
  const ledgerPath = path.join(h.storage, 'production-download-history', 'trusted-versions.json');
  t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof rename>) => {
    await rename(source, destination);
    if (destination === ledgerPath) service.cancel();
  });
  h.select(next);
  assert.equal((await service.download()).phase, 'cancelled');
  const ledger = await readLedger(h.storage);
  assert.ok(ledger);
  assert.equal(JSON.parse(ledger.toString())[0].version, next.manifest.packVersion);

  h.select();
  await assert.rejects(() => service.prepareForPlay(player.game, player.order), /404/);
  assert.deepEqual(await readLedger(h.storage), ledger);
  assert.deepEqual(await player.fingerprint(), before);
  assert.equal(h.requests.payload, 0);
});

test('W04 rejects a profile that expires during download before installation writes', async t => {
  const h = await harness(t);
  const pack = await h.pack();
  pack.server.expiresAt = new Date(now + 1000).toISOString();
  resign(pack);
  h.select(pack);
  const player = await h.player(pack, false);
  const before = await player.fingerprint();
  const service = h.service(pack);
  let admitted: Buffer | null = null;
  h.setPayloadHook(async () => {
    if (admitted) return;
    admitted = await readLedger(h.storage);
    assert.ok(admitted);
    t.mock.timers.setTime(now + 1000);
  });

  await assert.rejects(() => service.installAndActivate(player.game, player.order), /Stale or conflicting server profile/);
  assert.ok(admitted);
  assert.equal(h.requests.payload, pack.payloads.size);
  assert.deepEqual(await readLedger(h.storage), admitted);
  assert.deepEqual(await player.fingerprint(), before);
});

for (const entry of ['installation', 'Play'] as const) {
  test('W04 ' + entry + ' uses its admitted release when another inspection admits a newer one', async t => {
    const h = await harness(t);
    const original = await h.pack(1);
    const next = await h.pack(2, 1000);
    h.select(original);
    const player = await h.player(original, false);
    const inspection = await h.player(next);
    const beforeInspection = await inspection.fingerprint();
    const service = h.service(original);
    let inspected = false;
    h.setPayloadHook(async () => {
      if (inspected) return;
      inspected = true;
      t.mock.timers.setTime(now + 15000);
      h.select(next);
      assert.equal((await service.inspectInstallation(inspection.game, inspection.order)).installed, true);
    });

    const installed = entry === 'Play'
      ? await service.prepareForPlay(player.game, player.order)
      : await service.installAndActivate(player.game, player.order);
    assert.equal(inspected, true);
    assert.equal(installed.installed, true);
    assert.equal(installed.version, original.manifest.packVersion);
    assert.equal(h.requests.metadata, 2, 'Installation verification must use its original admitted bundle');
    const ledger = await readLedger(h.storage);
    assert.ok(ledger);
    assert.equal(JSON.parse(ledger.toString())[0].version, next.manifest.packVersion);
    assert.deepEqual(await inspection.fingerprint(), beforeInspection);
    for (const file of original.manifest.files) {
      if (file.package) assert.deepEqual(await fs.readFile(path.join(player.game, file.path)), original.payloads.get(file.package.assetId));
    }
  });
}
