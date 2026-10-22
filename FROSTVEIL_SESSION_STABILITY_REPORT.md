# FROSTVEIL — Session Stability / Launcher 0.1.15 candidate

Status: implementation, review and automated validation complete. **Not published, installed into the real game, or deployed to the running server.** One coordinated publication/server restart approval remains.

## Problems and changes
1. Crash 2026-10-20 17:02:24: native access violation SkyrimSE+0783642 in NPC movement, with a deleted Goat actor. The inspected client deleted NPCs while AI/native references or delayed spawning could remain active. Actor retirement now disables/hides without Delete, validates session/ownership/protection/deleted/base state, coalesces work while releasing each owner once, detaches views before retirement, and invalidates stale spawn callbacks. Native actor spawn operations run on update callbacks; Promise continuations only enqueue work. Ownership across preload/load and the chicken load workaround are covered. This removes demonstrated hazards; the exact native crash is not certified eliminated until gameplay testing.
2. Interior reconnect: deployed server log at 16:50:57 showed saved 13a8c:Skyrim.esm overwritten with Tamriel spawn by Spawn. Server login now preserves saved location. Cold client loading uses a known exterior stage locally, then retries restoration on update every 250ms until the actual cell/world, 3D coordinates and rotation match. The server never receives staging movement, inventory or other gameplay packets. Slow native move blocking is handled by observation, not a fixed five-second assumption. A 120-second failure remains guarded with diagnostics; disconnect/new session invalidates work. Manual single-player load cancels restoration and restores only controls this system changed.

## Verification
- Client/server TypeScript checks and JS builds: PASS.
- Client/server lifecycle regression: 38/38 PASS, including old deployed Spawn regression, slow cold interior load, another worldspace, native-context enforcement, gameplay transport gating, manual-save escape, inventory callback cancellation, owner-view replacement and NPC multi-owner retirement.
- Existing RP regression: 196/196 PASS. No economy, Courier progression or transaction changes.
- Launcher regression: 472/472 PASS. Interrupted 1.0.9 bootstrap recovers using the pinned previous client before applying recipe 1.0.10.
- Packaged Electron smoke: PASS, without launching Skyrim.
- Disposable repair fixture: 647/647 outputs verified; existing-player upgrade changes only the one client JS and verifies its backup; second Play changes zero; scan baseline reconciles. Real installed-game hashes unchanged. Fixture elapsed 167.467s. Candidate URLs were not published; originals came from local reviewed sources.
- Independent review found and fixed cold native lookup, deferred inventory context, actor view detach, load listener ordering and foreign-save cancellation. Final focused follow-up found no remaining critical issue in the last branch.

## Candidate artifacts / SHA-256
- Server JS: 1e8511088812e379e2237216ef294c7b94877057c1a13f3a18fb655456c1be95 (3155759 bytes).
- Client JS: 3e04546ad51aa0c9b1a8e1eea386f38c844bec16c82bb47fc92b62ac366faebc (1436738 bytes).
- R2 recipe 1.0.10: 9a94c9711012987e854e9bd655153ca7caaa4f51b6e4aa81e55db7129cc82455 (495405 bytes).
- Client archive: ecd81658e85d478c326ff7398fe957deeb48f1e39d1283498c4f42f5ef1c4400 (262189 bytes).
- Launcher 0.1.15 installer: b102f679f291cbe5db13c174e4e43d85cd7943280280821c66b5994013665682 (112374191 bytes).
- Full paths and identities: .local/session-stability/delivery/deployment-candidate.json.

## Coordinated deployment and rollback
Publish the new content-addressed client archive, standalone client JS and pinned recipe to R2, then the Ed25519-authenticated Launcher 0.1.15 release with corresponding source. Keep all old immutable R2 objects/releases. Do not change the canonical graphics pack or its mod choices. No new native plugin/DLL or ESP is needed.

