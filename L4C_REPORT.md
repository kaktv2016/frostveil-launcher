# FROSTVEIL LAUNCHER — L4-C Final Engineering Report

Date: 2026-10-16 (Asia/Bangkok)  
Launcher development version: **0.1.6**

## Evidence-Based Milestone Statuses

- **IMPLEMENTED**
- **AUTOMATED TEST PASSED** (381/381 Launcher tests + 4/4 Distribution tests)
- **REALISTIC SANDBOX VERIFIED**
- **PLUGIN CONFIGURATION FIXTURE VERIFIED**
- **REAL SKYRIM PREFLIGHT VERIFIED**
- **REAL SKYRIM WRITE NOT AUTHORIZED**
- **REAL SKYRIM INSTALL NOT YET VERIFIED**
- **PRODUCTION MODPACK NOT CONFIGURED**
- **PRODUCTION READINESS BLOCKED**

---

## 1. Summary of Implemented Systems

L4-C completes the end-to-end real Skyrim modpack management architecture inside a single milestone without introducing a duplicate installer, downloader, manifest schema, backup store, or transaction engine:

- **Read-Only Real Skyrim Preflight (`src/main/management/preflight.ts`):** Inspects the selected Skyrim installation, `Data/` inventory, TES4 plugin headers, `plugins.txt`, `loadorder.txt`, `Skyrim.ccc`, INI `sTestFile` entries, MO2/Vortex indicators, hardlink/symlink/junction conditions, OS read/write access (without probe writes), available volume capacity, and running `SkyrimSE`/`skse64_loader` processes.
- **Content Path & Target Capability Boundary (`src/main/management/content-policy.ts`, `src/main/installer/managed-target.ts`):** Extends L4-A's `SandboxGrant` to support both disposable sandboxes (`managed-fixture`) and explicitly registered L1 real Skyrim targets (`real-skyrim`), while strictly rejecting native executables (`.dll`, `.exe`, `.bin`, `MZ` PE headers), official/Creation Club masters, `.esl` plugins, and path traversal/link escapes.
- **Single-Use Plan-Bound Authorization (`src/main/management/authorization.ts`):** Deep-freezes plain JSON `ManagedPlan` snapshots, computes canonical SHA-256 digests (`planDigest`), and issues opaque single-use `WeakMap` tokens bound to a Main-Process confirmation callback with a bounded TTL (default 2 minutes, max 5 minutes).
- **Safe Plugin Activation & Load-Order Planner (`src/main/management/activation.ts`):** Plans native Skyrim SE `plugins.txt` asterisk activation and topological master/order resolution while preserving UTF-8 BOM, CRLF/LF line endings, comments, disabled entries, and unrelated user plugin relative order. Blocks unsupported light/ESL activation and refuses MO2/Vortex-managed profiles.
- **Install / Update / Repair / Remove Planner & Engine Integration (`src/main/management/planner.ts`, `src/main/installer/engine.ts`):** Extends `SandboxInstaller` to execute `install`, `replace`, `verify`, `remove`, and `@config/plugins.txt` (`configuration`) operations within a single persistent journal, with verified backups, staged TES4/BSA/PE header validation, pre-write process rechecks (including before rollback deletions), and durable crash recovery.
- **Main Process Orchestration & Frostveil Management UI (`src/main/management/service.ts`, `src/main/management/demo.ts`, `src/renderer/ManagementPanel.tsx`):** Integrates L4-C with Electron Main Process, narrow typed preload IPC, startup/post-scan recovery detection, and the Frostveil dark-fantasy UI panel, including a realistic Skyrim-shaped fixture runner.

---

## 2. Existing Services Reused

