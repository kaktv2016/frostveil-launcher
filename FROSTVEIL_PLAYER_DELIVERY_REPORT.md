# Player-controlled delivery — 0.1.7

Status: public 0.1.7 published; source, package, anonymous acquisition and **actual installed public 0.1.6 → 0.1.7 upgrade passed**. Player-controlled delivery is ready for the currently approved first-party pack. Supplied SkyUI remains BLOCKED. No direct deployment to a player's game was performed.

## Scope

- Players acquire authenticated production files through **Updates → Download Server Files**, without selecting a game or writing game files. Completion means downloaded, not installed.
- Installation remains a separate **Review Install → Apply Reviewed Plan → native confirmation** transaction with ownership, backups, conflict refusal and recovery. Unknown files remain unowned.
- Unchanged existing ESL plugins retain an UNVERIFIED gameplay warning. Only the signed developer-owned inert Frostveil text/reference files may proceed with that single warning and no activation writes. Native files, archives, scripts, new plugins and other warnings receive no exception.
- A missing first-run compatibility baseline can be derived from the signed production pack's external-only references. Skyrim, SKSE, SkyMP binaries and Bethesda masters must already be obtained legitimately; they are never downloaded by that mechanism.
- Production public 0.1.6 → 0.1.7 updater acceptance is restricted to a disposable GitHub-hosted Windows runner. The owner's installed Launcher, game, server and world are not test targets.

## Supplied SkyUI example

The two files in `../mod-work` identify as **SkyUI SE 6.0**, with an ESL/light flag on the ESP. They are not verified as the commonly referenced 5.2 distribution.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| SkyUI_SE.esp | 2433 | 61eb77164ed3632344ac2ccac4c8a4e69c62397999e7d8d558c162fd205616cf |
| SkyUI_SE.bsa | 2947857 | a9e106beec4c083c8d8b7a7e108ebbc0593f57a0c12f1e4efc5cefdf9af9cfbf |

The ESP references Skyrim.esm and seven SKI_ quests. The BSA header is version 105, with 71 UI/script entries in seven directories. Inspection did not execute scripts or install assets. SkyMP's `FridaHooks.cpp` has an SKI_ hook exception, which does not establish this ESL distribution's runtime compatibility.

[The official SkyUI page](https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=description) prohibits mirroring in its upload permissions. No redistribution grant was supplied. Consequently **these files are not uploaded to our GitHub/server and Launcher installation remains BLOCKED**. The Launcher offers the fixed official source link and a read-only comparison with these supplied hashes; matching is not proof of upstream authenticity or in-game compatibility.

## Where files belong

- **GitHub source repository:** Launcher source and release configuration; no private keys or game binaries.
- **GitHub Releases / distribution repository:** versioned redistributable player payloads and signed manifests. Players download these through Launcher. Current `pack-v1.0.0` contains only three owned Frostveil configuration/reference files, not SkyUI.
- **SkyMP server:** dedicated server, server-side gamemode, required compatible masters/plugins, configuration and persistent player/world data. Client-only UI assets do not belong in world persistence. Skyrim does not automatically distribute the client's mods from the running server like some Minecraft setups.
- **Player machine:** their legitimate game/runtime, verified download cache, managed installed files and transaction backups. Only the player's reviewed, confirmed installation writes game content.

## Release acceptance