Deploy only the prepared server wrapper JS and map to skymp/build/dist/server/dist_back, after revalidating the current wrapper hash 0a1c8d113623f4e4891deca176fb01054755e5d931c32f1c8c6f6dd2e6d08c23, process identity and prepared artifacts. Preserve existing settings, deployed RP gamemode, load order and world/economy files. Restart in visible PowerShell with the existing beacon/admin environment. Require Launcher 0.1.15 before the owner tests an interior reconnect; older clients lack safe interior restoration. This is a coordinated local-development rollout, not a certification of mixed old/new clients.

Code-only rollback copies are in skymp/.local/session-stability/rollback-source; existing client preimages are retained by Launcher repair transactions. No world/save backup, reset or migration is performed. Server rollback restores prior wrapper/map and restarts visibly; client rollback must also update the pinned recipe/Launcher so next Play does not immediately reapply it.

## Owner gameplay acceptance
Update through Launcher and let Play apply the client. Walk near animals/NPCs and cross exterior cells; verify NPC replacements still work. Enter a house, quit, reconnect and confirm the same room/location. Repeat after a slow load and another reconnect. Verify Courier/chat/profile remain usable. On a restore error, retain logs and reconnect; do not manually edit player files.

## Limits
Old interior coordinates already overwritten by the prior login guard cannot be reconstructed automatically. Disabled NPC references can remain until engine/session cleanup, trading immediate deletion risk for session memory retention. This needs longer-session observation. Native rendering stability and existing server/client plugin/FormID parity are separate from this change. The previous CrashLogger report predates Launcher 0.1.14; neither 0.1.14 nor this candidate has been called gameplay-proven for that crash.

## Publication receipt
Launcher 0.1.15 published: https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.15
Three immutable R2 objects and all five public GitHub assets downloaded anonymously and SHA-256 verified; Ed25519 update authentication PASS. Installer/source identities match the sealed candidate. Publication approval did not include live server deployment; its wrapper remains unchanged at 0a1c8d113623f4e4891deca176fb01054755e5d931c32f1c8c6f6dd2e6d08c23. Interior persistence repair requires the prepared server wrapper deployment/restart after the owner updates to 0.1.15. No installed-game writes, world writes or server restart performed.

## Authorized server deployment
Owner authorized server JS deployment after publication. Prepared wrapper SHA-256 1e8511088812e379e2237216ef294c7b94877057c1a13f3a18fb655456c1be95 installed and verified; server running in visible PowerShell PID 11392, Node PID 18188, 127.0.0.1:7777/UDP. Settings and RP gamemode hashes unchanged. Code/map rollback copies retained; no world backup/reset/migration or manual installed-game writes. Actual interior reconnect and crash gameplay acceptance remains pending with Launcher 0.1.15. Receipt: skymp/.local/session-stability/delivery/active-deployment.json.


## Launcher 0.1.16 — spawn rotation correction
After the authorized server deployment, the owner observed black screen with audio. Installed client hash matches 0.1.15 and the server logged successful actor login. Native callback output repeated until disconnect; no new CrashLogger crash was recorded. Source inspection found a definite restore regression: Papyrus/network GetAngle values are degrees, but TESModPlatform::MoveRefrToPosition forwards angles directly to native MoveTo_Impl (radians). The rotation readiness check therefore never settles at a nonzero yaw and repeatedly requests relocation, consistent with the reported symptom. The prior test double incorrectly copied raw native angles into degree observations, hiding the mismatch. Corrected the harness to emulate native radians-to-Papyrus-degrees and reproduced failure before fixing.

Fix: convert only the restore move angles to radians; keep saved/network coordinates in degrees. Lifecycle diagnostic log spawnResume records cold-load, restored or failure once per transition. No changes to other movement, economy, mods, server, or player data.

Validation: client typecheck/build PASS; 39/39 client/server regression PASS, including actual saved yaw reproduction and single successful move; Launcher typecheck and 472/472 regressions PASS; packaged Electron fixture smoke PASS. Targeted disposable upgrade verifies new client, original backup, second preparation zero changes and scan reconciliation; 646 other recipe entries identical to 0.1.15. Real installed client unchanged during tool work. In-game confirmation remains pending.

