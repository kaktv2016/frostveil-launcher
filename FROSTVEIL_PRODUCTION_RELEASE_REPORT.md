# Frostveil first production release — verified execution report

Date: 2026-10-16. Evidence finalized: 2026-10-16T08:15:46.864Z.

**PRODUCTION KEYS PINNED · SOURCE AUDITED AND PUSHED · LAUNCHER v0.1.6 RELEASE PUBLISHED · MODPACK pack-v1.0.0 RELEASE PUBLISHED.**

The owner's FIRST PRODUCTION RELEASE brief authorizes A–D. E (real Skyrim writes) is excluded. Both public releases were actually published and tested. L5, Nexus integration, new gameplay and real game/server operations were not performed.

## Independent production trust and offline recovery

| Channel | Key ID | Full public SPKI SHA-256 |
|---|---|---|
| Launcher | `frostveil-launcher-update-20261016` | `44b402b99394515908c10c72d2e6e77ad210a1b36248e5bafe991b59183b0fea` |
| Modpack | `frostveil-modpack-publisher-20261016` | `7eded189b364ffc31c5c9730c7b73c0b13424b60576313a0197a6327b5633369` |

Both keys are Ed25519, environment=production, not revoked in configured trust, expiry **2027-10-16T00:00:00.000Z**. Local possession challenges, independent signature verification and exact packaged public pins passed. No replacement production keys were generated. Unknown, expired, cross-channel and synthetic Level B publishers remain rejected.

**Offline backup VERIFIED:** owner-selected removable USB, AES-256-GCM with scrypt N=131072/r=8/p=1; encrypted bundle 1,492 bytes, SHA-256 `fd2e83dc470c968ee0ae1d25b6cd73537755f9973d32e9a24a4030de49949d3b`. USB readback/decryption recovered both approved public fingerprints and passed fresh challenges. Owner confirmed USB detached/password separate; drive absence was checked before activation. FAT32 lacks NTFS ACLs, so only encrypted key bytes were exported; live keys retain owner/SYSTEM ACLs outside repositories. No password or plaintext private key entered source, artifacts or logs.

Recovery: attach the offline medium locally, decrypt into a protected signing location outside repositories, independently compare both public fingerprints, and sign a fresh random challenge before use. Detach the medium afterward. Keep its password separate. Rotation/revocation needs separately approved identities, audited trust configuration and a new signed Launcher release; compromise recovery may require a separately verified manual bootstrap. Preserve independent channel identities and prior immutable releases.

## Source and Windows verification

