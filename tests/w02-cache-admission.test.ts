import assert from 'node:assert/strict';
import test from 'node:test';
import {decideCacheAdmission, reserveRawBytes, type CacheVolumeBudget} from '../src/main/runtime/cache-admission';

const volume: CacheVolumeBudget = {
  volumeId: 'raw', rawAllocatedBytes: 32n, rawLogicalBytes: 75n, availableBytes: 39n,
  rawCapBytes: 54n, rawRequestBytes: 19n, helperBytes: 5n, stagingBytes: 6n, recoveryBytes: 4n,
};

test('W02 admission rounds each signed file before adding raw physical charges', () => {
  assert.equal(reserveRawBytes([4097, 8191], 4096n), 16384n);
  assert.throws(() => reserveRawBytes([Number.MAX_SAFE_INTEGER + 1], 4096n), /signed|bytes/i);
  assert.throws(() => reserveRawBytes([1], 0n), /unit|bytes/i);
});

test('W02 admission accepts exact cap and free-space thresholds independently', () => {
  const result = decideCacheAdmission({volumes: [volume], outstanding: [{volumeId: 'raw', rawBytes: 3n, helperBytes: 2n}]});
  assert.equal(result.disposition, 'ADMIT');
  assert.equal(result.volumes[0]?.rawRequiredBytes, 54n);
  assert.equal(result.volumes[0]?.availableRequiredBytes, 39n);
  assert.equal(result.volumes[0]?.rawLogicalBytes, 75n);
  assert.deepEqual(result.issues, []);
});

test('W02 admission reports separate cap and free-space byte shortfalls', () => {
  const result = decideCacheAdmission({volumes: [{...volume, rawCapBytes: 50n, availableBytes: 33n}], outstanding: []});
  assert.equal(result.disposition, 'REFUSE');
  assert.deepEqual(result.issues, [
    {volumeId: 'raw', reason: 'CAP_SHORTFALL', shortfallBytes: 1n},
    {volumeId: 'raw', reason: 'SPACE_SHORTFALL', shortfallBytes: 1n},
  ]);
});

test('W02 split helper and recovery charges do not count toward any raw cap', () => {
  const result = decideCacheAdmission({volumes: [
    {...volume, helperBytes: 0n, stagingBytes: 0n, recoveryBytes: 0n, availableBytes: 19n},
    {...volume, volumeId: 'recovery', rawAllocatedBytes: 0n, rawLogicalBytes: 0n, rawCapBytes: null, rawRequestBytes: 0n, availableBytes: 15n},
  ], outstanding: []});
  assert.equal(result.disposition, 'ADMIT');
  assert.equal(result.volumes[1]?.rawRequiredBytes, 0n);
  assert.equal(result.volumes[1]?.availableRequiredBytes, 15n);
});

test('W02 admission refuses unknown measurements, duplicate scope and unmapped reservations', () => {
  for (const inputs of [
    {volumes: [{...volume, rawAllocatedBytes: null}], outstanding: []},
    {volumes: [{...volume, rawCapBytes: null}], outstanding: []},
    {volumes: [{...volume, availableBytes: null}], outstanding: []},
    {volumes: [volume, volume], outstanding: []},
    {volumes: [volume], outstanding: [{volumeId: 'unmapped', rawBytes: 1n, helperBytes: 0n}]},
    {volumes: [{...volume, helperBytes: -1n}], outstanding: []},
  ]) assert.equal(decideCacheAdmission(inputs).disposition, 'UNKNOWN');
});

test('W02 ordinary trusted caller can leave the raw cap unset while census and capacity remain mandatory', () => {
  const uncapped = {...volume, rawCapBytes: null};
  assert.equal(decideCacheAdmission({volumes:[uncapped],outstanding:[],enforceRawCap:false}).disposition, 'ADMIT');
  assert.equal(decideCacheAdmission({volumes:[{...uncapped,availableBytes:0n}],outstanding:[],enforceRawCap:false}).disposition, 'REFUSE');
  assert.equal(decideCacheAdmission({volumes:[{...uncapped,rawAllocatedBytes:null}],outstanding:[],enforceRawCap:false}).disposition, 'UNKNOWN');
});
