import {createServer} from 'node:net';
import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {noLinks, safeDirectory} from '../files';
import {durableWrite} from '../installer/metadata';
import {runtimePath} from './policy';
import type {CacheCharge} from './cache-admission';

export interface CacheFileIdentity {
  fileId: string;
  generation: string;
}

export interface CacheObservedFile extends CacheFileIdentity {
  path: string;
  size: number;
  sha256: string;
  links: number;
}

interface CacheRequestFile {
  path: string;
  size: number;
  sha256: string;
  depot: string;
  manifest: string;
  before: CacheFileIdentity | null;
}

export interface CacheReservationInput {
  operationId: string;
  policyId: string;
  profileId: string;
  targetId: string;
  rawRootId: string;
  rawVolumeId: string;
  cohortDigest: string;
  hostBootId: string;
  requested: readonly CacheRequestFile[];
  charges: readonly CacheCharge[];
  beforeAllocated: readonly CacheCharge[];
  reviewAfterMs: number | null;
}

export interface CacheReservation extends CacheReservationInput {
  createdAt: number;
  sequence: number;
  state: 'reserved' | 'overrun';
}

export interface CacheResolutionEvidence {
  quiescent: true;
  censusStable: true;
  rawRootId: string;
  rawVolumeId: string;
  observed: readonly CacheCharge[];
}

export interface CacheSettlementEvidence extends CacheResolutionEvidence {
  outcome: 'verified' | 'failed';
  files: readonly CacheObservedFile[];
}

export interface CacheReconciliationEvidence extends CacheResolutionEvidence {
  hostBootId: string;
  independentlyQuiescent?: true;
}

type RecordedCharge = Omit<CacheCharge, 'rawBytes' | 'helperBytes'> & {rawBytes: string; helperBytes: string};
type RecordedRequest = Omit<CacheReservationInput, 'charges' | 'beforeAllocated'> & {charges: RecordedCharge[]; beforeAllocated: RecordedCharge[]};
type Outcome = CacheSettlementEvidence['outcome'] | 'overrun' | 'reconciled';
type Resolution = {rawRootId:string;rawVolumeId:string;quiescence:'awaited' | 'changed-boot' | 'independent';hostBootId:string};
type Event = {kind:'reserve'; request:RecordedRequest} |
  {kind:'settle'; operationId:string; outcome:Outcome; observed:RecordedCharge[]; files:CacheObservedFile[]; resolution:Resolution} |
  {kind:'reuse'; operationId:string; advanceReview:boolean};
type Head = {scopeId:string; sequence:number; digest:string};
type Anchor = {scopeId:string;rootId:string;keyDigest:string};
type Entry = {scopeId:string; sequence:number; previous:string; at:number; event:Event};
type Snapshot = {head:Head; active:string|null; operations:Map<string, Operation>};
type Operation = {
  reservation:CacheReservation;
  status:'reserved' | Outcome;
  verifiedFiles:CacheObservedFile[];
  observed:CacheCharge[];
  reviewedFrom:number|null;
  lastVerifiedReuseAt:number|null;
  resolution:Resolution|null;
};

const hash = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const zeroDigest = '0'.repeat(64);
const maxEntries = 1024;
const maxRecordBytes = 2 * 1024 * 1024;
const maxHistoryBytes = 48 * 1024 * 1024;
const keyName = 'auth-key';
const headName = 'head.json';
const historyName = 'history';
const lockName = 'cache-writer.lock'; // Retained marker from pre-release fixture trials.
const reaperName = 'cache-reaper.lock';

function exact(value: unknown, keys: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== keys) throw Error('Invalid cache accounting record');
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f]/.test(value);
}

