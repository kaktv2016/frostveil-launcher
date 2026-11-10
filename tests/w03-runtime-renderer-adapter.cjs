const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

const scratch = process.env.FROSTVEIL_W03_UI_SCRATCH;
assert.ok(scratch && /^fv-w03-ui-[\w-]+$/.test(path.basename(scratch)));
assert.equal(scratch, fs.realpathSync(scratch));
assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir()));

const dist = path.resolve(__dirname, '../dist');
const renderer = path.join(dist, 'renderer');
app.setPath('userData', scratch);
app.setPath('sessionData', scratch);
protocol.registerSchemesAsPrivileged([
  { scheme: 'w03-fixture', privileges: { standard: true, secure: true } },
]);

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: 'w03-fixture-memory',
      preload: path.join(dist, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const session = window.webContents.session;
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
    done({ cancel: !details.url.startsWith('w03-fixture://launcher/') });
  });
  session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  session.protocol.handle('w03-fixture', async request => {
    const url = new URL(request.url);
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const type = mime[path.extname(relative)];
    if (url.host !== 'launcher' || !type || !/^(?:index\.html|assets\/[\w.-]+\.(?:js|css))$/.test(relative)) {
      return new Response(null, { status: 404 });
    }
    const file = path.join(renderer, relative);
    if (fs.realpathSync(file) !== file) return new Response(null, { status: 403 });
    return new Response(await fs.promises.readFile(file), {
      headers: {
        'Content-Type': type,
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
      },
    });
  });

  const initial = {
    targetRuntime: '1.6.1170.0', changedFiles: 0, downloadBytes: 0,
    backupBytes: 0, stagingBytes: 0, canRestore: false,
  };
  const state = {
    version: 'fixture', settings: { channel: 'stable' }, events: [],
    runtimePreparation: { ...initial, phase: 'idle', message: 'W03 fixture idle' },
  };
  let finishPrepare;
  let prepareCount = 0;
  const publish = (phase, message, details) => {
    state.runtimePreparation = { ...initial, phase, message, ...details };
    window.webContents.send('launcher:runtime-preparation-state', state.runtimePreparation);
  };
  const handle = (name, operation = () => {}) => ipcMain.handle('launcher:' + name, async (event, arg) => {
    assert.equal(event.sender, window.webContents);
    assert.equal(event.senderFrame, window.webContents.mainFrame);
    assert.equal(event.senderFrame.url, 'w03-fixture://launcher/');
    assert.equal(arg, undefined);
    await operation();
    return structuredClone(state);
  });
  handle('scan');
  handle('status');
  handle('inspect-runtime', () => publish('checking', 'W03 fixture inspected', { changedFiles: 3 }));
  handle('prepare-runtime', async () => {
    assert.equal(finishPrepare, undefined);
    prepareCount += 1;
    if (prepareCount === 1) {
      publish('authentication', 'W03 fixture waiting for cancel', { authQr: '█▀\n▄█' });
      await new Promise(resolve => { finishPrepare = resolve; });
      finishPrepare = undefined;
    } else {
      assert.equal(prepareCount, 2);
      publish('ready', 'W03 fixture ready', { canRestore: true });
    }
  });
  handle('cancel-runtime', () => {
    assert.equal(typeof finishPrepare, 'function');
    publish('cancelled', 'W03 fixture cancelled');
    finishPrepare();
  });
  await window.loadURL('w03-fixture://launcher/');
}

run().catch(error => { console.error(error); app.exit(1); });
