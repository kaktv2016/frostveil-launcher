# L4-C Real Skyrim Installation — Preflight & Approval Gate

Date: 2026-10-16 (Asia/Bangkok)  
Launcher version: **0.1.6**

## Evidence-Based Gate Status

- **REAL SKYRIM PREFLIGHT VERIFIED**
- **PRODUCTION MODPACK NOT CONFIGURED**
- **REAL SKYRIM WRITE NOT AUTHORIZED**
- **REAL SKYRIM INSTALL NOT YET VERIFIED**
- **PRODUCTION READINESS BLOCKED**

> **Note on user prompt authorization vs. executable transaction authorization:**  
> Although the development request granted general permission to edit Skyrim files once ready, the L4-C architecture and milestone rules require a concrete, cryptographically signed production Modpack Release, an approved production Ed25519 publisher identity (`productionSource.keys`), verified redistribution rights, and an exact immutable file-operation plan (`ManagedPlan` + SHA-256 digest) before the first real game write can occur. Because no production Modpack Release or production publisher key is configured yet, real-installation actions remain **BLOCKED** and **zero bytes** have been written to the actual Skyrim installation or native load-order files.

---

## 1. Detected Actual Skyrim Installation

- **Installation root:** Standard Steam `Skyrim Special Edition` directory (verified via read-only OS stat/realpath/link checks; no junctions, symlinks, or hardlinks on `game`, `Data`, or `config` roots).
- **Native activation config root:** `%LOCALAPPDATA%\Skyrim Special Edition` (`plugins.txt` present, `loadorder.txt` absent as expected for native Steam Skyrim SE; `Skyrim.ccc` present in game root).
- **Permissions (`read-only-os-access-check`, `writeProbePerformed: false`):**
  - `gameReadable`: `true`
  - `gameWriteAccess`: `true`
  - `configReadable`: `true`
  - `configWriteAccess`: `true`
- **Data directory inventory:** 30 top-level files inspected read-only (`links: 1` for all entries), including 10 TES4 plugins (`Skyrim.esm`, `Update.esm`, `Dawnguard.esm`, `HearthFires.esm`, `Dragonborn.esm`, `ccBGSSSE001-Fish.esm`, `ccBGSSSE025-AdvDSGS.esm`, `ccBGSSSE037-Curios.esl`, `ccQDRSSE001-SurvivalMode.esl`, `_ResourcePack.esl`) and their corresponding `.bsa` archives.

## 2. Runtime / SKSE / SkyMP Compatibility

- **Skyrim SE executable (`SkyrimSE.exe`):** `1.6.1170.0` — verified against L1 baseline.
- **SKSE64 loader & runtime (`skse64_loader.exe`, `skse64_1_6_1170.dll`):** `0.2.2.6` (release `2.2.6`) — verified against L1 baseline.
- **SkyMP client baseline:** 24/24 required baseline integration files verified (`ready: true`).
- **Preflight overall status:** `UNVERIFIED`
  - **Reason:** Three implicit Creation Club / resource light plugins (`ccBGSSSE037-Curios.esl`, `ccQDRSSE001-SurvivalMode.esl`, `_ResourcePack.esl`) are active through `Skyrim.ccc` / engine rules. While preserved untouched by the planner, their runtime/gameplay compatibility with the pinned SkyMP server build is not automatically assumed (`Existing active light/ESL plugins are preserved; their gameplay compatibility with the pinned SkyMP build is unverified.`).

## 3. Active Process Status

- **Skyrim / SKSE processes (`SkyrimSE.exe`, `skse64_loader.exe`):** `processActive: false` (not running during read-only preflight).
- **Process coordination policy:** If any game process starts before or during an operation, `ManagementService` and `SandboxInstaller` refuse writes rather than terminating user processes.

## 4. Selected Proposed Signed Modpack Identity

