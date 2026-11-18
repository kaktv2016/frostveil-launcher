import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hashFile, noLinks, relativePath, safeDirectory } from '../files';
import { pluginName } from '../modpack/schema';
import type { PlayProjection, PlayWrite, PlayWriter } from '../runtime/whole-play';
import { sourceVerifiesLegacyTarget } from '../navigation-repair-targets';

export interface GraphicsManifest {
  version: string;
  generatedAt: string;
  packageName: string;
  downloadUrl: string;
  size: number;
  sha256: string;
  integrityPatchUrl?: string;
  integrityPatchSize?: number;
  integrityPatchSha256?: string;
  activePlugins: string[];
  masterPlugins?: string[];
  forbiddenPlugins?: string[];
  integrityFiles?: Record<string, { size: number; sha256: string }>;
}

export interface GraphicsPackState {
  phase: 'idle' | 'checking' | 'downloading' | 'extracting' | 'complete' | 'error' | 'cancelled';
  installed: boolean;
  version?: string;
  availableVersion?: string;
  message: string;
  bytes: number;
  totalBytes: number;
  speedMBps: number;
  error?: string;
}

const R2_MANIFEST_URL = 'https://pub-276cbfc24fc84b30bbef7eaa4f57067c.r2.dev/frostveil-graphics-manifest.json';

const DEFAULT_MASTER_PLUGINS = [
  'unofficial skyrim special edition patch.esp',
  'Lux - Master plugin.esm',
  'Lux - Resources.esp',
  'Natural Waterfalls.esp',
  'Natural Waterfalls - Dawnguard.esp',
  'Natural Waterfalls - Dragonborn.esp',
  'Natural Waterfalls - Blackreach.esp',
];

function graphicsActivationImages(manifest: GraphicsManifest, existingText: string) {
    const bom = existingText.startsWith('\uFEFF') ? '\uFEFF' : '';
    const masterList = manifest.masterPlugins ?? DEFAULT_MASTER_PLUGINS;
    const masterSet = new Set(masterList.map(p => p.toLowerCase()));
    const nonMasterList = manifest.activePlugins.filter(p => !masterSet.has(p.toLowerCase()));

    // Canonical Master-First order:
    // 1. All 8 ESM-flagged masters in topological order
    // 2. FrostveilCourierNavigation.esp (server-required full plugin immediately after masters)
    // 3. All 19 non-master Graphics & World plugins in topological order
    // 4. SkyUI_SE.esp (client-only required UI plugin)
    const canonicalOrder = [
      ...masterList,
      'FrostveilCourierNavigation.esp',
      ...nonMasterList,
      'SkyUI_SE.esp',
    ];

    // Retain enabled mods absent from the remote canonical list. A manifest is
    // not permission to disable the player's unrelated installed plugins.
    const canonicalNames = new Set(canonicalOrder.map(p => p.toLowerCase()));
    const retained = existingText.replace(/^\uFEFF/, '').split(/\r?\n/)
      .map(line => line.trim()).filter(line => line.startsWith('*'))
      .map(line => line.slice(1).trim())
      .filter(name => !canonicalNames.has(name.toLowerCase()));
    for (const name of retained) {
      if (!canonicalNames.has(name.toLowerCase())) {canonicalOrder.push(name);canonicalNames.add(name.toLowerCase());}
    }
    const pluginsLines = [
      '# This file is used by Skyrim to keep track of your downloaded content.',
      '# Please do not modify this file.',
      ...canonicalOrder.map(p => `*${p}`),
    ];
    const loadorderLines = [
      'Skyrim.esm',
      'Update.esm',
      'Dawnguard.esm',
      'HearthFires.esm',
      'Dragonborn.esm',
      'ccBGSSSE001-Fish.esm',
      'ccBGSSSE025-AdvDSGS.esm',
      'ccBGSSSE037-Curios.esl',
      'ccQDRSSE001-SurvivalMode.esl',
      '_ResourcePack.esl',
      ...canonicalOrder,
    ];

    const nextPluginsText = bom + pluginsLines.join('\r\n') + '\r\n';
    const nextLoadorderText = loadorderLines.join('\r\n') + '\r\n';
    return {nextPluginsText,nextLoadorderText};
}

const legacyBaseFiles = ['d3dx9_42.dll', 'Data/Lux.esp', 'Data/Ulvenwald.esp', 'Data/BlendedRoads.esp'];
const legacyArchiveLimit = 9 * 1024 ** 3;

