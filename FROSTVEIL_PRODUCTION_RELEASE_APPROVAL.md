# FROSTVEIL — Production Release Approval

Original approval proposal. The owner subsequently approved A–D in the FIRST
PRODUCTION RELEASE brief on 2026-10-16. E remains separate. Consult
`FROSTVEIL_PRODUCTION_RELEASE_REPORT.md` for executed operations and current status;
the sections below retain the original approved scope.

## Approval A — Pin production identities

| Channel | keyId | SPKI SHA-256 (full) |
|---|---|---|
| Launcher update | `frostveil-launcher-update-20261016` | `44b402b99394515908c10c72d2e6e77ad210a1b36248e5bafe991b59183b0fea` |
| Modpack publisher | `frostveil-modpack-publisher-20261016` | `7eded189b364ffc31c5c9730c7b73c0b13424b60576313a0197a6327b5633369` |

Action if approved: add the Launcher public key to `productionLauncherUpdateSource.keys` and the Modpack public key to `productionSource.keys` (environment `production`, expiry 2027-10-16), update the L4-B/L4-C audit scripts to expect exactly these fingerprints, rebuild, re-run all tests and audits.

Owner should first make an **offline backup** of both private keys.

## Approval B — Commit & push Launcher source

Commit the current local 0.1.6 source to `kaktv2016/frostveil-launcher` after reviewing the diff. Private keys and `.local/` are excluded.

## Approval C — Publish Launcher Release `v0.1.6`

Assets: `SkyrimRPLauncher-0.1.6-x64-local.exe`, `.blockmap`, `latest.yml`, `frostveil-launcher-update.json` (re-signed after the Approval A rebuild, since installer bytes change).

Note: players on **0.1.4** do not have the Ed25519 updater and must install 0.1.6 manually once. Updates from 0.1.6 onward are automatic.

## Approval D — Publish Modpack Release `pack-v1.0.0`

Repository `kaktv2016/frostveil-distribution`, stable, not prerelease. Assets: the 3 first-party files + `frostveil-manifest.json`. After upload, asset IDs must match the signed manifest; if GitHub assigns different IDs, re-sign with the real IDs before making the release public.

## Approval E — First real Skyrim write (separate)

Only after A–D: run Install from the Launcher on the owner's real Skyrim, review the native confirmation dialog, then perform in-game acceptance on the SkyMP server. Rollback is available from the Launcher.

## Not requested

Authenticode purchase, L5, or third-party mod redistribution.
