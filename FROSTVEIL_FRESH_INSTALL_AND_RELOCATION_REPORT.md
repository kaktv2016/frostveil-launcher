# Frostveil — Fresh Steam Install and Game Relocation Audit

2026-11-05 (Asia/Bangkok). Scope: normal player/server7777 only, per owner clarification. The isolated NPC profile/server17777 is excluded. This task does not uninstall/move the owner's real game, touch world/player/economy data or control Skyrim/Creation Kit.

## Player workflow

1. Install Skyrim Special Edition through Steam, including its normal official DLC/free Creation content. Supported executable:1.6.1170.0.
2. Install the current signed Frostveil Launcher0.1.26 from https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.26 . Existing0.1.26 installations do not need a new installer for this metadata renewal.
3. Open Launcher and press PLAY SKYRIM RP. Steam discovery finds the installation. If moving an existing installation leaves the old saved path selected, choose the new folder containing SkyrimSE.exe once, then Play. No raw IDs/hashes, mod archives, manual SKSE installation or mod-manager setup is required.
4. Leave Launcher open while it verifies/downloads/extracts/activates the reviewed pack. If the connection is interrupted, retry Play; the base archive's existing partial-download mechanism resumes and checks the complete hash before extraction. Close Skyrim before repairs.

The file pipeline installs SKSE64 loader/runtime2.2.6 and63 compiled scripts, SkyMP/Skyrim Platform native/browser files (58 CEF resources), Address Library, SkyUI, current client/native corrections, required graphics/world plugins and first-party Courier content. The142-file bootstrap and649-target pinned recipe are downloaded automatically. Players supply the legitimate Steam game; game executables/Bethesda masters are not mirrored as mod payloads.

## Findings and correction

The already published R2 recipe1.0.20 contains SKSE64 and all automatic source URLs. All10 referenced source archive HEAD requests returned200 with exact expected lengths. Graphics pack1.0.6 contains required Engine Fixes/root preload libraries, Community Shaders, CrashLogger, MLO, XPMF, RaceMenu, TerrainHelper and Address Library. No new missing required binary was identified in that inventory; no unnecessary duplicate R2 upload or new executable version is introduced.

A real blocker was reproduced using the default production provider: signed pack1.0.8's server profile expired at2026-10-28T05:57:28.049Z. The unchanged production validator correctly rejected it with Stale or conflicting server profile. Prepared pack1.0.9 renews the signed metadata and rebinds actual release asset IDs; all39 file path/size/hash identities, eight payload contents, plugin requirements and archive requirements remain identical. Existing publisher key, Ed25519 validation, release binding and downgrade ledger remain mandatory. The seven-day maximum signed snapshot lifetime is preserved; no expiry bypass or arbitrary lifetime increase.

The prior fresh-install harness used stale recipe1.0.9 and copied every installedArchive dependency from the real game, including four mod BSAs. That could mask missing delivery. The corrected harness loads/authenticates the currently pinned recipe, seeds only named Steam files and Bethesda Skyrim Meshes BSAs, excludes USSEP/Lux/Particle Patch BSAs from the seed, supplies no Downloads/mod-work source directory, and checks all649 hashes plus active plugins and final baseline. A genuinely new clean fixture was started after discovering that harness defect; the earlier contaminated fixture is not acceptance evidence.

## Existing delivery reused

- Current Launcher0.1.26 authenticates recipe SHA256869d042275926fb13f14c44d08523572b5d0d77a35ac90ef35087370822f538c (498388 bytes), then exact HTTPS source archive hashes/member hashes.
- Base graphics archive7270769508 bytes and integrity patch973829577 bytes come from the existing R2 graphics manifest. Asset repair then applies the current649-target recipe, including SKSE/player bootstrap and current client/native pins.
- Signed GitHub pack supplies authenticated compatibility/activation and eight approved first-party payloads. Native/SKSE binaries remain delivered through the existing hash-pinned R2 bootstrap rather than weakening direct-package native-content restrictions.
- Existing Play order is graphics/base repair → current source/bootstrap repair → client correction → signed pack verification/activation → compatibility scan → SKSE launch. Missing SKSE does not disable Play's preparation button.
- An installation move is detected through current Steam library manifests or one normal folder selection. Prior verified backup/scan attribution is cleared by the existing selection mechanism.

## Verification ledger

