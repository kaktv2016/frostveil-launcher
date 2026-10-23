# 0.1.23 native preflight hotfix

Owner screenshot: after Play repaired SkyrimPlatformImpl.dll to 0.1.22 hash, ProductionDownloads still compared its external-only requirement against the old signed pack hash. Compatibility profile scan also retained the old hash. The 0.1.22 fixture tested repair in isolation and missed this downstream validation.

Fix: explicit reviewed old-to-new native requirement mapping, reused in signed pack matches and compatibility scan. The latter updates only when actual disk bytes match the approved new identity. Paths, baseline size/hash and new size/hash are fixed; other DLLs and unknown baseline requirements remain unchanged/rejected. No external-only distribution rule, download signature or hash checks disabled. Native DLL and source repair recipe unchanged.

Full regression 483/483, including Windows NSIS install, signed manifest/installer handoff, app restart and recovery regressions. Typecheck, packaged Electron smoke and metadata audit pass. Public 0.1.23 installer, blockmap, latest.yml, corresponding source and Ed25519 manifest downloaded anonymously and checked against sealed plan/hash; manifest authenticated by production pin.

https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.23

Installer SHA256 3b75834121efe12ed6d8b680a551a069f25338deccd60f5412e27f81355a5ab2. Plan SHA256 859988a812bfb2bd312386d723ba6278bbee2da7de826674a0bf29125aef607a. Evidence: .local/native-preflight/delivery/publication-verified.json; .local/cursor-renderer/tests-0123.log. No installed Skyrim or world/economy data written. Owner acceptance pending: update to 0.1.23, Play, enter server, E at Clerk, check gold cursor only/hover/click/ESC restoration.