- **Status:** `NONE (PRODUCTION MODPACK NOT CONFIGURED)`
- **Pack ID / Version:** Not configured (`productionSource.packId: 'frostveil-rp-pack'`, `channel: 'stable'`, no published production release).
- The synthetic Level B test release (`test-pack-v0.0.1` / `frostveil-integration-test` `0.0.1` on `beta`) is strictly **TEST-ONLY** and is rejected by `productionSource` policy and `managedContentTarget` path rules.

## 5. Publisher Trust Status

- **Status:** `PRODUCTION NOT CONFIGURED`
- `productionSource.keys` in `src/main/distribution/policy.ts` is `{}` (empty).
- The Level B test key (`frostveil-level-b-test-20261015`, expiring `2026-10-21T10:33:00.783Z`) has `environment: 'test'` and is cryptographically and policy-blocked from authorizing `real-skyrim` targets.

## 6. Server Compatibility Status

- **Offline server snapshot:** `UNVERIFIED` (no signed production modpack manifest/server snapshot bundle is configured).
- **Live SkyMP server state:** `UNVERIFIED` (offline profile comparison never claims live server runtime verification).

## 7. Exact Source Package and Release

- **Repository:** `https://github.com/kaktv2016/frostveil-distribution`
- **Production Release (`stable` channel):** None published (`GET /releases/latest` returns `404`).
- **Packages to download:** `0` (blocked prior to network acquisition because `productionConfigured === false`).

## 8. Exact Target Files and Operations

- **Planned file operations:** `None` — no real-installation plan can be generated until a signed production release and approved production publisher key are configured.
- **Files added / replaced / repaired / removed in actual Skyrim installation:** `0`.

## 9. Existing Ownership / Conflicts

- **Launcher-owned files in real Skyrim installation:** `0` (no `managed-installations` ledger or `management-session.json` exists in `%LOCALAPPDATA%\SkyrimRPLauncher`).
- **Mod Manager (MO2 / Vortex) indicators:** `managerDetected: false` (no `ModOrganizer.ini`, `usvfs_*.dll`, `vortex.deployment.*`, or `sTestFile` overrides found).
- **File conflicts:** `0` blocking filesystem conflicts; `1` manual verification notice regarding implicit active `.esl` plugins (`ccBGSSSE037-Curios.esl`, `ccQDRSSE001-SurvivalMode.esl`, `_ResourcePack.esl`).

## 10. Exact Plugin Activation / Load-Order Changes

- **Current `plugins.txt`:** Contains only the default 2-line header comment (`99 bytes`, SHA-256 `f1a2f9ac6966906068474da0df8cd64c6113470858d0f80b1cf3bcebb8e5da25`).
- **Current `loadorder.txt`:** Absent.
- **Current `Skyrim.ccc`:** Unchanged (`1,698 bytes`, SHA-256 `abdbd029c2aaf1c401c7537ae8bd9201258eb68a36f0513253c54d7c0e244a3b`).
- **Derived active plugins (10):**
  1. `Skyrim.esm` (full `0x00`)
  2. `Update.esm` (full `0x01`)
  3. `Dawnguard.esm` (full `0x02`)
  4. `HearthFires.esm` (full `0x03`)
  5. `Dragonborn.esm` (full `0x04`)
  6. `ccBGSSSE001-Fish.esm` (full `0x05`)
  7. `ccBGSSSE037-Curios.esl` (light)
  8. `ccQDRSSE001-SurvivalMode.esl` (light)
  9. `ccBGSSSE025-AdvDSGS.esm` (full `0x06`)
  10. `_ResourcePack.esl` (light)
- **Proposed changes to `plugins.txt` / `loadorder.txt` / `Skyrim.ccc`:** `None`.

## 11. Backup Locations and Verified Available Capacity

