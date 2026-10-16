# Frostveil L4-A report — 2026-10-14 Asia/Bangkok

Local development version **0.1.3**. The installer is limited to newly generated disposable sandboxes. **REAL SKYRIM INSTALL DISABLED. PRODUCTION DISTRIBUTION BLOCKED.**

## Implemented

Authenticated L3 manifest → existing scanner/compatibility planner → local synthetic payload streaming → isolated staging/size/hash verification → ownership/conflict checks → verified transaction backup → persistent journal → prepared same-filesystem per-file rename → final hash/identity checks → ownership receipt → commit. No HTTP/ZIP/FOMOD/hooks, real mod downloads, engine changes or real game installation API.

Reuse: L3 `validateManifest`/`verifyEnvelope`, `scanPackFiles`, plugin checks, compatibility/update planner; L1 `relativePath`, containment/no-link checks, `safeDirectory`, `hashFile` and backup verification principles; existing typed IPC/preload/Updates UI, L2 updater and Windows packaging. No new dependencies or second manifest/hash/IPC framework.

Managed actions derive from authenticated allowed-distribution files and the L3 plan. Verified ownership supplies observed component version for managed upgrades; a generic hash mismatch is not silently repaired. External/native/SKSE/client files remain verification/manual-only. Synthetic baseline files contain original inert bytes inside the sandbox, never copies of game assets.

## Transaction and ownership design

- Trusted internal code creates a random OS temporary sandbox. Renderer cannot select paths, URLs, keys, content or overrides. Validate canonical temporary location before creation; deny game/Steam/server locations, paths outside the grant, root substitution, links/junctions, multi-link files and file/directory conflicts. Root and NTFS file identities use exact BigInt inode/dev values.
- Separate installation, local packages, staging, backups, journals, ownership and session metadata. Install targets are a limited synthetic Data/UI/texture subtree with passive file types. No launcher executable, native DLL, master, executable script, internal journal or trust-file installation target.
- Receipt records pack/component version, normalized path, hash/size, original transaction/timestamp and current filesystem identity. Unowned existing files, external changes, identity substitution, pack/component changes and non-monotonic upgrades are conflicts. Restored ownership retains prior version/transaction provenance but updates the identity for the newly restored inode.
- Each transaction keeps its own verified original copies and previous/new ownership snapshot. L1 baseline backups are untouched. Transaction backups, journals and partial/replacement evidence are retained; no broad cleanup or automatic backup expiry.
- Bounded local acquisition is sequential (one active stream), 64 KiB chunks, max 32 MiB/file, max 64 managed actions. Stage outside destination, with random partial names, declared/actual size caps, streamed verification, progress and cancellation. A failed acquisition can be retried as a fresh transaction after recovery; no public source or arbitrary redirect support.
- Metadata uses a per-sandbox random HMAC key, bounded validated JSON, exclusive temporary writes, file sync and same-directory rename. Writer lease uses exclusive creation, PID liveness and token/identity-checked release; write/sync failure closes the handle and removes only the proven just-created lease.
- Journal states record per-file intent before rename and actual observations afterward. Replacement temp is on the destination filesystem; recheck roots, ownership, prepared payload and file identity immediately before apply. Multi-file installation is **not one atomic filesystem transaction**.
- Rollback restores verified backups/removes new transaction files only when current identity/hash evidence proves ownership. Random exclusive restore temps never delete unknown collisions. Restoration intent is durable before rename, permitting recovery after that rename. Revalidate already-restored files; external changes stay intact and require manual recovery. Older commits cannot overwrite newer receipts.
- Startup inspects a bounded internally recorded sandbox pointer, validates authenticated sandbox identity, acquires a recovery lease and reconciles incomplete journals. Pending/manual recovery blocks another transaction on that root. Recovery/repeated rollback is idempotent in the demonstrated cases.

## Verification results

