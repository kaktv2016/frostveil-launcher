import {createHash} from 'node:crypto';
import path from 'node:path';

export type CachePolicyBinding = {
  scopeId: string;
  profileId: string;
  cohortDigest: string;
};

export type PackagedCachePolicy = {required:boolean; revision?:number; bytes?:string; sha256?:string};
export type CacheVolumePolicy = {
  volumeId: string;
  rawCapBytes: bigint;
  stagingBytes: bigint;
  recoveryBytes: bigint;
  helperBytes: bigint;
};

declare const FROSTVEIL_PACKAGED_CACHE_POLICY: PackagedCachePolicy;
export const packagedCachePolicy: PackagedCachePolicy = typeof FROSTVEIL_PACKAGED_CACHE_POLICY === 'undefined'
  ? {required:false}
  : FROSTVEIL_PACKAGED_CACHE_POLICY;

const hex = /^[a-f0-9]{64}$/;
const fail = () => new Error('Cache accounting policy is missing, expired, invalid, or outside the approved scope');
const digest = (value:string) => createHash('sha256').update(value).digest('hex');

export function cacheScopeId(storage:string, volumeId:string, fileId:string) {
  return digest(JSON.stringify([path.resolve(storage).toLowerCase(),volumeId,fileId]));
}

export function cacheProfileId(game:string, config:string) {
  return digest(path.resolve(game).toLowerCase()+'\n'+path.resolve(config).toLowerCase());
}

function object(value:unknown, keys:string): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== keys) throw fail();
  return value as Record<string,unknown>;
}

function bytes(value:unknown) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) throw fail();
  return BigInt(value);
}

export function admitPackagedCachePolicy(pin:PackagedCachePolicy, binding:CachePolicyBinding, now=Date.now()) {
  if (pin.required === false) return null;
  if (pin.required !== true || !Number.isSafeInteger(pin.revision) || pin.revision!<1 ||
      typeof pin.bytes !== 'string' || Buffer.byteLength(pin.bytes)>64*1024 ||
      typeof pin.sha256 !== 'string' || !hex.test(pin.sha256) || digest(pin.bytes)!==pin.sha256) throw fail();

  let parsed:unknown;
  try { parsed=JSON.parse(pin.bytes); } catch { throw fail(); }
  const policy=object(parsed,'cohortDigest,expiresAt,profileId,reviewAfterMs,revision,schemaVersion,scopeId,volumes');
  const expiry=typeof policy.expiresAt==='string'?Date.parse(policy.expiresAt):NaN;
  if (policy.schemaVersion!==1 || policy.revision!==pin.revision ||
      !Number.isFinite(expiry) || expiry<=now ||
      !Number.isSafeInteger(policy.reviewAfterMs) || Number(policy.reviewAfterMs)<1 || Number(policy.reviewAfterMs)>365*86400000 ||
      !Array.isArray(policy.volumes) || !policy.volumes.length || policy.volumes.length>16 ||
      Object.entries(binding).some(([name,value])=>!hex.test(value)||value!==policy[name])) throw fail();

  const volumes=new Map<string,CacheVolumePolicy>();
  for (const item of policy.volumes) {
    const row=object(item,'helperBytes,rawCapBytes,recoveryBytes,stagingBytes,volumeId');
    const {volumeId}=row;
    if (typeof volumeId!=='string' || !/^[a-zA-Z0-9._:{}-]{1,128}$/.test(volumeId) || volumes.has(volumeId)) throw fail();
    volumes.set(volumeId,{volumeId,rawCapBytes:bytes(row.rawCapBytes),stagingBytes:bytes(row.stagingBytes),
      recoveryBytes:bytes(row.recoveryBytes),helperBytes:bytes(row.helperBytes)});
  }
  return {id:pin.sha256,reviewAfterMs:Number(policy.reviewAfterMs),expiresAt:expiry,volumes};
}
