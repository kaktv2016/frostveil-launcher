# Frostveil first production release — execution report

Date: 2026-10-16. Status: **IN PROGRESS — PRODUCTION KEYS PINNED; FINAL VALIDATION/PUBLICATION PENDING**.

The owner's FIRST PRODUCTION RELEASE brief explicitly authorizes A–D. Approval E
(real Skyrim writes) is excluded. This is an interim evidence record, not a claim
that the production release is complete. No replacement identities were generated.

## Production identities

| Channel | Approved key ID | Public SPKI SHA-256 | Expiry UTC |
|---|---|---|---|
| Launcher | `frostveil-launcher-update-20261016` | `44b402b99394515908c10c72d2e6e77ad210a1b36248e5bafe991b59183b0fea` | 2027-10-16T00:00:00.000Z |
| Modpack | `frostveil-modpack-publisher-20261016` | `7eded189b364ffc31c5c9730c7b73c0b13424b60576313a0197a6327b5633369` | 2027-10-16T00:00:00.000Z |

Fresh local verification at 2026-10-16T06:37:30.551Z:

- Both existing private keys derive the exact approved public fingerprints and
  match the original public candidate identities.
- Independent random-challenge signing/verification passed for both Ed25519 keys.
- Neither identity is marked revoked in the approved local identity record;
  both expiries remain in the future. This is local configured revocation state,
  not a claim about a separate external revocation service.
- Signing directory inheritance is disabled. Directory/file ACL allow entries
  are restricted to SYSTEM and the current Windows user.
- Private keys remain outside the repositories. Verification output contains
  public identity metadata only.
- **Offline backup: VERIFIED. PRODUCTION KEYS PINNED.**

The brief's section 4 says: “Before production activation or publication, verify
that both production private keys have a usable secure offline backup.” The owner
confirmed no offline backup initially existed, then selected removable USB drive D:
and explicitly requested a local password dialog for an encrypted backup. The drive
is USB/FAT32, so its filesystem cannot enforce NTFS ACLs; encrypted backup bytes
will protect the offline copy while the live signing keys retain restrictive ACLs.
The encrypted backup was written to USB and reread at 2026-10-16T07:08:11.997Z;
both recovered keys passed public-fingerprint checks and fresh signing challenges.
The owner then confirmed USB detachment and separate password storage; drive D:
was independently observed absent before public-key activation.
Encrypted backup: AES-256-GCM, scrypt N=131072/r=8/p=1, 1,492 bytes, SHA-256
`fd2e83dc470c968ee0ae1d25b6cd73537755f9973d32e9a24a4030de49949d3b`.
Only encrypted key material and public recovery documentation were written to USB.
No backup password or plaintext private key was persisted in the workspace/logs.
A same-drive copy is insufficient. This gate applies before pinning
or publication; A–D authorization itself does not need to be requested again.

### Backup recovery and rotation procedure

1. The owner stores both private keys on secure offline media outside repositories,
   build outputs and cloud/shared folders. Protect the media with encryption or
   equivalent restricted physical access; keep its unlock secret outside chat/logs.
2. Temporarily attach/unlock that media locally. Verify the recovered files derive
   the exact fingerprints above and can sign a fresh random challenge. Check that
   the backup is not merely another directory on the live signing drive. Record
   only public fingerprints, verification time, medium description and results.
3. The owner detaches the media and confirms offline storage. Do not put restored
   private bytes into the workspace or attach them to a message.
4. On a signing-machine loss, restore into a protected signing directory outside
   repositories, restrict ACL to the owner/SYSTEM and repeat fingerprint/challenge
   verification before signing. Compare against the public pins independently.
5. Rotation requires separately approved new identities, expiry/revocation updates,
   audited source, tests and a new Launcher release. Preserve channel separation.
   If compromise is suspected, stop affected publication and revoke the old key
   in trusted configuration. Do not rely on an update signed solely by a compromised
   key for recovery; use a separately verified manual bootstrap where necessary.

## Current repositories and publication state

GitHub authentication was verified as `kaktv2016`. Both repositories are public,
default branch `main`, with push/maintain/admin permission available.