| Milestone | Existing Service / Module | How L4-C Reuses It |
|---|---|---|
| **L1** | `src/main/installation.ts`, `src/main/discovery.ts`, `src/main/windows.ts`, `src/main/backup.ts` | Trusted Skyrim/SKSE discovery, `fileVersion`, `gameRunning` process check, and preservation of L1 baseline backups |
| **L2** | `src/main/updates.ts`, `src/main/update-bootstrap.ts` | Preserved self-update state machine and play-lock coordination |
| **L3** | `src/main/modpack/schema.ts`, `trust.ts`, `scanner.ts`, `plugins.ts`, `compatibility.ts` | Signed Manifest V1 validation, Ed25519 verification, `scanPackFiles`, `readOrderInputs`, `readPluginHeader`, and `evaluateCompatibility` |
| **L4-A** | `src/main/installer/engine.ts`, `metadata.ts`, `sandbox.ts` | `SandboxInstaller`, `MetadataStore`, `OwnershipReceipt` ledger, verified transaction backups, and persistent journal rollback/recovery |
| **L4-B** | `src/main/distribution/github.ts`, `download.ts`, `policy.ts`, `transport.ts` | `GitHubDistributionProvider`, `PackageDownloader`, `authenticateRelease`, `productionSource`, and `VersionLedger` |

---

## 3. Main Files Modified and Added

### Modified Files
- `package.json`, `package-lock.json`, `.github/workflows/windows.yml`, `README.md` — Bumped development version to `0.1.6` while preserving `appId` (`dev.skyrimrp.launcher`), `productName` (`Skyrim RP Launcher`), and user-data paths.
- `src/shared/contracts.ts`, `src/shared/installer-contracts.ts` — Extended dashboard and journal/grant contracts for `remove` and `configuration` operations and target classes.
- `src/main/installer/sandbox.ts`, `src/main/installer/metadata.ts`, `src/main/installer/engine.ts`, `src/main/installer/synthetic.ts` — Extended `SandboxInstaller` to support managed targets, `@config/plugins.txt`, controlled removal, staged TES4/BSA/MZ validation, and rollback process rechecks while keeping legacy L4-A/L4-B sandbox behavior intact.
- `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/main.tsx`, `src/renderer/style.css` — Wired `ManagementService` IPC handlers and `ManagementPanel` into the Updates view.
- `scripts/tests.mjs`, `scripts/smoke.mjs`, `tests/installer-worker.ts` — Added L4-C test suites, worker checkpoints for `remove`/`configuration`/`rollback`, and Playwright UI smoke coverage.

### Added L4-C Modules & Tests
- `src/shared/management-contracts.ts`
- `src/main/installer/managed-target.ts`
- `src/main/management/authorization.ts`
- `src/main/management/content-policy.ts`
- `src/main/management/activation.ts`
- `src/main/management/preflight.ts`
- `src/main/management/planner.ts`
- `src/main/management/service.ts`
- `src/main/management/demo.ts`
- `src/renderer/ManagementPanel.tsx`
- `tests/management-authorization.test.ts`
- `tests/management-activation.test.ts`
- `tests/management-engine.test.ts`
- `tests/management-recovery.test.ts`
- `tests/management-service.test.ts`
- `tests/management-demo.test.ts`
- `scripts/verify-l4c-artifacts.mjs`
- `L4C_REAL_INSTALL_APPROVAL.md`, `L4C_REPORT.md`

---

## 4. Real Skyrim Preflight Results

Read-only inspection of the actual Windows Skyrim installation produced the following verified evidence (`.local/l4c-real-preflight.json`):

- **Skyrim SE Runtime:** `1.6.1170.0` (`SkyrimSE.exe` verified)
- **SKSE64 Runtime & Loader:** `0.2.2.6` (24/24 L1 baseline files verified, `ready: true`)
- **Running Game Processes:** `false` (`SkyrimSE` and `skse64_loader` not running)
- **Mod Manager Indicators (`MO2` / `Vortex`):** `false`
- **Filesystem & Link Safety:** `game`, `Data`, and `config` roots verified as real directories (`links: 1`, no junctions/symlinks/hardlinks)
- **Read-Only OS Access Check (`writeProbePerformed: false`):** `gameReadable: true`, `gameWriteAccess: true`, `configReadable: true`, `configWriteAccess: true`
- **Available Disk Space:** `60,260,040,704 bytes` (~56.12 GiB)
- **Detected Plugins in `Data/` (10):**
  - Full `.esm` (7): `Skyrim.esm`, `Update.esm`, `Dawnguard.esm`, `HearthFires.esm`, `Dragonborn.esm`, `ccBGSSSE001-Fish.esm`, `ccBGSSSE025-AdvDSGS.esm`
  - Light `.esl` (3): `ccBGSSSE037-Curios.esl`, `ccQDRSSE001-SurvivalMode.esl`, `_ResourcePack.esl`
