# Player-controlled delivery — 0.1.7

Status: implementation and local validation in progress; publication and public-to-public upgrade acceptance are still pending. This report does not authorize direct deployment to a player's game.

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

Publication, exact source/release IDs, final test totals and hosted public upgrade results will be recorded after they actually run. Existing 0.1.6/pack-v1.0.0 reports remain historical evidence. Pack server snapshot expiry is 2026-10-23T08:09:13.587Z; compatibility must not be claimed after expiry without a fresh signed release.

Windows Authenticode certification is unavailable; Ed25519 publisher verification is separate. Old 0.1.4 users require one manual bootstrap because that version lacks the production key. No actual Skyrim graphical or two-client test is asserted by this delivery work.
