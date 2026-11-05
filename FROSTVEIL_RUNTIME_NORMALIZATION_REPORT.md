# Frostveil — Steam runtime normalization and Anniversary Edition isolation

Status: implementation, real isolated transaction, UI, packaged artifact and release gates passed. Publication pending final delivery.

## Design and implementation

- Steam Windows / English, runtime `1.6.1170.0`, normal server `7777`; same game directory, persistent RP profile.
- `src/main/runtime/` adds a production-Ed25519-authenticated cohort, verified Steam selection/depot generation, pinned SteamRE DepotDownloader 3.4.0 acquisition, creation/native-input audit, HMAC metadata/lease-backed content-addressed transaction, and Play orchestration.
- `src/main/installer/managed-target.ts` adds a narrowly scoped pre-L1 bootstrap entry accepting only a verified Steam selection. Existing mod-content authorization is unchanged.
- Main/preload/renderer add inspect, prepare, cancel, restore and ephemeral QR progress; renderer cannot supply paths, manifests, helper commands or URLs. Play prepares the runtime before the existing signed graphics/client/modpack steps and verifies the complete expected cohort before SKSE.
- Paid/extra Creation plugin/archive files are backed up and quarantined, not discarded. The five acquired free Creation/resource plugins are retained. `Skyrim.ccc`, plugins/loadorder, native proxies/configuration, unknown loose inputs and INI archive overrides are audited. Newer `SkyrimReservedAddOnIndexes.txt` is preserved in the journal and removed from the active 1170 profile.
- Immutable modpack after-images and canonical configuration templates come from the real cold R2 fixture. Before modpack installation, originals are snapshotted; added files can be removed on Restore. Conflict checks protect subsequent external edits. Known generated CS shader/UI outputs remain owner data.
- A changed, verified Steam InstalledDepots fingerprint permits a new normalization generation for Steam-owned paths only. Prior journals are retained in authenticated bounded history (8 generations); modified modpack/config files still block. Restore returns the latest pre-normalization runtime; older overridden preimages remain preserved.
- Native code, installed player files, server JS, world/player/economy data and NPC test profile are not modified by this development/test workflow. No Bethesda game bytes are uploaded to R2.

## Actual Steam acquisition evidence

Owned staging: `D:\FrostveilRuntimeAcquisition-20261106`.

| Depot | Manifest | Result |
|---|---|---|
| 489831 | 8442952117333549665 | authenticated download passed |
| 489832 | 8042843504692938467 | first attempt 401 after connection/authentication failure; one fresh authenticated retry passed |
| 489833 | 1914580699073641964 | authenticated download passed; actual EXE FileVersion 1.6.1170.0 |

44 files, 16,095,728,705 bytes. Receipt SHA-256 `30e627934c5b49cf320a31d342464187d6ad5ee4b3d42856509e1053e762e345`.

Reviewed upstream helper:
- ZIP: 33,474,005 bytes, SHA-256 `41c9e9f0df54b3ad02e67a11726756e5c73283bd7c2e1b04acfa5ae4c2ed3767`.
- EXE: 78,840,739 bytes, SHA-256 `6281279efce8f1e20db9532a58e42382f81afb9e3827a8b965ffcb43fbe4531f`.

No passwords, Steam Guard codes, account identifiers or QR payloads are included in this report or public metadata.

## Verification so far

- Focused regression: 22/22 (latest source). Six additional publication rollback tests passed (exact prior bytes, delete only own new object, already-restored idempotency, concurrent-publisher preservation, verification mismatch and network failure).
- Final full regression: **519/519**, zero failures/skips, 206.870 seconds. Earlier snapshots: 503/503 and 512/512. Real isolated Windows NSIS install/update/handoff included; build 1.098s, package phases 60.490s/54.109s, install 9.466s, handoff 4.199s, updated window 17.401s. No timeout increase or skipped handoff.
- Typecheck/build/Electron smoke passed. Real Electron UI/CSP verified crisp SVG QR, QR removal and Restore state. Packaged ASAR: all 35 dist/assets members compared byte-for-byte, signed cohort authenticated, no private artifacts. ASAR SHA-256 `ea74b8701fa33d9f8ebbb21528b9bb8a4753a500d4ac9142489706ec5a20f2a1`. Runtime source digest `e76a6aa220a4110246d2b4381e737063648e81165024918a5896d8bcb428dd9b` remained unchanged across the final release gates.
- Real cold Steam-to-R2 bootstrap passed: 7,390 managed files, final installation scan READY, 670.959 seconds, no player installation writes or Skyrim launch.
- Real isolated normalization from actual `1.7.104.0` bytes to `1.6.1170.0` passed, including real signed R2 installers, final scan READY, warm preparation zero writes/downloads, reopening metadata and restoring originals. 45 installed owner inputs rehashed unchanged; 967.823 seconds. Paid Creation bytes in this fixture are deliberately inert; this does not prove paid-AE gameplay.
- Measured changed cohort for 1.7.104: 31 files; original backup 14,415,197,070 bytes, target runtime payload 14,418,394,516 bytes. Most of these are large changed vanilla archives, not a second full game installation. Additional staging/download space is required before commit.
- Independent reviewer found an incomplete root native-input audit (.asi/proxy config); fixed and regression-covered. Reviewer also advised explicit Steam generation history; implemented and tested.


