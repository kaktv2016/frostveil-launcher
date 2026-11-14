import {execFile} from 'node:child_process';
import path from 'node:path';
import {inspectCacheScript} from './cache-census-windows';

export type CacheVolumeObservation = {
  volumeId: string;
  availableBytes: bigint;
  allocationUnitBytes: bigint;
};

export type RawCacheRoot = {
  path: string;
  state: 'PRESENT' | 'ABSENT';
  volumeId: string;
  fileId: string | null;
  generation: string | null;
  ancestorPath: string;
  ancestorFileId: string;
  ancestorGeneration: string;
};

export type RawCacheFile = {
  path: string;
  volumeId: string;
  fileId: string;
  generation: string;
  logicalBytes: bigint;
  allocatedBytes: bigint;
  linkCount: number;
  known: boolean;
};

export type RawCacheVolume = CacheVolumeObservation & {
  logicalBytes: bigint;
  allocatedBytes: bigint;
  unknownLogicalBytes: bigint;
  unknownAllocatedBytes: bigint;
};

type IssueCode = 'INVALID_SCOPE' | 'INVALID_ENTRY' | 'UNSTABLE_ENTRY' | 'REDIRECTED_PATH'
  | 'UNSUPPORTED_VOLUME' | 'UNSUPPORTED_STREAM' | 'UNVERIFIED_HARDLINK' | 'MEASUREMENT_FAILED' | 'ENTRY_LIMIT';

export type RawCacheIssue = {code: IssueCode; path?: string};

export type RawCacheCensus = {
  status: 'COMPLETE' | 'UNKNOWN';
  roots: RawCacheRoot[];
  volumes: RawCacheVolume[];
  files: RawCacheFile[];
  issues: RawCacheIssue[];
};

type CensusOptions = {knownPaths?: ReadonlySet<string>; maxEntries?: number};
type NativeFile = Omit<RawCacheFile, 'logicalBytes' | 'allocatedBytes' | 'known'> & {
  logicalBytes: string;
  allocatedBytes: string;
};
type NativeVolume = Omit<CacheVolumeObservation, 'availableBytes' | 'allocationUnitBytes'> & {
  availableBytes: string;
  allocationUnitBytes: string;
};
type NativeResult = {root?: RawCacheRoot; volume?: NativeVolume; files: NativeFile[];
  directories: NativeFile[]; error?: IssueCode};
type ObserverMode = 'volume' | 'census' | 'children' | 'file';

const maxRoots = 128;
const maxEntries = 20_000;
const maxPath = 240; // Keep .NET Framework directory enumeration within its ordinary Win32 path limit.
const issueCodes = new Set<IssueCode>([
  'INVALID_SCOPE', 'INVALID_ENTRY', 'UNSTABLE_ENTRY', 'REDIRECTED_PATH',
  'UNSUPPORTED_VOLUME', 'UNSUPPORTED_STREAM', 'UNVERIFIED_HARDLINK', 'MEASUREMENT_FAILED', 'ENTRY_LIMIT',
]);

function localDirectory(raw: string, allowDriveRoot: boolean): string {
  if (typeof raw !== 'string' || raw.length > maxPath || !/^[a-z]:[/\\]/i.test(raw)) {
    throw Error('INVALID_SCOPE');
  }
  const normalized = raw.replaceAll('/', '\\');
  const names = normalized.slice(3).split('\\');
  if (allowDriveRoot && normalized.length === 3) return normalized;
  if (names.some(name => !name || /[. ]$|[<>:"|?*\x00-\x1f]/.test(name)
    || /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³])(?:\.|$)/i.test(name))) {
    throw Error('INVALID_SCOPE');
  }
  return normalized;
}

function validateRoots(roots: readonly string[]): string[] {
  if (!roots.length || roots.length > maxRoots) throw Error('INVALID_SCOPE');
  const validated = roots.map(root => localDirectory(root, false));
  const lower = validated.map(root => root.toLowerCase());
  if (lower.some((value, index) => lower.some((other, otherIndex) => index !== otherIndex
    && (value === other || value.startsWith(other + '\\'))))) throw Error('INVALID_SCOPE');
  return validated;
}

