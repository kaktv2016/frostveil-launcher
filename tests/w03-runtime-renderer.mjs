import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';

const executablePath = fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url));
await fs.access(executablePath); // Fail closed when pinned Electron has not been provisioned offline.
const scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'fv-w03-ui-'));
const adapter = fileURLToPath(new URL('./w03-runtime-renderer-adapter.cjs', import.meta.url));
const env = {
  ...process.env,
  APPDATA: scratch,
  LOCALAPPDATA: scratch,
  FROSTVEIL_W03_UI_SCRATCH: scratch,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

let app;
try {
  app = await electron.launch({ executablePath, args: [adapter], env, timeout: 30000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = page.getByTestId('runtime-preparation');
  const status = panel.getByRole('status');
  const inspect = panel.getByRole('button', { name: 'ตรวจและดูพื้นที่', exact: true });
  const prepare = panel.getByRole('button', { name: 'เตรียมเกม', exact: true });
  const cancel = panel.getByRole('button', { name: 'ยกเลิกการเตรียมเกม', exact: true });
  const restore = panel.getByRole('button', { name: 'คืนชุดก่อนติดตั้ง Frostveil', exact: true });
  const qr = panel.getByRole('img', { name: 'Steam Guard login QR' });
  await expect(status).toHaveText('W03 fixture idle');
  await expect(restore).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.ipcRenderer]), ['undefined', 'undefined']);
  await page.evaluate(() => {
    window.fixtureEvents = [];
    window.stopFixtureObserver = window.launcher.onRuntimePreparation(state => {
      window.fixtureEvents.push({ phase: state.phase, hasQr: Boolean(state.authQr) });
    });
  });

  await inspect.click();
  await expect(status).toHaveText('W03 fixture inspected');
  await expect(panel.getByText(/3 ไฟล์/)).toBeVisible();
  await prepare.click();
  await expect(status).toHaveText('W03 fixture waiting for cancel');
  await expect(qr).toBeVisible();
  await expect(prepare).toBeDisabled();
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(status).toHaveText('W03 fixture cancelled');
  await expect(qr).toHaveCount(0);
  await expect(cancel).toHaveCount(0);
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect(status).toHaveText('W03 fixture ready');
  await expect(restore).toBeEnabled();
  const events = await page.evaluate(() => {
    window.stopFixtureObserver();
    return window.fixtureEvents;
  });
  assert.deepEqual(events, [
    { phase: 'checking', hasQr: false },
    { phase: 'authentication', hasQr: true },
    { phase: 'cancelled', hasQr: false },
    { phase: 'ready', hasQr: false },
  ]);
  const security = await app.evaluate(({ BrowserWindow }) => {
    const { contextIsolation, nodeIntegration, sandbox, webSecurity } =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { contextIsolation, nodeIntegration, sandbox, webSecurity };
  });
  assert.deepEqual(security, { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', boundary: 'production renderer and preload with test-only main IPC adapter', events, security }));
} finally {
  if (app) await app.close();
  // Only the directory created by this invocation, below the resolved temp root.
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}