- Typecheck: PASS.
- Full Launcher regression:497/497 PASS, zero failed/skipped;267218.879ms. Includes real isolated NSIS install/update/handoff, signing/tamper/expiry tests, source/bootstrap download and cancellation, activation, native/client repair, plugin order and target isolation. No tests were bypassed or budgets enlarged.
- Actual corrected cold R2 fixture: PASS in518.703 seconds;649/649 target hashes, active plugins, signed candidate pack, final scan READY, second preparation zero source-repair writes, actual Steam-library relocation/discovery/scan READY. No Skyrim launch/render/server-login claim.
- Current public Launcher0.1.26 installer: anonymously downloaded112374672 bytes; SHA2566eddaf4aef2e011a7a8de55b24c9d7a57ffde96a091020d1a288ba2eb0c7addf and production Ed25519 updater authentication PASS.
- Production pack1.0.9: PUBLISHED after the cold fixture passed. Default production provider authenticated the actual public release in separate fresh acquisition metadata, verified all eight actual asset downloads anonymously, accepted31 external baseline requirements, and returned installed/scan READY. Candidate and public-version ledgers were kept separate; no same-version ledger bypass.

Private logs/receipts are in .local/fresh-install-audit. Because C initially had only11.7GB free, generated game/download/NSIS fixtures use D:/Frostveil-FreshInstall-Audit. No unrelated directories or existing backups were deleted. Initial network requests were cut by the remote socket; bounded owner retry resumed the verified base archive. Failed attempt logs are retained. An interrupted download is not proof of a missing mod or a successful installation.

## Data and relocation notes

The test copies/reads actual Steam files into an explicitly marked disposable directory and obtains mods from published network sources. It records hashes of the real649 target paths before work and verifies them unchanged afterwards. It never launches Skyrim, rewrites installed mods/profiles, restarts either server or resets saves. Existing registry, world, account, wallet and economy storage remain outside the game-directory operation.

Steam uninstall/move is the owner's separate action after this audit. Preserve personal saves and project/development source backups. Do not delete Launcher transaction/ownership evidence as part of moving the game. The normal Launcher cache remains under LocalAppData/SkyrimRPLauncher even if the game moves; it contains downloaded archives and verified repair/recovery material, not a second standalone game. Adequate space is needed for cache/staging as well as the selected game's mod files.

For this owner's previously activated NPC test profile only: it has separate explicit authorization, pinned owned source files and a previously fixed installation path. It is not part of the normal7777 player workflow and is not silently activated/published here. Its existing project staging/source backups are preserved. No NPC or player/world migration accompanies a regular game reinstall.

## Operational expiry and rollback

The new signed snapshot remains subject to the existing seven-day limit. Publisher operations must renew it before expiry; this is a server/operator responsibility, not an instruction for players to install mods manually. The renewal helper refuses overwriting an existing reviewed plan, uses the existing offline-key backup prerequisite, verifies pinned publisher identity and refuses publication until the specific candidate's fresh fixture passed. No private keys, credentials, caches, downloaded binaries or logs enter Git.

Old releases/R2 objects remain intact. A payload rollback requires another valid signed forward release, never a stale/expired manifest or a downgrade-ledger bypass. This change renews metadata only and needs no server restart or player file rollback. Failed publication remains a recoverable draft with an exact plan/state receipt.

## Changed files / delivery

scripts/test-r2-fresh-player.mjs: current pinned recipe, corrected Steam-only seed, current native scan correction, cold automatic R2 source delivery, same-player no-op and actual Steam-path relocation checks. scripts/refresh-player-pack.mjs: reviewed metadata-only pack1.0.9 renewal via existing validators/signing/release workflow. This report records acceptance and limitations. No application runtime/UI/native DLL, game, mod selection, Launcher version or production server code changed.

Commit/push and final fixture/publication evidence are appended after verification. Authorized repository is kaktv2016/frostveil-launcher, existing development branch; no upstream/force push.

## Final public evidence

Release: https://github.com/kaktv2016/frostveil-distribution/releases/tag/pack-v1.0.9 . Signed payload SHA25639736be34d446bab3159e2699fb546f74cdcaacd4adbaa9b5a91cb564b645918. The offline candidate hash0dddd4829bad23c129d2c894202499b175f4168852eb0ad1d3dba38992fcac44 differs only because actual new-release asset IDs were rebound before final signing. Both passed their appropriate validation; only the final real release is published. Preparation plan SHA2562935413d49e1967a54cff96a728504c3e7d375dc03b17b78443180b61a7ddddf.

