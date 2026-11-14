#!/usr/bin/env node
// Synthetic, offline W13 comparison. No game, cache, network, or repo data is read.
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CHUNK_BYTES = 256 * 1024;
const MIB = 1024 * 1024;
const rounds = 3;

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeFile(size, seed, edits = []) {
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += 32) {
    const block = createHash('sha256').update(`${seed}:${offset >>> 5}`).digest();
    block.copy(bytes, offset, 0, Math.min(block.length, size - offset));
  }
  for (const {offset, length, value} of edits) {
    bytes.fill(value, offset, Math.min(size, offset + length));
  }
  return bytes;
}

function corpus() {
  const definitions = [
    {name: 'Frostveil.bsa', size: 5 * MIB, edits: [{offset: 2 * MIB, length: 24 * 1024, value: 0x61}]},
    {name: 'textures/landscape.dds', size: 4 * MIB, edits: [{offset: MIB, length: 32 * 1024, value: 0x72}]},
    {name: 'Frostveil.esp', size: MIB, edits: [{offset: 64 * 1024, length: 8 * 1024, value: 0x83}]},
    {name: 'bin/FrostveilNative.dll', size: 2 * MIB, edits: []},
    {name: 'textures/new-castle.dds', size: 2 * MIB, edits: [], added: true},
  ];
  const old = new Map();
  const next = new Map();
  for (const item of definitions) {
    if (!item.added) old.set(item.name, makeFile(item.size, item.name));
    next.set(item.name, makeFile(item.size, item.name, item.edits));
  }
  return {definitions, old, next};
}

function bundleSize(files) {
  return [...files.values()].reduce((total, bytes) => total + bytes.length, 0);
}

function hashFiles(files) {
  const digest = createHash('sha256');
  for (const [name, bytes] of files) digest.update(name).update(bytes);
  return digest.digest('hex');
}

function changedFiles(old, next) {
  return [...next].filter(([name, bytes]) => !old.has(name) || hash(old.get(name)) !== hash(bytes));
}

function changedFileBytes(changes) {
  return changes.reduce((sum, [, bytes]) => sum + bytes.length, 0);
}

function peakBytes(old, changes, stagedPayloadBytes) {
  const replacedBytes = changes.reduce((sum, [name]) => sum + (old.get(name)?.length ?? 0), 0);
  return bundleSize(old) + stagedPayloadBytes + replacedBytes;
}

function makeChunkPlan(baseFiles, nextFiles, baseHashes) {
  let reusedChunkBytes = 0;
  let payloadBytes = 0;
  const stagedFiles = new Map();
  const newFiles = [];
  const fallbacks = [];
  for (const [name, expected] of nextFiles) {
    const base = baseFiles.get(name);
    if (!base) {
      if (baseHashes.has(name)) {
        fallbacks.push({file: name, reason: 'base-file-missing', outcome: 'full-file-fallback', payloadBytes: expected.length});
      } else {
        newFiles.push(name);
      }
      payloadBytes += expected.length;
      stagedFiles.set(name, Buffer.from(expected));
      continue;
    }
    if (!baseHashes.has(name) || hash(base) !== baseHashes.get(name)) {
      fallbacks.push({file: name, reason: 'base-file-hash-mismatch', outcome: 'full-file-fallback', payloadBytes: expected.length});
      payloadBytes += expected.length;
      stagedFiles.set(name, Buffer.from(expected));
      continue;
    }
    const staged = Buffer.alloc(expected.length);
    for (let offset = 0; offset < expected.length; offset += CHUNK_BYTES) {
      const end = Math.min(expected.length, offset + CHUNK_BYTES);
      const wantedBlock = expected.subarray(offset, end);
      const baseBlock = base.subarray(offset, end);
      if (baseBlock.length === wantedBlock.length && baseBlock.equals(wantedBlock)) {
        baseBlock.copy(staged, offset);
        reusedChunkBytes += wantedBlock.length;
      } else {
        wantedBlock.copy(staged, offset);
        payloadBytes += wantedBlock.length;
      }
    }
    stagedFiles.set(name, staged);
  }
  return {stagedFiles, payloadBytes, reusedChunkBytes, newFiles, fallbacks};
}

function stageFiles(base, next, changed, mode) {
  if (mode === 'full-bundle') {
    return new Map([...next].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  }
  const staged = new Map([...base].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  for (const [name, bytes] of changed) staged.set(name, Buffer.from(bytes));
  return staged;
}

function verifyManifest(files, expectedHashes) {
  if (files.size !== expectedHashes.size) return false;
  for (const [name, expected] of expectedHashes) {
    if (!files.has(name) || hash(files.get(name)) !== expected) return false;
  }
  return true;
}

function hasCapacity(availableBytes, requiredBytes) {
  return Number.isSafeInteger(availableBytes) && Number.isSafeInteger(requiredBytes) && availableBytes >= requiredBytes;
}

function applyStaged(target, staged, expectedHashes, availableBytes, requiredBytes) {
  if (!hasCapacity(availableBytes, requiredBytes)) return {applied: false, reason: 'insufficient-space'};
  if (!verifyManifest(staged, expectedHashes)) return {applied: false, reason: 'integrity-mismatch'};
  target.clear();
  for (const [name, bytes] of staged) target.set(name, Buffer.from(bytes));
  return {applied: true, installedDigest: hashFiles(target)};
}

function measure(operation) {
  const cpuStart = process.cpuUsage();
  const start = process.hrtime.bigint();
  const result = operation();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const cpu = process.cpuUsage(cpuStart);
  return {result, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000};
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1)};
}

