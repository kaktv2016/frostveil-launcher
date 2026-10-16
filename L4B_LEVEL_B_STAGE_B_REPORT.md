# L4-B Level B — Stage B execution report

Date: 2026-10-16, Asia/Bangkok. Launcher development version: **0.1.5**.

**PUBLIC TEST RELEASE PUBLISHED**  
**ANONYMOUS GITHUB DOWNLOAD VERIFIED**  
**ED25519 TEST SIGNATURE VERIFIED**  
**REAL GITHUB ASSETS INSTALLED IN SANDBOX**  
**MANAGED UPGRADE VERIFIED**  
**BACKUP / ROLLBACK VERIFIED**  
**RECOVERY VERIFIED**  
**REAL SKYRIM INSTALL DISABLED**  
**PRODUCTION DISTRIBUTION NOT READY**

Stage B used the exact approved Stage A candidate. The human operator explicitly authorized all five publication/settings/sandbox items in this chat on 16 October 2026. No second Release, source commit/push, real Mod publication, game/server write or L4-C work was performed. Stage A remains a historical prepublication report; this report supersedes its pending-execution status.

## Actual publication and repository settings

- Repository: [kaktv2016/frostveil-distribution](https://github.com/kaktv2016/frostveil-distribution).
- Release: [test-pack-v0.0.1](https://github.com/kaktv2016/frostveil-distribution/releases/tag/test-pack-v0.0.1).
- Release ID: **414428948**.
- Title: **Frostveil Distribution — Synthetic Integration Test**.
- Public, draft=false, prerelease=true, **immutable=true**.
- Published: **2026-10-16T01:13:45Z**, **16 October 2026 08:13:45 Asia/Bangkok**.
- Requested make_latest=false. Anonymous /releases/latest returns **404** because no stable Release exists; this test is not latest stable.
- Exact target commit and actual tag ref: **1c223f11fcdf59529efa3f5800f6c0f7505a87c9**. Remote main remains at this commit.
- Final readback: **one Release**, exactly **four uploaded assets**. Nothing was replaced or modified after publication.
- Canonical original publication plan SHA-256: **3fc408ec734dfedb89b2a44d8ac1a0ae749cda7fe27dd6f2a7790d2c1e3befe9**. Original plan/profile/template/payloads remain unchanged.

Approved settings were applied before creating the draft and independently read back:

| Setting | Before | Verified after |
|---|---|---|
| Immutable Releases | enabled=false | **enabled=true**, enforced_by_owner=false |
| Release immutability | No Release | **immutable=true** on this published Release |
| production-distribution admin bypass | true | **false** |
| Required reviewer | kaktv2016 | Preserved kaktv2016 |
| prevent_self_review | false | Preserved false |
| Deployment policy | custom branch policies | Preserved custom=true, protected=false |
| Allowed branch rule | main only | Preserved main only |

Only the two approved repository settings were changed. Existing workflows were not altered. Environment protections apply to workflow deployments, not every direct owner API call; the explicit operator approval remained enforced by the local publisher before API operations. No protected workflow job was bypassed and no write-permission workflow was introduced.

## Published assets — actual IDs, bytes and hashes

| Asset | Actual GitHub ID | Bytes | SHA-256 |
|---|---:|---:|---|
| frostveil-manifest.json | 645721097 | 7327 | 511a95dcef15c53d76a70eda6062114c86a1c9efaff3520f3aaf9670b3e5cc0a |
| frostveil-test-config-v0.0.1.dat | 645720808 | 57 | 78e9abe3db0d38dd2ec896fae6bba428ee8f9c915747dcc0a23ab9e806617382 |
| frostveil-test-publisher.json | 645720898 | 499 | efda9673d8462d7bce2168604e63edf294d7483ed0a766664a1a2c4b4647ed81 |
| frostveil-test-ui-v0.0.1.dat | 645720736 | 53 | b0411a3fe663336a6dd1d7c38554634e086d96abf94683fd2722f13b6647901b |

The three fixed files match their exact Stage A bytes/hashes. The fourth file was generated only after GitHub allocated the actual uploaded asset IDs. The manifest's package bindings contain **645720736** and **645720808** for the two approved data files, with their exact names, sizes, repository/tag and hashes. No placeholder IDs were signed.

Publication sequence actually executed: approval/plan revalidation → existing tag/release collision checks → draft creation → three fixed uploads → actual-ID readback → authenticated download/hash comparison of draft bytes → existing V1 validation/signing/independent verification → signed envelope upload → complete four-asset draft readback/hash verification → publish immutable prerelease. Authenticated draft reads were not counted as anonymous public evidence. A local published-result record retains the final public metadata and signed envelope.

## Publisher and trust evidence

- Key ID: **frostveil-level-b-test-20261015**.
- SPKI DER SHA-256 fingerprint: **c9d19a50b06f2d55c5e9a31c6ba85b947c021581faa56c44231679223ce31391**.
- Expiration unchanged: **2026-10-21T10:33:00.783Z** / **21 October 2026 17:33:00.783 Asia/Bangkok**.
- Key existed, was not revoked or expired; fingerprint, original domain-separated possession proof and fresh possession challenge all verified before publication. No replacement key was generated.
- Private key stayed in its existing protected external local directory. Parent inheritance remains disabled with two access rules (current user and SYSTEM); no ACL change, private-key upload/export, Actions secret registration or bundled private key.
- A separate local **public** operator test profile sets publicationApproved=true after this explicit authorization. It retains the exact approved identity/scope/expiry. The frozen Stage A profile in the publication plan remains false so its approved plan hash does not change.
- Test scope accepts only the fixed repository, test-pack-v0.0.1, frostveil-integration-test 0.0.1/beta, matching publisher and current expiry/revocation state. The profile is loaded only through explicit Main Process test flags; no renderer-supplied key or target path.
- The actual public envelope passed Ed25519 verification with existing V1 and release-binding checks. Authenticating it under production policy was rejected. Source/package audits confirm productionSource.keys remains empty; normal production UI stays UNVERIFIED/MISSING PRODUCTION TRUST ROOT and has no game-install capability.
- Packaged audit found no private PEM, committed fixture private material, credentials, private profiles, transaction evidence or candidate-specific public identity embedded in app.asar. The candidate key/fingerprint/key ID are external and explicitly enabled.

Rights: the data files are original inert ASCII, and publisher JSON contains only nonsecret test identity metadata. There are no real Mods, proprietary masters, DLL/EXE/PEX/ESP/ESM/ESL or executable payloads. Source-generated native-looking verification fixtures stayed inside disposable sandboxes and were not uploaded. The local NSIS installer was not uploaded.

## Actual anonymous acquisition

The existing DistributionTransport/GitHubDistributionProvider/PackageDownloader were used unchanged. Requests were observed in standalone verification and inside actual Electron Main Process source and packaged applications. Test instrumentation checked that neither Authorization nor Cookie headers were supplied; production transport retained credentials=omit and manual redirect handling. No CLI-authenticated download was used as public acceptance evidence.

Observed GitHub behavior: metadata API **200**; asset API **302** to the existing allowed **release-assets.githubusercontent.com** origin; asset delivery **200**. All strict URL/redirect policies remained unchanged. Temporary signed URL query strings and sensitive headers were not logged. Direct API asset-200 behavior remains covered by existing local regression cases; it was not the behavior observed for these public assets.

- All four unique public assets were independently downloaded and checked: **7,936 bytes** total (manifest 7,327 + publisher 499 + payloads 53 + 57).
- Both data files flowed through the real downloader into L4-A; hashes/sizes and finalized cache bytes were rechecked independently.
- Each three-sandbox Main Process run made **six** package acquisitions, totaling **330 payload bytes**, in addition to metadata/envelope bytes.
- Standalone observation totals: **29 HTTP requests**, **39884 response-body bytes**, including repeated assets, JSON metadata and negative-response bodies. This is not a claim of unique payload size.
- Source Main observation: **15 requests**, **15945 response-body bytes**, 7 asset redirects and 7 allowed delivery-200 responses.
- Packaged Main observation: **15 requests**, **15945 response-body bytes**, 7 asset redirects and 7 allowed delivery-200 responses.

Non-destructive actual API negatives passed: missing test tag test-pack-v0.0.404 → 404; missing asset ID999999999999999 → 404; latest stable → 404. Public artifacts were never tampered with to test errors. Signature tampering/unknown signer, unsafe origins, hash/size failure, interruption/cancellation/resume/cache corruption and same-version mutation protections remain covered by local automated regressions.

## L4-A installation, upgrade and rollback

Actual remote bytes were installed through the existing engine, not another installer:

| Scenario | Actual result |
|---|---|
| Fresh sandbox | Both remote files staged/hash-verified, committed journal and two-file receipt verified; explicit rollback restored absence and empty receipt |
| Managed upgrade | Properly signed LOCAL 0.0.0 baseline → actual remote 0.0.1; existing ownership accepted; both backups verified; new bytes/receipt committed |
| Explicit rollback | Remote upgrade rolled back; previous two 0.0.0 file hashes/ownership restored and independently read back |
| Exception during apply | Injected after-rename exception triggered automatic rollback; reopening showed clean recoverable state |
| True pending-transaction restart recovery | Separate owned Node-worker test below proves recovery of an actual unfinished journal |

This proves **LOCAL BASELINE → REMOTE RELEASE**, not remote-to-remote upgrading. No second Release was published. Native integration files and game files were never installation targets.

Restored baseline bytes: notice.txt, 30 bytes, SHA-256 **d5487295a447ff5df0ff8002d7aa938d4b8b480601855cd5250008c278c92ef7**; banner.txt, 30 bytes, SHA-256 **76f4c5416fc4a411896c0b89d3dcca309962efacf568cc941be77ce46833f742**. Both restored ownership entries report packVersion0.0.0.

## True restart recovery and conflict safety

Fresh review correctly distinguished automatic rollback from recovery after a stopped service. An additional real-assets test reuses the existing installer-worker durable-checkpoint mechanism:

1. Authenticate the actual GitHub envelope and download/cache both actual remote files in a new sandbox.
2. Install a signed local 0.0.0 baseline and add an unrelated inert file.
3. Start an owned Node test worker with the real envelope/public key and explicit 0.1.5/beta test compatibility.
4. Pause at after-rename index0 after the durable journal records applying/pending and verified backups.
5. Terminate **only this test worker**; verify exactly one actual applying journal exists before recovery.
6. Reopen the existing installer as a new service instance and recover the unfinished transaction.

Clean scenario: **one pending journal processed → rolled-back**, both original hashes/0.0.0 ownership restored; repeated recover returns an empty list; unrelated file preserved.

External-modification scenario: alter one sandbox target after worker termination. Reopened recovery returns **recovery-required**, preserves those external bytes and the unrelated file, and retains evidence. This is an intentionally passing negative test, not an unresolved production failure. That disposable conflict sandbox is retained for review; no broad cleanup was added.

Both scenarios used the same immutable public asset IDs. The original runner's exception test is described only as automatic rollback; genuine restart recovery is evidenced separately in stage-b-restart-recovery.json. No Skyrim/server process was terminated.

## Engineering verification

| Check | Result |
|---|---|
| Launcher focused Level B/service regression | **14/14 passed**, after observing the new UI-state assertion fail first |
| Full Launcher regression | **244/244 passed**, 0 failed/skipped; final run after worker change, 64,693.126ms |
| Distribution typecheck/build/audit | Passed |
| Distribution tests | **4/4 passed** |
| Launcher typecheck | Passed |
| Main/preload/React + unpacked/NSIS build | Passed, version0.1.5 |
| Real GitHub source Electron Main/IPC/UI smoke | Passed |
| Real GitHub packaged Electron Main/IPC/UI smoke | Passed |
| Existing normal-mode source smoke | Passed; L1/L2/L3/L4-A/L4-B fixture coverage retained |
| Existing normal-mode packaged smoke | Passed |
| Package/privacy/boundary audits | All four existing artifact audits plus candidate-specific identity audit passed |
| User GUI acceptance for this development build | Not claimed; automated Electron tests performed by the agent |

NSIS development artifact: **release/SkyrimRPLauncher-0.1.5-x64-local.exe**, **112,318,449 bytes**. SHA-256 **74f39f66ff48121e3530dae18f7e5fb8380a0ca28e42cdeae43e7241c9ede562**. Authenticode **NotSigned**. This local rebuilt artifact supersedes Stage A's local0.1.5 installer; no public Launcher0.1.5 release was replaced. L2 signed self-install remains a separate gate.

Source changes in Stage B only:

- src/main/distribution/service.ts — authenticated immutable/body/channel and verified acquisition count now reach UI; operation counters reset.
- src/renderer/DistributionPanel.tsx — completed GitHub test no longer shows unconditional obsolete 'anonymous download unverified' footer; production scope remains explicit.
- tests/level-b.test.ts — real local-HTTP service assertions cover metadata/channel/count propagation. Failed null-vs-false before fix; passed after fix. Test count remains14/244 because the existing integration case was expanded.
- tests/installer-worker.ts — accepts explicit launcherVersion/channel from a trusted generated test request while retaining existing defaults; enables the existing stopped-worker harness to exercise the actual beta manifest. It is not packaged or IPC-exposed. Real restart test failed to reach checkpoint under old defaults, then passed with this harness change.
- scripts/level-b-github-smoke.mjs — new explicit real-GitHub source/packaged Electron acceptance script; only synthetic app/game fixtures, default anonymous provider.
- scripts/level-b-recovery-smoke.mjs — new real-download/pending-worker recovery and external-conflict acceptance script.
- This report and a short historical pointer in L4B_LEVEL_B_REPORT.md. Ignored operational scripts/evidence/approval profiles remain local.

No dependency/lockfile change, engine/downloader/signature-policy change, Git commit or source push. Launcher HEAD remains **5eb2cf773deaaa47b460b17e02926913d856a90b**; distribution HEAD/main remains **1c223f11fcdf59529efa3f5800f6c0f7505a87c9**. Previous uncommitted work is preserved. Version remains local development0.1.5 because the current unpublished development build was rebuilt; approved minimumLauncherVersion and published content were not changed.

## Protected Skyrim/server baseline

Read-only compatibility recheck: Skyrim **1.6.1170.0**, SKSE **0.2.2.6** (release2.2.6), ready; **24** integration baseline files checked, no backup creation requested.

Prior Stage A baseline comparison: **53 protected file SHA-256 records unchanged**, including client/SKSE/load-order/server settings/manifest and existing rp-world/character state. Entire game tree metadata: **710 entries unchanged**. Save-location records: **3 unchanged** (one hashed steam_autocloud.vdf; two alternative roots absent). Metadata comparison is not a full-content hash of every game archive. No actual ESS saves were found in those recorded roots. Actual Launcher baseline-backup APIs were not invoked; fixture backup tests operated only in disposable app data. No complete prior hash inventory of all real Launcher backups is claimed.

No Skyrim/Steam/SKSE launch, server start/restart, actual Modpack install, game/mod/load-order write, world/persistence change or baseline-backup deletion occurred.

## Evidence and remaining boundaries

Ignored local evidence: stage-b-preflight.json; stage-b-environment-before/after.json; stage-b-branches-before/after.json; stage-b-publication-log.txt; candidate/published-result.json; stage-b-anonymous-sandbox.json; stage-b-source-github-smoke.json; stage-b-packaged-github-smoke.json; stage-b-restart-recovery.json; stage-b-recovery-red/green.txt; stage-b-ui-regression-red/green.txt; final full test/typecheck/package/smoke logs; protected before/after and tree-check JSON. HTTP evidence omits temporary signed query strings. Exact disposable directories and pending/recovered journal IDs are retained in the evidence; no private-key material is in this report.

Fresh independent review found no Critical defect or production trust bypass. Its Important restart-evidence gap was addressed with the failed-then-passing real-assets worker test and genuine pending-journal recovery above. One Minor remains deferred: after a successful test, checking an absent production stable release retains some previous test metadata (version/immutability/assets/progress) beside the current UNVERIFIED status. Installation remains disabled; there is no production READY or trust activation. The successful test screenshot/state is accurate. A later UI cleanup can clear this historical metadata without changing trust.

Production still requires separately approved publisher trust, a real authorized modpack/release/rights review, supported integration planning and Windows Launcher signing for trusted self-update. The test profile expires on21October; it must not become production trust or be silently renewed. This milestone does not authorize another Release or L4-C. **Stage B completes only the synthetic sandbox distribution pipeline.**
