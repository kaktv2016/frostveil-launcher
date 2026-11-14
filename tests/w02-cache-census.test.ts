import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {censusRawCache, listCacheDirectory, measureCacheFiles, measureCacheRoots, measureCacheVolume} from '../src/main/runtime/cache-census';

const windows = process.platform === 'win32';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fv-w02-census-'));
  t.after(async () => {
    // Keep all fixture removals literal and confined to this verified temp child.
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, {recursive: true, force: true});
  });
  return root;
}

test('reconciles hardlinks across raw sibling roots while retaining unknown occupants', {skip: !windows}, async t => {
  const root = await fixture(t);
  const first = path.join(root, 'retained');
  const second = path.join(root, 'pre-registration-พื้นที่');
  await fs.mkdir(first);
  await fs.mkdir(second);
  const original = path.join(first, 'game.bin');
  const alias = path.join(second, 'partial.bin');
  await fs.writeFile(original, Buffer.alloc(65_537, 7));
  await fs.link(original, alias);
  const result = await censusRawCache([first, second], {knownPaths: new Set([original])});
  assert.deepEqual(result.issues, []);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.roots.length, 2);
  assert.equal(result.files.length, 2);
  const [left, right] = result.files;
  assert.ok(left && right && left.generation && right.generation);
  assert.equal(left.fileId, right.fileId);
  assert.equal(left.generation, right.generation);
  assert.equal(left.linkCount, 2);
  const [volume] = result.volumes;
  assert.ok(volume);
  assert.equal(volume.logicalBytes, 65_537n);
  assert.equal(volume.allocatedBytes, left.allocatedBytes);
  assert.equal(volume.unknownAllocatedBytes, left.allocatedBytes);
  assert.ok(volume.allocatedBytes >= volume.logicalBytes);
  assert.ok(volume.allocationUnitBytes > 0n);
  assert.match(volume.volumeId, /^VOL:\{[0-9A-F-]{36}\}:[0-9A-F]{16}$/);
});

test('refuses nested redirected directories and redirected root ancestors', {skip: !windows}, async t => {
  const root = await fixture(t);
  const raw = path.join(root, 'raw');
  const outside = path.join(root, 'outside');
  await fs.mkdir(raw);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'unrelated.bin'), 'unrelated');
  const junction = path.join(raw, 'junction');
  await fs.symlink(outside, junction, 'junction');
  const nested = await censusRawCache([raw]);
  assert.equal(nested.status, 'UNKNOWN');
  assert.equal(nested.files.length, 0);
  assert.ok(nested.issues.some(issue => issue.code === 'REDIRECTED_PATH'));
  const indirect = await censusRawCache([path.join(junction, 'absent')]);
  assert.equal(indirect.status, 'UNKNOWN');
  assert.ok(indirect.issues.some(issue => issue.code === 'REDIRECTED_PATH'));
  await assert.rejects(measureCacheVolume(junction), /REDIRECTED_PATH/);
});

test('records an absent root and its validated ancestor on the same volume', {skip: !windows}, async t => {
  const root = await fixture(t);
  const absent = path.join(root, 'unregistered', 'raw');
  const volume = await measureCacheVolume(absent);
  const census = await censusRawCache([absent]);
  assert.equal(census.status, 'COMPLETE');
  assert.equal(census.roots[0]?.state, 'ABSENT');
  assert.equal(census.roots[0]?.path, absent);
  assert.equal(census.roots[0]?.ancestorPath, root);
  assert.equal(census.roots[0]?.volumeId, volume.volumeId);
  assert.equal(census.volumes[0]?.allocatedBytes, 0n);
  assert.ok(volume.availableBytes >= 0n);
  const measured = await measureCacheRoots([root, absent, root]);
  assert.equal(measured.roots.length, 2);
  assert.equal(measured.volumes.length, 1);
  assert.equal(measured.roots[0]?.state, 'PRESENT');
  assert.equal(measured.roots[1]?.state, 'ABSENT');
});

test('charges a hardlink allocation once but refuses growth if a name is outside the raw roots', {skip: !windows}, async t => {
  const root = await fixture(t);
  const raw = path.join(root, 'raw');
  await fs.mkdir(raw);
  const original = path.join(raw, 'equivalent.bin');
  await fs.writeFile(original, 'inert');
  await fs.link(original, path.join(root, 'outside-raw.bin'));
  const result = await censusRawCache([raw], {knownPaths: new Set([original])});
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.issues[0]?.code, 'UNVERIFIED_HARDLINK');
  assert.equal(result.volumes[0]?.logicalBytes, 5n);
  assert.equal(result.volumes[0]?.unknownLogicalBytes, 5n);
});