function unsigned(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCode(error: unknown, code: string) {
  return (error as NodeJS.ErrnoException).code === code;
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && hash.test(value);
}

function decodeCharges(rows: unknown): CacheCharge[] {
  if (!Array.isArray(rows) || !rows.length || rows.length > 32) throw Error('Invalid cache accounting charges');
  const seen = new Set<string>();
  return rows.map((row: RecordedCharge) => {
    exact(row, 'helperBytes,rawBytes,volumeId');
    if (!id(row.volumeId) || seen.has(row.volumeId) ||
        [row.rawBytes, row.helperBytes].some(value => typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,24})$/.test(value))) {
      throw Error('Invalid cache accounting charges');
    }
    seen.add(row.volumeId);
    return {volumeId:row.volumeId, rawBytes:BigInt(row.rawBytes), helperBytes:BigInt(row.helperBytes)};
  });
}

function encodeCharges(rows: readonly CacheCharge[]): RecordedCharge[] {
  if (!Array.isArray(rows)) throw Error('Invalid cache accounting charges');
  const encoded = rows.map(row => {
    if (typeof row?.rawBytes !== 'bigint' || typeof row.helperBytes !== 'bigint') throw Error('Invalid cache accounting bytes');
    return {volumeId:row.volumeId, rawBytes:row.rawBytes.toString(), helperBytes:row.helperBytes.toString()};
  });
  decodeCharges(encoded);
  return encoded;
}

function validateIdentity(identity: CacheFileIdentity) {
  if (!id(identity.fileId) || !id(identity.generation)) throw Error('Invalid cache file identity');
}

function validateRequest(request: RecordedRequest) {
  exact(request, 'beforeAllocated,charges,cohortDigest,hostBootId,operationId,policyId,profileId,rawRootId,rawVolumeId,requested,reviewAfterMs,targetId');
  if (!id(request.operationId) || !uuid.test(request.operationId) || !validHash(request.cohortDigest) ||
      ![request.policyId, request.profileId, request.targetId, request.rawRootId, request.rawVolumeId, request.hostBootId].every(id) ||
      (request.reviewAfterMs !== null && (!unsigned(request.reviewAfterMs) || request.reviewAfterMs === 0 ||
       request.reviewAfterMs > 365 * 86400000)) ||
      !Array.isArray(request.requested) || !request.requested.length || request.requested.length > 2048) {
    throw Error('Invalid cache accounting reservation');
  }
  const names = new Set<string>();
  let logicalBytes = 0n;
  for (const file of request.requested) {
    exact(file, 'before,depot,manifest,path,sha256,size');
    const name = runtimePath(file.path).toLowerCase();
    if (names.has(name) || !unsigned(file.size) || file.size === 0 || !validHash(file.sha256) ||
        !['489831','489832','489833'].includes(file.depot) || typeof file.manifest !== 'string' ||
        !/^\d{16,20}$/.test(file.manifest)) throw Error('Invalid cache accounting requested file');
    if (file.before !== null) {
      exact(file.before, 'fileId,generation');
      validateIdentity(file.before);
    }
    names.add(name);
    logicalBytes += BigInt(file.size);
  }
  const charges = decodeCharges(request.charges);
  if (charges.some(row => row.volumeId !== request.rawVolumeId && row.rawBytes !== 0n) ||
      (charges.find(row => row.volumeId === request.rawVolumeId)?.rawBytes ?? 0n) < logicalBytes) {
    throw Error('Cache reservation does not cover signed raw bytes');
  }
  return charges;
}

function validateObserved(expected: readonly CacheCharge[], recorded: RecordedCharge[]) {
  const observed = decodeCharges(recorded);
  if (observed.length !== expected.length || expected.some(charge => !observed.some(row => row.volumeId === charge.volumeId))) {
    throw Error('Independent cache census does not cover reserved volumes');
  }
  return observed;
}

function exceedsReservation(expected: readonly CacheCharge[], observed: readonly CacheCharge[]) {
  return expected.some(charge => {
    const actual = observed.find(row => row.volumeId === charge.volumeId);
    return !actual || actual.rawBytes > charge.rawBytes || actual.helperBytes > charge.helperBytes;
  });
}