### Redirected authentication and first-install interaction

The pinned Windows helper emits replacement `?` characters for QR full blocks when stdout is redirected. The initial parser therefore withheld its QR while Steam awaited approval. The fix accepts that bounded pattern only following the helper's explicit QR prompt, preserves module positions, and forwards only normalized QR blocks; UTF-8 streaming also uses StringDecoder. The UI renders modules as crisp SVG instead of font glyphs. The owner scanned the decoded challenge, and the **production acquisition adapter** downloaded and verified the real EXE in an isolated cache. The private temporary preview was removed and transient authentication buffers cleared.

The installed 3.4.0 source proves that `-depot` and `-manifest` accept aligned lists in one `DownloadAppAsync` session, and `-dir` gives a shared output folder. The final adapter batches missing depots into one helper invocation without `-remember-password`; focused command-shape tests and cache migration using three real Steam files passed. A fresh three-depot batch through the released GUI remains owner acceptance; the three actual full downloads and owner-confirmed redirected login were independently exercised. Steam disconnect/expiry may still require a refreshed challenge. Already-correct files/staged hashes do not require Steam authentication. Verified redundant raw download copies are removed after staging; original backups and reusable target bytes are retained.

Primary references: [SteamRE 3.4.0 Program.cs](https://github.com/SteamRE/DepotDownloader/blob/DepotDownloader_3.4.0/DepotDownloader/Program.cs), [ContentDownloader.cs](https://github.com/SteamRE/DepotDownloader/blob/DepotDownloader_3.4.0/DepotDownloader/ContentDownloader.cs), [Community Shaders shader cache](https://github.com/community-shaders/skyrim-community-shaders/blob/main/src/ShaderCache.cpp).

## Release / recovery

Launcher version: `0.1.27`; development branch `dev/steam-runtime-normalization` in the authorized owner Launcher repository. Not published yet.

Evidence is retained privately under `.local/runtime-normalization/`: acquisition receipts, bootstrap/transaction results and pointers, signed candidate, gate logs. Fixture roots are marked and must only be removed after verifying their resolved paths and markers. Keep known-good 0.1.26 artifacts and the existing modpack available for rollback. Production game data is outside these fixtures. The existing Windows Authenticode status is `NotSigned`; the unchanged owner-approved updater trust is the production Ed25519 release manifest, not a newly introduced certificate bypass.

The runtime cohort uses the existing production publisher identity and a maximum seven-day validity. Its mutable R2 metadata endpoint must be renewed through the signed publisher workflow before expiry; neither signature nor expiry checks may be disabled. Existing signed modpack 1.0.9 has its own independent expiry.

## Owner acceptance (pending)

1. Use Steam Skyrim Windows/English with only the normal player profile; close Skyrim/SKSE and let Steam finish installing/updating.
2. Update Launcher to the released version, select the Steam game folder and press Play. Review displayed disk requirements; approve Steam Guard on the phone if requested.
3. Confirm target runtime, enter 7777, walk/open chat, inspect compass/map and complete an ordinary Courier path.
4. Exit and Play again: check no repeated asset download/backup and that shader-cache/user-setting outputs do not cause false corruption errors.
5. Test a legitimate paid-AE installation separately: only server-compatible baseline content should be active, and extra content must remain recoverable.
6. Close Skyrim, inspect and use Restore. Verify original runtime/plugin files and owned extra content return. External modifications must produce a conflict, not be overwritten.

GOG/Epic/Game Pass, arbitrary unknown external mods, future unverified content layouts, and in-game success are not certified. No game GUI has been launched by these tests.
