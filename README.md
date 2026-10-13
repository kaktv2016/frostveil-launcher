# Skyrim RP Launcher — L1

Current work: [Frostveil L2 self-update/source repository](L2.md), version0.1.1. L1 sections below preserve foundation context; L2 implements launcher update state/IPC/UI but real download/install is signing-gated. Modpack updates remain future work.

Standalone Windows Electron/React/TypeScript/Vite/Tailwind app. Game integration is read-only: detects the existing Steam AppID489830 installation (registry + multiple libraryfolders + appmanifest), supports native folder selection, checks real version resources and a local hash baseline, creates bounded integration backups, and launches only the existing SKSE loader after the user clicks Play.

## Local workflow

Node24.11.1 was used; dependencies are pinned in package-lock.json. No global installs or Git client required for end users.

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm start
npm run package:dir
npm run package:nsis
npm run smoke
```

`test` uses inert temporary files and injected versions/process adapters. `smoke` launches only Electron against generated fixtures and explicitly blocks real game launch. To smoke the packaged app:

```powershell
$env:LAUNCHER_SMOKE_EXE=(Resolve-Path 'release/win-unpacked/Skyrim RP Launcher.exe').Path
npm run smoke
Remove-Item Env:LAUNCHER_SMOKE_EXE
```

No lint configuration is installed; strict TypeScript and focused tests are the configured gates. No SkyMP engine build, game repair, installer execution, server restart, commit, remote creation or publication is part of this workflow.

## Compatibility evidence

The public `assets/local-baseline.json` pins Skyrim Steam1.6.1170.0 and SKSE file version0.2.2.6 (release2.2.6) but intentionally has no machine-specific client hashes. The developer's existing 24-file baseline is preserved in `%LOCALAPPDATA%/SkyrimRPLauncher/compatibility-profile.json` and ignored `.local/`, not uploaded. Main loads the private profile when present; absent client evidence blocks Play. Evidence is the user's solo-tested local client, **not an invented upstream SkyMP version**. Native components include SkyrimPlatform.dll, MpClientPlugin.dll and SkyrimPlatformImpl.dll with their required dependencies/address database/client JS/config/UI. Public distribution client profiles require separate verification in a future phase.

Every file is classified LOCAL BASELINE MATCH / MISSING / DIFFERENT / UNVERIFIED. Unknown versions or modified same-version executables block Play. Baseline configuration changes are intentional source changes requiring review/rebuild, not an automatic “trust current files” button. Exact build versions for unversioned DLLs remain unverified even when their baseline hashes match.

READY means local compatibility only; server connection remains NOT TESTED. Play revalidates, checks SkyrimSE and SKSE processes, uses a fixed loader with no shell/renderer arguments, serializes operations, and observes early startup failures. A 15-second startup guard covers the loader-to-game handoff; after that, existing game/loader detection prevents duplicates. Process creation is not proof of in-game loading or multiplayer connection.

## Files and privileges

- `src/main/{discovery,installation,windows,files}.ts`: registry/VDF, PE versions, path/hash checks and OS adapters.
- `src/main/{backup,launch,authorization,session-state,index}.ts`: bounded backup, fixed Play, sender/input validation, per-installation UI state and Electron lifecycle.
- `src/shared/contracts.ts`, `src/main/updates.ts`: typed IPC and disabled future update contracts/fixture validation.
- `src/preload/index.ts`: only status/scan/choose/channel/backup/play; no raw Node, shell, filesystem or IPC exposed.
- `src/renderer/`: locally bundled original CSS/SVG interface, English/Thai text; dashboard/settings/updates/diagnostics.
- `.github/workflows/windows.yml`: lockfile Windows checks/package/smoke; no publish step. CI itself is not yet run on GitHub.

Sandbox/context isolation on; Node integration off; strict CSP/custom local protocol, navigation/popups/webview/permissions blocked. Launcher settings/logs live under `%LOCALAPPDATA%/SkyrimRPLauncher`; diagnostics are bounded to60 entries. No credentials are read into renderer or embedded.

## Backups

UI action creates a unique verified backup under `%LOCALAPPDATA%/SkyrimRPLauncher/backups/`. Exact allowlist: SkyrimPlatform.ini, skymp5-client.js, skymp5-client-settings.txt and rp-chat/index.html at their existing relative paths. Max32 files and32MiB total; links/junctions, redirected parents and unsafe paths are rejected. Original SHA/size, installation path/identifier, timestamp and copy SHA are recorded; source changes during copying fail verification. Missing files are listed as skipped; an empty backup is a diagnostic snapshot, not a full Skyrim backup. Failed/partial backups remain marked FAILED and are never overwritten. Selecting another installation clears the previous backup status.

No automatic restore or modification is implemented. L2 must require a verified backup tied to the exact affected installation/file and current original hash before changing any managed existing file; staged downloads and a separate journal/rollback design remain future work.

## Update and distribution gates

Launcher self-update: planned electron-updater/public GitHub Releases, separate semver and stable/beta preferences. Owner/repository are null; no updater is instantiated or contacted. Modpack update: separate versioned manifest with compatibility, hashes/sizes, component ownership and permission metadata. L1 parses only synthetic fixtures. Untrusted metadata is not proof of redistribution rights or authenticity, and no downloads/installation/deletion/apply methods exist.

L2 trust model: verify Ed25519 signed payload before parsing/planning; pinned key-ID→public-key map, overlapping trusted keys for rotation, retire compromised keys through authenticated launcher releases. Windows Authenticode publisher validation, updater manifest authenticity and modpack signatures are distinct controls. Hashes alone authenticate none of these. Release metadata conventions must match the pinned builder/updater versions; builder26 docs differ from v27 signed-manifest requirements.

Local `--publish never` build is explicitly unsigned/not a production release. `electron-builder.production.example.json` is a nonfunctional template with forceCodeSigning=true and required placeholders. Missing publisher/signing credentials, manifest signing keys, GitHub owner/repos and distribution permissions block production readiness but do not block local L1. No verification switch is disabled to make packaging pass. No auto-update compatibility claim until a later installed-build update test.

References checked: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [Vite requirements](https://vite.dev/guide/), [builder26 updates](https://www.electron.build/v26/docs/features/auto-update/), [Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win/), [signed manifest changes](https://www.electron.build/docs/migration/v27-breaking-changes/).

## Manual acceptance

2026-10-14: user confirmed **Play opens the real game and connects to the existing server successfully**. Installer installation and the other individual manual checks below are not separately confirmed; auto-updates remain disabled.

Open the unpacked launcher or install the **local unsigned** NSIS package yourself. Confirm detected path/runtime/SKSE/client status, re-scan, native folder selection, baseline backup, and channel preferences. With Skyrim closed, click Play once; the user has verified this opens the game and joins the server. Click again while running and verify refusal. Installer installation and remaining checks still require confirmation. The launcher does not automate menus or configure the server.
