# FROSTVEIL — Player Update & Modpack Delivery Report

Launcher version: **0.1.6** · Report date: 2026-10-16

Historical preparation snapshot. Subsequent key activation, fixes, publication and
current verification evidence are recorded in `FROSTVEIL_PRODUCTION_RELEASE_REPORT.md`.

## 1. Outcome

| Capability | Status |
|---|---|
| Ed25519-signed Launcher auto-update without Authenticode | **Implemented & tested** |
| Real NSIS upgrade 0.1.5 → 0.1.6 (isolated, settings/ownership preserved) | **Verified** |
| Separate Ed25519 Modpack channel (L3 manifest + L4-B download + L4-C install) | **Implemented & tested** |
| Player UI: Launcher Update + Server Modpack status/controls | **Implemented** |
| Candidate production identities (2, distinct) | **Generated, stored outside repos, NOT pinned** |
| First Server Modpack candidate `pack-v1.0.0` | **Prepared locally, NOT published** |
| Real Skyrim writes | **NOT performed** (not authorized) |
| GitHub publication | **NOT performed** (not authorized) |

## 2. Launcher Update Channel (`kaktv2016/frostveil-launcher`)

- Release asset `frostveil-launcher-update.json` = Ed25519 envelope over a canonical manifest binding: `keyId`, owner/repo, tag, version, channel `stable`, `minimumLauncherVersion`, installer asset id/name/size/SHA-512/SHA-256, expiry.
- `latest.yml` is never trusted alone; it is used only after the signed manifest matches it.
- Pinned verification key lives in `productionLauncherUpdateSource` (currently `keys: {}` → updater reports **not configured** until the owner approves).
- Download through pinned `electron-updater 6.8.9` (no major upgrade). Before handoff, `prepareVerifiedInstallHandoff` re-hashes the cached installer, checks PE header and file identity (TOCTOU protection).
- Install blocked while Skyrim/SKSE is running; explicit Install/Restart/Defer; failure returns to a retryable verified state; manual reinstall remains a fallback.

Security tests (`tests/launcher-update-security.test.ts`) — all pass: valid accept; unsigned `latest.yml` reject; tampered payload; bad signature; unknown/revoked/expired key; wrong repo/tag/draft/prerelease; downgrade; same-version mutation; `minimumLauncherVersion`; SHA-512/SHA-256/size mismatch; non-PE; TOCTOU replacement; unapproved redirect host; running game blocks install.

Real NSIS test (`tests/real-nsis-update.test.ts`): builds disposable 0.1.5 and signed 0.1.6 NSIS installers, installs into an isolated temp directory, upgrades silently, verifies version, and confirms `settings.json` + `ownership.json` preserved. The user's installed **Skyrim RP Launcher 0.1.4** was not touched.

## 3. Server Modpack Channel (`kaktv2016/frostveil-distribution`)

Reuses existing services only: L3 Manifest V1 + Ed25519 (`authenticateRelease`), L4-B `GitHubDistributionProvider` / `PackageDownloader`, L4-C `ManagementService` planner/activation, L4-A journal/backup/rollback.

Change made this milestone: `SandboxInstaller` now authenticates real-target releases against the **same** `DistributionSource` the `ManagementService` was constructed with (`InstallerOptions.distributionSource`, default `productionSource`). Previously plan and apply could disagree on trust roots; behaviour in shipped builds is unchanged.

Modpack tests (`tests/modpack-delivery.test.ts`) — all pass:

1–5. Valid manifest accepted; tampered, wrong key, Launcher key used for Modpack (cross-channel), and expired Level B test key rejected.
6. Corrupt download rejected with SHA-256 mismatch before any game write.
7. Install into disposable Skyrim-shaped directory.
8. Update replaces owned files and removes obsolete owned files.
9. Missing managed file repaired.
10. User-modified managed file → conflict, apply refused.
11–12. Unmanaged user mod and official/SKSE/SkyMP files byte-identical.
13. Rollback restores exact previous version (including removed file).

## 4. Candidate Identities

| Purpose | keyId | SPKI SHA-256 | Expires |
|---|---|---|---|
| Launcher update | `frostveil-launcher-update-20261016` | `44b402b9…183b0fea` | 2027-10-16 |
| Modpack publisher | `frostveil-modpack-publisher-20261016` | `7eded189…5b633369` | 2027-10-16 |

Private keys are stored in the owner's user profile signing directory (outside every repository and build output) with ACL limited to SYSTEM + current user. Neither key is in shipped code.

## 5. Candidate Artifacts (local, `.local/production-candidates/`)

- `launcher-v0.1.6/frostveil-launcher-update.json` — signed for `SkyrimRPLauncher-0.1.6-x64-local.exe` (size 112,343,723; SHA-256 `1b83b5fb…b0c686c1`; manifestHash `e3ec7e67…a37b7d7`).
- `modpack-pack-v1.0.0/` — 32 manifest files: 29 external-only (Bethesda, SKSE, SkyMP runtime — verified, never redistributed), 3 first-party distributable (`Data/Frostveil/settings.json`, `Data/Frostveil/readme.txt`, `Data/Interface/Frostveil/hud-reference.html`), 0 third-party redistributed. manifestHash `b044be16…9675b3c0`. Server gamemode script classified server-only.

## 6. Verification Summary

| Check | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | **392 / 392 pass** |
| `npm run package:nsis` | Pass |
| Source smoke / packaged smoke | Pass / Pass |
| verify-artifacts, L3, L4-A, L4-B, L4-C audits | All pass (no private keys, tokens, personal paths, or unapproved trust in package) |
| Protected baseline files | 53 checked, 0 changed |
| Game tree guard | 710 game entries, 3 save entries, unchanged |
| Installed Launcher 0.1.4 | Untouched |

## 7. Remaining Limitations

- Installer is still not Authenticode-signed; Windows SmartScreen will warn on **first** install. Subsequent updates are authenticated by Ed25519.
- Live SkyMP server compatibility and in-game acceptance remain **unverified**.
- Creation Club light-plugin compatibility notice remains open.
- Recent local source changes are not yet committed/pushed.
- Production keys not pinned; no stable Release published. See `FROSTVEIL_PRODUCTION_RELEASE_APPROVAL.md`.
