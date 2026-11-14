export interface CacheCharge {
  volumeId: string;
  rawBytes: bigint;
  helperBytes: bigint;
}

export interface CacheVolumeBudget {
  volumeId: string;
  rawAllocatedBytes: bigint | null;
  rawLogicalBytes: bigint | null;
  availableBytes: bigint | null;
  rawCapBytes: bigint | null;
  rawRequestBytes: bigint;
  helperBytes: bigint;
  stagingBytes: bigint;
  recoveryBytes: bigint;
}

type AdmissionIssue = {
  volumeId?: string;
  reason: 'INVALID_PLAN' | 'CENSUS_UNKNOWN' | 'CAP_UNKNOWN' | 'SPACE_UNKNOWN' |
    'RESERVATION_UNKNOWN' | 'CAP_SHORTFALL' | 'SPACE_SHORTFALL';
  shortfallBytes?: bigint;
};

type MeasuredVolume = CacheVolumeBudget & {
  outstandingRawBytes: bigint;
  outstandingHelperBytes: bigint;
  rawRequiredBytes: bigint | null;
  availableRequiredBytes: bigint;
};

function known(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n;
}

export function reserveRawBytes(signedSizes: readonly number[], clusterSize: bigint): bigint {
  if (!known(clusterSize) || clusterSize === 0n) throw Error('Unknown cache allocation unit');
  return signedSizes.reduce((total, size) => {
    if (!Number.isSafeInteger(size) || size < 0) throw Error('Invalid signed cache file size');
    return total + (BigInt(size) + clusterSize - 1n) / clusterSize * clusterSize;
  }, 0n);
}

/** Measurements are supplied under the accounting lease. The admission plan
 * gives every affected volume its own obligations before this calculation. */
export function decideCacheAdmission(input: {
  volumes: readonly CacheVolumeBudget[];
  outstanding: readonly CacheCharge[];
  enforceRawCap?: boolean;
}): {disposition: 'ADMIT' | 'REFUSE' | 'UNKNOWN'; volumes: MeasuredVolume[]; issues: AdmissionIssue[]} {
  const issues: AdmissionIssue[] = [];
  const volumes: MeasuredVolume[] = [];
  const seen = new Set<string>();
  const active = new Map<string, CacheCharge>();
  if (!input.volumes.length) issues.push({reason: 'INVALID_PLAN'});
  for (const charge of input.outstanding) {
    if (!charge.volumeId || active.has(charge.volumeId) || !known(charge.rawBytes) || !known(charge.helperBytes)) {
      issues.push({volumeId: charge.volumeId, reason: 'RESERVATION_UNKNOWN'});
      continue;
    }
    active.set(charge.volumeId, charge);
  }
  for (const row of input.volumes) {
    const {volumeId, rawAllocatedBytes, rawLogicalBytes, rawRequestBytes, helperBytes, stagingBytes, recoveryBytes} = row;
    if (!volumeId || seen.has(volumeId) || ![rawRequestBytes, helperBytes, stagingBytes, recoveryBytes].every(known)) {
      issues.push({volumeId, reason: 'INVALID_PLAN'});
      continue;
    }
    seen.add(volumeId);
    const outstandingRawBytes = active.get(volumeId)?.rawBytes ?? 0n;
    const outstandingHelperBytes = active.get(volumeId)?.helperBytes ?? 0n;
    const rawRequiredBytes = known(rawAllocatedBytes) ? rawAllocatedBytes + outstandingRawBytes + rawRequestBytes : null;
    const availableRequiredBytes = outstandingRawBytes + outstandingHelperBytes + rawRequestBytes + helperBytes + stagingBytes + recoveryBytes;
    volumes.push({...row, outstandingRawBytes, outstandingHelperBytes, rawRequiredBytes, availableRequiredBytes});
    if (rawRequiredBytes === null || !known(rawLogicalBytes)) issues.push({volumeId, reason: 'CENSUS_UNKNOWN'});
    if (input.enforceRawCap !== false && rawRequiredBytes !== null && rawRequiredBytes > 0n) {
      if (!known(row.rawCapBytes)) issues.push({volumeId, reason: 'CAP_UNKNOWN'});
      else if (row.rawCapBytes < rawRequiredBytes) issues.push({volumeId, reason: 'CAP_SHORTFALL', shortfallBytes: rawRequiredBytes - row.rawCapBytes});
    }
    if (!known(row.availableBytes)) issues.push({volumeId, reason: 'SPACE_UNKNOWN'});
    else if (row.availableBytes < availableRequiredBytes) issues.push({volumeId, reason: 'SPACE_SHORTFALL', shortfallBytes: availableRequiredBytes - row.availableBytes});
  }
  for (const volumeId of active.keys()) if (!seen.has(volumeId)) issues.push({volumeId, reason: 'RESERVATION_UNKNOWN'});
  const unknown = issues.some(issue => issue.shortfallBytes === undefined);
  return {disposition: unknown ? 'UNKNOWN' : issues.length ? 'REFUSE' : 'ADMIT', volumes, issues};
}