- **Existing L1 baseline backups:** `%LOCALAPPDATA%\SkyrimRPLauncher\backups` (untouched).
- **L4-C transaction metadata & backup root (when authorized):** `%LOCALAPPDATA%\SkyrimRPLauncher\managed-installations\<target-sha256>\metadata\transactions\<tx-uuid>\backup\` (outside the Skyrim directory on the independent Launcher storage path).
- **Verified available disk space on target volume:** `60,260,040,704 bytes` (~56.12 GiB free).

## 12. Expected Install and Rollback Behavior

When a valid production Modpack is configured and an exact plan is approved:
1. All direct-file assets are downloaded and SHA-256/size verified in `%LOCALAPPDATA%\SkyrimRPLauncher\managed-installations\<target-sha256>\packages` before any native confirmation dialog.
2. Staged TES4 headers (`.esm`/`.esp`), BSA headers, and PE magic (`MZ` rejection) are verified before apply.
3. Every replaced, removed, or `@config/plugins.txt` file is backed up to `transactions/<id>/backup/<index>.bin`, fsynced, and SHA-256/size verified before any target mutation.
4. Target writes use atomic same-directory temp files + `fs.rename` with immediate pre-write process rechecks (`gameRunning`) and observation identity verification (`dev:ino`, `size`, `sha256`, `mtime`, `ctime`).
5. On any failure or cancellation during apply, `restore()` reverses applied operations in reverse order, rechecking active game processes before each restore/unlink, preserving any externally modified files, and restoring `ownership.json` and `plugins.txt`.

## 13. Risks and Unresolved Uncertainties

1. **Missing Production Trust & Release:** `productionSource.keys` is empty and no stable production Release exists on `kaktv2016/frostveil-distribution`.
2. **Third-Party Redistribution Rights:** Any third-party mod components must have documented redistribution rights in `productionSource.permittedReviews` and manifest `rights` metadata before publication.
3. **Implicit Light Plugins (`Skyrim.ccc`):** Three installed Creation Club / resource `.esl` files are implicitly active in Skyrim SE 1.6.1170.0. Their compatibility with the pinned SkyMP server configuration must be explicitly decided (either verified as benign client-side/ignored by server or handled via an approved compatibility policy).
4. **Windows Authenticode Signing:** Local NSIS installer `SkyrimRPLauncher-0.1.6-x64-local.exe` is `NotSigned` (L2 production code-signing certificate remains pending).

## 14. Whether Safe Real Installation Is Currently Possible

- **NO — BLOCKED (`PRODUCTION MODPACK NOT CONFIGURED`).**
- The L4-C real-installation engine, ownership ledger, transactional `plugins.txt` adapter, rollback, and crash-recovery systems are **IMPLEMENTED** and **REALISTIC SANDBOX VERIFIED** on the Windows filesystem, but real Skyrim writes are rightly blocked until the prerequisites below are supplied.

## 15. Exact Authorization & Configuration Requested from the User

Before a future continuation can execute the first real Skyrim installation, please provide:

1. **Production Publisher Public Key:** An approved Ed25519 production public key (`keyId`, SPKI PEM, fingerprint, and expiration date) to pin in `productionSource.keys` (`environment: 'production'`).
2. **Signed Production Modpack Release:** A published immutable `stable` GitHub Release in `kaktv2016/frostveil-distribution` containing permitted Skyrim mod content (`Data/...`) signed by that production key, with documented component rights.
3. **SkyMP Light-Plugin / Server Profile Decision:** Confirmation of the target SkyMP server's plugin snapshot and whether standard Creation Club `.esl` files present in Steam Skyrim SE 1.6.1170.0 (`ccBGSSSE037-Curios.esl`, `ccQDRSSE001-SurvivalMode.esl`, `_ResourcePack.esl`) are approved as compatible client baseline files.
4. **Plan-Bound Final Approval:** Once items 1–3 produce a concrete `ManagedPlan` with a deterministic 64-hex SHA-256 `planHash`, explicit approval of that exact `planHash` (and in-app native confirmation dialog).