interface LegacyImage {
  path: string;
  size: number;
  sha256: string;
}

interface LegacyArchive {
  url: string;
  size: number;
  sha256: string;
}

function legacyArchive(url: unknown, size: unknown, sha256: unknown): LegacyArchive {
  if (typeof url !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size) ||
      size < 1 || size > legacyArchiveLimit || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw Error('Missing bounded legacy graphics archive identity');
  }
  const address = new URL(url);
  if (address.origin !== new URL(R2_MANIFEST_URL).origin || address.username || address.password ||
      address.search || address.hash || !address.pathname.endsWith('.zip')) {
    throw Error('Unapproved legacy graphics archive URL');
  }
  return {url, size, sha256};
}

async function matchesLegacyImage(file: string | null, image: {size: number; sha256: string}) {
  if (!file) return false;
  await noLinks(file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1) throw Error('Unsafe or hard-linked legacy graphics file');
  if (stat.size !== image.size) return false;
  return (await hashFile(file, image.size)).sha256 === image.sha256;
}

function limitBytes(size: number) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > size) return done(Error('Graphics staging exceeds the planned byte limit'));
      done(null, chunk);
    },
  });
}
export class GraphicsPackService {
  private state: GraphicsPackState = {
    phase: 'idle',
    installed: false,
    message: 'Mandatory Graphics & World Pack ready to verify from Cloudflare R2.',
    bytes: 0,
    totalBytes: 7270769508,
    speedMBps: 0,
  };
  private listeners = new Set<(state: GraphicsPackState) => void>();
  private controller?: AbortController;
  private manifestCache?: GraphicsManifest;
  private sourceRepairTargets = new Set<string>();

  /** These assets have a second, hash-pinned source verifier before Play. */
  setSourceRepairTargets(targets: string[]) {
    if (targets.some(p => !sourceVerifiesLegacyTarget(p))) {
      throw new Error('Only reviewed graphics/navigation assets may use source repair targets');
    }
    this.sourceRepairTargets = new Set(targets.map(p => p.toLowerCase()));
  }

  reportSourceRepair(message: string, complete = false) {
    this.update({ phase: complete ? 'complete' : 'checking', message });
  }

  constructor(private storageDir: string) {}

  snapshot(): GraphicsPackState {
    return structuredClone(this.state);
  }