- **Overall Preflight Status:** `UNVERIFIED` (and `PRODUCTION NOT CONFIGURED` in service state), because the 3 implicit active light plugins have unverified gameplay compatibility with the pinned SkyMP server build and no production Modpack Release is configured.

---

## 5. Install / Update / Repair / Remove Implementation

- **INSTALL:** Detects missing required files, verifies publisher/release/rights, downloads and SHA-256-verifies assets into `packages/`, validates TES4/BSA headers and rejects PE `MZ` binaries, backs up any affected `@config/plugins.txt`, installs files atomically, verifies post-install observations, and commits `ownership.json`.
- **UPDATE:** Enforces monotonic versions (`VersionLedger` + `semver.lt`), rejects same-version content mutations, backs up existing owned files before replacement, removes obsolete owned files from the same pack (deactivating removed owned plugins in `plugins.txt`), and commits the updated receipt.
- **REPAIR:** Re-evaluates managed files against `ownership.json`; classifies missing owned files as `repair` only when `intent === 'repair'`, blocks on externally modified managed files rather than overwriting them, and restores signed bytes.
- **REMOVE:** Removes only files recorded in `ownership.json` whose current disk observation (`identity`, `sha256`, `size`) matches the receipt, deactivates removed owned plugins in `@config/plugins.txt` within the same journal, and preserves all unknown/user files.
- **CANCELLATION:** Aborts in-flight downloads, staging, or pre-commit steps via `AbortController`, revokes any pending plan review, and reports whether transaction rollback completed or recovery is pending.

---

## 6. Ownership and Conflict Handling

All 10 ownership rules from Section 7 are enforced and tested:
1. Unmanaged existing files are never overwritten (`OWNERSHIP CONFLICT: existing unowned file` / `Unmanaged file must not be adopted/overwritten`).
2. Existing unmanaged files with matching SHA-256 hashes are never adopted into `ownership.json`.
3. Externally modified managed files (`identity`, `sha256`, or `size` drift from `ownership.json`) are reported as conflicts and never overwritten automatically.
4. No recursive directory deletion exists; only individual owned files are unlinked.
5. Removal verifies both receipt presence and current file identity/hash before unlink.
6. Provenance (`packId`, `packVersion`, `componentId`, `componentVersion`, `sha256`, `size`, `transactionId`, `installedAt`, `identity`) is validated on every receipt read/write.
7. Rollback restores `previousReceipt` and updates restored file identities (`dev:ino`).
8. L1 baseline backups in `%LOCALAPPDATA%\SkyrimRPLauncher\backups` are never touched by modpack transactions.
9. Skyrim/Steam runtime binaries are rejected by `managedContentTarget`.
10. Native binaries (`.dll`, `.exe`, `.bin`, `MZ` headers) are rejected both by path policy and by staged file-header inspection.

---

## 7. Plugin Activation and Load-Order Coverage

