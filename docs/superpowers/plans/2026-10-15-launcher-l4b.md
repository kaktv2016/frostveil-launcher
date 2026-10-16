# Frostveil L4-B Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; preserve cumulative uncommitted work. No launcher commit/push.

**Goal:** Authenticated GitHub direct-file acquisition feeding the existing sandbox transaction engine, demonstrated with real loopback transfers.

**Architecture:** Extend Manifest V1 with optional authenticated release/package bindings and rights review metadata. Fixed main-process GitHub provider, bounded resumable acquisition, persisted anti-replay state and offline explicit-key preparation reuse L3 validation/signature and L4-A staging/rollback. Production pins remain empty; a visibly separate synthetic loopback sandbox demonstrates the pipeline.

**Tech Stack:** Existing pinned Node/Electron/TypeScript/React, native fetch/fs/crypto, existing esbuild/Playwright; no new dependencies.

**Spec:** User supplied FROSTVEIL LAUNCHER L4-B, 2026-10-15 (retained attachment; no personal path published).

## Global Constraints

- Fixed public repository kaktv2016/frostveil-distribution; source publication authorized, Release/tags/assets/production identity not authorized.
- REAL SKYRIM INSTALL DISABLED; no game/server/load-order/process changes; existing L2 signing unchanged.
- Direct-file passive sandbox assets only; no archives/FOMOD/hooks; original synthetic content only.
- Version 0.1.4; preserve app/installer/executable/user-data identities.
- Production and sandbox trust roots separate; no private key generated/selected by CI or bundled.

## Review Focus

- Range response ignoring offset or returning changed ETag must restart/refuse, never append full body.
- Restart with forged/stale partial metadata must not trust incomplete bytes; final full hash always required.
- Release asset replacement/name/ID/size/repository mismatch must fail before installation.
- Same-version changed signed payload and downgrade must fail across service restarts.
- Cancellation during metadata/staging/apply must preserve recoverable existing transaction evidence.

### Task 1: Authenticated bindings and trust policy

Files: shared/modpack-contracts.ts, main/modpack/schema.ts, main/distribution/policy.ts, tests/distribution-policy.test.ts.
Interface: authenticateRelease(envelope, source, release) produces validated bundle; optional direct package references retain existing V1.
- [x] Write/run failing schema/binding/rights/key/replay cases.
- [x] Add strict optional V1 extension, fixed trusted source, canonical bytes and durable bounded version ledger.
- [x] Run policy + existing regressions.

### Task 2: Release discovery and resumable acquisition

Files: main/distribution/{transport,github,download}.ts, tests/distribution-network.test.ts.
Interface: provider.resolve(channel, exactTag?) and downloader.acquire(binding, signal) return authenticated metadata and verified cache payload.
- [x] Write/run failing real HTTP release/range/redirect/retry/cancel/size/hash/partial cases.
- [x] Implement bounded metadata, fresh release resolution, credential-free restricted redirects, sequential streaming/durable partial identity/ETag and final hash.
- [x] Pass real loopback tests; no live GitHub assets claimed.

### Task 3: Engine integration, preparation and UI

Files: installer/engine.ts acquisition hook, distribution/{prepare,service,synthetic-network}.ts, shared/distribution-contracts.ts, main/preload/renderer, tests integration and smoke.
Interface: InstallerOptions.acquire supplies checked bytes into existing stage; main-only service owns sandbox/source/keys/transactions.
- [x] Write/run failing signed-network install/upgrade/rollback/recovery and preparation cases.
- [x] Reuse engine/scanner/plan; preparation requires explicit Ed25519 key and reviewed rights; independent verification of output.
- [x] Add no-argument IPC/status/progress/cancel/rollback/recovery and explicit local network sandbox UI.
- [x] Run suite and source smoke.

### Task 4: Audited distribution source and verification

Files: separate frostveil-distribution repo, workflows/scripts/docs, launcher scripts/reports.
- [x] Build small source scaffold sharing exact L3 validation implementation; no binary/key fixture publication.
- [x] Audit/test source, commit/push only authorized distribution scaffold; verify CI/repository/release status.
- [x] Run typecheck/full tests/network/terminated recovery/build/NSIS/source+packaged smoke/content audits/protected hashes.
- [x] Fresh independent read-only review; fix evidenced findings and reverify affected checks.
- [x] Write L4B_REPORT.md with precise local/public status and pending approvals; stop before L4-C.

## Rulings / evidence ledger

- Detailed user authorization supplies design/execution approval. Implement inline without another approval ceremony. Keep ledger here because launcher commits are forbidden; Windows has no native skill shell helper requirement overriding user scope.
- Existing source main HEAD 5eb2cf7 includes uncommitted L3/L4-A; preserve it. SkyMP develop has preexisting local RP/docs/client changes.
- Repository created under authenticated kaktv2016, PUBLIC, ADMIN; initial empty branch. GET immutable-releases: enabled=false, enforced_by_owner=false. No settings mutation.
- Reuse L3 exact validator/verifier/scanner/planner; L4-A grant, stage, HMAC metadata, lease, backups, receipts, rollback/recovery. Gap is authenticated remote source + release/version policy + durable HTTP acquisition + publishing preparation.

- Task 1 complete: 25 policy cases; existing V1 retained; strict refs/rights/pins/version ledger.
- Task 2 complete: 27 real loopback cases, including resume/crash/reset/promotion/timeout regressions.
- Task 3 complete: 5 integration and 3 service cases; owned terminated Node processes recover network acquisition/apply; UI and source/packaged smoke pass.
- Task 4 complete: audited distribution source pushed (1c223f1), CI success, protected env configured; 230 launcher +2 tool tests; type/build/NSIS/current audits pass; 53 protected SHA paths and final 710 game metadata entries/1 save hash unchanged.
- Review fixes: authenticated-prefix crash tail, atomic cache promotion, unresolved recovery gate, restart rollback lookup, HTTP200 reset ordering and timeout retry reproduced RED then GREEN. No remaining Important findings on scoped recheck.
- Ruling: normalize public source snapshot to LF with .gitattributes so Git checkout preserves recorded hashes; same canonical shared source, no second parser.
- Ruling: offline signing uses prepare:offline because npm prepare is an automatic lifecycle hook; first CI failure fixed, ordinary npm ci and current public CI passed.
- Public Release/tag/assets/production identity remain NOT AUTHORIZED; Level B BLOCKED as spec permits. Launcher source commits/pushes remain forbidden; source stays local. L4-C not started.
