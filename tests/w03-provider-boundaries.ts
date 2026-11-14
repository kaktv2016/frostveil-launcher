import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {contained, noLinks} from '../src/main/files';
export {acquireDepots} from '../src/main/runtime/depot';

// Only the W03 test bundle substitutes these ephemeral keys at the policy
// import. Verification still runs the production-shaped policy rules.
export const fixtureKeys = generateKeyPairSync('ed25519');
export const productionSource = {keys: {w03: {
  publicKey: fixtureKeys.publicKey.export({type: 'spki', format: 'pem'}).toString(),
  environment: 'production' as const,
  revoked: false
}}};

export class InertHelper extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private closed = false;

  finish(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code);
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.finish(null));
  }
}

interface Boundary {
  root: string;
  steamRoot: string;
  game: string;
  helper: string;
  storage: string;
  version: (file: string) => Promise<string>;
  invoke: (child: InertHelper, args: string[], cwd: string) => Promise<void>;
  faults: unknown[];
}

let current: Boundary | undefined;
export function bindFixture(boundary: Boundary) {
  assert.equal(current, undefined);
  for (const p of [boundary.steamRoot, boundary.game, boundary.helper, boundary.storage]) {
    assert.ok(p !== boundary.root && contained(boundary.root, p));
  }
  current = boundary;
  return () => { current = undefined; };
}

function fixture() {
  assert.ok(current, 'W03 fixtures require a bound disposable root');
  return current;
}

export async function steamRoots() { return [fixture().steamRoot]; }
export async function gameRunning() { fixture(); return false; }

export async function fileVersion(file: string) {
  const boundary = fixture();
  assert.ok(file===path.join(boundary.game,'SkyrimSE.exe')||
    (contained(boundary.storage,file)&&path.basename(path.dirname(file))==='runtime-staging'&&/^[a-f0-9]{64}$/.test(path.basename(file))));
  await noLinks(file);
  return boundary.version(file);
}

export async function ensureDepotHelper(storage: string) {
  const boundary = fixture();
  assert.equal(storage, boundary.storage);
  assert.equal(await fs.realpath(boundary.helper), boundary.helper);
  await noLinks(boundary.helper);
  return boundary.helper;
}

export function execFile() { throw Error('W03 may not execute a real helper'); }

export function spawn(helper: string, args: string[], options: {cwd: string; shell: boolean}) {
  const boundary = fixture();
  assert.equal(helper, boundary.helper);
  assert.equal(options.shell, false);
  assert.ok(options.cwd !== boundary.storage && contained(boundary.storage, options.cwd));
  const child = new InertHelper();
  queueMicrotask(() => {
    void boundary.invoke(child, args, options.cwd).catch(error => {
      boundary.faults.push(error);
      child.finish(1);
    });
  });
  return child;
}