function matchVerifiedFiles(request: CacheReservation, files: CacheObservedFile[]) {
  if (!Array.isArray(files) || files.length !== request.requested.length) throw Error('Incomplete verified cache evidence');
  const seen = new Set<string>();
  return request.requested.map(expected => {
    const file = files.find(item => item.path === expected.path);
    exact(file, 'fileId,generation,links,path,sha256,size');
    if (!file || file.links !== 1 || seen.has(file.fileId) || file.size !== expected.size || file.sha256 !== expected.sha256) {
      throw Error('Verified cache file identity mismatch');
    }
    validateIdentity(file);
    seen.add(file.fileId);
    return file;
  });
}

function applyEvent(state: Snapshot, entry: Entry) {
  const {event, at, sequence} = entry;
  if (event.kind === 'reserve') {
    exact(event, 'kind,request');
    if (state.active) throw Error('Outstanding cache accounting operation');
    if (state.operations.has(event.request.operationId)) throw Error('Replayed cache operation id');
    const charges = validateRequest(event.request);
    const beforeAllocated = validateObserved(charges, event.request.beforeAllocated);
    const reservation: CacheReservation = {...event.request, charges, beforeAllocated, createdAt:at, sequence, state:'reserved'};
    state.active = reservation.operationId;
    state.operations.set(reservation.operationId, {reservation,status:'reserved',observed:[],verifiedFiles:[],
      reviewedFrom:null,lastVerifiedReuseAt:null,resolution:null});
    return;
  }
  const operation = state.operations.get(event.operationId);
  if (!operation || at < operation.reservation.createdAt) throw Error('Unknown cache accounting operation');
  if (event.kind === 'reuse') {
    exact(event, 'advanceReview,kind,operationId');
    if (typeof event.advanceReview !== 'boolean' || operation.status !== 'verified' ||
        (operation.lastVerifiedReuseAt !== null && at < operation.lastVerifiedReuseAt) ||
        operation.reviewedFrom === null || at < operation.reviewedFrom ||
        operation.reservation.requested.some(file => file.before !== null)) throw Error('Unverified cache reuse');
    operation.lastVerifiedReuseAt = at;
    if (event.advanceReview && operation.reservation.reviewAfterMs !== null) operation.reviewedFrom = at;
    return;
  }
  exact(event, 'files,kind,observed,operationId,outcome,resolution');
  if (event.kind !== 'settle' || state.active !== event.operationId ||
      !['verified','failed','overrun','reconciled'].includes(event.outcome) ||
      (operation.status === 'overrun' && event.outcome !== 'reconciled')) throw Error('Invalid active cache accounting operation');
  const {reservation} = operation;
  const {resolution} = event;
  exact(resolution, 'hostBootId,quiescence,rawRootId,rawVolumeId');
  const validQuiescence = event.outcome === 'reconciled'
    ? resolution.quiescence === 'independent' ||
      (resolution.quiescence === 'changed-boot' && resolution.hostBootId !== reservation.hostBootId)
    : resolution.quiescence === 'awaited' && resolution.hostBootId === reservation.hostBootId;
  if (!validQuiescence || !id(resolution.hostBootId) || resolution.rawRootId !== reservation.rawRootId ||
      resolution.rawVolumeId !== reservation.rawVolumeId) throw Error('Invalid cache accounting quiescence evidence');
  const observed = validateObserved(reservation.charges, event.observed);
  if (event.outcome !== 'reconciled' && exceedsReservation(reservation.charges, observed) !== (event.outcome === 'overrun')) {
    throw Error('Invalid cache accounting overrun evidence');
  }
  if (event.outcome === 'verified') {
    operation.verifiedFiles = matchVerifiedFiles(reservation, event.files);
    operation.reviewedFrom = at;
  } else if (!Array.isArray(event.files) || event.files.length) {
    throw Error('Unexpected verified cache files');
  }
  operation.status = event.outcome;
  operation.observed = observed;
  operation.resolution = resolution;
  if (event.outcome === 'overrun') reservation.state = 'overrun';
  else state.active = null;
}

