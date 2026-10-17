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
  activePlugins: string[];
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

export class GraphicsPackService {
  private state: GraphicsPackState = {
    phase: 'idle',
    installed: false,
    message: 'Graphics Pack ready to download from Cloudflare R2.',
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

  async fetchManifest(signal?: AbortSignal): Promise<GraphicsManifest> {
    if (this.manifestCache) return this.manifestCache;
    const res = await fetch(R2_MANIFEST_URL, { signal: signal ?? AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Could not fetch graphics manifest: ${res.statusText}`);
    this.manifestCache = (await res.json()) as GraphicsManifest;
    return this.manifestCache;
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
        // Verify key files exist
        const hasD3D = fsSync.existsSync(path.join(gameDirectory, 'd3dx9_42.dll'));
        const hasLux = fsSync.existsSync(path.join(gameDirectory, 'Data', 'Lux.esp'));
        const hasBlended = fsSync.existsSync(path.join(gameDirectory, 'Data', 'BlendedRoads.esp'));
        if (hasD3D && hasLux && hasBlended) {
          installed = true;
        }
      }
    } catch {
      installed = false;
    }

    try {
      const manifest = await this.fetchManifest();
      this.update({
        installed,
        version,
        availableVersion: manifest.version,
        totalBytes: manifest.size,
        message: installed
          ? `Graphics Overhaul v${version} installed & verified`
          : `Graphics Overhaul v${manifest.version} available (6.77 GB)`,
      });
    } catch {
      this.update({
        installed,
        version,
        message: installed ? `Graphics Overhaul installed` : `Ready to check Cloudflare R2`,
      });
    }

    return this.snapshot();
  }

  async downloadAndInstall(gameDirectory: string, orderDirectory: string): Promise<GraphicsPackState> {
    if (this.controller) throw new Error('A download is already in progress');
    if (!gameDirectory) throw new Error('Game directory is required');

    const controller = new AbortController();
    this.controller = controller;

    try {
      this.update({ phase: 'checking', message: 'Checking manifest from Cloudflare R2...' });
      const manifest = await this.fetchManifest(controller.signal);

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
          message: 'Downloading graphics pack from Cloudflare R2...',
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
          // Range not supported or expired, restart from 0
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

        // Verify SHA256
        this.update({ message: 'Verifying package integrity...' });
        const downloadedHash = await this.computeHash(partFile);
        if (downloadedHash !== manifest.sha256) {
          await fs.unlink(partFile).catch(() => {});
          throw new Error(`Hash mismatch: expected ${manifest.sha256}, got ${downloadedHash}`);
        }

        await fs.rename(partFile, targetArchive);
      }

      // Extract to Skyrim directory
      this.update({ phase: 'extracting', message: 'Extracting graphics pack to Skyrim SE...' });
      await this.extractToGame(targetArchive, gameDirectory);

      // Activate all plugins in plugins.txt
      this.update({ message: 'Configuring load order in plugins.txt...' });
      await this.activatePlugins(manifest.activePlugins, orderDirectory);

      this.update({
        phase: 'complete',
        installed: true,
        version: manifest.version,
        message: '✓ Graphics pack installed & activated! Ready to play.',
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
      // Use native Windows tar.exe to extract the zip directly into the game directory
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

  private async activatePlugins(pluginsToActivate: string[], orderDirectory: string): Promise<void> {
    const pluginsFile = path.join(orderDirectory, 'plugins.txt');
    let existingText = '';
    try {
      existingText = await fs.readFile(pluginsFile, 'utf8');
    } catch {
      existingText = '';
    }

    const bom = existingText.startsWith('\uFEFF') ? '\uFEFF' : '';
    const lines = existingText.slice(bom.length).split(/\r?\n/);
    const existingActive = new Set(
      lines
        .map(l => l.trim())
        .filter(l => l.startsWith('*'))
        .map(l => l.slice(1).toLowerCase())
    );

    // Filter which plugins need to be added
    const toAdd = pluginsToActivate.filter(p => !existingActive.has(p.toLowerCase()));

    if (toAdd.length === 0) return;

    // Insert new plugins before any user plugins or server plugins like FrostveilCourierNavigation
    const updatedLines: string[] = [];
    const serverMods = ['frostveilcouriernavigation.esp'];

    // Collect existing non-server lines
    for (const line of lines) {
      const trimmed = line.trim();
      const pureName = trimmed.replace(/^\*/, '').toLowerCase();
      if (!serverMods.includes(pureName)) {
        updatedLines.push(line);
      }
    }

    // Append our active plugins
    for (const plugin of toAdd) {
      updatedLines.push(`*${plugin}`);
    }

    // Append server mods back at the end
    for (const line of lines) {
      const trimmed = line.trim();
      const pureName = trimmed.replace(/^\*/, '').toLowerCase();
      if (serverMods.includes(pureName)) {
        updatedLines.push(line);
      }
    }

    const outputText = bom + updatedLines.filter(Boolean).join('\r\n') + '\r\n';
    await fs.writeFile(pluginsFile, outputText, 'utf8');
  }
}
