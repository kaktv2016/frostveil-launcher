export interface CleanupFixture {
  selectedRoots: Array<{rootId: string; volumeId: string}>;
  selectedTargetId: string;
  operation: {
    authenticated: boolean;
    status: 'verified' | 'failed' | 'reconciled';
    operationId: string;
    rootId: string;
    volumeId: string;
    files: Array<{
      path: string;
      fileId: string;
      generation: string;
      size: number;
      sha256: string;
      beforeFileId: string | null;
    }>;
  };
  currentRaw: Array<{
    path: string;
    rootId: string;
    volumeId: string;
    fileId: string;
    generation: string;
    size: number;
    sha256: string;
    links: number;
    canonical: boolean;
  }>;
  commit: {
    authenticated: boolean;
    state: 'committed' | 'pending' | 'rolled-back';
    operationId: string;
    files: Array<{
      sourcePath: string;
      destinationPath: string;
      targetId: string;
      fileId: string;
      generation: string;
      size: number;
      sha256: string;
    }>;
  };
  currentDestinations: Array<{
    path: string;
    targetId: string;
    fileId: string;
    generation: string;
    size: number;
    sha256: string;
  }>;
  pendingReservations: string[];
  activeWriters: string[];
  pendingJournals: string[];
  restoreDependencies: Array<{fileId: string; generation: string}>;
  policy: {approved: boolean};
  gates: {localReady: boolean; ownerE2ePass: boolean};
}

export function createCleanupFixture(): CleanupFixture {
  const file = {
    path: '489831/Data/Skyrim.esm',
    fileId: 'raw-file-1',
    generation: 'raw-generation-1',
    size: 128,
    sha256: 'a'.repeat(64),
  };
  const destination = {
    path: 'Data/Skyrim.esm',
    targetId: 'selected-target',
    fileId: 'target-file-1',
    generation: 'target-generation-1',
    size: file.size,
    sha256: file.sha256,
  };

  return {
    selectedRoots: [{rootId: 'raw-root-1', volumeId: 'volume-1'}],
    selectedTargetId: 'selected-target',
    operation: {
      authenticated: true,
      status: 'verified',
      operationId: 'operation-1',
      rootId: 'raw-root-1',
      volumeId: 'volume-1',
      files: [{...file, beforeFileId: null}],
    },
    currentRaw: [{...file, rootId: 'raw-root-1', volumeId: 'volume-1', links: 1, canonical: true}],
    commit: {
      authenticated: true,
      state: 'committed',
      operationId: 'operation-1',
      files: [{sourcePath: file.path, destinationPath: destination.path, ...destination}],
    },
    currentDestinations: [{...destination}],
    pendingReservations: [],
    activeWriters: [],
    pendingJournals: [],
    restoreDependencies: [],
    policy: {approved: true},
    gates: {localReady: true, ownerE2ePass: true},
  };
}

export function evaluateCleanupEligibility(fixture: CleanupFixture) {
  const reasons = new Set<string>();
  const {operation, commit} = fixture;

  if (!fixture.policy.approved) reasons.add('POLICY_NOT_APPROVED');
  if (!fixture.gates.localReady) reasons.add('LOCAL_READY_REQUIRED');
  if (!fixture.gates.ownerE2ePass) reasons.add('OWNER_E2E_PASS_REQUIRED');
  if (!operation.authenticated || operation.status !== 'verified' || !operation.files.length ||
      operation.files.some(file => file.beforeFileId !== null)) reasons.add('OWNERSHIP_UNKNOWN');
  if (!commit.authenticated || commit.state !== 'committed' || commit.operationId !== operation.operationId) {
    reasons.add('DESTINATION_COMMIT_UNVERIFIED');
  }
  if (fixture.pendingReservations.length) reasons.add('RESERVATION_PENDING');
  if (fixture.activeWriters.length) reasons.add('WRITER_ACTIVE');
  if (fixture.pendingJournals.length) reasons.add('JOURNAL_PENDING');

  const safeRelativePath = (value: string) => value.length > 0 && !value.includes('\\') && !value.includes(':') &&
    !value.startsWith('/') && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');

  for (const file of operation.files) {
    const rootSelected = fixture.selectedRoots.some(root =>
      root.rootId === operation.rootId && root.volumeId === operation.volumeId);
    const raw = fixture.currentRaw.find(observed => observed.path === file.path);
    if (!rootSelected || !safeRelativePath(file.path) || !raw || raw.rootId !== operation.rootId ||
        raw.volumeId !== operation.volumeId || !raw.canonical || raw.links !== 1) reasons.add('RAW_ROOT_OR_PATH_UNSAFE');
    if (!raw || raw.fileId !== file.fileId || raw.generation !== file.generation ||
        raw.size !== file.size || raw.sha256 !== file.sha256) reasons.add('RAW_IDENTITY_OR_HASH_CHANGED');

    const committed = commit.files.find(item => item.sourcePath === file.path);
    const destination = committed && fixture.currentDestinations.find(item =>
      item.path === committed.destinationPath && item.targetId === committed.targetId);
    if (!committed || !destination || committed.size !== file.size || committed.sha256 !== file.sha256 ||
        committed.targetId !== fixture.selectedTargetId || !safeRelativePath(committed.destinationPath) ||
        destination.fileId !== committed.fileId || destination.generation !== committed.generation ||
        destination.size !== committed.size || destination.sha256 !== committed.sha256) {
      reasons.add('DESTINATION_NOT_CURRENTLY_VERIFIED');
    }
    if (fixture.restoreDependencies.some(reference =>
      reference.fileId === file.fileId && reference.generation === file.generation)) {
      reasons.add('RESTORE_DEPENDENCY');
    }
  }

  return {eligible: reasons.size === 0, reasons: [...reasons].sort()};
}
