# Frostveil L4-B — 2026-10-15 Asia/Bangkok

Launcher **0.1.4**. **L4-B local implementation complete. PRODUCTION DISTRIBUTION NOT READY. PUBLIC RELEASE NOT YET AUTHORIZED. REAL SKYRIM INSTALL DISABLED.**

## Verified results

| Area | Result / evidence |
|---|---|
| Repository | **GITHUB REPOSITORY VERIFIED**: [kaktv2016/frostveil-distribution](https://github.com/kaktv2016/frostveil-distribution), PUBLIC, owner kaktv2016, ADMIN, main. Audited source pushed at `1c223f11fcdf59529efa3f5800f6c0f7505a87c9` (initial snapshot `1ee3293f4ced23320cffd7a317b71febc1619aef`). **0 Releases, 0 tags.** |
| Source audit | 32 tracked source/config/docs files; no game/SKSE/SkyMP/Nexus binaries, private keys, tokens, world/player data, local paths or test evidence. Exact shared V1 source snapshot hashes use canonical LF with .gitattributes. Original synthetic payloads stay in ignored local artifacts/temp sandboxes. No new third-party redistribution license is invented. |
| Automated tests | **AUTOMATED TEST PASSED: 230/230 launcher tests**, 0 failed/skipped: 170 L1–L4-A regressions + 60 L4-B cases (policy 25, real network 27, integration 5, service 3). Distribution preparation tooling separately **2/2** passed locally and in GitHub CI. |
| Level A network | **REAL LOCAL NETWORK VERIFIED**: actual loopback HTTP metadata/envelope/direct bytes; streamed bounded acquisition; valid Range/ETag resume; interrupted connections, full HTTP200 fallback, invalid ranges/changed ETags, retry/backoff, timeout, cancellation, corruption/hash/size/redirect refusal and simulated ENOSPC. Tests do not replace transport with success mocks. |
| Installation | **REAL SANDBOX VERIFIED**: acquired bytes feed the existing L4-A acquisition/staging engine. Two-file signed install, current receipt/target hashes, managed upgrade, verified backup, explicit rollback, injected partial-apply rollback and fresh-service recovery passed. Standalone Node and source/packaged Electron UI smoke passed. |
| Crash/restart | Owned Node children were terminated during remote acquisition and after target rename; persistent journal recovery and installation retry passed. Existing L4-A terminated-process/Windows file-lock cases remain passing. Committed current rollback restores across service restart. Invalid/missing referenced recovery evidence stays blocked; its pointer cannot be silently replaced. |
| Build/package | TypeScript, main/preload/React, Windows unpacked and NSIS **PASSED**. Source and packaged fixture smoke **PASSED**; L2 signing refusal and L1 Play refusal in fixture preserved. No real game launched. |
| Package audit | L2/L3/L4-A/L4-B package audits passed. No private profiles, fixture private key, tokens, download/transaction evidence or game assets in app.asar. App/install/executable/user-data identities preserved. |
| Actual environment | Read-only Skyrim **1.6.1170.0**, SKSE resource **0.2.2.6 (= 2.2.6)**, **24/24 baseline files match**. SHA256 before/after **53 protected paths unchanged**, including masters/archive/client/config, plugins/load order, server settings/manifest and existing rp-world character state. Final network sandbox rerun also left **710 observed game tree entries unchanged** (metadata comparison, not whole-game hashing). The final sandbox run also preserved **1 available save-directory file SHA256**; two other checked save locations remained absent. No game/mod/load-order/server/world writes or server restart; only owned test processes were stopped. |
| GitHub discovery | Actual main-process provider anonymously queried the fixed official stable endpoint and returned **404 / no published release**, accurately. No GitHub asset was downloaded/authenticated. This is discovery evidence, not Level B acceptance. |
| Actions | [Distribution validation at current source](https://github.com/kaktv2016/frostveil-distribution/actions/runs/38616397948) **SUCCESS**: npm ci/typecheck/build/tests/privacy/snapshot checks. First CI failed because npm treats `prepare` as an install lifecycle hook; fixed to explicit `prepare:offline`, standard npm ci and later CI passed. Launcher Windows CI is updated locally but **NOT RUN remotely** on uncommitted L3/L4-A/L4-B. |
| Publication gate | Manual preparation workflow has contents:read only, no signing secrets, Release/tag/payload uploads or production signing. `production-distribution` environment requires owner review and main branch; GitHub currently permits administrator bypass. No publication job exists. Repository immutable-releases API: **enabled=false, enforced_by_owner=false**; no immutability claim. |

## Implemented design and preparation

**IMPLEMENTED:** Existing Manifest V1 names/schema remain. Optional `distribution.release` binds fixed owner/repo/tag; eligible files have separate direct-file `package` identities: asset name/ID, size/SHA256, component/pack version and reviewed rights. Installed paths remain distinct. Native/runtime/executable requirements remain external/manual; mislabeled ownership cannot authorize their acquisition. No ZIP/FOMOD/hooks or second parser/installer.

L3 Ed25519 authenticates exact payload bytes. Publisher preparation validates the same schema, source hashes and actual read snapshot, rights and assigned release asset bindings, canonicalizes sorted UTF-8 JSON, signs only an explicit reviewed Ed25519 identity and independently verifies the output. Owned original assets are eligible; permitted content needs an approved canonical permission fingerprint in trusted configuration. Credit/signature alone is insufficient.

Pinned key IDs/environment/revocation checks, fixed pack/repository/channel, exact release resolution and bounded persisted highest-version/hash history reject wrong roots, cross-pack/repository substitution, downgrade/replay and same-version mutation. Production pins remain **empty**. No candidate production private/public identity was generated, selected, pinned or published. Deterministic keys exist only in excluded test fixtures; interactive/local preparation uses ephemeral sandbox-only keys in memory.

Downloads use anonymous HTTPS GitHub asset-ID endpoints, manual bounded GitHub delivery redirects, no credentials, sequential streaming (concurrency 1), max 32 MiB/direct file and 64 managed files. HMAC-authenticated partial metadata binds release/asset/hash/ETag, exact identity and prefix hash. Restart validates the saved prefix and discards an uncheckpointed tail; unknown nonempty partials remain conflicts. HTTP200 reset intent is persisted before truncation. Final cache promotion uses a separately verified/synced temporary file and rename; L4-A independently verifies/stages those bytes again before applying.

Narrow no-argument IPC supports fixed-source check/status/preview, loopback sandbox run, cancellation and validated sandbox rollback/recovery. Renderer supplies no URL/repository/path/key/payload/override. Existing CSP/context isolation/sandbox/sender checks, L1 Play/backups, L2 update policy, L3 scanner and L4-A demo remain. Release notes use escaped React text.

Local tool examples in the distribution repository:

```text
npm ci
npm run typecheck
npm run build
npm test
npm run audit
npm run prepare:synthetic -- 1.0.1 --output .artifacts/new-empty-draft-directory
npm run verify -- .artifacts/new-empty-draft-directory
```

Prepared local draft `.artifacts/local-reviewed-draft`: two original 30-byte text assets, signed envelope, test public source, release metadata and publication summary, independently verified. No private key output and no upload. Production CLI is `prepare:offline` with explicit definition/source/key/approval/output flags; identity/approval/output must be outside the repo. Current production approval/root is missing. See distribution README for input format. CI preparation only produces ephemeral test diagnostics on its runner; it does not upload publicly downloadable payload artifacts.

## Artifacts, manual checks and remaining gates

- NSIS: `release/SkyrimRPLauncher-0.1.4-x64-local.exe`, **112,280,262 bytes**, Authenticode **NotSigned**. SHA256 `2381f168b1348bd40058fa679a5c839609def68976802740bfeb83d2467edcec`.
- Unpacked: `release/win-unpacked/Skyrim RP Launcher.exe`. The installed launcher was not overwritten/run by the agent. L2 production Windows signing remains a separate blocker; no self-update bypass.
- Install local 0.1.4 over the existing installation manually, then Updates → **Run Local Network Sandbox**: five passed checks, eight acquired packages, sandbox 1.0.4. **Rollback Sandbox Update** returns 1.0.1; **Recover Distribution Sandbox** reports verified. The agent's source/packaged smoke exercised these controls, but real installed GUI acceptance is still manual.
- **Check Trusted Distribution** currently reports no release/404. Production trust is unconfigured. No enabled actual-Skyrim Install button exists. Play/server checks remain optional user regression testing; no real multiplayer result is claimed here.
- **Level B: BLOCKED / NOT YET AUTHORIZED.** Needs separate approval of a harmless public synthetic Release, its test publisher identity and exact assets/tag. Then verify actual anonymous GitHub downloads/signature/hashes/install/rollback. Current local HTTP success does not satisfy Level B.
- Before L4-C: finish Level B; separately review/pin production identity/rotation/rights; enable/verify release immutability and review environment bypass; define fresh/live server compatibility and seven-day V1 snapshot handling; review real-game targets/process coordination/permissions, cache/history retention and disk budgeting. Obtain explicit authorization for actual Skyrim installation. **L4-C not started.**

Durability limits remain: file sync/rename and demonstrated terminated-process recovery do not prove sudden power loss, storage corruption or every crash instant. Same-user hostile filesystem races and private-key ACL/vault provisioning are not solved. Cached partial/transaction evidence is retained without automatic cleanup; production history is bounded and does not resist a hostile user editing their own storage. Beta is supported by explicit trusted provider policy/tests, while the existing L2 UI beta switch remains disabled.

Launcher changes remain uncommitted/unpushed at existing HEAD `5eb2cf773deaaa47b460b17e02926913d856a90b`; cumulative L3/L4-A/L4-B publication needs its own audit/approval. Only authorized audited distribution source was committed/pushed. SkyMP develop and its prior local changes were preserved.

Main changes: `src/main/distribution/`, optional V1 bindings, L4-A acquisition hook/current rollback lookup and synthetic binding, main/preload/shared/DistributionPanel integration, tests, smoke/audit/CI/version/README/plan/report. Private `.local/l4b-*` evidence is ignored and not packaged/published. Independent reviewer findings were reproduced, fixed and regression-tested; final scoped recheck found no remaining Important findings.
