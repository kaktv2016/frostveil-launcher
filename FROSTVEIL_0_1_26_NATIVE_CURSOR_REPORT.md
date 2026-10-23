# Frostveil Launcher 0.1.26 — Native dialogue cursor

## Change
Deliver native DLL c91b5ed52adf1328877366c9497a668e2abaf1c5314b2b9ed422b762320f1a66 (15,676,928 bytes), recipe 1.0.20. Only the native renderer member changes; 648 other recipe entries are identical to 1.0.19. Launcher version changes to authenticate the new native pin through the established signed updater.

The game-side dialogue opts into a gold native sprite through optional APIs and restores prior cursor visibility/style on all close paths. Older clients continue the DOM fallback. Native renderer shares existing click coordinates, uses a 1px hotspot and 28x36 sprite, and does not wait for CEF page paints. Display was measured at 200 Hz while CEF rAF is 60 Hz; this removes that extra cursor paint dependency without promising 200 FPS. Owner verification is still pending.

## Validation and rollback
Native Release build passed. Game regression suite 318/318. Isolated Launcher repair fixture passed: missing/old/corrupt native repair, backup of unknown existing content, running-game refusal, repeat no-op. Typecheck passed. Full NSIS/install/update/signature regression and production packaging results recorded below after completion.

Known-good 0.1.25 native/recipe remain in `.local/gui-opt/delivery` and on R2/GitHub; no installed player files are written by this workflow. Server code/config rollback snapshot is `skymp/build/rp-audit/g22/dialogue-1792750632992`; deployment protected and verified 89 data files unchanged. Never restore world/economy/player snapshots as part of code rollback. Reverting a native pin must use a newly signed forward Launcher release rather than bypassing updater rollback rules.

Manual acceptance: update via Check for Updates, Play, open Guild Clerk, move fast across buttons and confirm a single gold cursor, correct click hotspot, close with ESC, reopen, reconnect and repeat. Native smoothness and absence of visual ghosting require owner acceptance.

Validation completed: 486/486 Launcher tests (zero skips), full NSIS test including handoff and update engine, production NSIS packaging, packaged Electron fixture smoke, typecheck, repair fixture and anonymous R2 hash verification. Sealed plan SHA-256: d716bcb8e67cc403f3a5834b134488949d89b49c82e25f460c6cfa7726b416da. No tests bypassed. Protected installation, player and economy files were not edited manually.
