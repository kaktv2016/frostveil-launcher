// Test-only import replacements for the packaged W09 Electron fixture.
// The production main index and runtime recovery service remain real; every
// external provider/process adapter is inert and writes only below the fixture.
import {RuntimePreparation as RealRuntimePreparation} from '../src/main/runtime/service';
import {authenticateRuntimeCohort, type RuntimeCohort} from '../src/main/runtime/policy';
import type {WholePlayCheckpoint} from '../src/main/runtime/transaction';
import type {Profile} from '../src/shared/contracts';
import path from 'node:path';
import fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const root = process.env.FROSTVEIL_W09_FIXTURE;
if (!root || !path.isAbsolute(root)) throw Error('W09 fixture root missing');
const fixturePath = (...segments: string[]) => path.join(root, ...segments);
const gamePath = (library: string) => fixturePath(library, 'steamapps', 'common', 'Skyrim Special Edition');
const marker = (name: string) => fs.appendFile(fixturePath('markers.jsonl'), JSON.stringify({name, at: Date.now()}) + '\n');
const mode = (name: string) => fs.readFile(fixturePath(name), 'utf8');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function runtimeVersionFixture(file: string) {
  if (file === path.join(gamePath('a'),'SkyrimSE.exe') || file === path.join(gamePath('b'),'SkyrimSE.exe')) {
    return '1.6.1170.0';
  }
  const stage=fixturePath('local','SkyrimRPLauncher','managed-installations');
  const rel=path.relative(stage,file);
  if (!/^[a-f0-9]{64}[\\/]packages[\\/]runtime-staging[\\/][a-f0-9]{64}$/.test(rel)) {
    throw Error('W09 unexpected staged version path');
  }
  await marker('fixture-staged-version');
  return await mode('version-mode') === 'wrong' ? '1.6.640.0' : '1.6.1170.0';
}
async function trace<T>(run: Promise<T>): Promise<T> {
  try { return await run; }
  catch (error) {
    console.error('W09 fixture operation:', error);
    throw error;
  }
}
const syntheticFiles = () => fs.readFile(fixturePath('inputs.json'), 'utf8').then(JSON.parse) as Promise<{
  createdAt: string;
  runtime: string[];
  baseline: Array<{path: string; component: Profile['files'][number]['component']}>;
}>;

async function image(relative: string) {
  const bytes = await fs.readFile(fixturePath('depot', relative));
  return {path: relative, sha256: sha(bytes), size: bytes.length};
}

async function baseline(): Promise<Profile> {
  const inputs = await syntheticFiles();
  const files = await Promise.all(inputs.baseline.map(async ({path, component}) => ({...await image(path), component})));
  return {id:'w09-fixture', runtime:'1.6.1170.0', skseVersion:'0.2.2.6', skseDll:'skse64_1_6_1170.dll',
    evidence:'W09 inert fixture', files, backupFiles:[]};
}

export class RuntimePreparation extends RealRuntimePreparation {
  protected override runtimeVersion(file: string) { return runtimeVersionFixture(file); }
  override prepare(...args: Parameters<RealRuntimePreparation['prepare']>) { return trace(super.prepare(...args)); }
  override prepareWholePlay(...args: Parameters<RealRuntimePreparation['prepareWholePlay']>) { return trace(super.prepareWholePlay(...args)); }
  override restore(...args: Parameters<RealRuntimePreparation['restore']>) { return trace(super.restore(...args)); }
  protected override async loadPolicy(signal: AbortSignal): Promise<Readonly<RuntimeCohort>> {
    await marker('runtime-policy-started');
    while (await mode('policy-mode') === 'stall') await delay(50, undefined, {signal});
    if (await mode('policy-mode') === 'fail') throw Error('W09 controlled runtime metadata refusal');
    const {runtime, createdAt, baseline} = await syntheticFiles();
    const depots = ['489831', '489832', '489833'].map((id, i) => ({id, manifest:String(i+1).repeat(18)}));
    const files = await Promise.all(runtime.map(async (relative, i) => ({...await image(relative), depot:depots[i % depots.length]!.id})));
    const payload: RuntimeCohort = {
      schemaVersion:1, kind:'frostveil-steam-runtime', runtime:'1.6.1170.0', appId:'489830', language:'english',
      createdAt, expiresAt:new Date(Date.parse(createdAt)+86400000).toISOString(), depots, files, creations:[],
      managedFiles:await Promise.all(baseline.filter(file=>!runtime.includes(file.path)).map(file=>image(file.path))), pluginOrder:[],
      configuration:{pluginsBase64:'', loadorderBase64:''},
      helper:{version:'3.4.0', size:1, sha256:'a'.repeat(64)}, acquisition:{verified:true, receiptSha256:'b'.repeat(64)},
    };
    // An ephemeral fixture key exercises the complete cohort schema and brand.
    // Its trust map is confined to this test bundle and the key is never persisted.
    const {publicKey, privateKey} = generateKeyPairSync('ed25519');
    const bytes = Buffer.from(JSON.stringify(payload));
    const envelope = {keyId:'w09-fixture', payloadBase64:bytes.toString('base64'), signatureBase64:sign(null,bytes,privateKey).toString('base64')};
    return authenticateRuntimeCohort(envelope, {'w09-fixture':{environment:'production',revoked:false,publicKey:publicKey.export({type:'spki',format:'pem'}).toString()}});
  }
  protected override async acquire(_policy: Readonly<RuntimeCohort>, _cache: string, signal: AbortSignal) {
    signal.throwIfAborted();
    await marker('fixture-runtime-source');
    return fixturePath('depot');
  }
  protected override async wholePlayCheckpoint(stage: WholePlayCheckpoint) {
    if (stage === 'after-target-write' && await mode('apply-mode') === 'fail') {
      await marker('post-write-refusal');
      throw Error('W09 controlled post-write refusal; Restore is available');
    }
  }
}