- **Skyrim SE Asterisk Format (`src/main/management/activation.ts`):** Implements native Steam Skyrim SE `plugins.txt` handling (`*Plugin.esp` enabled, `Plugin.esp` disabled) without fabricating `loadorder.txt` writes.
- **Encoding & Formatting Preservation:** Restricts managed edits to byte-safe ASCII, preserves UTF-8 BOM (`\uFEFF`), preserves CRLF or LF line endings, keeps all `#` comments and blank lines, and preserves the pairwise relative order of unrelated user plugins.
- **Implicit Masters & Creation Club:** Recognizes `Skyrim.esm`, `Update.esm`, `Dawnguard.esm`, `HearthFires.esm`, `Dragonborn.esm`, and installed `Skyrim.ccc` entries as implicitly active without inserting them into `plugins.txt`.
- **Topological Dependency & Index Verification:** Validates TES4 `MAST` records (both installed and staged pending headers), detects dependency cycles, prevents `.esp` hoisting before `.esm` masters, verifies exact `server-required` full-plugin indices (`0..253`), and blocks `.esl`/light-flagged plugin activation for the pinned SkyMP build.

---

## 8. MO2 / Vortex Behavior

- `inspectManagedInstallation` checks for `ModOrganizer.ini`, `usvfs_x64.dll`, `usvfs_x86.dll`, `Data/vortex.deployment.json`, `Data/vortex.deployment.msg`, `Data/__folder_managed_by_vortex`, MO2/Vortex header comments in `plugins.txt`/`loadorder.txt`, and non-standard `sTestFile` entries in `Skyrim.ini`/`SkyrimCustom.ini`.
- When detected (`managerDetected: true`), `planActivation` returns `status: 'manual'` with zero `configWrites`, `inspectManagedInstallation` reports `MANUAL ACTION REQUIRED` (or `BLOCKED` if combined with blockers), and `prepareManagementPlan` adds a blocker (`MO2/Vortex effective profile is ambiguous`) so physical `Data/` and `plugins.txt` are never written as if authoritative.

---

## 9. Backup, Journal, Rollback, and Recovery Results

- **Unified Transaction Journal:** Content operations (`install`, `replace`, `verify`, `remove`) and `@config/plugins.txt` (`configuration`) share a single `InstallJournal` and backup directory (`transactions/<id>/backup/<index>.bin`).
- **Pre-Rollback Process Recheck:** `SandboxInstaller.restore()` rechecks `checkProcess()` at the start of each reverse operation, immediately before renaming a restored backup into place, and immediately before unlinking newly installed content or activation files.
- **Post-Scan Recovery Rebinding:** If `ManagementService.initialize()` runs at Launcher startup before the L1 game scan completes (`state.scan === null`), any persisted `management-session.json` immediately surfaces `RECOVERY REQUIRED` without performing writes, and automatically rebinds the verified `SandboxGrant`, backup list, and recovery state once the L1 scan completes.
- **Durable Worker Crash Recovery:** Tested across 5 real child-process crash scenarios (`install-rename`, `remove-unlink`, `activation-rename`, `rollback-rename`, `external-conflict`) in `tests/management-recovery.test.ts`. Interrupted transactions roll back cleanly on reopen once authorized, while external modifications after a crash are preserved and reported as `recovery-required`.

---

## 10. Automated Test Totals

All unit, integration, security, worker-recovery, and regression tests passed:

| Test Suite | Passed | Failed | Skipped | Notes |
|---|---:|---:|---:|---|
| **Launcher Full Suite (`npm test`)** | **381** | **0** | **0** | Includes all L1, L2, L3, L4-A, L4-B, Level B, and 137 new L4-C tests (`39.3s`) |
| **Distribution Repository (`npm test` in `frostveil-distribution`)** | **4** | **0** | **0** | Manifest/release verification regressions |
| **TypeScript (`npm run typecheck`)** | **PASS** | **0** | **0** | `tsc --noEmit` zero errors |

---

## 11. Sandbox and Windows Filesystem Results

