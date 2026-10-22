# FROSTVEIL — Automatic R2 Player Delivery / Launcher 0.1.14

Owner authorized uploading supplied mod archives and automatic Launcher installation. No additional deployment approval is pending.

## Implemented
- Play downloads missing source archives automatically from Cloudflare R2; no manually prepared Downloads/mod-work folder is required.
- Six content-addressed archives (1,319,379,489 bytes): the original five graphics/dependency sources and a reviewed player bootstrap.
- Recipe 1.0.9 verifies 647 targets, including the prior 505 graphics repairs and 142 bootstrap files: SKSE 2.2.6 with its scripts, SkyMP native/browser resources and Thai locale, the reviewed current client JS, settings, RP browser page and SkyUI.
- Graphics pack and the signed server pack are still acquired through existing verified flows. Bootstrap matches the authenticated production baseline; the reviewed client transition uses the 0.1.11 hang-fix identity. No new native versions or plugin/load-order changes were introduced by this release.
- The bundled recipe hash authenticates URLs, archive sizes/hashes, members and installed files. HTTPS is restricted to the configured R2 origin with hash-addressed keys; redirects are rejected. Downloads stream to storage outside the game, cache is reverified and corrupt cache quarantined. Valid files require no download on later Play.
- Staging, backup, atomic replacement, rollback, running-game guard and compatible recovery from interrupted 1.0.7/1.0.8 operations are retained. Cancel now reaches active R2 streams and repair writes; interrupted apply restores previous assets and prevents launch.
- No tool installed files into the real player game, removed/disabled mods, changed a world/save, restarted the server, or pushed source.

## Validation
- Typecheck and NSIS build passed. Full regression suite: 471 passed, 0 failed.
- Packaged Electron fixture smoke passed without launching Skyrim.
- Fresh-player disposable fixture started with Steam game files only, including the free Creations/resource pack supplied with 1.6.1170. No mod archives or mod assets were preloaded. Base graphics and all six source archives were obtained anonymously over the public network.
- All 647 targets verified; all active graphics plugins exist; signed server pack installed/activated; final runtime compatibility scan READY. A second complete preparation changed 0 source-repair files. Installed real-game observations remained unchanged. Elapsed fixture time: 391.83 seconds.
- Negative cases include missing/corrupt assets, wrong/oversize/failed/redirected downloads, untrusted URLs, missing SKSE, forbidden game-binary target, stale operation recovery, running-game refusal, active download cancellation and cancellation during apply. Independent code review found a Cancel gap, fixed before packaging, and no remaining P1/P2 findings on follow-up.
- Public R2 anonymous archive/recipe hash checks passed. Public signed Launcher release verification is recorded in .local/r2-delivery/anonymous-release-verification.json after publication.

## Artifacts and rollback
- Recipe SHA-256: 5253ffe15a511fc33f3f79aab917d028258a567cb736205e149bdba6dd4f5a08; 494994 bytes.
- Installer SHA-256: 1a4a7e0702345a3c8be30abe66b51e7a27df040a0a609641037d722140d0bec0.
- R2 archive inventory/hashes: ../mod-dist/graphics-repair-109/archive-verification.json.
- R2 source plan: ../mod-dist/graphics-repair-109/source-repair-plan.json.
- Release: https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.14
- Installation keeps per-operation verified preimages in Launcher storage graphics-source-repair/<id>/before; pending operations recover on next Play. Do not overwrite already published immutable recipe keys. The 0.1.13 release and its pinned 1.0.8 metadata remain available; Launcher downgrade alone does not roll back installed mod files. Player files must continue to be restored through Launcher transactions, not manual tool copies.

## Limits and owner acceptance
This is file-installation/launch-readiness evidence, not gameplay certification. Owner should close Skyrim, update to 0.1.14, Play, let shaders rebuild and inspect affected flowers/shadows online. Existing server/client plugin/FormID parity and quest/admin gameplay issues remain outside this delivery change. Every future graphics combination and machine cannot be guaranteed bug-free.

Skyrim itself, native masters/BSAs and official free Creation content are never uploaded here; install/repair those through Steam. Authenticode remains unsigned; the independent production Ed25519 update trust is unchanged. The current connection settings are the existing development settings, not a newly configured public server endpoint.
