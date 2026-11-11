import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { effectiveClientRequirement, effectiveNativeRequirement } from '../src/main/client-repair';
import { authenticateRelease, type DistributionSource } from '../src/main/distribution/policy';
import { evaluateCompatibility } from '../src/main/modpack/compatibility';
import { checkPlugins } from '../src/main/modpack/plugins';
import { authenticateRuntimeCohort, type RuntimeCohort } from '../src/main/runtime/policy';
import {
  authenticateLauncherUpdate, LAUNCHER_MANIFEST_ASSET, LauncherUpdateLedger, signLauncherUpdateManifest,
  validateLauncherUpdateManifest, verifyDownloadedInstaller, type LauncherUpdateSource,
} from '../src/main/update-integrity';
import type { FileEvidence, ServerProfile } from '../src/shared/modpack-contracts';
import { envelope, fixture, keyId, publicKey, testKey } from './distribution-fixture';

const updaterId = 'w04-updater-fixture';
const installedVersion = '0.1.25';
const version = '0.1.30';
const iso = (value: number) => new Date(value).toISOString();
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (key: string) => sha(createPublicKey(key).export({ format: 'der', type: 'spki' }));

async function qualificationFixture(t: TestContext) {
  const start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', () => { throw Error('W04 qualification uses local fixture bytes'); });
  const f = await fixture();
  const game = f.grant.installation;
  const pack = { ...f.manifest, generatedAt: iso(start) };
  const server = { ...f.server, generatedAt: iso(start), expiresAt: iso(start + 120000) } as ServerProfile;
  const contentKeys = {
    [keyId]: { publicKey, environment: 'test' as const, revoked: false, expiresAt: iso(start + 360000) },
  };
  const contentSource: DistributionSource = {
    mode: 'sandbox-test', packId: pack.packId, channel: 'stable', keys: contentKeys, permittedReviews: [],
  };
  function signPack(profile = server) {
    const signed = envelope(pack, profile);
    const release = structuredClone(f.metadata);
    release.assets.find(asset => asset.id === 100)!.size = Buffer.byteLength(JSON.stringify(signed));
    return { signed, release };
  }

  for (const file of pack.files.filter(file => file.package)) {
    const target = path.join(game, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.payloads.get(file.package!.assetId)!, { flag: 'wx' });
  }
  const fileEvidence: FileEvidence[] = await Promise.all(pack.files.map(async file => {
    const bytes = await fs.readFile(path.join(game, file.path));
    assert.equal(sha(bytes), file.sha256);
    assert.equal(bytes.length, file.size);
    return {
      path: file.path, componentId: file.componentId, required: file.required, status: 'verified',
      expectedHash: file.sha256, expectedSize: file.size, observedHash: sha(bytes), observedSize: bytes.length,
    };
  }));
  const plugins = await checkPlugins(game, pack.requiredPlugins, {
    pluginsText: '# synthetic profile', loadorderText: null, cccText: null, managed: false,
  });

  const depots = [
    { id: '489831', manifest: '8442952117333549665' },
    { id: '489832', manifest: '8042843504692938467' },
    { id: '489833', manifest: '1914580699073641964' },
  ];
  const runtimeBytes = [
    { path: 'Data/Skyrim.esm', bytes: await fs.readFile(path.join(game, 'Data/Skyrim.esm')) },
    { path: 'Data/Skyrim - Voices_en0.bsa', bytes: Buffer.from('inert voices') },
    { path: 'SkyrimSE.exe', bytes: Buffer.from('inert runtime') },
  ];
  const helper = Buffer.from('inert helper 3.4.0');
  const helperPath = path.join(f.grant.directory, 'helper-fixture.bin');
  await fs.writeFile(helperPath, helper, { flag: 'wx' });
  for (const file of runtimeBytes.slice(1)) await fs.writeFile(path.join(game, file.path), file.bytes, { flag: 'wx' });
  const policy: RuntimeCohort = {
    schemaVersion: 1, kind: 'frostveil-steam-runtime', runtime: '1.6.1170.0', appId: '489830', language: 'english',
    createdAt: iso(start), expiresAt: iso(start + 300000), depots,
    files: runtimeBytes.map((file, i) => ({ path: file.path, size: file.bytes.length, sha256: sha(file.bytes), depot: depots[i]!.id })),
    creations: [],
    managedFiles: pack.files.filter(file => file.path !== 'Data/Skyrim.esm').map(file => {
      const { path, size, sha256 } = effectiveNativeRequirement(effectiveClientRequirement(file));
      // The runtime policy requires the canonical Data prefix.
      return { path: path.replace(/^data\//i, 'Data/'), size, sha256 };
    }),
    pluginOrder: [], configuration: { pluginsBase64: '', loadorderBase64: '' },
    helper: { version: '3.4.0', size: helper.length, sha256: sha(helper) },
    acquisition: { verified: true, receiptSha256: sha('W04 synthetic acquisition') },
  };
  function signRuntime(runtime = policy) {
    const bytes = Buffer.from(JSON.stringify(runtime));
    return { keyId, payloadBase64: bytes.toString('base64'), signatureBase64: sign(null, bytes, testKey).toString('base64') };
  }

  const updateKeys = generateKeyPairSync('ed25519');
  const updaterPublic = updateKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const updateSource: LauncherUpdateSource = {
    mode: 'disposable-test', owner: 'kaktv2016', repo: 'frostveil-launcher', channel: 'stable',
    keys: { [updaterId]: { publicKey: updaterPublic, environment: 'test', revoked: false, expiresAt: iso(start + 420000) } },
  };
  const installer = Buffer.from('MZ inert W04 NSIS byte fixture');
  const installerPath = path.join(f.grant.directory, 'w04-installer-fixture.exe');
  await fs.writeFile(installerPath, installer, { flag: 'wx' });
  function signUpdate(bytes = installer, releaseVersion = version) {
    const manifest = validateLauncherUpdateManifest({
      schemaVersion: 1, keyId: updaterId, owner: updateSource.owner, repo: updateSource.repo,
      tag: 'v' + releaseVersion, version: releaseVersion, channel: 'stable', minimumLauncherVersion: '0.1.20',
      publishedAt: iso(start), expiresAt: iso(start + 480000), releaseNotes: 'W04 synthetic update',
      installer: { assetId: 200, assetName: 'w04-fixture.exe', size: bytes.length, sha256: sha(bytes),
        sha512: createHash('sha512').update(bytes).digest('base64') },
    });
    const signed = signLauncherUpdateManifest(manifest, updateKeys.privateKey);
    const serialized = JSON.stringify(signed);
    const release = {
      id: 101, tag_name: manifest.tag, draft: false, prerelease: false, published_at: manifest.publishedAt,
      body: manifest.releaseNotes, assets: [
        { id: 200, name: manifest.installer.assetName, size: bytes.length, state: 'uploaded', digest: 'sha256:' + sha(bytes) },
        { id: 201, name: LAUNCHER_MANIFEST_ASSET, size: Buffer.byteLength(serialized), state: 'uploaded', digest: 'sha256:' + sha(serialized) },
      ],
    };
    return { signed, release, manifest };
  }
  function compatible(bundle: ReturnType<typeof authenticateRelease>) {
    return evaluateCompatibility({
      manifest: bundle.manifest, server: bundle.server, files: fileEvidence, plugins, trust: 'AUTHENTICATED',
      launcherVersion: version, channel: 'stable', now, runtime: {
        ready: true, runtime: '1.6.1170.0', skseLoader: '0.2.2.6', skseRuntime: '0.2.2.6',
      },
    });
  }

  return {
    start, f, game, policy, contentKeys, contentSource, server, updateSource, updaterPublic, helperPath, installerPath, fileEvidence,
    signPack, signRuntime, signUpdate, compatible, setNow: (value: number) => { now = value; },
    verifyInstaller: (update: ReturnType<typeof signUpdate>) => verifyDownloadedInstaller(
      installerPath, update.manifest.installer.sha512, [], async () => { throw Error('Fixture cannot use Authenticode'); },
      { source: updateSource, envelope: update.signed, release: update.release, installedVersion, now: () => now },
    ),
  };
}

function qualifyWindow(start: number, end: number, expiries: string[]) {
  const deadline = Math.min(...expiries.map(value => Date.parse(value)));
  assert.ok(Number.isFinite(deadline) && start < end && end < deadline, 'UTC test window crosses the earliest expiry');
  return iso(deadline);
}

test('W04 authenticates and binds one synthetic candidate and its test window', async t => {
  const f = await qualificationFixture(t);
  const runtimeEnvelope = f.signRuntime(), packEnvelope = f.signPack(), updateEnvelope = f.signUpdate();
  const runtime = authenticateRuntimeCohort(runtimeEnvelope, f.contentKeys, { fixture: true });
  const pack = authenticateRelease(packEnvelope.signed, f.contentSource, packEnvelope.release);
  const update = authenticateLauncherUpdate(updateEnvelope.signed, f.updateSource, updateEnvelope.release, installedVersion);
  await f.verifyInstaller(updateEnvelope);
  assert.equal(runtime.runtime, pack.manifest.requiredSkyrimRuntime);
  assert.equal(runtime.runtime, pack.server.runtime);
  assert.equal(pack.manifest.requiredSKSEVersion, pack.server.skseVersion);
  assert.equal(f.compatible(pack).status, 'Compatible');
  assert.notEqual(fingerprint(publicKey), fingerprint(f.updaterPublic));
  assert.equal(pack.manifestHash, sha(Buffer.from(packEnvelope.signed.payloadBase64, 'base64')));
  assert.equal(update.manifestHash, sha(Buffer.from(updateEnvelope.signed.payloadBase64, 'base64')));
  for (const file of [...runtime.files, ...runtime.managedFiles]) {
    const declaredPath = pack.manifest.files.find(entry => entry.path.toLowerCase() === file.path.toLowerCase())?.path;
    const bytes = await fs.readFile(path.join(f.game, declaredPath ?? file.path));
    assert.deepEqual({ size: bytes.length, sha256: sha(bytes) }, { size: file.size, sha256: file.sha256 });
  }
  const helperBytes = await fs.readFile(f.helperPath);
  assert.equal(sha(helperBytes), runtime.helper.sha256);
  assert.equal(helperBytes.length, runtime.helper.size);
  const effectiveNative = pack.manifest.skyMPClientRequirements!.nativeFiles.map(relative => {
    const file = pack.manifest.files.find(entry => entry.path.toLowerCase() === relative.toLowerCase())!;
    const { path, size, sha256 } = effectiveNativeRequirement(effectiveClientRequirement(file));
    const identity = { path, size, sha256 };
    const managed = runtime.managedFiles.find(entry => entry.path.toLowerCase() === path.toLowerCase());
    assert.deepEqual({ ...managed, path }, identity);
    const observed = f.fileEvidence.find(entry => entry.path.toLowerCase() === path.toLowerCase());
    assert.ok(observed);
    assert.deepEqual({ size: observed.observedSize, sha256: observed.observedHash }, { size, sha256 });
    return { path, expected: { size, sha256 }, observed: { size: observed.observedSize, sha256: observed.observedHash } };
  });
  const observedInstaller = await fs.readFile(f.installerPath);
  const installerIdentity = { size: observedInstaller.length, sha256: sha(observedInstaller),
    sha512: createHash('sha512').update(observedInstaller).digest('base64') };
  assert.deepEqual({ ...update.manifest.installer, ...installerIdentity }, update.manifest.installer);
  const expiries = [
    f.contentKeys[keyId]!.expiresAt, f.updateSource.keys[updaterId]!.expiresAt!,
    runtime.expiresAt, pack.server.expiresAt, update.manifest.expiresAt,
  ];
  const windowEnd = f.start + 60000;
  const deadline = qualifyWindow(f.start, windowEnd, expiries);
  assert.equal(deadline, pack.server.expiresAt);
  for (const end of [Date.parse(deadline), Date.parse(deadline) + 1]) {
    assert.throws(() => qualifyWindow(f.start, end, expiries), /earliest expiry/);
  }
  t.diagnostic(JSON.stringify({
    scope: 'Synthetic candidate qualification with the existing verifiers',
    runtime: { version: runtime.runtime, appId: runtime.appId, language: runtime.language, helper: runtime.helper, depots: runtime.depots },
    pack: { id: pack.manifest.packId, version: pack.manifest.packVersion, client: pack.server.clientIdentity,
      serverId: pack.server.id, serverVersion: pack.server.version, engineCommit: pack.server.engineCommit,
      skseVersion: pack.server.skseVersion, effectiveNative, sharedPlugins: pack.server.plugins },
    updater: { releaseId: update.release.id, tag: update.release.tag_name,
      expectedInstaller: update.manifest.installer, observedInstaller: installerIdentity },
    trustFingerprints: { content: fingerprint(publicKey), updater: fingerprint(f.updaterPublic) },
    envelopeSha256: { runtime: sha(JSON.stringify(runtimeEnvelope)), pack: sha(JSON.stringify(packEnvelope.signed)),
      updater: sha(JSON.stringify(updateEnvelope.signed)) },
    utcWindow: { start: iso(f.start), end: iso(windowEnd), earliestExpiry: deadline },
    enforcement: { profileComparison: 'offline compatibility evaluator', window: 'test-only composition' },
  }));
});

test('W04 rejects signed profile and installer disagreements at their actual enforcement points', async t => {
  const f = await qualificationFixture(t);
  const server = structuredClone(f.server);
  server.plugins[0]!.sha256 = 'd'.repeat(64);
  const pack = f.signPack(server);
  const authentic = authenticateRelease(pack.signed, f.contentSource, pack.release);
  const evaluation = f.compatible(authentic);
  assert.equal(evaluation.status, 'Incompatible');
  assert.ok(evaluation.reasons.some(reason => reason.code === 'server-plugins'));
  const alternate = f.signUpdate(Buffer.from('MZ separately signed W04 installer'));
  const authenticated = authenticateLauncherUpdate(alternate.signed, f.updateSource, alternate.release, installedVersion);
  assert.notEqual(authenticated.manifest.installer.sha256, sha(await fs.readFile(f.installerPath)));
  await assert.rejects(f.verifyInstaller(alternate), /checksum|size/i);
  t.diagnostic('Shared-plugin mismatch is refused by the offline compatibility evaluator. Installer mismatch is refused by the real installer byte verifier.');
});

test('W04 refuses wrong trust, tampering, expiry, future metadata, prerelease and minimum-version input', async t => {
  const f = await qualificationFixture(t);
  const runtime = f.signRuntime(), pack = f.signPack(), update = f.signUpdate();
  assert.throws(() => authenticateRuntimeCohort(runtime, {
    [keyId]: { ...f.contentKeys[keyId]!, publicKey: f.updaterPublic },
  }, { fixture: true }), /signature invalid/i);
  assert.throws(() => authenticateRelease(pack.signed, { ...f.contentSource, keys: {} }, pack.release), /unknown publisher/i);
  assert.throws(() => authenticateRelease(pack.signed, { ...f.contentSource, keys: {
    [keyId]: { ...f.contentKeys[keyId]!, revoked: true },
  } }, pack.release), /revoked/i);
  const updaterKey = f.updateSource.keys[updaterId]!;
  assert.throws(() => authenticateLauncherUpdate(update.signed, { ...f.updateSource, keys: {
    [updaterId]: { ...updaterKey, publicKey },
  } }, update.release, installedVersion), /signature verification failed/i);
  assert.throws(() => authenticateLauncherUpdate(update.signed, f.updateSource, update.release, '0.1.10'), /minimumLauncherVersion/i);
  assert.throws(() => authenticateLauncherUpdate(update.signed, f.updateSource, { ...update.release, prerelease: true }, installedVersion), /tag\/channel/i);
  const tampered = { ...runtime, payloadBase64: Buffer.from('tampered').toString('base64') };
  assert.throws(() => authenticateRuntimeCohort(tampered, f.contentKeys, { fixture: true }), /signature invalid/i);
  const future = f.signRuntime({ ...f.policy, createdAt: iso(f.start + 600000), expiresAt: iso(f.start + 660000) });
  assert.throws(() => authenticateRuntimeCohort(future, f.contentKeys, { fixture: true }), /expired runtime policy/i);
  f.setNow(Date.parse(f.server.expiresAt));
  assert.throws(() => authenticateRelease(pack.signed, f.contentSource, pack.release), /stale|conflicting/i);
  f.setNow(Date.parse(f.policy.expiresAt));
  assert.throws(() => authenticateRuntimeCohort(runtime, f.contentKeys, { fixture: true }), /expired runtime policy/i);
  assert.throws(() => authenticateLauncherUpdate(update.signed, f.updateSource, update.release, installedVersion,
    () => Date.parse(updaterKey.expiresAt!)), /expired launcher update publisher key/i);
});

test('W04 updater ledger preserves the accepted installer and history on replay or same-version mutation', async t => {
  const f = await qualificationFixture(t);
  const ledger = new LauncherUpdateLedger(f.f.grant.directory);
  const admitted = f.signUpdate();
  await ledger.accept(authenticateLauncherUpdate(admitted.signed, f.updateSource, admitted.release, installedVersion));
  const ledgerPath = path.join(f.f.grant.directory, 'launcher-update-history.json');
  const history = await fs.readFile(ledgerPath);
  const payload = await fs.readFile(f.installerPath);
  const replay = f.signUpdate(payload, '0.1.29');
  const mutation = f.signUpdate(Buffer.from('MZ different valid signed bytes'));
  for (const [update, error] of [[replay, /downgrade/i], [mutation, /same-version.*mutation/i]] as const) {
    const authentic = authenticateLauncherUpdate(update.signed, f.updateSource, update.release, installedVersion);
    await assert.rejects(ledger.accept(authentic), error);
    assert.deepEqual(await fs.readFile(ledgerPath), history);
    assert.deepEqual(await fs.readFile(f.installerPath), payload);
  }
});