Client SHA-256: a792d03fa30e037484e0690a205ce34df6dc27d136ac72036dd7f874e0ffa160. Recipe 1.0.11 SHA-256: 52fd8a4039ad4f1401609fbf2e138458950a66629082f26a6d12ccd4f127be4b. Installer 0.1.16 SHA-256: 7b5283cd439b2b56d88ef8fc491e3552b6f8f5392fb0edd21abb8cc7b06a747f. Existing server wrapper remains 1e8511088812e379e2237216ef294c7b94877057c1a13f3a18fb655456c1be95; no restart required. Old immutable releases/R2 objects retained and client transaction backup available.

0.1.16 publication verified: https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.16. All 5 public assets and 3 R2 objects anonymously downloaded/hash-verified; Ed25519 update verification PASS. Installed client remains owner-managed 0.1.15 until Launcher Play; no server restart. Gameplay confirmation pending.

## Launcher 0.1.17 — player readiness and controls
The owner reproduced black screen followed by visible scenery with movement locked on 0.1.16. Read-only live process inspection (player form 0x14, Tamriel world 0x3c, symbols/offsets verified against installed 1.6.1170 address library and CommonLib layout) showed the player had already reached the authoritative saved destination: position difference 1.689 units, heading difference 0.000003 degrees. The native engine reset camera pitch from saved 3.428559 degrees to zero. The old readiness predicate incorrectly required pitch to match within 2 degrees, producing repeated full relocations until the 120-second failure retained the controls lock. Once relocations stopped the picture returned. This is direct runtime evidence beyond the earlier unit fix; 0.1.16 did not resolve the complete symptom.

Fix: readiness requires the correct cell/world, position and heading. Engine-normalized pitch/roll are no longer readiness requirements. If position is correct but heading needs adjustment, use Papyrus SetAngle on update rather than another scene relocation. Retain transport guard until authoritative position/heading is observed; saved position, database and server validation are unchanged. Failure diagnostics include the last observed state.

Validation: the real captured runtime state fails the old predicate and passes the new one. Native-angle/pitch-reset and facing-only test cases failed before the fix. All 41 client/server lifecycle tests PASS; client TypeScript/build PASS. Launcher TypeScript and 59 focused client repair, graphics recipe, update security, trust audit and updater regressions PASS; packaged Electron smoke PASS. Disposable one-file upgrade verifies backup, final hash, second Play zero writes and scan readiness; the other 646 recipe entries are unchanged. Previous 0.1.16 full Launcher suite 472 PASS is retained as prior evidence, not rerun or claimed fresh here.

Client SHA-256: 01264ed1a000ec8bbc75bfaa8f7548b687169fd144ac5e4d22d9c540fc7b0290; recipe 1.0.12: 62e28b229c5dd6e202e3bc775224cb28eb4e11740415b82ec1599b85c0100353; installer 0.1.17: 9eee4f5302f2cd90f8251dfd84ae17dc19472455723b7e9f99a9aa19c0ed8806. No manual installed-game writes, player/world edits, mod removal or server restart. Existing server wrapper remains 1e8511088812e379e2237216ef294c7b94877057c1a13f3a18fb655456c1be95. Final owner gameplay acceptance pending; failure remains guarded rather than transmitting a staging location.

0.1.17 published and anonymously verified: https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.17. 5 GitHub assets, 3 R2 objects, update signature PASS. Server unchanged; owner gameplay verification requested and pending.

## 0.1.17 owner gameplay confirmation
Owner confirms visible scenery and movement restored. Installed client hash matches 0.1.17. Runtime spawnResume log records cold-load at 2026-10-20T15:30:23.706Z and restored at 15:30:41.648Z (17.942 seconds), confirming successful exterior saved-location readiness and release. This confirms the reported black-screen/movement-lock scenario on this run; interior reconnect and long-session NPC stability remain separate acceptance items. No game/server/world changes made while recording this evidence.