Release source: `0eb5a8c178fc56cfedcd30e22d1e001981961687` (implementation `47201c06a80b6c4ccbf2884ab5c401c6ee9d09a4`, followed by synthetic smoke-version correction). [Source Windows CI 38900192464](https://github.com/kaktv2016/frostveil-launcher/actions/runs/38900192464) passed all required checks: typecheck, **436/436 tests**, zero failed/skipped tests, isolated NSIS update, package build, five artifact/privacy/trust audits, sandbox checks, source and packaged Electron smoke.

[Public Launcher v0.1.7](https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.7), release ID `414941556`, uses the existing launcher production key `frostveil-launcher-update-20261016`. Minimum updating version is 0.1.6. Draft upload, independent asset readback, actual asset-ID binding, signature validation and anonymous normal production-engine check/download passed. Launcher repository immutability remains disabled; no repository setting was changed.

| Asset | GitHub ID | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| SkyrimRPLauncher-0.1.7-x64-local.exe | 647273649 | 112352391 | 293e60b9be34a11d027185092af7dbd59892a74efccabf9341021522d44c7a37 |
| SkyrimRPLauncher-0.1.7-x64-local.exe.blockmap | 647274823 | 118129 | 91bfc89da6d32580a207726d92f27b3e38f0faf29e8745b617bd2c30a9e977b6 |
| latest.yml | 647275024 | 369 | aba17beb8e7cee6a674d72c44eede50161b5cfea63ff381327ae878db8470035 |
| frostveil-launcher-update.json | 647275240 | 1508 | 3a3130bee8000e8d3c7bd2b4079b751a596aded19180f42b833db5900ea994e5 |

Actual new download service anonymously acquired `frostveil-rp-pack` 1.0.0: three files, **1724 bytes**, each verified; reopened authenticated cache passed. It did not receive a game root or report installed. Signed baseline discovery resolved 29 external-only requirements for Skyrim 1.6.1170.0 / SKSE resource version 0.2.2.6.

A read-only `ManagementService.prepare('install')` audit against the existing game reached **AWAITING REVIEW**, with three additions, no activation writes, zero blockers and the existing ESL warning preserved. No authorization/apply ran. Private audit metadata is outside the game/Git; that five-minute plan expires and must not be reused by players. Installed Launcher must generate a fresh plan from its actual storage and ownership receipt.

Review identified two issues, both corrected and re-reviewed: final eligibility now covers obsolete receipt removals and recomputed activation, and complete temporary-cache disappearance permits fresh acquisition without accepting surviving damaged evidence. Focused regression checks passed 35/35 before the complete 436-test run.

Historical protected comparison: 61 game/server/world/save/backup paths still match the previous baseline. Two installed Launcher files already differed: installed 0.1.6 files dated 15:03:58 predate this work and the earlier baseline was taken at 13:36. All 63 current protected paths were recorded for the remaining release work and compared unchanged. `mod-work` hashes and SkyMP `develop` at `5397cd3bf4666c942f78193107881d8cf0ac2748` were preserved. Public 0.1.6, pack-v1.0.0 and test-pack-v0.0.1 release bodies/assets/identities were compared unchanged.

Hosted actual public-to-public acceptance: **[run 38902696119 PASSED](https://github.com/kaktv2016/frostveil-launcher/actions/runs/38902696119)** at 2026-10-16T12:46:35.895Z. It used genuine public installers and production keys, anonymous requests, normal installed-app updater IPC and default NSIS handoff on disposable Windows. Verified old-process exit, new 0.1.7 process/window and installed package, exact preservation of settings and authenticated ownership/journals/backups, and a normal **Download Server Files** UI action acquiring all three authenticated production files while the selected game directory remained absent. No loopback server, substitute install callback or real-game writes were used. Report and screenshot were downloaded and inspected locally under ignored `.local/player-release/public-upgrade-confirmed/`.

Acceptance harness source: `77f191ca7571e136fb1bce8aec0d04872119aae3`. Three earlier attempts exposed harness defects: transient exe absence during NSIS replacement (38901352343), the ASAR reader caching the replaced archive's old header (38901735028), and asynchronous Playwright predicates resolving before actual IPC completion (38902172910). Corrections were limited to the acceptance script and reviewed. The ASAR defect was independently reproduced with inert archives. Attempt three already verified actual upgrade/restart/preservation; final attempt also verified completed UI pack acquisition. **Published application source and all four v0.1.7 assets were unchanged throughout these retries.**

Existing 0.1.6/pack-v1.0.0 reports remain historical evidence. Pack server snapshot expiry is **2026-10-23T08:09:13.587Z**; compatibility must not be claimed after expiry without a fresh signed release.

Windows Authenticode certification is unavailable; Ed25519 publisher verification is separate. Old 0.1.4 users require one manual bootstrap because that version lacks the production key. No actual Skyrim graphical or two-client test is asserted by this delivery work.

## Player steps

1. Installed 0.1.6: open Updates, Check for Updates, Download Update, then Restart & Update. Verify installed version 0.1.7. Fresh/old-key installations use the public 0.1.7 installer once.
2. Choose **Download Server Files**. Wait for authenticated, verified completion. Downloading alone changes no game files.
3. Select the legitimate supported Skyrim/SKSE/SkyMP installation. Choose **Review Install**, inspect every operation, then **Apply Reviewed Plan** and approve the native confirmation only if correct. Close the game before installation. Resolve conflicts rather than overwriting unknown files.
4. Only the current owned Frostveil content is included. Do not expect SkyUI to install; its source/rights/ESL compatibility remain separate blockers. No Skyrim executable downgrade/update or master-file download is offered.
5. Launch through SKSE and manually check server connection, existing character/inventory and RP chat. Graphical in-game acceptance belongs to the user.
