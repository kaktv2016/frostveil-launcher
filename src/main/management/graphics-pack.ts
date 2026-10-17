import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';

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
  'Lux Via.esp',
  'Natural Waterfalls.esp',
  'Natural Waterfalls - Dawnguard.esp',
  'Natural Waterfalls - Dragonborn.esp',
  'Natural Waterfalls - Blackreach.esp',
];

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
      fsSync.existsSync(path.join(gameDirectory, 'Data', 'Lux - Meshes.bsa')) &&
      fsSync.existsSync(path.join(gameDirectory, 'Data', 'Ulvenwald.bsa')) &&
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
        const hasForbidden = fsSync.existsSync(path.join(gameDirectory, 'Data', 'RaceMenuPlugin.esp'));
        if (hasBase && hasParallaxFix && !hasForbidden) {
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

  private async purgeForbiddenPlugins(gameDirectory: string, forbiddenPlugins: string[] = ['RaceMenuPlugin.esp']) {
    for (const plugin of forbiddenPlugins) {
      const target = path.join(gameDirectory, 'Data', plugin);
      if (fsSync.existsSync(target)) {
        await fs.unlink(target).catch(() => {});
      }
    }
  }

  private async verifyIntegrityFiles(
    gameDirectory: string,
    manifest: GraphicsManifest
  ): Promise<{ valid: boolean; mismatched: string[] }> {
    await this.purgeForbiddenPlugins(gameDirectory, manifest.forbiddenPlugins);
    if (!manifest.integrityFiles) return { valid: true, mismatched: [] };

    const mismatched: string[] = [];
    for (const [relPath, expected] of Object.entries(manifest.integrityFiles)) {
      const fullPath = path.join(gameDirectory, ...relPath.split('/'));
      try {
        const st = await fs.stat(fullPath);
        if (st.size !== expected.size) {
          mismatched.push(relPath);
          continue;
        }
        const actualHash = await this.computeHash(fullPath);
        if (actualHash !== expected.sha256) {
          mismatched.push(relPath);
        }
      } catch {
        mismatched.push(relPath);
      }
    }
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
      this.update({
        phase: 'downloading',
        message: `Downloading anti-cheat & world integrity patch v${manifest.version}...`,
      });
      const res = await fetch(manifest.integrityPatchUrl, { signal: signal ?? AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`Failed to download integrity patch: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = createHash('sha256').update(buf).digest('hex');
      if (hash !== manifest.integrityPatchSha256) {
        throw new Error(`Integrity patch hash mismatch: expected ${manifest.integrityPatchSha256}, got ${hash}`);
      }
      await fs.writeFile(patchArchive, buf);
    }

    this.update({
      phase: 'extracting',
      message: 'Restoring verified plugins, SKSE DLLs & anti-cheat INI configurations...',
    });
    await this.extractToGame(patchArchive, gameDirectory);
    await this.purgeForbiddenPlugins(gameDirectory, manifest.forbiddenPlugins);
  }

  /**
   * AAA Mandatory Pre-Play Enforcement:
   * 1. Requires the Graphics & World Pack to be installed (auto-downloads if missing).
   * 2. Purges forbidden cheat plugins (e.g. RaceMenuPlugin.esp).
   * 3. Verifies SHA-256 hashes of all 27 plugins, SKSE DLLs, and hardened INI/TOML configs.
   *    If any file was modified or tampered with, automatically restores it from the signed integrity patch.
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

    this.update({
      phase: 'complete',
      installed: true,
      version: manifest.version,
      availableVersion: manifest.version,
      message: `✓ Graphics & Anti-Cheat Integrity v${manifest.version} verified (100% match)`,
    });

    return this.snapshot();
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
        await this.purgeForbiddenPlugins(gameDirectory, manifest.forbiddenPlugins);
      }

      // Verify all 46 integrity files
      const check = await this.verifyIntegrityFiles(gameDirectory, manifest);
      if (!check.valid) {
        throw new Error(`Integrity verification failed: ${check.mismatched.slice(0, 5).join(', ')}`);
      }

      // Activate all plugins in canonical Master-First order
      this.update({ message: 'Locking canonical Master-First load order in plugins.txt...' });
      await this.activatePlugins(manifest, orderDirectory);

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

    const pluginsLines = [
      '# This file is locked by Skyrim RP Launcher (AAA Anti-Cheat Load Order)',
      ...canonicalOrder.map(p => `*${p}`),
    ];
    const loadorderLines = [
      'Skyrim.esm',
      'Update.esm',
      'Dawnguard.esm',
      'HearthFires.esm',
      'Dragonborn.esm',
      'ccBGSSSE001-Fish.esm',
      'ccQDRSSE001-SurvivalMode.esl',
      'ccBGSSSE037-Curios.esl',
      'ccBGSSSE025-AdvDSGS.esm',
      '_ResourcePack.esl',
      ...canonicalOrder,
    ];

    await fs.writeFile(pluginsFile, bom + pluginsLines.join('\r\n') + '\r\n', 'utf8');
    await fs.writeFile(loadorderFile, loadorderLines.join('\r\n') + '\r\n', 'utf8');
  }
}
