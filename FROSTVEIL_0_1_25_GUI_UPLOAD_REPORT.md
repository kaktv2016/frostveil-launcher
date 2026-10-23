# GUI texture upload candidate — Launcher 0.1.25 / recipe 1.0.19

Native source: SkyMP `1dd5a6ff`, branch wip/gui-performance-profiling.
DLL SHA256 `52b7572f75f5b09fe8db8bf6f04931522c11d6573181bf88ac5039042e09338d`, 15675904 bytes.

Owner-run 0.1.24 diagnostics measured 20–22 ms native upload CPU per paint, including Map/copy/Unmap under the shared renderer mutex, with paint frequency about 38–42 Hz while browser callbacks stayed near 60 Hz. Hiding the DOM gold cursor for 25 seconds did not remove the reported sluggishness or expensive uploads.

Native change moves CEF callbacks to CPU-only dirty-rectangle staging and performs UpdateSubresource on the render thread after releasing the CPU-buffer mutex. A DEFAULT texture preserves unchanged pixels. Uploads and command-list execution on unchanged frames are removed. Initial/resize texture contents must be fully populated before drawing. No arbitrary hooks, CEF flags, shared GPU resources or game data changes.

Native Release build and standalone surface tests pass. RP regressions 313/313 pass. Launcher fixtures cover native repair, corrupt/missing/old bytes, idempotence and running-game refusal. Other 648 recipe targets are unchanged; exact known requirements for the prior native releases map to the new pinned identity. Unknown requirements retain existing integrity refusal behavior.

Release gates, public signature/hash verification and final status are recorded in `.local/gui-opt/`. The package must not publish if critical gates fail. Existing signed 0.1.24 artifacts and recipe remain available for rollback through the established pipeline. No installed player files are changed manually.

Owner acceptance pending: close Skyrim, update Launcher to 0.1.25, start it with FROSTVEIL_GUI_PROFILE=1 and use Play to repair the native file. Compare static GUI, rapid cursor movement/clicks, ESC/F7/Thai input, repeated open/close, reconnect and loading. Compare paint/upload/frame-interval P95/P99 and confirm visual preservation. No after-fix improvement or in-game success is asserted before that run.

Previous attempt BLOCKED: full regression 482/483, installed NSIS handoff correctly refuses while actual Skyrim/SKSE is running. Original diagnostic log: .local/gui-opt/regression-serial.log. Candidate is staged on R2, not published in Launcher updates. Close the game normally and rerun required verification; do not bypass the process guard.

A second NSIS run with the game closed completed update handoffs but cleanup failed with transient ENOTEMPTY; immediate inventory found the owned temporary directory empty. Test-only removeLockedTree now retries ENOTEMPTY alongside EBUSY/EPERM, bounded to 31 delays of 250 ms, and preserves unrelated/persistent errors. Three new focused tests cover recovery, unrelated errors and exhaustion. Production installation/process checks are unchanged. Full regression count is now 486.

FINAL RELEASE: https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.25 . Full regressions 486/486 PASS, no skips; production NSIS package rebuilt after tests; packaged smoke PASS. Every public GitHub/R2 asset anonymously downloaded and hash verified; pinned Ed25519 update manifest authenticated. Release plan SHA256 bab5ecab03c5bcbee9802c7401d586d06c6df11c3a531e0226c0f6a8b47166f5; installer SHA256 a3f15f0d39468ecbd451e4a707d0d22262bdc2c1b0f58f288b4370b10bd1ecc7. Earlier blocked gates are resolved; original failure diagnostics retained locally. Owner in-game performance/visual verification remains pending. No server restart or direct player installation writes performed.