function benchmarkMode(run) {
  const timings = [];
  let result;
  for (let iteration = 0; iteration < rounds; iteration++) {
    const measured = measure(() => run());
    result = measured.result;
    timings.push({elapsedMs: measured.elapsedMs, cpuMs: measured.cpuMs});
  }
  return {...result, iterations: rounds, elapsedMs: summarize(timings.map(x => x.elapsedMs)), cpuMs: summarize(timings.map(x => x.cpuMs))};
}

function run() {
  const {definitions, old, next} = corpus();
  const changes = changedFiles(old, next);
  const oldBytes = bundleSize(old);
  const newBytes = bundleSize(next);
  const filePayloadBytes = changedFileBytes(changes);
  const expectedHashes = new Map([...next].map(([name, bytes]) => [name, hash(bytes)]));
  const baseHashes = new Map([...old].map(([name, bytes]) => [name, hash(bytes)]));
  const primaryBase = new Map([...old].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const chunkBuild = benchmarkMode(() => {
    const plan = makeChunkPlan(primaryBase, next, baseHashes);
    if (!verifyManifest(plan.stagedFiles, expectedHashes)) throw new Error('Chunk reconstruction hash mismatch');
    return {plan};
  });
  const primaryChunkPlan = chunkBuild.plan;
  const common = {measurement: 'synthetic logical-byte model; no OS disk counters', wireOverheadBytes: null, wireOverheadMeasured: false};
  const full = benchmarkMode(() => {
    const staged = stageFiles(old, next, changes, 'full-bundle');
    if (!verifyManifest(staged, expectedHashes)) throw new Error('Full bundle manifest verification failed');
    return {
      ...common,
      payloadBytes: newBytes,
      installPeakLogicalBytes: peakBytes(old, changes, newBytes),
      ioReadLogicalBytes: oldBytes + newBytes,
      ioWriteLogicalBytes: newBytes + oldBytes,
      reconstructionDigest: hashFiles(staged),
    };
  });
  const fileLevel = benchmarkMode(() => {
    const staged = stageFiles(old, next, changes, 'file-level');
    if (!verifyManifest(staged, expectedHashes)) throw new Error('File-level manifest verification failed');
    return {
      ...common,
      payloadBytes: filePayloadBytes,
      installPeakLogicalBytes: peakBytes(old, changes, filePayloadBytes),
      ioReadLogicalBytes: oldBytes + filePayloadBytes,
      ioWriteLogicalBytes: filePayloadBytes * 2,
      reconstructionDigest: hashFiles(staged),
    };
  });
  const chunks = benchmarkMode(() => {
    const plan = makeChunkPlan(primaryBase, next, baseHashes);
    if (!verifyManifest(plan.stagedFiles, expectedHashes)) throw new Error('Chunk reconstruction hash mismatch');
    if (plan.fallbacks.length) throw new Error('Primary chunk scenario unexpectedly used a fallback');
    if (plan.payloadBytes + plan.reusedChunkBytes !== newBytes) throw new Error('Chunk byte accounting mismatch');
    return {
      ...common,
      payloadBytes: plan.payloadBytes,
      reusedChunkBytes: plan.reusedChunkBytes,
      installPeakLogicalBytes: peakBytes(old, changes, plan.payloadBytes),
      ioReadLogicalBytes: oldBytes + plan.reusedChunkBytes + plan.payloadBytes,
      ioWriteLogicalBytes: plan.payloadBytes + newBytes,
      reconstructionDigest: hashFiles(plan.stagedFiles),
      fallback: plan.fallbacks,
    };
  });

  const fallbackScenarios = ['missing', 'corrupt'].map(kind => {
    const alteredBase = new Map([...primaryBase].map(([name, bytes]) => [name, Buffer.from(bytes)]));
    const file = 'Frostveil.bsa';
    if (kind === 'missing') alteredBase.delete(file);
    else alteredBase.get(file)[0] ^= 0xff;
    const plan = makeChunkPlan(alteredBase, next, baseHashes);
    const fallback = plan.fallbacks.find(item => item.file === file);
    const reason = kind === 'missing' ? 'base-file-missing' : 'base-file-hash-mismatch';
    if (fallback?.reason !== reason || fallback.payloadBytes !== next.get(file).length) throw new Error(`${kind} base did not fall back to a full file`);
    if (!verifyManifest(plan.stagedFiles, expectedHashes)) throw new Error(`${kind} base fallback failed reconstruction hash verification`);
    return {scenario: kind, baseChangedBeforePlanning: true, fallback, payloadBytes: plan.payloadBytes, reconstructionDigest: hashFiles(plan.stagedFiles), hashVerified: true};
  });

  const tamperedTarget = new Map([...old].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const stagedTampered = new Map([...primaryChunkPlan.stagedFiles].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  stagedTampered.get('Frostveil.esp')[0] ^= 0xff;
  const targetBeforeTamper = hashFiles(tamperedTarget);
  const rejectedTamperedApply = applyStaged(tamperedTarget, stagedTampered, expectedHashes, Number.MAX_SAFE_INTEGER, 0);
  const tamperedPayload = {attempted: true, result: rejectedTamperedApply.reason, rejected: !rejectedTamperedApply.applied, targetUnchanged: hashFiles(tamperedTarget) === targetBeforeTamper};

  const capacityTarget = new Map([...old].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const targetBeforeCapacity = hashFiles(capacityTarget);
  const requiredPeakLogicalBytes = peakBytes(old, changes, primaryChunkPlan.payloadBytes);
  const capacityAvailableBytes = requiredPeakLogicalBytes - 1;
  const rejectedCapacityApply = applyStaged(capacityTarget, primaryChunkPlan.stagedFiles, expectedHashes, capacityAvailableBytes, requiredPeakLogicalBytes);
  const insufficientSpace = {
    predicate: 'availableLogicalBytes >= requiredPeakLogicalBytes',
    availableLogicalBytes: capacityAvailableBytes,
    requiredPeakLogicalBytes,
    refusedBeforeApply: !rejectedCapacityApply.applied && rejectedCapacityApply.reason === 'insufficient-space',
    targetUnchanged: hashFiles(capacityTarget) === targetBeforeCapacity,
  };
  if (tamperedPayload.result !== 'integrity-mismatch' || !tamperedPayload.rejected || !tamperedPayload.targetUnchanged || !insufficientSpace.refusedBeforeApply || !insufficientSpace.targetUnchanged) {
    throw new Error('Synthetic integrity or capacity control failed');
  }

  return {
    schema: 'frostveil.w13.synthetic-benchmark.v1',
    generatedAt: new Date().toISOString(),
    environment: {node: process.version, platform: process.platform, arch: process.arch, cpuCount: os.cpus().length},
    input: {source: 'deterministically generated in-memory bytes', networkUsed: false, gameOrUserDataRead: false, chunkBytes: CHUNK_BYTES, iterations: rounds},
    corpus: {
      labels: definitions.map(({name}) => name),
      oldFileCount: old.size,
      newFileCount: next.size,
      oldBundleBytes: oldBytes,
      newBundleBytes: newBytes,
      changedFileCount: changes.length,
      changedWholeFileBytes: filePayloadBytes,
      workloadNote: 'Three changed files contain small edits. A new DDS and an unchanged DLL model representative file-level cases; these are synthetic labels, not Bethesda data.',
    },
    results: {
      fullBundle: full,
      fileLevel,
      fixedChunkReuse: chunks,
      deltaBuildCost: {elapsedMs: chunkBuild.elapsedMs, cpuMs: chunkBuild.cpuMs, baseLogicalBytesRead: oldBytes, chunkBytes: CHUNK_BYTES},
    },
    fallbackScenarios,
    negativeControls: {tamperedPayload: {...tamperedPayload, modeled: true}, insufficientInstallSpace: {...insufficientSpace, modeled: true}},
    maintenance: {
      fullBundle: 'LOW',
      fileLevel: 'LOW',
      fixedChunkReuse: 'HIGH',
      note: 'Relative engineering estimate only. Delta requires a stable chunk format, patch authoring, bounded reconstruction, compatibility rules, recovery and broad corpus validation.',
    },
    decision: 'Synthetic data demonstrates byte reduction opportunities only. It does not establish that binary delta is beneficial for real archives, player storage, network costs, or release maintenance.',
    limitations: [
      'Timings and CPU samples cover in-memory hashing and plan calculation, not network, disk throughput, installer code or Windows allocation behavior.',
      'Payload bytes exclude protocol framing, retries, compression and transport overhead. Wire overhead was not measured.',
      'I/O and install peak values are logical-byte formulas, not observed operating-system disk counters or physical allocation.',
      'The integrity and capacity checks exercise this standalone synthetic runner predicate, not the Launcher installer.',
      'Peak install bytes are the exact logical-size sum for the modeled old target, staged download and backup. Sparse, compressed, hard-linked and filesystem metadata allocation are excluded.',
      'No signed manifest, real BSA/DDS/plugin binary, Skyrim installation, cache, Steam account or network endpoint is read.',
      'Each strategy runs one deterministic synthetic workload three times. The median is descriptive and not a production service-level guarantee.',
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
    throw new Error('Usage: node scripts/benchmark-w13.mjs [--output <private-json-path>]');
  }
  const outputPath = args.length ? path.resolve(args[1]) : undefined;
  const result = run();
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, json, {flag: 'wx'});
  process.stdout.write(json);
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