- `runManagementFixtureDemo` (`src/main/management/demo.ts`) executes against a real temporary Windows directory (`%TEMP%\frostveil-l4c-*`) using an ephemeral Ed25519 test key and local loopback HTTP server:
  1. Fresh 2-file signed installation (`Data/Interface/Frostveil/notice.html`, `banner.css`) -> verified on disk & in `ownership.json`.
  2. Managed upgrade to generation 2 adding `Data/FrostveilFixture.esp` -> verified backups of generation 1 files + transactional activation of `*FrostveilFixture.esp` in `plugins.txt`.
  3. Rollback of generation 2 upgrade -> verified exact restoration of generation 1 files and original `plugins.txt` bytes.
  4. Re-apply generation 2, delete an owned file, run `repair` -> missing owned file classified as `repair` and restored.
  5. Controlled `remove` -> all 3 owned files deleted, `*FrostveilFixture.esp` disabled in `plugins.txt`, unrelated user file (`unrelated-user-file.txt`) preserved.
  6. Rollback of `remove` -> all 3 owned files, `ownership.json`, and `*FrostveilFixture.esp` activation restored.
  7. Recovery check -> 0 unfinished journals remaining.

---

## 12. Build and NSIS Output

- **Build command:** `npm run package:nsis`
- **Renderer bundle:** `dist/renderer/index.html` (`0.36 kB`), `index-bV5gITxq.css` (`9.15 kB`), `index-hZZDmZms.js` (`246.70 kB`)
- **Unpacked application:** `release/win-unpacked/Skyrim RP Launcher.exe` (version `0.1.6`)
- **Local NSIS installer:** `release/SkyrimRPLauncher-0.1.6-x64-local.exe`
  - **Size:** `112,336,312 bytes`
  - **SHA-256:** `04ee4899cdca0d876ea57ce8d03815f12ee345cea140813168ae3953b14fe9a7`
  - **Authenticode status:** `NotSigned` (L2 production signing certificate still pending)
- **Smoke tests:**
  - Source Electron smoke (`npm run smoke`): **PASSED**
  - Packaged Electron smoke (`LAUNCHER_SMOKE_EXE=release/win-unpacked/Skyrim RP Launcher.exe npm run smoke`): **PASSED**

---

## 13. Privacy and Security Audit

All four packaged `app.asar` audit scripts passed (`verify-l3-artifacts.mjs`, `verify-l4a-artifacts.mjs`, `verify-l4b-artifacts.mjs`, `verify-l4c-artifacts.mjs`):

- **No private keys or fixture keys:** 0 PEM private keys, 0 deterministic fixture private keys, 0 Level B test publisher IDs/fingerprints in `dist/main.cjs` or `app.asar`.
- **No tokens or credentials:** 0 GitHub PATs or tokens packaged.
- **No personal filesystem paths:** 0 `<Drive>:\Users\<username>` strings in `dist/main.cjs`, `dist/preload.cjs`, or `assets/local-baseline.json`.
- **No transaction or session leakage:** 0 journals, backups, `ownership.json`, `management-session.json`, `plugins.txt`, or `.local` files packaged in `app.asar`.
- **Production trust remains closed:** `productionSource.keys` verified empty (`keys: {}`) inside packaged `dist/main.cjs`.
- **Existing settings compatibility:** `%LOCALAPPDATA%\SkyrimRPLauncher\settings.json` (`channel: 'stable'`) remains valid and unmodified.

---

## 14. Real-Game Protected-File Comparison

Before/after comparison against `.local/l4c-protected-before.json` and `.local/l4c-tree-before.json`:

- **Protected file SHA-256 hashes (`.local/l4c-protected-after.json`):** **53 / 53 unchanged** (`changed: 0`), covering `SkyrimSE.exe`, `skse64_loader.exe`, `skse64_1_6_1170.dll`, SkyMP client DLLs/JS/settings/UI, official `.esm`/`.bsa` files, `Skyrim.ccc`, `%LOCALAPPDATA%\Skyrim Special Edition\plugins.txt`, `loadorder.txt` (still absent), `server-settings.json`, `server/data/manifest.json`, and all `rp-world/changeforms/*.json` files.
- **Full Skyrim installation tree & save directories (`.local/l4c-tree-check.json`):** **710 / 710 game entries unchanged**, **3 / 3 save entries unchanged** (`unchanged: true`, `realGameLaunched: false`).