async function inspectWindows(roots: readonly string[], mode: ObserverMode, limit: number): Promise<NativeResult[]> {
  if (process.platform !== 'win32') throw Error('UNSUPPORTED_VOLUME');
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // The program is embedded source. Only the JSON request contains caller-controlled data.
  const boot = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())); & ([ScriptBlock]::Create($source))";
  const script = Buffer.from(inspectCacheScript, 'utf8').toString('base64');
  const input = Buffer.from(script + '\n' + JSON.stringify({roots, mode, limit}), 'utf8');
  const output = await new Promise<string>((resolve, reject) => {
    const process = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', boot], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => error ? reject(Error('MEASUREMENT_FAILED')) : resolve(stdout));
    process.stdin?.on('error', () => { /* execFile reports an early observer exit */ });
    process.stdin?.end(input);
  });
  const result: unknown = JSON.parse(output);
  if (!Array.isArray(result)) throw Error('MEASUREMENT_FAILED');
  return result as NativeResult[];
}

function volumeFromNative(volume: NativeVolume): CacheVolumeObservation {
  const availableBytes = BigInt(volume.availableBytes);
  const allocationUnitBytes = BigInt(volume.allocationUnitBytes);
  if (!volume.volumeId || availableBytes < 0n || allocationUnitBytes <= 0n) throw Error('MEASUREMENT_FAILED');
  return {volumeId: volume.volumeId, availableBytes, allocationUnitBytes};
}

function issueCode(error: unknown): IssueCode {
  const code = error instanceof Error ? error.message as IssueCode : 'MEASUREMENT_FAILED';
  return issueCodes.has(code) ? code : 'MEASUREMENT_FAILED';
}

export async function measureCacheVolume(candidate: string): Promise<CacheVolumeObservation> {
  const {volumes: [volume]} = await measureCacheRoots([candidate]);
  if (!volume) throw Error('MEASUREMENT_FAILED');
  return volume;
}

/** Validates absolute roots and observes their volume without enumerating contents. */
export async function measureCacheRoots(candidates: readonly string[]):
  Promise<{roots: RawCacheRoot[]; volumes: CacheVolumeObservation[]}> {
  if (!candidates.length || candidates.length > maxRoots) throw Error('INVALID_SCOPE');
  const input = new Map<string, string>();
  for (const candidate of candidates) {
    const root = localDirectory(candidate, true);
    input.set(root.toLowerCase(), root);
  }
  const measured = await inspectWindows([...input.values()], 'volume', 0);
  if (measured.length !== input.size) throw Error('MEASUREMENT_FAILED');
  const roots: RawCacheRoot[] = [];
  const volumes = new Map<string, CacheVolumeObservation>();
  for (const observation of measured) {
    if (!observation.root || !observation.volume || observation.error) {
      throw Error(observation.error ?? 'MEASUREMENT_FAILED');
    }
    const volume = volumeFromNative(observation.volume);
    const previous = volumes.get(volume.volumeId);
    if (previous && previous.allocationUnitBytes !== volume.allocationUnitBytes) throw Error('UNSTABLE_ENTRY');
    if (!previous || volume.availableBytes < previous.availableBytes) volumes.set(volume.volumeId, volume);
    roots.push(observation.root);
  }
  return {roots, volumes: [...volumes.values()]};
}

/** Lists only direct ordinary directory names. The Windows handle protects the enumerated parent. */
export async function listCacheDirectory(candidate: string, maxChildren = maxRoots): Promise<string[]> {
  const root = localDirectory(candidate, false);
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 1 || maxChildren > maxEntries) throw Error('INVALID_SCOPE');
  const [observation] = await inspectWindows([root], 'children', maxChildren);
  if (!observation?.root || observation.error) throw Error(observation?.error ?? 'MEASUREMENT_FAILED');
  return observation.directories.filter(entry => entry.path !== observation.root!.path)
    .map(entry => path.win32.basename(entry.path));
}

function observedFile(value: NativeFile, known: boolean): RawCacheFile {
  const {path: filename, volumeId, fileId, generation, linkCount, logicalBytes, allocatedBytes} = value;
  return {path: filename, volumeId, fileId, generation, linkCount,
    logicalBytes: BigInt(logicalBytes), allocatedBytes: BigInt(allocatedBytes), known};
}