async function readRegular(file: string, limit: number): Promise<Buffer> {
  await noLinks(file);
  const before = await fs.lstat(file, {bigint:true});
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) throw Error('Unsafe cache accounting metadata');
  const handle = await fs.open(file, 'r');
  try {
    const current = await handle.stat({bigint:true});
    if (!sameFile(before, current)) throw Error('Cache accounting metadata changed');
    const bytes = Buffer.alloc(Number(current.size));
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    await noLinks(file);
    if (bytesRead !== bytes.length || !sameFile(before, await handle.stat({bigint:true})) ||
        !sameFile(before, await fs.lstat(file, {bigint:true}))) throw Error('Cache accounting metadata changed');
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameFile(before: Awaited<ReturnType<typeof bigStat>>, current: Awaited<ReturnType<typeof bigStat>>) {
  return current.isFile() && current.nlink === 1n && before.dev === current.dev && before.ino === current.ino &&
    before.size === current.size && before.ctimeNs === current.ctimeNs && before.mtimeNs === current.mtimeNs;
}

const bigStat = (file: string) => fs.lstat(file, {bigint:true});
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function seal(value: Head | Entry | Anchor, key: Buffer) {
  const body = JSON.stringify(value);
  const mac = createHmac('sha256', key).update('frostveil-cache-accounting\0').update(body).digest('hex');
  const bytes = Buffer.from(JSON.stringify({body, mac}));
  if (bytes.length > maxRecordBytes) throw Error('Cache accounting metadata is too large');
  return bytes;
}

function unseal<T extends Head | Entry | Anchor>(bytes: Buffer, key: Buffer): T {
  const item = JSON.parse(bytes.toString('utf8')) as {body:string;mac:string};
  exact(item, 'body,mac');
  if (typeof item.body !== 'string' || !validHash(item.mac)) throw Error('Invalid cache accounting metadata envelope');
  const data = JSON.parse(item.body) as T;
  if (!bytes.equals(Buffer.from(JSON.stringify({body:item.body,mac:item.mac}))) ||
      !timingSafeEqual(Buffer.from(item.mac, 'hex'),
        createHmac('sha256', key).update('frostveil-cache-accounting\0').update(item.body).digest())) {
    throw Error('Cache accounting metadata authentication failed');
  }
  if (JSON.stringify(data) !== item.body) throw Error('Non-canonical cache accounting metadata');
  return data;
}

function entryName(sequence: number) {
  return sequence.toString().padStart(6, '0') + '.json';
}

async function openHistory(directory: string, scopeId: string, key: Buffer, assertHeld: () => Promise<void>): Promise<Snapshot> {
  const headFile = path.join(directory, headName), history = path.join(directory, historyName);
  const head = unseal<Head>(await readRegular(headFile, maxRecordBytes), key);
  exact(head, 'digest,scopeId,sequence');
  if (head.scopeId !== scopeId) throw Error('Cache accounting scope changed');
  if (!unsigned(head.sequence) || head.sequence > maxEntries || !validHash(head.digest)) throw Error('Invalid cache accounting head');
  await noLinks(history);
  const entries = (await fs.readdir(history)).sort();
  if (entries.length < head.sequence || entries.length > maxEntries || entries.length > head.sequence + 1) {
    throw Error('Missing or replayed cache accounting history');
  }
  const state: Snapshot = {head:{scopeId,sequence:0,digest:zeroDigest}, active:null, operations:new Map()};
  let usedBytes = 0;
  for (const name of entries) {
    const sequence = state.head.sequence + 1;
    if (name !== entryName(sequence)) throw Error('Missing or unexpected cache accounting history');
    const bytes = await readRegular(path.join(history, name), maxRecordBytes);
    usedBytes += bytes.length;
    if (usedBytes > maxHistoryBytes) throw Error('Cache accounting history size limit');
    const entry = unseal<Entry>(bytes, key);
    exact(entry, 'at,event,previous,scopeId,sequence');
    if (entry.scopeId !== scopeId || entry.previous !== state.head.digest || entry.sequence !== sequence ||
        !unsigned(entry.at)) throw Error('Changed cache accounting history');
    applyEvent(state, entry);
    state.head = {scopeId, sequence, digest:digest(bytes)};
    if (sequence === head.sequence && state.head.digest !== head.digest) throw Error('Cache accounting history authentication failed');
  }
  if (head.sequence === 0 && head.digest !== zeroDigest) throw Error('Invalid cache accounting history anchor');
  if (state.head.sequence > head.sequence) {
    await durableWrite(headFile, seal(state.head, key), false, assertHeld);
  }
  return state;
}

export class CacheLedger {
  private closed = false;
  private pending: Promise<unknown> | null = null;
  private freshReservation: string | null = null;

  constructor(
    private readonly directory: string,
    private readonly key: Buffer,
    private readonly snapshot: Snapshot,
    private readonly assertHeld: () => Promise<void>,
  ) {}

  private assertOpen() {
    if (this.closed) throw Error('Cache accounting lease is closed');
  }

  private write<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.pending) return Promise.reject(Error('Concurrent cache accounting write refused'));
    const pending = fn().finally(() => { this.pending = null; });
    this.pending = pending;
    return pending;
  }

  async close() {
    this.closed = true;
    if (this.pending) await this.pending;
  }

  private async append(event: Event) {
    const prior = this.snapshot.head;
    const sequence = prior.sequence + 1;
    if (sequence > maxEntries) throw Error('Cache accounting history limit');
    const entry: Entry = {scopeId:prior.scopeId,sequence,previous:prior.digest,at:Date.now(),event};
    const bytes = seal(entry, this.key);
    const head: Head = {...prior,sequence,digest:digest(bytes)};
    const next: Snapshot = {
      ...this.snapshot,
      operations: new Map(this.snapshot.operations),
    };
    if (event.kind !== 'reserve') {
      const operation = next.operations.get(event.operationId);
      if (operation) next.operations.set(event.operationId, {...operation, reservation:{...operation.reservation}});
    }
    applyEvent(next, entry);
    await this.assertHeld();
    try {
      await durableWrite(path.join(this.directory, historyName, entryName(sequence)), bytes, true, this.assertHeld);
      await durableWrite(path.join(this.directory, headName), seal(head, this.key), false, this.assertHeld);
    } catch (error) {
      // A durable event may exist even when advancing the head failed.
      this.closed = true;
      throw error;
    }
    Object.assign(this.snapshot, next, {head});
  }

  async readActive(): Promise<CacheReservation | null> {
    this.assertOpen();
    const id = this.snapshot.active;
    return id ? structuredClone(this.snapshot.operations.get(id)!.reservation) : null;
  }

  async reserve(input: CacheReservationInput): Promise<CacheReservation> {
    return this.write(async () => {
      await this.append({kind:'reserve', request:{...structuredClone(input),charges:encodeCharges(input.charges),
        beforeAllocated:encodeCharges(input.beforeAllocated)}});
      this.freshReservation = input.operationId;
      return structuredClone(this.snapshot.operations.get(input.operationId)!.reservation);
    });
  }

  private requireResolution(operationId: string, proof: CacheResolutionEvidence) {
    const active = this.snapshot.active && this.snapshot.operations.get(this.snapshot.active);
    if (!active || active.reservation.operationId !== operationId) throw Error('Unknown active cache accounting operation');
    const reservation = active.reservation;
    if (proof.quiescent !== true || proof.censusStable !== true ||
        proof.rawRootId !== reservation.rawRootId || proof.rawVolumeId !== reservation.rawVolumeId) {
      throw Error('Independent helper quiescence and matching cache root census required');
    }
    const observed = encodeCharges(proof.observed);
    return {active, observed};
  }

  async settle(operationId: string, proof: CacheSettlementEvidence): Promise<'verified' | 'failed' | 'overrun'> {
    return this.write(async () => {
      if (operationId !== this.freshReservation) throw Error('Prior cache reservations require independent reconciliation');
      const {active,observed} = this.requireResolution(operationId, proof);
      if (proof.outcome !== 'verified' && proof.outcome !== 'failed') throw Error('Invalid cache settlement outcome');
      const overrun = exceedsReservation(active.reservation.charges, validateObserved(active.reservation.charges, observed));
      const outcome = overrun ? 'overrun' : proof.outcome;
      const resolution: Resolution = {hostBootId:active.reservation.hostBootId,rawRootId:proof.rawRootId,
        rawVolumeId:proof.rawVolumeId,quiescence:'awaited'};
      await this.append({kind:'settle',operationId,outcome,observed,resolution,
        files:outcome === 'verified' ? structuredClone([...proof.files]) : []});
      return outcome;
    });
  }

  async reconcile(operationId: string, proof: CacheReconciliationEvidence) {
    return this.write(async () => {
      const {active,observed} = this.requireResolution(operationId, proof);
      if (!id(proof.hostBootId) || (proof.hostBootId === active.reservation.hostBootId && proof.independentlyQuiescent !== true)) {
        throw Error('A changed host boot or independently verified helper quiescence is required');
      }
      const resolution: Resolution = {hostBootId:proof.hostBootId,rawRootId:proof.rawRootId,
        rawVolumeId:proof.rawVolumeId,quiescence:proof.independentlyQuiescent === true ? 'independent' : 'changed-boot'};
      await this.append({kind:'settle',operationId,outcome:'reconciled',observed,resolution,files:[]});
    });
  }

  async recordVerifiedReuse(operationId: string, files: readonly CacheObservedFile[], advanceReview: boolean) {
    return this.write(async () => {
      const operation = this.snapshot.operations.get(operationId);
      if (!operation || operation.status !== 'verified') throw Error('Unknown verified cache reuse');
      const actual = matchVerifiedFiles(operation.reservation, [...files]);
      if (actual.some((file, index) => file.fileId !== operation.verifiedFiles[index]?.fileId ||
          file.generation !== operation.verifiedFiles[index]?.generation)) throw Error('Cache reuse identity changed');
      await this.append({kind:'reuse',operationId,advanceReview});
    });
  }

  /** Historical provenance receipt. A current use must independently match
   * observed file identities. This metadata never authorizes deletion. */
  async review(operationId: string, now = Date.now()) {
    this.assertOpen();
    const operation = this.snapshot.operations.get(operationId);
    if (!operation) return null;
    const {reservation,status,reviewedFrom} = operation;
    const owned = status === 'verified' && reservation.requested.every(file => file.before === null);
    const reviewAt = owned && reviewedFrom !== null && reservation.reviewAfterMs !== null
      ? reviewedFrom + reservation.reviewAfterMs : null;
    const disposition = status === 'reserved' ? 'RESERVED' : status === 'failed' ? 'FAILED_RETAINED' :
      !owned ? 'PROTECTED_UNKNOWN' : reviewAt !== null && now >= reviewAt ? 'REVIEW_DUE' : 'VERIFIED_RETAINED';
    const files = reservation.requested.map((file, index) => ({
      path:file.path,
      ownership:status === 'verified' && file.before === null && operation.verifiedFiles[index] ? 'PROVEN' : 'UNKNOWN',
    }));
    return {disposition, reviewAt, files, reserved:structuredClone(reservation.charges),
      observed:structuredClone(operation.observed), lastVerifiedReuseAt:operation.lastVerifiedReuseAt,
      resolution:structuredClone(operation.resolution)};
  }
}