---

## 15. Production Trust and Distribution Status

- **Status:** **PRODUCTION MODPACK NOT CONFIGURED** / **PRODUCTION READINESS BLOCKED**
- `productionSource` (`src/main/distribution/policy.ts`) is wired to `kaktv2016/frostveil-distribution` (`packId: 'frostveil-rp-pack'`, `channel: 'stable'`, `keys: {}`, `permittedReviews: []`).
- Because `productionSource.keys` is empty, `ManagementService` immediately blocks `prepare('install' | 'update' | 'repair' | 'remove')` with `PRODUCTION NOT CONFIGURED` before any network request or confirmation dialog.
- The Level B synthetic release (`test-pack-v0.0.1`) is never used for real Skyrim targets.

---

## 16. Real-Install Approval Gate Status

- Documented in [`L4C_REAL_INSTALL_APPROVAL.md`](./L4C_REAL_INSTALL_APPROVAL.md).
- **Current Gate State:** **REAL SKYRIM WRITE NOT AUTHORIZED** / **REAL SKYRIM INSTALL NOT YET VERIFIED**.
- Real Skyrim writes are blocked pending configuration of an approved production Ed25519 publisher key, publication of a signed `stable` production Modpack Release with verified rights, a SkyMP compatibility decision on implicit Creation Club `.esl` files, and explicit user confirmation of the resulting `planHash`.

---

## 17. Remaining Limitations

1. **No Configured Production Modpack or Publisher Key:** Production installation remains intentionally blocked until a real signed Modpack Release and production Ed25519 public key are supplied.
2. **Pinned SkyMP Light/ESL Plugin Support:** Activation of new `.esl` or light-flagged `.esp`/`.esm` plugins is blocked until verified against the pinned SkyMP server/client runtime, and existing implicit Creation Club `.esl` plugins in `Skyrim.ccc` are flagged for manual compatibility review.
3. **External Mod Managers (MO2 / Vortex):** When MO2/Vortex virtualization or profile markers are detected, automatic physical `Data/` and `plugins.txt` writes are refused in favor of manual mod-manager application.
4. **Same-User Hostile Race Conditions & Sudden Power Loss:** While atomic same-volume renames, `fsync`, file-identity (`dev:ino`) checks, and persistent journals protect against ordinary crashes and accidental modifications, the installer does not claim resistance to hostile concurrent same-user processes or hardware power loss across uncached filesystem metadata.
5. **L2 Authenticode Signing:** The local NSIS installer (`0.1.6`) is unsigned (`NotSigned`).

---

## 18. Manual Acceptance Checklist

When inspecting the `0.1.6` build or preparing for future production configuration, the operator can verify:

- [ ] Launch the app (`npm start` or `release\win-unpacked\Skyrim RP Launcher.exe`) and open the **Updates** tab.
- [ ] Confirm the **Modpack management · L4-C** panel displays `PRODUCTION MODPACK NOT CONFIGURED — REAL INSTALLATION BLOCKED` and keeps `Review Install`, `Review Update`, `Review Repair`, `Review Remove`, and `Apply Reviewed Plan` disabled.
- [ ] Click **Verify Installation** and confirm read-only preflight reports Skyrim `1.6.1170.0`, SKSE `0.2.2.6`, SkyMP `LOCAL BASELINE MATCH`, Live server `UNVERIFIED`, and surfaces the Creation Club light-plugin notice without writing to the Skyrim directory or `plugins.txt`.
- [ ] Click **Run Realistic Modpack Fixture** and confirm all 7 disposable Windows filesystem checks pass (`REALISTIC SANDBOX VERIFIED — real Skyrim not modified`).
- [ ] Review [`L4C_REAL_INSTALL_APPROVAL.md`](./L4C_REAL_INSTALL_APPROVAL.md) for the exact items required before authorizing the first real Skyrim modpack installation.
