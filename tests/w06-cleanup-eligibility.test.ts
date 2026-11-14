import assert from 'node:assert/strict';
import test from 'node:test';
import {createCleanupFixture, evaluateCleanupEligibility} from './w06-cleanup-eligibility.fixture';

test('eligible cleanup requires owned bytes and a currently verified committed destination', () => {
  const fixture = createCleanupFixture();

  assert.deepEqual(evaluateCleanupEligibility(fixture), {eligible: true, reasons: []});
});

test('unknown or unverified operation ownership never qualifies', () => {
  for (const [change, reason] of [
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.operation.authenticated = false; }, 'OWNERSHIP_UNKNOWN'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.operation.status = 'failed'; }, 'OWNERSHIP_UNKNOWN'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.operation.files[0]!.beforeFileId = 'preexisting-file'; }, 'OWNERSHIP_UNKNOWN'],
  ]) {
    const fixture = createCleanupFixture();
    (change as (fixture: ReturnType<typeof createCleanupFixture>) => void)(fixture);
    assert.ok(evaluateCleanupEligibility(fixture).reasons.includes(reason as string));
  }
});

test('changed raw identity or bytes and unverified destination refuse cleanup', () => {
  const changes = [
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.currentRaw[0]!.generation = 'replaced'; }, 'RAW_IDENTITY_OR_HASH_CHANGED'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.currentRaw[0]!.sha256 = 'b'.repeat(64); }, 'RAW_IDENTITY_OR_HASH_CHANGED'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.currentDestinations[0]!.sha256 = 'b'.repeat(64); }, 'DESTINATION_NOT_CURRENTLY_VERIFIED'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.commit.state = 'pending'; }, 'DESTINATION_COMMIT_UNVERIFIED'],
  ];

  for (const [change, reason] of changes) {
    const fixture = createCleanupFixture();
    (change as (fixture: ReturnType<typeof createCleanupFixture>) => void)(fixture);
    assert.ok(evaluateCleanupEligibility(fixture).reasons.includes(reason as string));
  }
});

test('unselected roots, aliases, and redirected paths refuse cleanup', () => {
  const changes = [
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.currentRaw[0]!.rootId = 'other-root'; }, 'RAW_ROOT_OR_PATH_UNSAFE'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.currentRaw[0]!.links = 2; }, 'RAW_ROOT_OR_PATH_UNSAFE'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.currentRaw[0]!.canonical = false; }, 'RAW_ROOT_OR_PATH_UNSAFE'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.operation.files[0]!.path = '../outside/file.bin'; }, 'RAW_ROOT_OR_PATH_UNSAFE'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.selectedTargetId = 'another-target'; }, 'DESTINATION_NOT_CURRENTLY_VERIFIED'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.commit.files[0]!.destinationPath = '../outside/file.bin'; }, 'DESTINATION_NOT_CURRENTLY_VERIFIED'],
  ];

  for (const [change, reason] of changes) {
    const fixture = createCleanupFixture();
    (change as (fixture: ReturnType<typeof createCleanupFixture>) => void)(fixture);
    assert.ok(evaluateCleanupEligibility(fixture).reasons.includes(reason as string));
  }
});

test('pending reservations, writers, journals, or Restore dependencies refuse cleanup', () => {
  const changes = [
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.pendingReservations.push('operation-2'); }, 'RESERVATION_PENDING'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.activeWriters.push('writer-1'); }, 'WRITER_ACTIVE'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.pendingJournals.push('journal-1'); }, 'JOURNAL_PENDING'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.restoreDependencies.push({fileId:'raw-file-1',generation:'raw-generation-1'}); }, 'RESTORE_DEPENDENCY'],
  ];

  for (const [change, reason] of changes) {
    const fixture = createCleanupFixture();
    (change as (fixture: ReturnType<typeof createCleanupFixture>) => void)(fixture);
    assert.ok(evaluateCleanupEligibility(fixture).reasons.includes(reason as string));
  }
});

test('approved policy and independent readiness gates are required', () => {
  const changes = [
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.policy.approved = false; }, 'POLICY_NOT_APPROVED'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.gates.localReady = false; }, 'LOCAL_READY_REQUIRED'],
    [(fixture: ReturnType<typeof createCleanupFixture>) => { fixture.gates.ownerE2ePass = false; }, 'OWNER_E2E_PASS_REQUIRED'],
  ];

  for (const [change, reason] of changes) {
    const fixture = createCleanupFixture();
    (change as (fixture: ReturnType<typeof createCleanupFixture>) => void)(fixture);
    assert.ok(evaluateCleanupEligibility(fixture).reasons.includes(reason as string));
  }
});