/** Observes only the requested existing file identities and does not enumerate sibling names. */
export async function measureCacheFiles(candidates: readonly string[]): Promise<RawCacheFile[]> {
  if (!candidates.length) return [];
  if (candidates.length > maxRoots) throw Error('INVALID_SCOPE');
  const roots = candidates.map(value => localDirectory(value, false));
  const measured = await inspectWindows(roots, 'file', 0);
  if (measured.length !== roots.length) throw Error('MEASUREMENT_FAILED');
  return measured.map((result, index) => {
    const [file] = result.files;
    if (result.error || result.files.length !== 1 || file?.path.toLowerCase() !== roots[index]?.toLowerCase()) {
      throw Error(result.error ?? 'MEASUREMENT_FAILED');
    }
    return observedFile(file!, false);
  });
}

function summarize(files: readonly RawCacheFile[], volumes: Map<string, RawCacheVolume>, issues: RawCacheIssue[]) {
  const unique = new Map<string, {file: RawCacheFile; names: Set<string>; known: boolean}>();
  for (const file of files) {
    const key = file.volumeId + '/' + file.fileId;
    const group = unique.get(key);
    const name = file.path.toLowerCase();
    const first = group?.file;
    if (!group || !first) unique.set(key, {file, names: new Set([name]), known: file.known});
    else if (first.generation !== file.generation || first.allocatedBytes !== file.allocatedBytes
      || first.logicalBytes !== file.logicalBytes || first.linkCount !== file.linkCount
      || first.linkCount <= 1 || group.names.has(name)) {
      issues.push({code: 'UNSTABLE_ENTRY', path: file.path});
      group.known = false;
    } else {
      group.names.add(name);
      group.known &&= file.known;
    }
  }
  for (const {file, names, known} of unique.values()) {
    const volume = volumes.get(file.volumeId);
    if (!volume) {
      issues.push({code: 'MEASUREMENT_FAILED', path: file.path});
      continue;
    }
    volume.logicalBytes += file.logicalBytes;
    volume.allocatedBytes += file.allocatedBytes;
    const unverifiedAlias = names.size !== file.linkCount;
    if (unverifiedAlias) issues.push({code: 'UNVERIFIED_HARDLINK', path: file.path});
    if (!known || unverifiedAlias) {
      volume.unknownLogicalBytes += file.logicalBytes;
      volume.unknownAllocatedBytes += file.allocatedBytes;
    }
  }
}

export async function censusRawCache(candidates: readonly string[], options: CensusOptions = {}): Promise<RawCacheCensus> {
  const result: RawCacheCensus = {status: 'UNKNOWN', roots: [], volumes: [], files: [], issues: []};
  const volumes = new Map<string, RawCacheVolume>();
  try {
    const roots = validateRoots(candidates);
    const limit = options.maxEntries ?? maxEntries;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxEntries) throw Error('INVALID_SCOPE');
    const knownPaths = new Set(Array.from(options.knownPaths ?? [], filename => localDirectory(filename, false).toLowerCase()));
    const measured = await inspectWindows(roots, 'census', limit);
    if (measured.length < roots.length && !measured.some(item => item.error === 'ENTRY_LIMIT')) {
      throw Error('MEASUREMENT_FAILED');
    }
    for (const [index, observation] of measured.entries()) {
      const rootPath = roots[index];
      if (!rootPath) throw Error('MEASUREMENT_FAILED');
      if (observation.error) result.issues.push({code: issueCode(Error(observation.error)), path: rootPath});
      if (observation.root && observation.root.path.toLowerCase() === rootPath.toLowerCase()) result.roots.push(observation.root);
      else if (!observation.error) throw Error('MEASUREMENT_FAILED');
      if (!observation.volume) continue;
      const volume = volumeFromNative(observation.volume);
      const previous = volumes.get(volume.volumeId);
      if (!previous) volumes.set(volume.volumeId, {...volume, logicalBytes: 0n, allocatedBytes: 0n,
        unknownLogicalBytes: 0n, unknownAllocatedBytes: 0n});
      else if (previous.allocationUnitBytes !== volume.allocationUnitBytes) {
        result.issues.push({code: 'UNSTABLE_ENTRY', path: rootPath});
      } else if (volume.availableBytes < previous.availableBytes) {
        previous.availableBytes = volume.availableBytes;
      }
      for (const file of observation.files) {
        result.files.push(observedFile(file, knownPaths.has(file.path.toLowerCase())));
      }
    }
    summarize(result.files, volumes, result.issues);
    result.volumes = [...volumes.values()];
    if (result.issues.length === 0 && result.roots.length === roots.length) result.status = 'COMPLETE';
  } catch (error) {
    result.issues.push({code: issueCode(error)});
  }
  return result;
}