async function cacheLock(directory:string){
  // libuv binds a first-instance Windows pipe. The operating system releases
  // it when the owning process exits, including exits during reconciliation.
  // The pipe serializes cooperating ledger opens; it does not prove helper exit.
  if(process.platform!=='win32')throw Error('Cache accounting lock requires Windows');
  const name=digest(Buffer.from(directory.toLowerCase()));
  const handle='\\\\.\\pipe\\frostveil-runtime-cache-'+name;
  const server=createServer(connection=>connection.destroy());
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen({path:handle,exclusive:true},()=>{
      server.removeListener('error',reject);
      resolve();
    });
  }).catch(error=>{
    if(isCode(error,'EADDRINUSE')||isCode(error,'EACCES'))throw Error('Concurrent cache accounting writer refused');
    throw error;
  });
  let failed=false;
  server.on('error',()=>{failed=true;});
  return {
    assertHeld(){
      if(failed||!server.listening)throw Error('Cache accounting lock identity changed');
    },
    close:()=>new Promise<void>((resolve,reject)=>{
      server.close(error=>error?reject(error):resolve());
    })
  };
}

export async function openCacheAccounting<T>(directory: string, scopeId: string, callback: (ledger: CacheLedger) => Promise<T>): Promise<T> {
  if (!path.isAbsolute(directory) || !id(scopeId)) throw Error('Invalid cache accounting scope');
  const anchorFile = path.resolve(directory) + '.anchor';
  await safeDirectory(directory).catch(async error => {
    if (!isCode(error,'EEXIST')) throw error;
    await noLinks(directory);
  });
  const real = await fs.realpath(directory);
  if ((process.platform === 'win32' ? real.toLowerCase() : real) !==
      (process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory))) {
    throw Error('Redirected cache accounting directory');
  }
  const root = await bigStat(directory);
  if (!root.isDirectory() || root.ino === 0n) throw Error('Unknown cache accounting directory identity');
  const lease = await cacheLock(real);
  const assertHeld = async () => {
    await noLinks(directory);
    const current = await bigStat(directory);
    if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino) {
      throw Error('Cache accounting directory identity changed');
    }
    lease.assertHeld();
  };
  try {
    await assertHeld();
    const names = (await fs.readdir(directory)).filter(name => name !== lockName && name !== reaperName);
    const anchorBytes = await readRegular(anchorFile,4096).catch(error => {
      if (!isCode(error,'ENOENT')) throw error;
      return null;
    });
    const keyFile = path.join(directory,keyName);
    const history = path.join(directory,historyName), head = path.join(directory,headName);
    const recognized = [keyName,headName,historyName];
    if (names.some(name => !recognized.includes(name))) throw Error('Unexpected cache accounting metadata');
    let key:Buffer;
    if (anchorBytes === null) {
      if (!names.includes(keyName) && names.length) throw Error('Missing cache accounting enrollment key or anchor');
      key = names.includes(keyName) ? await readRegular(keyFile,32) : randomBytes(32);
      if (key.length !== 32) throw Error('Invalid cache accounting metadata key');
      if (names.includes(historyName)) {
        await noLinks(history);
        if (!(await fs.lstat(history)).isDirectory() || (await fs.readdir(history)).length) {
          throw Error('Missing established cache accounting enrollment anchor');
        }
      }
      if (names.includes(headName)) {
        const initial = unseal<Head>(await readRegular(head,maxRecordBytes),key);
        exact(initial,'digest,scopeId,sequence');
        if (initial.scopeId !== scopeId || initial.sequence !== 0 || initial.digest !== zeroDigest) {
          throw Error('Missing established cache accounting enrollment anchor');
        }
      }
      // The callback can never reserve until the anchor is durable. Therefore
      // only a wholly empty history and the zero head can resume enrollment.
      if (!names.includes(keyName)) await durableWrite(keyFile,key,true,assertHeld);
      if (!names.includes(historyName)) await safeDirectory(history);
      if (!names.includes(headName)) await durableWrite(head,seal({scopeId,sequence:0,digest:zeroDigest},key),true,assertHeld);
      await durableWrite(anchorFile,seal({scopeId,rootId:`${root.dev}:${root.ino}`,keyDigest:digest(key)},key),true,assertHeld);
    } else {
      if (names.length !== recognized.length) throw Error('Missing cache accounting metadata or enrollment anchor');
      key = await readRegular(keyFile,32);
    }
    if (key.length !== 32) throw Error('Invalid cache accounting metadata key');
    const anchor = unseal<Anchor>(await readRegular(anchorFile,4096),key);
    exact(anchor,'keyDigest,rootId,scopeId');
    if (anchor.scopeId !== scopeId || anchor.rootId !== `${root.dev}:${root.ino}` || anchor.keyDigest !== digest(key)) {
      throw Error('Cache accounting enrollment scope changed');
    }
    const state = await openHistory(directory,scopeId,key,assertHeld);
    const ledger = new CacheLedger(directory,key,state,assertHeld);
    try {
      return await callback(ledger);
    } finally {
      await ledger.close();
    }
  } finally {
    await lease.close();
  }
}
