import {createHash} from 'node:crypto';
import {relativePath} from '../files';
import type {Profile} from '../../shared/contracts';
import type {RuntimeCohort} from './policy';
import type {SandboxGrant} from '../installer/sandbox';
import type {RuntimePreparation} from './service';

export interface PlayProjection {
  policy: Readonly<RuntimeCohort>;
  signal: AbortSignal;
  projectedFile(relative: string): Promise<string | null>;
  isRuntimeRemoval?(relative: string): boolean;
}

export interface PlayWrite {
  path: string;
  source: string;
  sha256: string;
  size: number;
  writer?: string;
  sourceGrant?: SandboxGrant;
}

export interface PlayWriter {
  writes: readonly PlayWrite[];
  authority?: string;
  revalidate?(): Promise<void>;
  verifyInstalled?(): Promise<void>;
  publishReady?(): void;
}

export interface PlayPack extends PlayWriter {
  cohortId: string;
  baseline: Profile;
}

export interface PlayAdapters<T> {
  legacyGraphics(projection: PlayProjection): Promise<PlayWriter>;
  sourceGraphics(projection: PlayProjection): Promise<PlayWriter>;
  client(projection: PlayProjection): Promise<PlayWriter>;
  pack(projection: PlayProjection): Promise<PlayPack>;
  scan(baseline: Profile): Promise<T>;
}

export async function preparePlay<T>(
  runtime: Pick<RuntimePreparation, 'prepareWholePlay'>,
  game: string,
  config: string,
  adapters: PlayAdapters<T>,
): Promise<T> {
  let result: {scan: T; publishReady: () => void} | undefined;
  await runtime.prepareWholePlay(game, config, async projection => {
    const writes = new Map<string, PlayWrite>();
    const projected: PlayProjection = {
      policy: projection.policy,
      signal: projection.signal,
      isRuntimeRemoval: projection.isRuntimeRemoval,
      projectedFile: relative => {
        const planned = writes.get(relative.toLowerCase());
        return planned ? Promise.resolve(planned.source) : projection.projectedFile(relative);
      },
    };
    const stages: PlayWriter[] = [];
    function add(stage: PlayWriter) {
      projection.signal.throwIfAborted();
      for (const write of stage.writes) {
        const name = relativePath(write.path);
        const key = name.toLowerCase();
        const existing = writes.get(key);
        if (existing && (existing.size !== write.size || existing.sha256 !== write.sha256)) {
          throw Error('Play writers disagree on final file bytes: ' + name);
        }
        if (!existing) writes.set(key, write);
      }
      stages.push(stage);
    }
    add(await adapters.legacyGraphics(projected));
    add(await adapters.sourceGraphics(projected));
    add(await adapters.client(projected));
    const pack = await adapters.pack(projected);
    add(pack);
    return {
      cohortId: createHash('sha256').update(JSON.stringify([pack.cohortId, ...stages.map(stage => stage.authority ?? null)])).digest('hex'),
      writes: [...writes.values()],
      revalidate: async () => {
        for (const stage of stages) {
          projection.signal.throwIfAborted();
          await stage.revalidate?.();
        }
      },
      verifyInstalled: async () => {
        for (const stage of stages) {
          projection.signal.throwIfAborted();
          await stage.verifyInstalled?.();
        }
        result = {
          scan: await adapters.scan(pack.baseline),
          publishReady: () => { for (const stage of stages) stage.publishReady?.(); },
        };
      },
    };
  });
  if (!result) throw Error('Play completed without a verified installation scan');
  result.publishReady();
  return result.scan;
}

export async function restorePlay<T>(
  runtime: Pick<RuntimePreparation, 'restore'>,
  game: string,
  config: string,
  refreshLocal: () => Promise<T>,
): Promise<T> {
  await runtime.restore(game, config);
  return refreshLocal();
}