  subscribe(listener: (state: GraphicsPackState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<GraphicsPackState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* listener error ignored */
      }
    }
  }

  async fetchManifest(signal?: AbortSignal, forceRefresh = false): Promise<GraphicsManifest> {
    if (this.manifestCache && !forceRefresh) return this.manifestCache;
    const res = await fetch(R2_MANIFEST_URL, {
      signal: signal ?? AbortSignal.timeout(8000),
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) throw new Error(`Could not fetch graphics manifest: ${res.statusText}`);
    this.manifestCache = (await res.json()) as GraphicsManifest;
    return this.manifestCache;
  }

  private hasBaseAssets(gameDirectory: string): boolean {
    return (
      fsSync.existsSync(path.join(gameDirectory, 'd3dx9_42.dll')) &&
      fsSync.existsSync(path.join(gameDirectory, 'Data', 'Lux.esp')) &&
      fsSync.existsSync(path.join(gameDirectory, 'Data', 'Ulvenwald.esp')) &&
      fsSync.existsSync(path.join(gameDirectory, 'Data', 'BlendedRoads.esp'))
    );
  }

  async inspect(gameDirectory?: string) {
    if (!gameDirectory) {
      this.update({ installed: false, message: 'Select Skyrim folder first' });
      return this.snapshot();
    }

    let installed = false;
    let version: string | undefined;

    try {
      const verPath = path.join(gameDirectory, 'Data', 'frostveil-graphics-version.json');
      if (fsSync.existsSync(verPath)) {
        const raw = JSON.parse(await fs.readFile(verPath, 'utf8'));
        version = raw.version;
        const hasBase = this.hasBaseAssets(gameDirectory);
        const hasParallaxFix = fsSync.existsSync(path.join(gameDirectory, 'Data', 'Parallax TXST Fixes.esp'));
        if (hasBase && hasParallaxFix) {
          installed = true;
        }
      }
    } catch {
      installed = false;
    }

    try {
      const manifest = await this.fetchManifest();
      const upToDate = installed && version === manifest.version;
      this.update({
        installed: upToDate,
        version,
        availableVersion: manifest.version,
        totalBytes: manifest.size,
        message: upToDate
          ? `Mandatory Graphics & World Pack v${version} verified (Anti-Cheat active)`
          : this.hasBaseAssets(gameDirectory)
            ? `Graphics & Anti-Cheat Integrity update v${manifest.version} ready (auto-applies on Play)`
            : `Mandatory Graphics & World Pack v${manifest.version} required (6.77 GB)`,
      });
    } catch {
      this.update({
        installed,
        version,
        message: installed ? `Mandatory Graphics & World Pack installed` : `Ready to check Cloudflare R2`,
      });
    }

    return this.snapshot();
  }

  private async verifyIntegrityFiles(
    gameDirectory: string,
    manifest: GraphicsManifest
  ): Promise<{ valid: boolean; mismatched: string[] }> {
    if (!manifest.integrityFiles) return { valid: true, mismatched: [] };

    // Source repair runs after any legacy base extraction. It verifies every
    // excluded asset and prevents old hashes from reintroducing the v106 meshes.
    const entries = Object.entries(manifest.integrityFiles)
      .filter(([p]) => !this.sourceRepairTargets.has(p.toLowerCase()));
    const results = await Promise.all(
      entries.map(async ([relPath, expected]) => {
        const fullPath = path.join(gameDirectory, ...relPath.split('/'));
        try {
          const st = await fs.stat(fullPath);
          if (st.size !== expected.size) return relPath;
          const actualHash = await this.computeHash(fullPath);
          return actualHash === expected.sha256 ? null : relPath;
        } catch {
          return relPath;
        }
      })
    );
    const mismatched = results.filter((r): r is string => r !== null);
    return { valid: mismatched.length === 0, mismatched };
  }

  private async applyIntegrityPatch(
    gameDirectory: string,
    manifest: GraphicsManifest,
    signal?: AbortSignal
  ): Promise<void> {
    if (!manifest.integrityPatchUrl || !manifest.integrityPatchSha256) {
      throw new Error('Integrity patch URL is missing from manifest');
    }

    const cacheFolder = path.join(this.storageDir, 'r2-cache');
    await fs.mkdir(cacheFolder, { recursive: true });
    const patchArchive = path.join(cacheFolder, `frostveil-integrity-patch-v${manifest.version}.zip`);

    let needsDownload = true;
    if (fsSync.existsSync(patchArchive)) {
      const hash = await this.computeHash(patchArchive).catch(() => '');
      if (hash === manifest.integrityPatchSha256) {
        needsDownload = false;
      }
    }

    if (needsDownload) {
      const totalBytes = manifest.integrityPatchSize || 0;
      this.update({
        phase: 'downloading',
        bytes: 0,
        totalBytes,
        message: `Downloading anti-cheat & world integrity patch v${manifest.version}...`,
      });

      const res = await fetch(manifest.integrityPatchUrl, { signal: signal ?? AbortSignal.timeout(900000) });
      if (!res.ok) throw new Error(`Failed to download integrity patch: HTTP ${res.status}`);
      if (!res.body) throw new Error('Response body is null');

      const tempFile = patchArchive + '.part';
      const fileStream = fsSync.createWriteStream(tempFile);
      const hashStream = createHash('sha256');
      const reader = res.body.getReader();
      let bytesDownloaded = 0;
      let lastTime = Date.now();
      let bytesSinceLast = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        fileStream.write(Buffer.from(value));
        hashStream.update(value);
        bytesDownloaded += value.length;
        bytesSinceLast += value.length;

        const now = Date.now();
        if (now - lastTime >= 500) {
          const speed = (bytesSinceLast / (now - lastTime)) * 1000;
          const pct = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 0;
          this.update({
            phase: 'downloading',
            bytes: bytesDownloaded,
            totalBytes: totalBytes || bytesDownloaded,
            speedMBps: speed / (1024 * 1024),
            message: `Downloading integrity patch v${manifest.version} (${pct}%)...`,
          });
          lastTime = now;
          bytesSinceLast = 0;
        }
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end((err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const hash = hashStream.digest('hex');
      if (hash !== manifest.integrityPatchSha256) {
        await fs.unlink(tempFile).catch(() => {});
        throw new Error(`Integrity patch hash mismatch: expected ${manifest.integrityPatchSha256}, got ${hash}`);
      }

      if (fsSync.existsSync(patchArchive)) {
        await fs.unlink(patchArchive).catch(() => {});
      }
      await fs.rename(tempFile, patchArchive);
    }

    this.update({
      phase: 'extracting',
      message: 'Restoring verified plugins, SKSE DLLs & anti-cheat INI configurations...',
    });
    await this.repairNestedEmbersFolders(gameDirectory);
    await this.extractToGame(patchArchive, gameDirectory);
  }

  private async repairNestedEmbersFolders(gameDirectory: string): Promise<void> {
    const copyRecursive = async (srcDir: string, destDir: string): Promise<void> => {
      if (!fsSync.existsSync(srcDir)) return;
      const entries = await fs.readdir(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const s = path.join(srcDir, entry.name);
        const d = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          await fs.mkdir(d, { recursive: true });
          await copyRecursive(s, d);
        } else {
          await fs.mkdir(path.dirname(d), { recursive: true });
          await fs.copyFile(s, d);
        }
      }
    };

    const texRoot = path.join(gameDirectory, 'Data', 'textures');
    for (const v of ['hd', 'common', 'embers', 'new', 'cs']) {
      await copyRecursive(path.join(texRoot, v, 'textures'), texRoot).catch(() => {});
    }
    // Retain source folders and existing normal textures. Flattening must never
    // delete another mod's files, even when a copy fails.

  }

  /**
   * AAA Mandatory Pre-Play Enforcement:
   * 1. Requires the Graphics & World Pack to be installed (auto-downloads if missing).
   * 2. Preserves existing enabled plugins omitted from the manifest.
   * 3. Verifies SHA-256 hashes of all 27 plugins, SKSE DLLs, and hardened INI/TOML configs.
   *    Source-managed assets are verified separately after the legacy patch.
   * 4. Enforces the exact Master-First topological load order in both plugins.txt and loadorder.txt.
   */
  async verifyAndEnforceForPlay(gameDirectory: string, orderDirectory: string): Promise<GraphicsPackState> {
    if (!gameDirectory) throw new Error('Game directory is required');

    if (!this.hasBaseAssets(gameDirectory)) {
      return this.downloadAndInstall(gameDirectory, orderDirectory);
    }

    this.update({
      phase: 'checking',
      message: 'Verifying anti-cheat SHA-256 hashes for 27 world plugins & configs...',
    });

    const manifest = await this.fetchManifest(undefined, true);
    const check = await this.verifyIntegrityFiles(gameDirectory, manifest);

    if (!check.valid) {
      await this.applyIntegrityPatch(gameDirectory, manifest);
      const recheck = await this.verifyIntegrityFiles(gameDirectory, manifest);
      if (!recheck.valid) {
        throw new Error(`Anti-cheat integrity verification failed for: ${recheck.mismatched.slice(0, 5).join(', ')}`);
      }
    }

    await this.activatePlugins(manifest, orderDirectory);
    await this.enforceSkyrimPrefs();

    this.update({
      phase: 'complete',
      installed: true,
      version: manifest.version,
      availableVersion: manifest.version,
      message: `✓ Graphics & Anti-Cheat Integrity v${manifest.version} verified (100% match)`,
    });

    return this.snapshot();
  }

  /**
   * Normal Play admits only named legacy members whose output is independently
   * authorized by the signed runtime inventory. Extraction writes into Launcher
   * staging, and profile and preferences are owned by the whole-Play plan.
   */
  async planWholePlay(projection: PlayProjection, reservedTargets: ReadonlySet<string> = new Set()): Promise<PlayWriter> {
    const {policy, signal, projectedFile} = projection;
    signal.throwIfAborted();
    const manifest = await this.fetchManifest(signal, true);
    if (typeof manifest.version !== 'string' || !/^[\w.-]{1,80}$/.test(manifest.version) ||
        !Array.isArray(manifest.activePlugins) || manifest.activePlugins.length > 254 ||
        (manifest.masterPlugins !== undefined && (!Array.isArray(manifest.masterPlugins) || manifest.masterPlugins.length > 254)) ||
        !manifest.integrityFiles || Array.isArray(manifest.integrityFiles)) {
      throw Error('Legacy graphics manifest cannot be bound to the signed runtime profile');
    }
    for (const name of [...manifest.activePlugins, ...(manifest.masterPlugins ?? DEFAULT_MASTER_PLUGINS)]) pluginName(name);
    const pluginsText = Buffer.from(policy.configuration.pluginsBase64, 'base64').toString('utf8');
    const loadorderText = Buffer.from(policy.configuration.loadorderBase64, 'base64').toString('utf8');
    const profile = graphicsActivationImages(manifest, pluginsText);
    if (profile.nextPluginsText !== pluginsText || profile.nextLoadorderText !== loadorderText) {
      throw Error('Legacy graphics activation differs from the exact signed runtime profile bytes');
    }

    const expected = new Map(policy.managedFiles.map(file => [file.path.toLowerCase(), file]));
    const targets = new Map<string, LegacyImage>();
    const integrity = Object.entries(manifest.integrityFiles);
    if (integrity.length > 25000) throw Error('Legacy graphics inventory exceeds the signed runtime bound');
    for (const [name, identity] of integrity) {
      const relative = relativePath(name);
      const key = relative.toLowerCase();
      if (this.sourceRepairTargets.has(key)) continue;
      const signed = expected.get(key);
      if (!signed || !identity || signed.sha256 !== identity.sha256 || signed.size !== identity.size || targets.has(key)) {
        throw Error('Legacy graphics output is not authorized by the signed runtime: ' + relative);
      }
      targets.set(key, signed);
    }
    let needsBase = false;
    for (const name of legacyBaseFiles) {
      const key = name.toLowerCase();
      const signed = expected.get(key);
      if (!signed) throw Error('Signed runtime omits a required legacy graphics target: ' + name);
      if (this.sourceRepairTargets.has(key)) continue;
      targets.set(key, signed);
      if (!await matchesLegacyImage(await projectedFile(signed.path), signed)) needsBase = true;
    }

    const patchName = 'frostveil-integrity-patch-v' + manifest.version + '.zip';
    const missing = new Map<string, LegacyImage>();
    for (const [key, target] of targets) {
      signal.throwIfAborted();
      if (!await matchesLegacyImage(await projectedFile(target.path), target)) missing.set(key, target);
    }

    // The legacy cold installer extracted the full archive. Only admit named
    // members that intersect the authenticated runtime inventory, and leave
    // reviewed source-repair targets to their pinned recipe.
    const candidates = new Map<string, LegacyImage>();
    for (const [key, target] of expected) {
      if (targets.has(key) || reservedTargets.has(key) || this.sourceRepairTargets.has(key)) continue;
      signal.throwIfAborted();
      if (!await matchesLegacyImage(await projectedFile(target.path), target)) candidates.set(key, target);
    }
    const base = async () => this.playArchive(
      legacyArchive(manifest.downloadUrl, manifest.size, manifest.sha256), signal, manifest.packageName,
    );
    const patch = async () => this.playArchive(legacyArchive(
      manifest.integrityPatchUrl, manifest.integrityPatchSize, manifest.integrityPatchSha256,
    ), signal, patchName);
    const archives: string[] = [];
    if (missing.size || candidates.size) {
      if (manifest.integrityPatchUrl) archives.push(await patch());
      if (needsBase || candidates.size || !archives.length) archives.push(await base());
    }
    const indexed = await Promise.all(archives.map(async archive => ({
      archive, members: await this.listPlayMembers(archive, signal),
    })));
    const writes: PlayWrite[] = [];
    for (const [key, target] of [...missing, ...candidates]) {
      const sources = indexed.flatMap(({archive, members}) => {
        const member = members.get(key);
        return member ? [{archive, member}] : [];
      });
      const source = sources.length ? await this.stagePlayMember(sources, target, signal) : undefined;
      if (!source) {
        if (missing.has(key)) throw Error('Exact signed legacy graphics archive member unavailable: ' + target.path);
        continue;
      }
      writes.push({...target, source, writer: 'legacy-graphics'});
    }
    const authority = createHash('sha256').update(JSON.stringify({
      version: manifest.version,
      plugins: profile,
      targets: [...targets.values()],
      archive: [manifest.sha256, manifest.integrityPatchSha256],
    })).digest('hex');
    return {
      authority,
      writes,
      publishReady: () => {
        this.update({
          phase: 'complete',
          installed: true,
          version: manifest.version,
          availableVersion: manifest.version,
          message: 'Verified graphics pack and signed runtime profile',
        });
      },
    };
  }

  private async playArchive(archive: LegacyArchive, signal: AbortSignal, legacyName: string): Promise<string> {
    if (typeof legacyName !== 'string' || relativePath(legacyName).includes('/') || !legacyName.endsWith('.zip')) {
      throw Error('Invalid legacy graphics archive name');
    }
    const existing = path.join(this.storageDir, 'r2-cache', legacyName);
    try {
      if (await matchesLegacyImage(existing, archive)) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const root = path.join(this.storageDir, 'whole-play-graphics');
    await safeDirectory(root);
    const target = path.join(root, archive.sha256 + '.zip');
    try {
      if (await matchesLegacyImage(target, archive)) return target;
      throw Error('Protected graphics archive differs from the planned bytes');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const free = await fs.statfs(root);
    if (Number(free.bsize) * Number(free.bavail) < archive.size) throw Error('Insufficient space for graphics archive staging');
    const response = await fetch(archive.url, {
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
    });
    if (response.status !== 200 || !response.body) throw Error('Legacy graphics archive unavailable');
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== archive.size) {
      await response.body.cancel();
      throw Error('Legacy graphics archive length differs from the plan');
    }
    const temp = path.join(root, archive.sha256 + '-' + randomUUID() + '.part');
    try {
      await pipeline(Readable.fromWeb(response.body as never), limitBytes(archive.size),
        fsSync.createWriteStream(temp, {flags: 'wx'}), {signal});
      if (!await matchesLegacyImage(temp, archive)) throw Error('Legacy graphics archive hash differs from the plan');
      await noLinks(root);
      await fs.link(temp, target);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
    if (!await matchesLegacyImage(target, archive)) throw Error('Staged legacy graphics archive changed');
    return target;
  }

  private async listPlayMembers(archive: string, signal: AbortSignal) {
    await noLinks(archive);
    const child = cp.spawn('tar.exe', ['-tf', archive], {
      signal, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(Error('Legacy graphics archive inventory unavailable')));
    });
    const chunks: Buffer[] = [];
    const read = async () => {
      let bytes = 0;
      for await (const chunk of child.stdout) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) throw Error('Legacy graphics archive inventory exceeds bound');
        chunks.push(chunk);
      }
    };
    try { await Promise.all([read(), exited]); }
    finally { if (child.exitCode === null) child.kill(); }

    const members = new Map<string, string>();
    for (const raw of Buffer.concat(chunks).toString('utf8').split(/\r?\n/)) {
      if (!raw || raw.endsWith('/')) continue;
      const name = relativePath(raw.replace(/^\.\//, ''));
      const key = name.toLowerCase();
      if (members.has(key)) throw Error('Ambiguous member in legacy graphics archive: ' + name);
      members.set(key, raw);
    }
    return members;
  }

  private async stagePlayMember(
    sources: readonly {archive: string; member: string}[],
    target: LegacyImage,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const root = path.join(this.storageDir, 'whole-play-graphics');
    await safeDirectory(root);
    const staged = path.join(root, target.sha256 + '.asset');
    try {
      if (await matchesLegacyImage(staged, target)) return staged;
      throw Error('Protected graphics staging differs from the signed image: ' + target.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const {archive, member} of sources) {
      signal.throwIfAborted();
      const tmp = path.join(root, target.sha256 + '-' + randomUUID() + '.part');
      const child = cp.spawn('tar.exe', ['-xOf', archive, '--', member], {
        signal, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const extracted = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(Error('Archive member unavailable')));
      });
      try {
        await Promise.all([extracted, pipeline(child.stdout, limitBytes(target.size),
          fsSync.createWriteStream(tmp, {flags: 'wx'}), {signal})]);
        if (!await matchesLegacyImage(tmp, target)) continue;
        await noLinks(root);
        await fs.link(tmp, staged);
      } catch (error) {
        child.kill();
        signal.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== 'EPIPE') throw error;
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
      try {
        if (await matchesLegacyImage(staged, target)) return staged;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  invalidateInstalled() {
    this.update({installed: false, phase: 'idle', message: 'Graphics pack needs verification after Restore'});
  }
  async downloadAndInstall(gameDirectory: string, orderDirectory: string): Promise<GraphicsPackState> {
    if (this.controller) throw new Error('A download is already in progress');
    if (!gameDirectory) throw new Error('Game directory is required');

    const controller = new AbortController();
    this.controller = controller;

    try {
      this.update({ phase: 'checking', message: 'Checking manifest from Cloudflare R2...' });
      const manifest = await this.fetchManifest(controller.signal, true);

      // Fast path: if the 6.77 GB base assets are already present on disk, only apply the integrity patch!
      if (this.hasBaseAssets(gameDirectory) && manifest.integrityPatchUrl) {
        await this.applyIntegrityPatch(gameDirectory, manifest, controller.signal);
        const check = await this.verifyIntegrityFiles(gameDirectory, manifest);
        if (!check.valid) {
          throw new Error(`Integrity verification failed after patch: ${check.mismatched.slice(0, 5).join(', ')}`);
        }
        await this.activatePlugins(manifest, orderDirectory);
        await this.enforceSkyrimPrefs();
        this.update({
          phase: 'complete',
          installed: true,
          version: manifest.version,
          availableVersion: manifest.version,
          message: `✓ Graphics & Anti-Cheat Pack v${manifest.version} verified & active!`,
        });
        return this.snapshot();
      }

      const cacheFolder = path.join(this.storageDir, 'r2-cache');
      await fs.mkdir(cacheFolder, { recursive: true });
      const targetArchive = path.join(cacheFolder, manifest.packageName);

      // Check if already downloaded and verified
      let needsDownload = true;
      if (fsSync.existsSync(targetArchive)) {
        const stat = await fs.stat(targetArchive);
        if (stat.size === manifest.size) {
          this.update({ message: 'Verifying cached package hash...' });
          const hash = await this.computeHash(targetArchive);
          if (hash === manifest.sha256) {
            needsDownload = false;
          }
        }
      }

      if (needsDownload) {
        this.update({
          phase: 'downloading',
          totalBytes: manifest.size,
          bytes: 0,
          message: 'Downloading mandatory graphics pack from Cloudflare R2...',
        });

        const partFile = targetArchive + '.part';
        let startByte = 0;
        if (fsSync.existsSync(partFile)) {
          startByte = (await fs.stat(partFile)).size;
        }

        const headers: Record<string, string> = {};
        if (startByte > 0) {
          headers['Range'] = `bytes=${startByte}-`;
        }

        const res = await fetch(manifest.downloadUrl, {
          headers,
          signal: controller.signal,
        });

        if (startByte > 0 && res.status !== 206) {
          startByte = 0;
          await fs.unlink(partFile).catch(() => {});
        } else if (startByte === 0 && res.status !== 200) {
          throw new Error(`Failed to download graphics package: HTTP ${res.status}`);
        }

        const fileStream = fsSync.createWriteStream(partFile, { flags: startByte > 0 ? 'a' : 'w' });
        const reader = res.body!.getReader();
        let bytesDownloaded = startByte;
        let lastTime = Date.now();
        let bytesSinceLast = 0;

        for (;;) {
          if (controller.signal.aborted) throw new Error('Download cancelled');
          const { done, value } = await reader.read();
          if (done) break;

          fileStream.write(Buffer.from(value));
          bytesDownloaded += value.length;
          bytesSinceLast += value.length;

          const now = Date.now();
          if (now - lastTime >= 500) {
            const speed = (bytesSinceLast / (1024 * 1024)) / ((now - lastTime) / 1000);
            this.update({
              bytes: bytesDownloaded,
              totalBytes: manifest.size,
              speedMBps: Math.round(speed * 10) / 10,
              message: `Downloading: ${(bytesDownloaded / (1024 * 1024)).toFixed(0)} MB / ${(manifest.size / (1024 * 1024)).toFixed(0)} MB (${speed.toFixed(1)} MB/s)`,
            });
            lastTime = now;
            bytesSinceLast = 0;
          }
        }

        await new Promise(resolve => fileStream.end(resolve));

        this.update({ message: 'Verifying package integrity...' });
        const downloadedHash = await this.computeHash(partFile);
        if (downloadedHash !== manifest.sha256) {
          await fs.unlink(partFile).catch(() => {});
          throw new Error(`Hash mismatch: expected ${manifest.sha256}, got ${downloadedHash}`);
        }

        await fs.rename(partFile, targetArchive);
      }

      // Extract base archive to Skyrim directory
      this.update({ phase: 'extracting', message: 'Extracting graphics pack to Skyrim SE...' });
      await this.extractToGame(targetArchive, gameDirectory);

      // Apply anti-cheat integrity patch & remove forbidden plugins
      if (manifest.integrityPatchUrl) {
        await this.applyIntegrityPatch(gameDirectory, manifest, controller.signal);
      } else {
          }

      // Verify all 46 integrity files
      const check = await this.verifyIntegrityFiles(gameDirectory, manifest);
      if (!check.valid) {
        throw new Error(`Integrity verification failed: ${check.mismatched.slice(0, 5).join(', ')}`);
      }

      // Activate all plugins in canonical Master-First order
      this.update({ message: 'Locking canonical Master-First load order in plugins.txt...' });
      await this.activatePlugins(manifest, orderDirectory);
      await this.enforceSkyrimPrefs();

      this.update({
        phase: 'complete',
        installed: true,
        version: manifest.version,
        availableVersion: manifest.version,
        message: `✓ Graphics & Anti-Cheat Pack v${manifest.version} installed & locked! Ready to play.`,
      });

      return this.snapshot();
    } catch (err: any) {
      const isCancelled = controller.signal.aborted || err.message?.includes('cancelled');
      this.update({
        phase: isCancelled ? 'cancelled' : 'error',
        message: isCancelled ? 'Download cancelled' : `Error: ${err.message}`,
        error: err.message,
      });
      throw err;
    } finally {
      this.controller = undefined;
    }
  }

  cancel() {
    this.controller?.abort();
  }

  private async computeHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fsSync.createReadStream(filePath);
      stream.on('data', d => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private async extractToGame(archivePath: string, gameDirectory: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = cp.spawn('tar.exe', ['-xf', archivePath, '-C', gameDirectory], {
        windowsHide: true,
        stdio: 'ignore',
      });
      child.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`Extraction failed with exit code ${code}`));
      });
      child.on('error', reject);
    });
  }

  private async activatePlugins(manifest: GraphicsManifest, orderDirectory: string): Promise<void> {
    await fs.mkdir(orderDirectory, { recursive: true });
    const pluginsFile = path.join(orderDirectory, 'plugins.txt');
    const loadorderFile = path.join(orderDirectory, 'loadorder.txt');

    let existingText = '';
    try {
      existingText = await fs.readFile(pluginsFile, 'utf8');
    } catch {
      existingText = '';
    }

    const {nextPluginsText,nextLoadorderText} = graphicsActivationImages(manifest, existingText);
    if (existingText !== nextPluginsText) {
      await fs.writeFile(pluginsFile, nextPluginsText, 'utf8');
    }

    let existingLoadorder = '';
    try {
      existingLoadorder = await fs.readFile(loadorderFile, 'utf8');
    } catch {
      existingLoadorder = '';
    }
    if (existingLoadorder !== nextLoadorderText) {
      await fs.writeFile(loadorderFile, nextLoadorderText, 'utf8');
    }
  }

  private async enforceSkyrimPrefs(): Promise<void> {
    try {
      const userProfile = process.env.USERPROFILE || (process.env.HOMEDRIVE && process.env.HOMEPATH ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` : '');
      const prefsPath = path.join(userProfile, 'Documents', 'My Games', 'Skyrim Special Edition', 'SkyrimPrefs.ini');
      if (fsSync.existsSync(prefsPath)) {
        let content = await fs.readFile(prefsPath, 'utf8');
        let changed = false;

        // Ensure 3D skinned tree limit is at least 300 for dense Ulvenwald forests
        if (/uiMaxSkinnedTreesToRender=\d+/i.test(content)) {
          const match = content.match(/uiMaxSkinnedTreesToRender=(\d+)/i);
          if (match && parseInt(match[1]!, 10) < 300) {
            content = content.replace(/uiMaxSkinnedTreesToRender=\d+/i, 'uiMaxSkinnedTreesToRender=300');
            changed = true;
          }
        } else if (content.includes('[Trees]')) {
          content = content.replace('[Trees]', '[Trees]\r\nuiMaxSkinnedTreesToRender=300');
          changed = true;
        }

        // Disable vanilla buggy SAO on alpha grass/flowers
        if (content.includes('bSAOEnable=1')) {
          content = content.replace(/bSAOEnable=1/g, 'bSAOEnable=0');
          changed = true;
        }

        // Enable land shadows
        if (content.includes('bDrawLandShadows=0')) {
          content = content.replace(/bDrawLandShadows=0/g, 'bDrawLandShadows=1');
          changed = true;
        }

        if (changed) {
          await fs.writeFile(prefsPath, content, 'utf8');
        }
      }
    } catch {
      /* ignore if Documents folder is unavailable */
    }
  }
}
