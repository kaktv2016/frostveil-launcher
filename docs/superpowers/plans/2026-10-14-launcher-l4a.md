# L4-A implementation plan

> Execute inline using executing-plans/TDD. The supplied detailed L4-A spec explicitly authorizes implementation, sandbox writes and local verification; no commit/push/release or extra approval handoffs.

**Goal:** A signed synthetic multi-file sandbox installer with persistent ownership, verified transaction backups, journaled per-file apply, conservative rollback and startup recovery.

**Architecture:** Reuse L3 validation/signatures/scanning/update-plan and L1 safe paths/hash/backup principles. Add installer contracts, sandbox guard, authenticated local metadata/journal/lock, streamed local fixture acquisition and transaction engine. One internally selected demonstration target; renderer supplies no root, content, key, URL or policy. Production install is unconditionally disabled.

**Spec:** User-supplied FROSTVEIL LAUNCHER L4-A.

## Constraints

- Only newly generated OS temporary sandbox grants may select targets; canonical roots pinned by filesystem identity. Reject redirected roots/parents/files and multiple hard links.
- No actual Skyrim/Steam/client/server/world/load-order changes or process control, downloads, release publication or commits.
- Signed synthetic bundle authenticates the existing L3 manifest/server. Managed actions derive from L3 file scan and planner; external/native/runtime files are verification/manual only, never automatically owned.
- Managed full-file assets are an explicitly limited sandbox subtree and nonbinary payloads. No ZIP/scripts/hooks/download URLs. Static synthetic signing fixture is visibly test-only, scoped to internal demonstration grants, never remote trust config.
- Metadata uses per-sandbox private HMAC key and bounded validated JSON to detect tampering; it is not protection from an adversary controlling the same Windows account. Persist writes with exclusive temp + sync + same-dir rename. Flush parent-directory durability on Windows is not claimed.
- Single-writer lease persists process identity and random token. Normal concurrent writers rejected. Dead-process recovery acquires a fresh lease; no forced game/launcher process termination.
- Journal records pending intent before rename and actual observations after it. Backups and ownership snapshots retained; reverse only when actual identity/hash matches original or this transaction's applied version. External changes require manual recovery, never overwrite them.
- All filesystem operations revalidate roots and targets immediately before mutation; Node path-based Windows APIs cannot promise immunity to every hostile race/power-loss. Record this limit.
- Installed L3 profile provisioning was previously pending MSIX recovery; do not convert that into a claimed user acceptance absent evidence.

## Review focus

1. Receipt/journal tampering, forged paths, unowned/externally modified targets.
2. Crash between journal, rename, ownership and commit; recovery must inspect bytes rather than guess.
3. Root substitution/reparse/hardlink and file-identity substitution just before apply.
4. Two writers, dead-process locks, rollback interrupted and repeated recovery.
5. Cancellation, backup/disk/locked-file/posthash failure; no further writes after first apply failure.

## Tasks

- [x] Contracts/guard/metadata: opaque internally generated sandbox grant, pinned roots, scoped targets, original observations, HMAC receipts/journals and exclusive lease. Tests first for bad paths/hardlink/root replacement/metadata forgery.
- [x] Plan/stage/backup/apply: L3 signature + scanner/planner integration, bounded local acquisition/progress/cancellation/retry, verified original backups, durable intent, target-filesystem exclusive replacement + rename + installed hash. Real-file tests for new/replacement/multi-file and fault paths.
- [x] Rollback/recovery: inspect incomplete journals; restore/remove only proven unchanged transaction versions, restore receipt, retain evidence/manual conflicts, repeated recovery/rollback. Terminated-child tests at persisted checkpoints as well as deterministic faults.
- [x] Main/preload/UI/demo: original inert fixture generation, trusted internal target only, no-argument demo/cancel/status operations, transaction/progress/backup/rollback details in existing Updates panel. No real-install button.
- [x] Verify: full typecheck/tests, standalone sandbox smoke, source and packaged UI smoke, NSIS0.1.3 + package privacy, actual baseline read-only and protected before/after check, independent review, concise L4A_REPORT. No L4-B.

## Final ledger

170/170 tests, typecheck and sandbox/source/packaged smoke passed. Windows NSIS0.1.3 generated, unsigned, private evidence excluded. Exact inode values use BigInt; receipts update restored inode identity while retaining ownership/version provenance. Review faults were reproduced and fixed; pointer recovery metadata precedes publication; temporary root is validated before creation. Original baseline24/24 and53 protected paths unchanged. No actual game/server operations, commits/pushes/releases/L4-B. Directory/power-loss durability, hostile race immunity, same-user HMAC secrecy and production distribution remain explicitly limited.
