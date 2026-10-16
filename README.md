# Frostveil Launcher

Windows Electron/React/TypeScript launcher, version **0.1.6**. Current production
release execution and evidence: [release report](FROSTVEIL_PRODUCTION_RELEASE_REPORT.md).
Real-game installation remains a separate owner-approved operation:
[installation readiness](FROSTVEIL_REAL_INSTALL_READY.md).

## Current capabilities

- Steam AppID 489830 discovery, game-folder selection, Skyrim/SKSE resource versions,
  client-file verification, integration backup and Play through the existing SKSE loader.
- Independent Ed25519 Launcher update and Modpack publisher identities. Installer
  asset identity, size, SHA-256/SHA-512 and cached bytes are verified before NSIS
  execution. Downgrade/mutation and installation while Skyrim/SKSE is running are
  blocked. `latest.yml` alone cannot authorize an installer.
- Manifest/runtime/plugin/offline-server verification, anonymous fixed-repository
  GitHub transfers, ownership-aware plans, journals, backups, rollback and recovery.
- Real Modpack writes require a fresh Main-owned plan, compatible preflight and
  explicit native confirmation of its hash. Renderer input cannot select publishers,
  arbitrary roots or bypass confirmation.

The original production keys are pinned after encrypted offline backup recovery
verification. Publication and player acceptance are still in progress; use the
release report for actual published URLs/IDs rather than candidate files. The first
approved pack contains three first-party metadata/reference files only. Bethesda,
SKSE and SkyMP files remain external verification requirements, not redistributed
payloads. Nexus/third-party mod integration is not included.

## Development and verification

Node **24.11.1** was used. Dependencies are pinned in `package-lock.json`.

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
npm run package:nsis
node scripts/verify-artifacts.mjs
node scripts/verify-l3-artifacts.mjs
node scripts/verify-l4a-artifacts.mjs
node scripts/verify-l4b-artifacts.mjs
node scripts/verify-l4c-artifacts.mjs
```

The full suite builds/executes disposable Windows NSIS installers and launches an
isolated installed Electron application to test its update/restart. It also exercises
inert Skyrim-shaped fixtures and interrupted own-child recovery. It does not launch
Skyrim or change the real game/server. Do not package concurrently with the full
suite because the NSIS regression rebuilds `dist/`.

`npm start` opens the development application. Smoke uses generated fixtures and
blocks real game launch. To smoke the unpacked build:

```powershell
$env:LAUNCHER_SMOKE_EXE=(Resolve-Path 'release/win-unpacked/Skyrim RP Launcher.exe').Path
npm run smoke
Remove-Item Env:LAUNCHER_SMOKE_EXE
```

Builds use `--publish never`; CI repository permissions are read-only. Production
publication is an explicit reviewed operation. Candidate/signing scripts are offline
engineering tools; placeholder IDs must never become final release bindings.

## Runtime and storage

Local baseline: Skyrim Steam **1.6.1170.0**, SKSE release **2.2.6** (file version
**0.2.2.6**). `assets/local-baseline.json` deliberately contains no machine-specific
client hashes. An existing reviewed profile at
`%LOCALAPPDATA%/SkyrimRPLauncher/compatibility-profile.json` supplies the client
baseline; absent evidence blocks Play. A production pack manifest does not silently
replace this L1 profile. First-player baseline provisioning still needs review.

App ID `dev.skyrimrp.launcher`, product/executable `Skyrim RP Launcher` and existing
`%LOCALAPPDATA%/SkyrimRPLauncher` storage are preserved. Integration backups are not
full game/save backups. Private profiles/keys, downloaded bytes, ownership data,
journals and game assets are excluded from published source/packages.

## Acceptance limits

The owner previously verified Play opens Skyrim and connects to the local server.
Production pack installation and in-game acceptance remain pending. File integrity,
offline snapshot match and actual live compatibility are separate findings. Active
Creation Club light-plugin compatibility remains **UNVERIFIED**; activation is preserved.

Installed Launcher **0.1.4** needs one manual bootstrap to 0.1.6. The first release
does not prove a public 0.1.6 → 0.1.7 update; that requires a separately approved
later release. The installer lacks Authenticode; first installation may require
manual Windows confirmation. Subsequent update trust uses Ed25519 signatures and
exact installer bytes.

Earlier context: [L1](L1.md), [L2](L2.md), [L3](L3.md), [L4-A](L4A_REPORT.md),
[L4-B](L4B_REPORT.md), [L4-C](L4C_REPORT.md).