| Repository | Current local/remote main | Target release | Observed state |
|---|---|---|---|
| [Launcher](https://github.com/kaktv2016/frostveil-launcher) | `5eb2cf773deaaa47b460b17e02926913d856a90b` | `v0.1.6` | No release or target tag found |
| [Distribution](https://github.com/kaktv2016/frostveil-distribution) | `1c223f11fcdf59529efa3f5800f6c0f7505a87c9` | `pack-v1.0.0` | No target release/tag found |

Launcher immutable releases: **disabled**, not owner-enforced. Distribution immutable
releases: **enabled**, not owner-enforced. No settings were changed by this execution.
The existing immutable prerelease `test-pack-v0.0.1`, release ID `414428948`, remains
untouched. No new draft, tag, public release, source commit or source push has occurred.
Remote CI for the final production source is consequently **NOT RUN**.

## Fresh safe validation before key activation

These checks validate the current pre-activation source; they do not certify a
future installer rebuilt with production pins.

| Check | Executed result |
|---|---|
| Launcher TypeScript typecheck | PASSED |
| Full Launcher automated suite | **392 passed, 0 failed, 0 skipped** |
| Actual isolated Windows NSIS regression | PASSED within that suite: disposable 0.1.5 → 0.1.6, signed loopback download, installed ASAR version changed |
| Distribution TypeScript typecheck | PASSED |
| Distribution tests | **4 passed, 0 failed, 0 skipped** |
| Source build | PASSED |
| Source Electron fixture smoke | PASSED |
| Existing unpacked Electron fixture smoke | PASSED |
| Existing NSIS metadata + L3/L4-A/L4-B/L4-C package audits | PASSED before production pins |
| Pre-fix built main/preload vs existing packaged ASAR | Byte-identical at the initial baseline check; rebuild required after updater changes |
| Intended source inventory/privacy scan | 131 files scanned; no matching private-key material, GitHub tokens, credential assignments, prohibited binaries or actual personal paths found; two user-path matches are deliberate fictional redaction fixtures in `tests/updater.test.ts` |
| Protected file comparison | **63 paths checked, 0 changes**, including existing Launcher executable/ASAR, original protected runtime files, server settings/manifest/world, saves and L1 backups |

The initial NSIS regression substituted its handoff callback/arguments and never
launched the installed older application. Review identified that gap and a separate
15-second total installer transfer deadline. Both have now been addressed:

- Installer transfer has a separate bounded 30-minute deadline; metadata remains
  bounded to 15 seconds. A new regression reproduced the original timeout before
  the fix. The updated security suite passes **10/10**, including delayed streaming,
  cancellation and transfer-deadline enforcement.
- Disposable NSIS builds now include production dependencies. An installed-app
  bootstrap regression failed before this correction and passed afterward.
- The extended NSIS test passed through actual installed 0.1.5 Main/bootstrap,
  preload download/install IPC, verified handoff/default spawn, normal old-app quit
  and actual 0.1.6 restart carrying `--updated`. Actual application settings plus
  an existing sandbox engine's authenticated receipt/journals/backups survived.
  The test-only entry prelude confines storage/profile inputs across Explorer-based
  restarts; it is not included in production packaging. One final formatting-only
  cleanup to that test prelude still needs the final full-suite run.
- The existing callback-based installer replacement check remains additional
  coverage. No public-to-public 0.1.6 → 0.1.7 update has been verified.

These changes require a new full suite and final production packaging. The initial
392/392 baseline is not the final post-fix/post-pin result.

Local evidence is retained under the ignored production-release audit directory.
It is intentionally excluded from source commits and release assets.

## Source and package review

The cumulative uncommitted L3/L4-A/L4-B/L4-C/Player Distribution work is the intended
source audit scope. Dependency diff changes package versions from 0.1.1 to 0.1.6;
no dependency versions or resolved dependency graph changed in that diff.

Reviewed updater execution paths authenticate the signed manifest before download,
bind installer asset ID/name/size/SHA-256/SHA-512, use restricted anonymous transport,
maintain a version ledger, reverify cache identity and bytes before handoff, disable
web/differential installer downloads and refuse automatic quit-time installation.
`latest.yml` does not authorize the direct installer path; release publication must
independently verify its consistency against the signed manifest/final installer.
The old 0.1.4 installation is untouched and requires one manual bootstrap install.

Independent security review identified the two issues above; its fix review found
no additional blocking findings. Final pins, packaging and full regression remain
pending, so source is **NOT YET DECLARED FULLY AUDITED FOR PUSH**. The Windows workflow has been updated to run
the existing L4-C artifact audit as well as L3/L4-A/L4-B audits. Workflow permissions
remain `contents: read`; packaging uses `--publish never`.

Both production trust configurations now contain exactly their independently
approved public keys, environment `production`, revocation false and expiry
2027-10-16. Modpack pack ID is `frostveil-rp-pack`. The new literal-only artifact
audit verifies exact SPKI fingerprints without executing packaged code and rejects
cross-channel substitution, extra/missing trust, wrong identity/expiry and dynamic
initializers. Its five tests passed; full post-pin regression is running.
The synthetic Level B identity remains outside both production key sets.

## First-party Modpack content review

Required final identity: `frostveil-rp-pack`, stable, version `1.0.0`, tag `pack-v1.0.0`.
The original candidate uses `frostveil` and placeholder asset IDs. It is preserved
unchanged as preparation evidence and must not be uploaded as the final manifest.

The original first-party text claimed medical/police/economy/animation commands and
F2/F6 bindings that are not present in the inspected current RP gamemode modules.
New unsigned local content corrects the pack ID and documents only source-supported
chat, character profile, dice and Courier commands, with the configurable default
F7 chat key. These three files are metadata/static references; they do not install
or enable gameplay modules or replace the actual in-game HUD.

| Target | Asset name | Bytes | Reviewed unsigned payload SHA-256 |
|---|---|---:|---|
| `Data/Frostveil/settings.json` | `frostveil-client-settings.json` | 370 | `9a1d1d16c7271d816fd91f0699999ec516fdc0df26dae7dae67f35c85170bd21` |
| `Data/Frostveil/readme.txt` | `frostveil-client-readme.txt` | 897 | `4bf195a94902b870f688522b3461a1b0c3abacdec8e55cc66340bca4a82ce921` |
| `Data/Interface/Frostveil/hud-reference.html` | `frostveil-hud-reference.html` | 457 | `5bb5168fca942c7321bbedef569d26496eebcf14564d36093a6effa1817a9425` |

First-party ownership and real-target path policy checks passed. No external
endpoint, credential, script tag or executable header was found in these payloads.
The original 29 external-only requirements remain verification references, with
**zero redistributed third-party/game/native assets**. No new feature was implemented.

## Read-only SkyMP/runtime findings

- Skyrim executable: **1.6.1170.0**. SKSE loader/runtime file version: **0.2.2.6**
  (SKSE release **2.2.6**). Current L1 scan is ready; all **29/29** external-only
  manifest file requirements verified against local bytes/resource versions.
- SkyMP checkout HEAD: `5397cd3bf4666c942f78193107881d8cf0ac2748`; candidate native
  engine baseline reference: `2849e676fe008925384b26f34476e382a30bd877`.
- Fresh offline export checks current native manifest CRC/size/header/hash against
  the five official masters: Skyrim, Update, Dawnguard, HearthFires, Dragonborn.
  Server archive list: `Skyrim - Misc.bsa`.
- Native activation preflight: **UNVERIFIED**, no hard blockers, because existing
  active Creation Club light/ESL plugins have unverified pinned SkyMP behavior.
  No plugin activation was changed to clear the warning.
- Live server compatibility: **UNVERIFIED**. No game or server was launched/restarted.
- Current server-profile schema expires an offline snapshot after seven days.
  A final snapshot must be freshly exported for publication. An immutable embedded
  snapshot will still expire; later refresh/version publication needs separate
  authorization. Do not claim indefinite production availability from this release.

## Remaining release requirements

| Requirement | Current status / missing evidence |
|---|---|
| Offline backup and recovered-key verification | VERIFIED; owner detached USB and retained password separately |
| PRODUCTION KEYS PINNED | VERIFIED in source; final packaged audit pending |
| Final production-key build, hashes, executable versions | NOT BUILT; historical installer hashes are not final production values |
| SOURCE AUDITED AND PUSHED | NOT EXECUTED; cumulative review incomplete |
| Remote Windows CI | NOT RUN for a final production commit |
| LAUNCHER v0.1.6 RELEASE PUBLISHED | NOT EXECUTED; no actual production asset IDs/URL |
| MODPACK pack-v1.0.0 RELEASE PUBLISHED | NOT EXECUTED; no actual production asset IDs/URL |
| ANONYMOUS GITHUB DOWNLOAD VERIFIED | NOT TESTED for production releases |
| PRODUCTION ED25519 SIGNATURE VERIFIED | Key possession verified; final published signatures NOT TESTED |
| Real production assets in sandbox | NOT TESTED; generic/disposable regression success is not release acceptance |
| Production Backup / Rollback / Recovery | NOT TESTED with actual production downloads |
| Final real-install ManagedPlan and planHash | NOT PREPARED; requires real authenticated release metadata |
| REAL SKYRIM INSTALL NOT YET EXECUTED | CONFIRMED by protected comparison |
| PRODUCTION PLAYER ACCEPTANCE PENDING | PENDING; requires separately approved real installation and manual in-game tests |

Keep this report in progress until every required publication and verification is
complete. Do not relabel preparation or historical test results as production success.