export class ProductionDownloads extends EventEmitter {
  private value = {phase: 'idle', installed: false, message: 'W09 inert provider', bytes: 0, totalBytes: 0, speedMBps: 0, files:[]};
  private operation?: AbortController;
  snapshot() { return structuredClone(this.value); }
  async baselineProfile() {
    await marker('provider-baseline-started');
    while (await mode('provider-mode') === 'stall') await delay(50);
    if (await mode('provider-mode') === 'fail') throw Error('W09 controlled metadata refusal');
    return baseline();
  }
  async inspectInstallation() {
    await marker('provider-inspection-started');
    while (await mode('inspection-mode') === 'stall') await delay(50);
    if (await mode('provider-mode') === 'fail') throw Error('W09 controlled provider refusal');
  }
  async wholePlayAdmission(signal: AbortSignal) {
    signal.throwIfAborted();
    await marker('fixture-pack-admission');
    const profile = await baseline();
    return {packagedTargets:[], plan:async () => ({
      cohortId:'c'.repeat(64), baseline:profile, writes:[], publishReady:()=>this.setInstalled(true),
    })};
  }
  async installAndActivate(game: string) {
    if (game !== gamePath('a')) throw Error('W09 unexpected server pack target');
    const operation = new AbortController();
    this.operation = operation;
    this.value.phase = 'downloading';
    this.emit('state', this.snapshot());
    await marker('inert-server-download-started');
    try { await delay(30000, undefined, {signal:operation.signal}); }
    finally {
      this.operation=undefined;
      this.value.phase = operation.signal.aborted ? 'cancelled' : 'error';
      this.emit('state', this.snapshot());
      if (operation.signal.aborted) await marker('inert-server-download-cancelled');
    }
  }
  setInstalled(value: boolean) { this.value.installed = value; }
  subscribe(fn: (value: unknown) => void) { this.on('state', fn); return () => this.off('state', fn); }
  dispose() {}
  cancel() { this.operation?.abort(); }
  invalidateInstalled() { this.value.installed = false; }
}

export class GraphicsPackService extends EventEmitter {
  private value = {phase: 'idle', installed: false, message: 'W09 inert graphics provider', bytes: 0, totalBytes: 0, speedMBps: 0};
  constructor(_storage: string) { super(); }
  snapshot() { return structuredClone(this.value); }
  async inspect() { return this.snapshot(); }
  subscribe(fn: (value: unknown) => void) { this.on('state', fn); return () => this.off('state', fn); }
  dispose() {}
  cancel() {}
  invalidateInstalled() { this.value.installed = false; }
  setSourceRepairTargets() {}
  reportSourceRepair() {}
  async planWholePlay() { return {writes:[]}; }
}

export const fixtureWindows = {
  gameRunning: async () => false,
  steamRoots: async () => [fixturePath('a')],
  fileVersion: async (file: string) => path.basename(file) === 'SkyrimSE.exe' ? '1.6.1170.0' : '0.2.2.6',
  startSkse: async (exe: string, cwd: string) => {
    if (cwd !== gamePath('a') || exe !== path.join(gamePath('a'), 'skse64_loader.exe')) throw Error('W09 unexpected launch path');
    await marker('inert-skse');
  },
  authenticode: async () => undefined,
};

export const fixtureClientRepair = {clientRequirementForScan: async (f: any) => f, nativeRequirementForScan: async (f: any) => f,
  planClientForWholePlay: async () => ({writes:[]})};
export const fixtureGraphicsSourcePlan = {loadGraphicsSourcePlan: async () => ({version:'1.0.20',files:[]}), graphicsSourceDirectories: async () => []};

export async function createUpdater() {
  const listeners = new Set<(state: any) => void>();
  const value = {state: 'idle', installedVersion: 'fixture', message: 'W09 updater disabled', canDownload: false, canInstall: false, source: 'fixture'};
  return {snapshot: () => structuredClone(value), subscribe: (fn: (state: any) => void) => {listeners.add(fn); return () => listeners.delete(fn);},
    check: async () => {}, download: async () => { throw Error('W09 updater disabled'); },
    install: async () => { throw Error('W09 updater disabled'); }, defer: () => {}, dispose: () => listeners.clear()};
}