Launcher repository: [kaktv2016/frostveil-launcher](https://github.com/kaktv2016/frostveil-launcher). Release source commit **`4fc1ab067e88a0bdcf39174afb74af30e86cad61`**.

Cumulative approved implementation: `c07cc1a4935d14863184c0017501c85c4055c8c0`; trust-audit correction `6b81782f99361c6b0c108afca6ec92897cdde38f`; diagnostic source `18c24d2f60eaed70d3daafcb74654c1538bf7c94`; Windows canonical identity correction `fcbeaeab9c065118287271279ddc512d8c24c83f`; final disposable NSIS environment correction is the release source above. Normal commits/pushes only; no force/reset or source push to Distribution.

Distribution target commit: `1c223f11fcdf59529efa3f5800f6c0f7505a87c9`. SkyMP remains `develop`, checkout `5397cd3bf4666c942f78193107881d8cf0ac2748`; native engine baseline `2849e676fe008925384b26f34476e382a30bd877`.

Remote Windows CI: **PASSED**, [release-source run](https://github.com/kaktv2016/frostveil-launcher/actions/runs/38870565335). Node 24.11.1, locked npm dependencies, contents:read, no automated publication/secrets.

| Check | Actual result |
|---|---|
| Launcher TypeScript and full automated suite | PASSED; 401 passed, 0 failed, 0 skipped |
| Distribution typecheck and tests | PASSED; 4 passed, 0 failed, 0 skipped |
| Windows NSIS packaging | PASSED; final version 0.1.6 |
| Source and packaged Electron fixture smoke | PASSED |
| Artifact/privacy, L3, L4-A, L4-B, L4-C audits | PASSED; independent exact public fingerprints checked in packaged code |
| Actual isolated installed-app NSIS 0.1.5 → 0.1.6 | PASSED locally and remote CI; real Main/bootstrap, IPC, verified default handoff/spawn, old quit, new --updated restart/window readiness |
| Existing settings / authenticated ownership / journals / backups across NSIS | PASSED; exact bytes/HMAC evidence preserved |
| Production anonymous Launcher check/download | PASSED using normal production NsisEngine; install() never called |
| Production anonymous Modpack provider/download | PASSED; three package hashes/sizes and production signature verified |
| Production bytes managed sandbox | Fresh installation, owned upgrade, backup, rollback and killed-child/reopened recovery PASSED |
| Real protected files | 63 paths, **0 changes**; no real installation apply |

Earlier remote CI exposed four failures; those runs were not treated as success. Genuine Windows short8.3/full-path identity errors were reproduced and corrected with filesystem canonicalization while retaining link/capability checks. The 80ms retry fixture was replaced by an explicitly stalled first request and bounded realistic timeout; user cancellation remains non-retried. NSIS already upgraded, but the runner's Explorer restart changed session TEMP to Temp/2; only disposable test entries now preserve their initial TEMP/TMP. Production validators were not relaxed. Installer transfer separately permits a bounded 30-minute stream while metadata remains bounded to15 seconds. Read-only review found no blocking issues.

## Published Launcher

[Frostveil Launcher v0.1.6](https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.6) — release ID **414697483**, stable. Draft-first upload/readback used real asset IDs before signing. Exactly four assets; anonymous installer SHA-256/SHA-512/size match the final sealed build and signed manifest. latest.yml consistency and blockmap bytes verified independently.

| Asset | GitHub asset ID | Bytes | SHA-256 |
|---|---:|---:|---|
| frostveil-launcher-update.json | 646625083 | 1316 | `820cc590ecbf3bf56580637b75b815d03747a76580e63636281712effd630a35` |
| latest.yml | 646624955 | 369 | `48c2ba34c84cee0ca486771d5fd8d5d0bec70f7839cb366e7ae8e9a4fceb7dac` |
| SkyrimRPLauncher-0.1.6-x64-local.exe | 646623677 | 112344076 | `bac287620d90a4a9ef4bd8ef94e9abaf5ac994e8f9b258a1f61f596be6d23d49` |
| SkyrimRPLauncher-0.1.6-x64-local.exe.blockmap | 646624827 | 118149 | `9844b79d066aaae89fb6d9c0a8ae8ff84cbc95d187996666ac8aa3b87d700336` |

Installer SHA-512 (base64): `VQk6SsuuC3goKE6jjetr8RmILRBT/KZrgM50QM18isXYHt5p3Nu/BkmuNO/4rzN+MPO0gsa14l9LjGW8bSgBuQ==`.

Other final asset SHA-512 (base64):
- SkyrimRPLauncher-0.1.6-x64-local.exe.blockmap: `kjpHUbHQSeA2yaPv4XzNna2EOklwcNE7y3Q6tO/o8474uh6JuTDSMhMMtqetv6frUAvIXLx7MHUT1bVS4225kw==`
- latest.yml: `nmqWbSdjGRAUFkMojbLzL+4LkCMaxEopOnZAhLJH/P4aOxG5bJ2nuwbv3z7JX8vmd6tlRE1TQ/RQBB/NUYhmeQ==`

Installer Authenticode: **NotSigned** (verified from the actual final executable). Ed25519 production update trust was verified independently; Windows Authenticode/SmartScreen signing was not claimed.

Launcher repository immutable releases: **disabled**, not owner-enforced; reported and left unchanged. Ed25519/size/hash/release-binding checks still apply. Distribution immutable releases: enabled; the published Modpack is verified immutable. No repository settings changed in this milestone.

## Published first-party Modpack

[Frostveil RP Pack v1.0.0](https://github.com/kaktv2016/frostveil-distribution/releases/tag/pack-v1.0.0) — release ID **414698726**, tag `pack-v1.0.0`, pack ID `frostveil-rp-pack`, stable, immutable. Minimum Launcher0.1.6; Skyrim1.6.1170.0; SKSE resource0.2.2.6 (release2.2.6). Exact original29 external-only references preserved; none redistributed.

| Owned payload | GitHub asset ID | Bytes | SHA-256 |
|---|---:|---:|---|
| frostveil-client-settings.json | 646627204 | 370 | `9a1d1d16c7271d816fd91f0699999ec516fdc0df26dae7dae67f35c85170bd21` |
| frostveil-client-readme.txt | 646627342 | 897 | `4bf195a94902b870f688522b3461a1b0c3abacdec8e55cc66340bca4a82ce921` |
| frostveil-hud-reference.html | 646627477 | 457 | `5bb5168fca942c7321bbedef569d26496eebcf14564d36093a6effa1817a9425` |

Signed manifest asset ID **646627659**, 22674 bytes; SHA-256 `e9b4c46a3003e21bc0b1d62c6e937d904277a7402172e5511e6945bcac9df907`.
Authenticated payload SHA-256: `8558058fe274a57a8e4aa419e300e2d63fdb0888d6693411268ddae80b268fc4`.

Managed payload SHA-512 (base64):
- frostveil-client-settings.json: `bkpFvHqGhaY1HkVSp9A3Z/NQuLNrqlW1ku1uMJYVJgkqBbj9M//wguw4Km0Tv2ybkLk1S++EJGVdERaGvQCLtA==`
- frostveil-client-readme.txt: `2VFzGLpjDrN9TLyi80jKKOods9Y9JX+t7Lt6wK5USu/MP/oe1wsFz7/SUtLr/2MlbjF2I6/2Z3cWSpuEyYeTNg==`
- frostveil-hud-reference.html: `Z+7VAfre4yfyJT8M9BSDtaALgJg4YZzRkycRdN58j0qWLhIXEZ8peRXXy+H476sSCdM4UhGXQJkl0ZICe7aarw==`

These three owned files are configuration/static references documenting implemented chat/profile/dice/Courier commands, not new gameplay or an implemented HUD renderer. No third-party mods, proprietary masters, SKSE/SkyMP binaries, private endpoints or player data were uploaded. Existing immutable test release `test-pack-v0.0.1`, ID414428948, was preserved with unchanged assets.

## Production-byte sandbox evidence

- Anonymous production bytes fresh installation and absence rollback PASS
- Owned prior generation upgrade, byte-verified backup and exact rollback PASS
- Owned child terminated after actual rename; reopened authenticated journal recovery and prior bytes PASS
- 29 local-only external requirements, unmanaged sentinel and activation bytes unchanged PASS

Only newly generated `managed-fixture` capabilities were authorized. The29 legitimately installed external files were copied locally to disposable fixtures without hardlinks; no additional redistribution occurred. A separately generated in-memory TEST key supplied a prior owned generation, was explicitly rejected by production authentication, and was never published or pinned. Upgrade then consumed the actual anonymously downloaded v1.0.0 bytes. Actual verified backup bytes restored that prior generation. An owned Node worker was terminated after a real rename; reopening authenticated journal evidence recovered the original bytes. No Skyrim/server/Steam process was launched, stopped or restarted.

## Real compatibility and remaining limits

29/29 local external requirements and five server master hash/CRC/header entries match the offline baseline. This proves file integrity/offline snapshot correspondence. **Live server compatibility and production player acceptance remain UNVERIFIED.** Existing active Creation Club light/ESL plugins are preserved and keep the real preflight **UNVERIFIED**. They were not deactivated to clear the warning.

Signed offline server snapshot expires **2026-10-23T08:09:13.587Z** (maximum seven-day schema lifetime). After expiry, safe verification blocks installation until a separately reviewed/published compatible snapshot/release is approved; immutable metadata will not be edited in place.

Installed0.1.4 may need one manual0.1.6 bootstrap installation. This first public release does not prove public0.1.6→0.1.7 self-update; a later separately approved release is required. Production installer Authenticode is independent of the verified Ed25519 channel; do not infer Authenticode trust from the manifest signature. L1 first-player compatibility-profile provisioning remains a separate deployment limitation.

**REAL SKYRIM INSTALL NOT YET EXECUTED.** The actual signed production metadata was used to produce a deterministic read-only ManagedPlan (hash `d6c33c4954edbf0bb9868551e7622f44ec041793d01f7d3c6d8ec751a73a4c0b`). The real plan remains BLOCKED; NEW PREFLIGHT/PLAN REQUIRED BEFORE OWNER APPROVAL. See [real installation readiness](FROSTVEIL_REAL_INSTALL_READY.md). Approval E is still excluded; no fresh owner authorization was requested or consumed. L5/Nexus work was not started.

Read-only planning context: Codex's MSIX packaging redirects newly created LocalAppData metadata children. Root-identity validation correctly refused that redirected metadata path. Planning therefore used an explicit persistent private audit metadata root outside Git/cloud/game files; production validators were not changed. The installed Launcher must create its own fresh plan from its actual storage/ownership receipt before E can be considered. The retained hash describes this audit plan, not an authorization accepted by the installed UI.
