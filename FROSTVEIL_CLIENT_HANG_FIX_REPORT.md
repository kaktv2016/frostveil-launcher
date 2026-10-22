# Frostveil client hang correction — 2026-10-20

## Evidence and scope

- Owner reproduced a whole-process hang after joining, with sound still audible. Windows recorded Application Hang 1002 / AppHangB1 at 09:43:19 local host time.
- Two additional reproduced hangs were captured locally as minidumps. Both show Skyrim engine/Papyrus workers waiting while a Skyrim Platform JavaScript worker remains active. These are stack-memory scans, not a fully symbol-matched native unwind. The local PDB has a different incremental age; exact native call names are not asserted.
- Both observed client sessions report `once('update'): 'unofficial skyrim special edition patch.esp' is not a valid argument for 'filename'`. The installed native FileInfoApi calls ValidateFilename, which excludes spaces/apostrophes. The old `try/catch` did not prevent that native callback exception.
- A previous 08:56 crash references a Lux Via world object. It is a different event and is not treated as proof that Lux Via causes the later JavaScript/Papyrus hang.

## Implemented correction

- Replace the restricted native filename checksum API with asynchronous Node file reads, retaining true signed CRC32 and byte sizes for every full plugin. Snapshot native plugin names before awaiting; schedule comparison and error UI back onto an update event. Use a Node timer for asynchronous manifest retry delays. Do not fabricate zero checksums or enable ignoreLoadOrderMismatch.
- Launcher Play downloads one content-addressed, SHA256-pinned client JS from Cloudflare R2. It only replaces explicitly recognized prior client hashes; checks that Skyrim/SKSE is stopped, verifies the download, backs up the original, stages atomically and verifies the installed result. No DLL update.
- Keep the local compatibility scan and signed pack verifier consistent with this exact reviewed client transition. This does not accept arbitrary observed hashes or rewrite native runtime/SKSE trust. Old client remains recognized before Play so repair is reachable.
- Remove graphics plugin deletion, retain enabled plugins omitted from the remote canonical list, and remove deletion of nested FOMOD asset directories and existing normal textures. Existing R2 graphics manifest and graphics payloads are untouched.
- Existing server was restarted visibly with additional Quest lifecycle diagnostics. No player/world reset, migration or world backup. No installed-game file was manually copied, deleted or changed in this work.

## Delivery

Use Launcher **0.1.11**, superseding the intermediate 0.1.10 publication. Both original client and the intermediate reviewed client are explicitly accepted as inputs to the final repair.

Final client: 1395054 bytes, SHA256 `6ec56e6ccfaceca3fd946ea8372ce3b62e89d2e0fb618a242cf90b1c4fac75cf`.

Launcher installer SHA256 `99c1bc7f34351253c69460160111dd5e4f3093162bb845ca8c796894a9122540`.

Corresponding Launcher and modified SkyMP client source archive SHA256 `bb0182ae73909d8141630866129ee07a4da24aa3a8e460bff49e8dfbc882c054`.

R2 acquisition verification: `.local/white-screen/r2-verification.json`. Frozen release artifacts: `.local/white-screen/publication-files-final.json`. Existing independent Ed25519 update identity is retained; no source commit/push. Windows Authenticode remains unsigned, as in the previous distribution model.

## Verification and remaining acceptance

- Client tests 3/3 pass; client webpack/typecheck passes.
- Launcher typecheck and NSIS packaging pass. Launcher regression excluding the dedicated real-NSIS scenario: 449/449 pass. The earlier full run's single failure occurred because the owner had Skyrim running; its running-game install guard correctly refused the disposable update. Dedicated rerun passed 1/1 after Skyrim was closed (`.local/white-screen/nsis-final.log`), giving 450/450 across the regression suite.
- Packaged executable smoke passes in a disposable fixture. Focused server chat/navigation regression 26/26 passes. Preservation and repair tests include unknown original files, corrupted downloads, running game, repeat Play and interim-version repair.
- Independent review identified residual FOMOD deletion; it was removed and a failing-then-passing regression added. Review found no other important pin/baseline issue.
- Native hang resolution is **not yet certified**. We corrected an observed native exception and unsafe callback context; owner must run the delivered client once to establish whether these fully explain the hang. Do not treat unit tests or a release publication as proof that the real game no longer hangs.

Owner check: close Skyrim; update Launcher to 0.1.11; press Play and let it repair the client automatically; join the same server with the same mods and character. Confirm the game remains responsive. If it still hangs, the installed corrected client and retained server lifecycle diagnostics provide the next evidence without disabling mods.

Publication: GitHub release https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.11 is public. Actual installer asset IDs were bound before Ed25519 signing. Final verification record: .local/white-screen/anonymous-release-verification.json. Installed game remains owner-tested through Launcher Play.

## Final server-side finding and correction

The diagnostic replay log rpQuestLifecycle-logs.txt ends at: initial cleanup enter -> clear lookup courier-route-1-v1 -> clear objective -> clear active -> clear alias, with no return. This narrows the reproduced startup hang to the stopped-Quest alias cleanup path (the trace brackets GetAlias/cast/Clear together, not an individual native instruction). Removed this redundant alias lookup/clear path. Cleanup now skips stopped quests and uses Quest.stop for running quests; engine Stop owns alias release. It preserves the existing contracts and native objective lifecycle. No navigation plugin or mod was disabled. The added regression was seen failing with six stopped-alias reads before the correction and passes afterwards. Full gamemode typecheck/build and 196/196 tests pass.

Deployed bundle: 84a49fadb5ae57557814b9d97af064d56bf5505d32691f53007b56f7f1b6befb. Code/config audit and visible start script are recorded in .local/white-screen/server-deployment.json. Original game files are unchanged until Launcher Play applies the independently published client repair. Native post-fix gameplay still requires the owner's confirmation; the previous uncertainty paragraph should be read with this narrower startup diagnosis.