Snapshot expiry:2026-11-12T07:55:41.018Z (14:55:41 Asia/Bangkok). Renew through the publisher workflow before that deadline. The exact39 file identities and eight payload bytes are unchanged, and previous public1.0.8/R2 objects remain unmodified. No additional required mod was missing from R2, so duplicate multi-gigabyte mod uploads were unnecessary. Launcher0.1.26 remains the existing published installer; no new Launcher release/server deployment/restart.

Receipts: .local/fresh-install-audit/live-audit.json, renewal-plan.json, candidate-envelope.json, fresh-result.json, published-verification.json, published-play-verification.json, launcher-public-verification.json, cold-fixture.log, regressions.log and typecheck.log. Real game649-path pre/post assertions passed; original game/profile/server changes0. Candidate test actors, runtime code changes and Skyrim GUI operations0.

Confirmed scope: installation/download/activation/file compatibility and relocation. Actual graphical launch/login after the owner's Steam reinstall remains owner acceptance; this report does not certify every hardware/mod/gameplay combination or multiplayer performance.

Both marked generated game fixtures on D were removed after final publication verification. Diagnostic logs/receipts remain in the project; the original game, Launcher caches, existing backups and test-server persistence were not removed. The test-only temporary directory is retained for evidence rather than deleting unrelated contents.

## Server dependency discovered before uninstall

Read-only audit found that regular7777 server-settings.json referenced all five Bethesda masters and Skyrim - Misc.bsa inside the old Steam game folder. This would break server startup after removing that installation. Verified all six current plugin hashes against the renewed signed profile first; no plugin-content mismatch was found.

With the verified loopback/offline7777 server stopped (UDP/HTTP/process checks), preserved exact configuration bytes and144 world/economy/NPC/dialogue/Blueprint files' hashes. Copied six local owned game resources (380867296 bytes) into skymp/build/dist/server/data/steam-runtime-1.6.1170 and verified every complete hash. Only loadOrder/archive path values in local server configuration changed; plugin order/content, selected gamemode/assets and all144 persistence files are unchanged. No player game file was written and no Bethesda data was uploaded.

Startup preflight PASS. Actual native addon loaded all six plugin identities from the new configured paths, resolved a known NPC_ record and reported zero actors in fresh private probe storage without attachSaveStorage/ticks. No original world storage was attached and no server was restarted. Receipt/rollback source: .local/fresh-install-audit/server-relocation/{server-settings-before.json,protected-before.json,receipt.json,native-verification.json,native-read.log}. Exact original config backup is retained; restoration would also restore its old Steam-path dependency and must only be done if that old location exists.

One audit filter initially compared the intentionally changed configuration as protected data because Windows used backslashes; corrected path normalization proved144 non-config files identical. Native inspection first compared getEspmLoadOrder basenames to absolute paths; corrected the observation shape and additionally verified getServerSettings().loadOrder equals the new absolute paths. Both diagnostic failures are retained; the actual relocation/native checks then passed. No engine/data workaround was applied.

## One-time prerequisite on this owner's development machine

A read-only Launcher development status check still reports the NPC test profile active on this machine. A genuinely fresh normal player's machine has no such profile. Before uninstalling the old game on this particular development machine, restore its authenticated normal configuration using the existing Launcher-owned recovery command while Skyrim is closed:

```powershell
node "C:\Users\basba\OneDrive\Desktop\skyrim-rp\skyrim-rp-launcher\scripts\npc-development.mjs" revert
```

Review and type CONFIRM locally. This is the existing explicit owner-profile gate; the audit did not bypass it or edit installed profile files by hand. It prevents carrying the old17777/NPC-only activation into a regular7777 reinstall. This one-time cleanup is specific to this development machine, not a mod-installation requirement for ordinary players. After normal installation/move, select the new SkyrimSE.exe folder in Launcher and Play. Development17777 reactivation/installation-path rebinding remains outside the requested scope.

Server rollback/verification evidence is also retained with the server under skymp/build/rp-audit/installation-relocation-20261105 (exact before-config, protected-file hashes, copy receipt and successful native verification); no world/economy data copies were made. Source/test tooling commit:bac9a63c425f37b2749f829cd3cd6e5852d53b8a on dev/npc-local-activation-g241d. This report is committed separately. Public payload files and private keys are excluded from source delivery.
