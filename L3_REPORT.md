# Frostveil L3 report — 2026-10-14 Asia/Bangkok

Version **0.1.2**, local development build. **L3 implemented and locally verified; production readiness is not claimed.**

| Evidence level | Result |
|---|---|
| IMPLEMENTED | Strict extended PackManifest V1; Ed25519 signed bundle validation; local development profile; whitelist offline SkyMP export; scoped streamed/cancellable scans; TES4/master/activation/order checks; structured compatibility and read-only future plan; typed IPC and Updates UI. |
| AUTOMATED TESTED | **105/105 passed**, zero failed/skipped: existing 49 L1/L2 regression cases plus 56 L3 cases. TypeScript passed. Main/preload/React build passed. Independent core review and its own 105-test/typecheck run found no remaining critical/important findings. |
| AUTOMATED UI TESTED | Source and final packaged Electron fixture smoke passed: L1 detection/backup/Play refusal in fixture, L2 check/progress/defer/signing refusal, L3 not-configured and complete offline match, progress/cancel while IPC mutation lock is held, narrow API/security preferences, Thai text and no renderer errors. Actual Skyrim/Steam/SKSE were never launched by these tests. |
| REAL LOCAL SCAN VERIFIED | Skyrim **1.6.1170.0**, SKSE resources **0.2.2.6** (= release 2.2.6); L1 READY. Explicit local development requirements: **29/29 hashes verified**, consisting of the 24 local client/runtime/config reference files plus five server-required Steam masters. Existing SkyMP manifest order/size/CRC and fresh hashes validated for those five masters. Native client identity is backed by required hashes at exact loader locations. |
| SERVER PROFILE COMPARISON | **Compatible with offline local development snapshot**, trust **LOCAL DEVELOPMENT ONLY**, mandatory pack enforcement OFF. Known official masters' header/master dependencies and configuration-derived full-index prefix passed. This local reference is not an authenticated server release. Snapshot expires in seven days. |
| LIVE SERVER VERIFIED | **No.** No live endpoint or runtime-version measurement was added; actual loaded game plugin order and current remote server state remain UNVERIFIED. The server was not started/restarted for L3. |
| PROTECTED FILES | Before/after SHA256 check of **53 protected paths: zero changes**, including local baseline, master/archive inputs, Skyrim.ccc, activation/order files (including absent loadorder.txt), server settings/generated manifest and existing world files. No game/mod installs/downloads, world writes or load-order edits. |
| BUILD/PACKAGE | NSIS packaging and metadata/privacy checks passed. `release/SkyrimRPLauncher-0.1.2-x64-local.exe` (112,228,603 bytes), **Authenticode NotSigned**; `release/win-unpacked/Skyrim RP Launcher.exe`. Installer execution/overwrite installation is not automated or verified. |
| PUBLICATION | No L3 commit, push, tag, Release or distribution repository. Current Windows CI discovers L3 tests and adds package privacy verification; it has not run remotely on uncommitted L3 source. Private local profiles/hashes/evidence are excluded from source and app.asar. |
| BLOCKED | Real production modpack trust/source/rights and L2 production Windows signing remain unconfigured. Remote transport/signatures are fixture-tested, not a real published modpack test. No L4 work. |

Reuse: L1 discovery/version/baseline/files/backup/launch and existing V1 names; L2 secure IPC/preload/window/update service; existing SkyMP manifest/config as read-only inputs. Details and upstream source evidence: [L3.md](L3.md).

Schema choices: multi-file components and dependency DAG; separate native/shared/client-only/runtime/visual/owned/permitted/external roles; exact keys, semver/resource versions, hashes/sizes, Windows path/case collision checks; explicit client native-file identity; profile/pack version binding and fresh snapshot; separate publisher signatures versus file integrity. No arbitrary renderer paths, URLs, keys or enforcement overrides.

Plugin coverage: ESM/ESP headers/MAST, enabled markers, known implicit masters, physically present Skyrim.ccc entries, corroborated configuration order, required full-index prefix and client-only extras. Required server ESL/light ESP stays UNVERIFIED on pinned SkyMP. MO2/usvfs/Vortex detection is partial; managed/ambiguous/unreadable views stay UNVERIFIED. Installed files alone are not activation evidence. Current real plugins.txt is comment-only; no loadorder.txt exists, so the verified required prefix derives from known implicit masters and direct SKSE configuration, not a running game's query.

Modified files: `src/main/modpack/`, `src/shared/{contracts,modpack-contracts}.ts`, main/preload integration, `ModpackPanel.tsx`/renderer styling, existing manifest facade, tests/fixtures, test/smoke/offline-export/package-audit scripts, package version and lock metadata, README/L3 docs/plan and Windows CI. The L2 fixture offer advances to synthetic 0.1.3 so it remains newer than local 0.1.2. Dependencies and installer/application/user-data identities are unchanged. SkyMP branch develop and its existing changes were preserved.

Private evidence: ignored `.local/l3-real-scan.json`, protected before/after snapshots, explicit requirements/offline export, `.local/modpack.png` and smoke report. The developer profile is stored in the existing launcher-private data directory, outside game/source. It is not packaged or public. Some malformed/cancel/version/signature tests use synthetic adapters; no real protected inputs were mutated.

## Manual acceptance

1. Close the old launcher; install local **0.1.2** to the same installation folder, or run the unpacked EXE. Confirm the version, retained game path and L1 READY. Manual overwrite is still to be confirmed.
2. Updates → **Scan Modpack**. Expect local pack/server version `0.0.0-local`, 29 verified files, five verified required masters, **LOCAL DEVELOPMENT ONLY**, **OFFLINE SNAPSHOT MATCH** and **LIVE SERVER … UNVERIFIED**.
3. Open file/plugin/component/future-plan details. Thai text should render. No working modpack install/update button. Current profile needs no file action.
4. Scan again and Cancel while progress is visible; expect cancelled/Unverified, then a fresh scan should recover. A fast scan may finish before Cancel is clicked.
5. Play through the existing SKSE path and manually join the existing server. Confirm the usual character/inventory/UI behavior. L3 has not re-tested real gameplay automatically.
6. Close/reopen the launcher; verify path/settings remain. A launcher-update check may return a recoverable missing-release/signing message; do not expect production auto-update to work yet.

Do not delete/alter real game files to test errors. Malformed/missing/tampered cases have automated temporary fixtures. L4 prerequisites: approved immutable release source, reviewed pinned Ed25519 publisher keys/rotation, explicit redistribution permissions and controlled file ownership/install/rollback design. L2 signing remains a separate prerequisite for launcher self-install.

## Installed-launcher follow-up — 2026-10-14

User installed 0.1.2 but Scan Modpack remained Not Configured and installed L1 readiness logs failed. Installed app.asar main matches the tested build. Investigation found Windows MSIX AppData virtualization: profiles prepared by the Codex-hosted process were in its package LocalCache, while the shortcut-launched installed app uses ordinary AppData. The earlier real scan confirms game content in the developer process, not successful profile provisioning to the installed launcher. No source fix or security bypass is indicated. A private recovery script copies the two validated launcher profiles from staging to the ordinary user-data directory, backs up existing profiles and verifies copy hashes. It must run from an ordinary Windows PowerShell outside Codex. Installed Scan/Play acceptance remains pending that provisioning and user retest. Diagnostic probe launch errors were agent-caused; those temporary probe processes were stopped. No game/server files changed.
