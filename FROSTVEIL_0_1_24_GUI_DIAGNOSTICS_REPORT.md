# Launcher 0.1.24 — native GUI diagnostics delivery

This is an opt-in measurement build, not a confirmed GUI performance fix.
Native source is on SkyMP branch wip/gui-performance-profiling. Existing custom cursor behavior is preserved.

DLL SHA256: `8549f8be88fefec1341399a64293b3798c8ea5f20c34a60204d0088759d4025b` (15674880 bytes).
Recipe 1.0.18 changes only the DLL; other 648 entries are unchanged.
Reviewed compatibility transitions include both ce58aa2d (original) and 18b530ef (cursor build). Unknown hash/path requirements remain unchanged and fail existing integrity checks.

Native build, typecheck, isolated DLL repair fixtures and packaged smoke pass. Fixtures cover old/missing/corrupt native files, running-game refusal and idempotence without touching the owner's installation. R2 DLL/archive/recipe have been anonymously downloaded and hash checked.

Initial regression run passed 482/483 and failed the installed NSIS test's key-ID assertion while a production package build was running concurrently. Both paths build/read the shared dist output, so concurrent execution is unsafe. A serial focused NSIS rerun passed including both verified install handoffs. Full serial regression and final publication evidence are recorded in `.local/gui-native/`; the failed original log is retained unchanged. Do not publish unless the full serial regression passes.

After publication, close Skyrim, update Launcher to 0.1.24, then close Launcher. In PowerShell set `$env:FROSTVEIL_GUI_PROFILE='1'` and start the installed Launcher from that PowerShell; use Play for automatic signed/pinned repair. Do not copy the DLL manually. Native logs include `[FV-GUI-PROFILE]` summaries every five seconds. Repeat the existing baseline/dialogue/mouse/open-close scenarios once; disable the environment flag and restart after measurement. No game FPS or input-to-display improvement is asserted by this release.

Recovery: previous 0.1.23 release, its native source archive and recipe are retained. New update pin and archive hashes are authenticated through the established Ed25519 updater manifest; no signature checks are bypassed. No server, player, world, or economy files are modified by release scripts.

## Published evidence

Full serial regressions: 483/483 PASS, no skips. Production package rebuilt after tests; packaged smoke and metadata checks pass. R2 payloads and every GitHub asset downloaded anonymously and hash verified; pinned Ed25519 update envelope authenticated against public release metadata. Release: https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.24 . Plan SHA256 c91f18420453ab183e4557850985d0d3d4a6daa63d4d408343acf30baadfc122. GitHub release is not immutable; signed manifest and pinned content hashes still apply. Native profiling/GUI performance acceptance is pending the owner updating and running with the environment flag.