| Status | Evidence |
|---|---|
| AUTOMATED TEST PASSED | **170/170**, 0 failed/skipped: 105 L1-L3 regressions plus 65 L4-A cases. Signed valid/invalid/tampered/schema/identity/policy/collision packages, ownership/hash conflicts, malicious paths, hardlink/junction/root/temp substitution, backup/resource/read/write failures, concurrency, cancellation, receipt/journal forgery, payload/target substitution and post-verification conflicts. |
| REAL SANDBOX VERIFIED | Standalone Node sandbox smoke and source/packaged Electron smoke execute an actual two-file signed installation, managed upgrade, verified backup, explicit rollback to original bytes/ownership, injected partial-apply failure and rollback. No filesystem-success mock substitutes for these operations. |
| RECOVERY VERIFIED | Actual terminated Node children leave persisted journals during acquiring/chunk/staging/verification/backup, first and middle apply, after rename, installed verification, receipt update, commit finalization, rollback, restore-rename pending and after restore rename. Fresh service startup recovers and checks file/receipt state; repeated recovery passes. External changes are preserved with recovery-required status. |
| WINDOWS BEHAVIOR | Local NTFS hardlinks/junctions and an actual PowerShell fixture holding `FileShare.None` were exercised. Replacement is refused, original bytes remain, installer does not terminate holder/game processes; the test harness closes only its own disposable holder. Windows builds/test runner, not Linux-only mocks. |
| TYPECHECK / BUILD | TypeScript and Electron main/preload/React builds PASSED. All existing L1/L2/L3 fixture workflows still pass. |
| PACKAGING | Local NSIS PASSED: `release/SkyrimRPLauncher-0.1.3-x64-local.exe`; unpacked `release/win-unpacked/Skyrim RP Launcher.exe`. **NotSigned** development artifact; installer execution/overwrite acceptance remains manual. appId, product/executable, install and user-data identities preserved. L2 fixture offer is synthetic 0.1.4; production signing policy unchanged. |
| PACKAGE AUDIT | Provider/version metadata and current implementation checks passed; no local profiles/hashes/evidence, journals, receipts, backups, private keys, game assets or mod binaries packaged. Only generated original synthetic demonstration logic is included. |
| ACTUAL PROTECTED RECHECK | Read-only Skyrim **1.6.1170.0**, SKSE resources **0.2.2.6**, **24/24 local baseline files match**. **53 protected paths unchanged** before/after, including masters/archive, client/config, load order, server settings/manifest and world files. No game launch, server restart or process stop. |
| PUBLICATION | No L4-A commits/pushes/tags/Releases/distribution repository. Windows CI extended for all tests, sandbox smoke and package audit, but not run remotely on this uncommitted source. |

Read-only reviewer findings were reproduced and fixed: unknown temp deletion, rollback rename crash gap, restored-file revalidation, verify identity check, writer-handle cleanup and pointer publication before recovery metadata. Final core changes and fault regressions passed locally. No production readiness claim.

Main files: `src/main/installer/{sandbox,metadata,engine,synthetic,demo}.ts`, `src/shared/installer-contracts.ts`, main/preload/renderer integration and `InstallerPanel.tsx`, installer/demo/terminated-child tests, sandbox smoke/package audit scripts, existing test/UI smoke runner, package version/lock metadata, Windows CI and docs. Private evidence is ignored `.local/l4a-*` and `.local/installer-sandbox.png`; sandbox metadata is outside source/game.

## Limits and L4-B prerequisites

File sync + rename and terminated-process recovery are demonstrated; directory-flush durability, sudden power loss, storage/controller corruption and every crash instant are **UNVERIFIED**. Windows Node APIs use paths rather than exclusive directory-handle transactions: last checks catch tested substitution but cannot promise immunity to a hostile concurrent same-user filesystem race. Cross-volume final rename is avoided by destination-local preparation; arbitrary volumes/network filesystems were not exercised. PID reuse can conservatively block recovery. HMAC detects accidental/untrusted metadata edits; it does not protect against a malicious process with access to the same account's key.

Cancellation does not itself prove restoration: journal/evidence is retained and incomplete/unsafe states require recovery. Startup recovery concerns the internally tracked sandbox; this is not a production fleet/global mod-manager recovery system. Automatic retention cleanup, ZIP entry/decompression validation, real network retry/resume, Windows ACL hardening and real game process/file-lock coordination remain future work. Nonstandard or game-like temporary roots are rejected before sandbox creation.

L4-B needs separately approved immutable package sources, pinned production Ed25519 identity/rotation, reviewed redistribution rights and archive limits/source restrictions. Production Windows signing remains an independent L2 blocker. Real Skyrim writes require separate **L4-C** authorization and policy; no developer setting bypasses the current sandbox-only core. Do not begin L4-B automatically.

## User GUI checks

1. Close old launcher and install local **0.1.3** into the same folder (or use unpacked EXE). Confirm version and retained game path/settings.
2. Updates → **Installer Sandbox Test · L4-A → Run Sandbox Test**. Expect `Sandbox demo passed`, five checks, `Transaction: rolled-back` and `Backup: verified`.
3. Run again and optionally Cancel while running; inspect cancellation/recovery message. Cancel never authorizes game writes.
4. Confirm L3 Scan Modpack and L2 update controls remain available. Real publisher/signing is still unconfigured; no working Install Modpack button should exist for Skyrim.
5. Manual Play/server check is optional regression acceptance; the agent did not launch Skyrim. Your L4-A brief records prior real UI/Play acceptance. The earlier MSIX profile recovery remains relevant if an installed launcher still reports profile missing; no private profile is bundled to hide that issue.
