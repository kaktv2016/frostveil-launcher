# Frostveil Launcher 0.1.22 release

Published: https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.22

Root cause: two full NSIS fixture builds consumed ~117 seconds of a 180-second whole-test budget. The verified application update completed; cleanup encountered transient Windows EBUSY. Preserve distinct 0.1.5/0.1.6 builds (each embeds unique temporary boot paths); unsafe cross-run caching would invalidate isolation. Both real IPC handoff/restart and verified engine installation remain required and executed.

Fix: stage logs, bounded cleanup retries only EBUSY/EPERM (31 retries, 250ms); other errors propagate. Close loopback connections during cleanup. Test-specific 300-second budget includes measured build plus runtime and cleanup; existing 30/90-second readiness waits preserved. No production updater/signature bypass or gameplay change.

Verification: full 482/482; focused repeated NSIS 1/1, ~177s and ~179s whole-test duration, cleanup ~3.5s/~3.0s. Typecheck, native Play repair fixtures, packaged Electron smoke, production metadata and pinned trust regression passed. Existing rollback/failed-install recovery regressions passed. Public installer, blockmap, latest.yml, source archives and Ed25519 manifest downloaded anonymously and SHA-256 checked. Manifest authenticated against pinned production key, installer SHA512 and GitHub release identity. GitHub release immutable=false; authenticity remains enforced by signed manifest and pinned hash.

Final repeat stage timings:

- build: 1.08s
- package-015: 58.87s
- package-016: 51.51s
- install-015: 10.78s
- launch-installed: 3.66s
- first-window: 0.26s
- update-check-available: 0.13s
- download-verify: 4.02s
- handoff-install: 4.55s
- new-app-ready: 19.56s
- close-app: 0.35s
- engine-check: 0.03s
- engine-download: 1.84s
- engine-install: 14.30s
- http-close: 0.00s
- cleanup-temp: 2.99s

Evidence: .local/cursor-renderer/{full-final.log,repeat-final.log,stages.jsonl}; delivery/publication-verified.json; sealed plan SHA256 3204cfc34f28d6cf80fe07e91feb7c7ae0c9df2a86fec8da3c8fa626b7b392c1.

No installed Skyrim, world, saves or economy data touched. Owner acceptance pending: close Skyrim, Check for Updates to 0.1.22, Play; open Clerk dialogue, verify gold cursor only and click alignment; ESC, inventory, reopen/reconnect. Native rendering at actual DPI/resolution needs owner confirmation.