test('refuses alternate streams and files with an open writer', {skip: !windows}, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'raw.bin');
  await fs.writeFile(file, 'inert');
  const writer = await fs.open(file, 'r+');
  try {
    const result = await censusRawCache([root]);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.issues[0]?.code, 'UNSTABLE_ENTRY');
  } finally {
    await writer.close();
  }
  await fs.writeFile(file + ':fixture-stream', 'alternate inert bytes');
  const streams = await censusRawCache([root]);
  assert.equal(streams.status, 'UNKNOWN');
  assert.equal(streams.issues[0]?.code, 'UNSUPPORTED_STREAM');
});

test('measures allocated data bytes for sparse and compressed files', {skip: !windows}, async t => {
  const root = await fixture(t);
  const sparse = path.join(root, 'sparse.bin');
  const compressed = path.join(root, 'compressed.bin');
  await fs.writeFile(sparse, '');
  await fs.writeFile(compressed, Buffer.alloc(1024 * 1024));
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const sparseResult = spawnSync(path.join(system32, 'fsutil.exe'), ['sparse', 'setflag', sparse], {windowsHide: true});
  const compressResult = spawnSync(path.join(system32, 'compact.exe'), ['/c', '/a', '/q', compressed], {windowsHide: true});
  if (sparseResult.status !== 0 || compressResult.status !== 0) {
    t.skip('Fixture volume does not support sparse and compressed test inputs');
    return;
  }
  const h = await fs.open(sparse, 'r+');
  try {
    await h.write(Buffer.from([0x42]), 0, 1, 8 * 1024 * 1024 - 1);
    await h.sync();
  } finally {
    await h.close();
  }
  const result = await censusRawCache([root]);
  assert.deepEqual(result.issues, []);
  const sparseFile = result.files.find(entry => entry.path === sparse);
  const compressedFile = result.files.find(entry => entry.path === compressed);
  assert.ok(sparseFile && compressedFile);
  assert.equal(sparseFile.logicalBytes, 8n * 1024n * 1024n);
  assert.equal(compressedFile.logicalBytes, 1024n * 1024n);
  assert.ok(sparseFile.allocatedBytes > 0n && sparseFile.allocatedBytes < sparseFile.logicalBytes);
  assert.ok(compressedFile.allocatedBytes < compressedFile.logicalBytes);
});

test('fails closed on a file masquerading as a directory or an incomplete bounded census', {skip: !windows}, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'a');
  await fs.writeFile(path.join(root, 'other'), 'b');
  const badRoot = await censusRawCache([file]);
  assert.equal(badRoot.status, 'UNKNOWN');
  assert.ok(badRoot.issues.some(issue => issue.code === 'INVALID_ENTRY'));
  const limited = await censusRawCache([root], {maxEntries: 1});
  assert.equal(limited.status, 'UNKNOWN');
  assert.ok(limited.issues.some(issue => issue.code === 'ENTRY_LIMIT'));
});

test('refuses paths with aliases, overlapping requests and unbounded traversal scopes', async () => {
  const root = path.resolve(os.tmpdir(), 'fv-w02-census-input');
  for (const roots of [[root, path.join(root, 'nested')], [path.parse(root).root], ['relative'], [root + path.sep + '..']]) {
    const census = await censusRawCache(roots);
    assert.equal(census.status, 'UNKNOWN');
    assert.ok(census.issues.some(issue => issue.code === 'INVALID_SCOPE'));
  }
});

test('lists only direct child directories and fails closed on entries outside the supported layout', {skip: !windows}, async t => {
  const root = await fixture(t);
  const managed = path.join(root, 'managed');
  const inner = path.join(managed, 'pending-bootstrap');
  await fs.mkdir(inner, {recursive: true});
  const unrelated = path.join(root, 'other');
  await fs.mkdir(unrelated);
  await fs.symlink(unrelated, path.join(inner, 'deep-junction'), 'junction');
  assert.deepEqual(await listCacheDirectory(managed, 1), ['pending-bootstrap']);
  assert.deepEqual(await listCacheDirectory(path.join(root, 'absent'), 1), []);
  await fs.mkdir(path.join(managed, 'another'));
  await assert.rejects(listCacheDirectory(managed, 1), /ENTRY_LIMIT/);
  await fs.symlink(unrelated, path.join(managed, 'direct-junction'), 'junction');
  await assert.rejects(listCacheDirectory(managed, 10), /REDIRECTED_PATH/);
});

test('measures exact file paths and catches replacement or a redirected ancestor without enumerating siblings', {skip: !windows}, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'selected');
  await fs.writeFile(file, 'inert');
  const other = path.join(root, 'neighbor');
  await fs.mkdir(other);
  const redirected = path.join(root, 'redirected');
  await fs.symlink(other, redirected, 'junction');
  const before = (await measureCacheFiles([file]))[0];
  assert.ok(before);
  assert.equal(before.logicalBytes, 5n);
  await fs.rename(file, path.join(root, 'displaced'));
  await fs.writeFile(file, 'inert');
  const after = (await measureCacheFiles([file]))[0];
  assert.ok(after);
  assert.notEqual(after.fileId, before.fileId);
  await assert.rejects(measureCacheFiles([path.join(redirected, 'file')]), /REDIRECTED_PATH/);
});
