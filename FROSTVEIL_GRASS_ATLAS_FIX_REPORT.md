# Frostveil — Purple grass atlas repair

20 October 2026 · Launcher 0.1.13 · Repair recipe 1.0.8

## Cause

The previous source import completed: Launcher logged 440 files restored. A complete read-only native/CCC/plugin audit then followed 52,183 winning LAND records through 91 used LTEX records into 50 grass models. Their diffuse files exist, DDS payloads are valid and alpha testing is enabled. Missing diffuse files alone do not explain the continuing screenshot.

The installed Community Shaders 1.9.1 core is mixed with a legacy GrassLighting descriptor **2-0-0** and helper. Its current log rejects that feature; `Data/ShaderCache/Info.ini` records `GrassLighting Enabled=false`. Official 1.9.1 requires the matching descriptor **2-0-3**. Without the feature's `GRASS_LIGHTING` define, RunGrass samples the full complex grass atlas as ordinary color. That includes the opaque lavender normal/specular half, producing the visible purple cards.

## Targeted repair

Launcher restores exactly two official matching files, **1,021 bytes total**, after the base graphics check:

- `Data/Shaders/Features/GrassLighting.ini`
- `Data/Shaders/GrassLighting/GrassLighting.hlsli`

The previous 503 recipe entries remain byte-for-byte unchanged. The new hash-pinned recipe has 505 targets. Community Shaders' built-in cache validation detects the disabled-to-enabled/version transition and rebuilds cache on the next launch; the Launcher does not manually delete caches, disable mods, replace the native CS DLL, change user shader settings or touch the server/world. An interrupted 1.0.7 transaction can recover under 1.0.8, retaining per-target hash checks.

The files are MIT-licensed shader source. Original copyright/license text and attribution are included in the recipe and corresponding source snapshot. No protected Lux/FFM payloads are mirrored. Existing archives in Downloads remain the source fallback for the prior repair.

## Validation and remaining acceptance

Focused tests reproduce legacy descriptor repair, paired installation, idempotence, rejection of unreviewed shader targets, running-game refusal and compatible recovery. The complete original-source fixture imports and verifies 505 targets and confirms installed player files remain unchanged. Typecheck, regression, packaging and public update verification are retained under `.local/grass-atlas/`.

No manual installed-game writes or server restart occurred. In-game visual acceptance is pending: close Skyrim, update Launcher to0.1.13, then Play. Wait for the shader cache rebuild and inspect the same grass in daylight. The mechanism and source match are verified; a post-repair screenshot has not yet been observed. Separate online plugin-index incompatibility from the earlier audit remains outside this targeted fix.

## Primary implementation references

- [Feature loading and cache validation](https://github.com/community-shaders/skyrim-community-shaders/blob/v1.9.1/src/Feature.cpp)
- [Grass shader define selection](https://github.com/community-shaders/skyrim-community-shaders/blob/v1.9.1/src/ShaderCache.cpp)
- [Complex grass atlas sampling](https://github.com/community-shaders/skyrim-community-shaders/blob/v1.9.1/package/Shaders/RunGrass.hlsl)

Read-only evidence: `../mod-dist/graphics-repair-108/shaders/` and `dependencies/`. Recipe SHA-256: `fac86e764558bc6027d81aca9470e74d8233a5f4401a0c5ca34fce3b6a0b3ac2`.

## Delivery results

- Published [v0.1.13](https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.13), signed update metadata uses the existing production publisher and real GitHub asset ID.
- Final regression **464/464 passed**, typecheck/NSIS build and packaged Electron smoke passed. Full original-source fixture verified **505/505** targets, second simulated Play changed0, real installed game files unchanged.
- Installer SHA-256: `ecbeb4019017764347d0c6ea719b3500d0503b4f62dc3e5d5da1b767ba88fdae`.
- Corresponding source SHA-256: `7b0a43d92df437eab1e2489c3a47b8259c08bf5cfc632b238d41db20a5289518`.
- R2 recipe downloaded anonymously and matched the pin. Public GitHub asset hashes and update authentication evidence are recorded in `.local/grass-atlas/anonymous-release-verification.json` after verification.
