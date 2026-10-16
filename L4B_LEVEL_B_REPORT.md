# L4-B Level B — Stage A publication approval report

> Stage B update (2026-10-16): the explicitly approved synthetic prerelease was published and verified. See [L4B_LEVEL_B_STAGE_B_REPORT.md](L4B_LEVEL_B_STAGE_B_REPORT.md) for actual IDs, hashes, anonymous acquisition and sandbox/restart-recovery evidence. The remainder of this document records historical Stage A status.

Date: 2026-10-15 (Asia/Bangkok). Launcher development build: **0.1.5**.

**PREPUBLICATION READY** · **PUBLICATION WAITING FOR APPROVAL**

**REAL SKYRIM INSTALL DISABLED** · **PRODUCTION DISTRIBUTION NOT READY**

Stage A preparation is complete. Stage B has **NOT EXECUTED**. There is no public test Release, final GitHub-bound signed manifest, anonymous GitHub payload verification, or actual GitHub-to-installer acceptance result. No GitHub mutation, commit, source push, game launch, server restart, or L4-C work was performed.

## Exact proposed publication

- Repository: `kaktv2016/frostveil-distribution` (PUBLIC).
- Tag: **test-pack-v0.0.1**; currently unused.
- Title: **Frostveil Distribution — Synthetic Integration Test**.
- **One prerelease**, `make_latest: false`; never stable or production.
- Target source commit: **1c223f11fcdf59529efa3f5800f6c0f7505a87c9**.
- Pack: `frostveil-integration-test`, version `0.0.1`, manifest channel `beta`.
- Minimum Launcher: `0.1.5`.
- Release body: TEST ONLY; contains no real Skyrim Mods or proprietary game assets; nonproduction test publisher identity; not intended for installation into Skyrim; explicit Frostveil sandbox integration testing only.

Candidate is stored in ignored `.local/level-b-candidate/`. Public approval scope is bound by canonical publication plan SHA-256:

`3fc408ec734dfedb89b2a44d8ac1a0ae749cda7fe27dd6f2a7790d2c1e3befe9`

| Intended uploaded asset | Bytes | SHA-256 |
|---|---:|---|
| frostveil-test-ui-v0.0.1.dat | 53 | b0411a3fe663336a6dd1d7c38554634e086d96abf94683fd2722f13b6647901b |
| frostveil-test-config-v0.0.1.dat | 57 | 78e9abe3db0d38dd2ec896fae6bba428ee8f9c915747dcc0a23ab9e806617382 |
| frostveil-test-publisher.json | 499 | efda9673d8462d7bce2168604e63edf294d7483ed0a766664a1a2c4b4647ed81 |
| frostveil-manifest.json | Pending actual GitHub IDs | Pending finalization after approved draft uploads |

The first payload is original ASCII `FROSTVEIL LEVEL B UI\nversion=0.0.1\nsandbox-only=true\n`; the second is `FROSTVEIL LEVEL B CONFIG\nversion=0.0.1\nsandbox-only=true\n`. There is no executable code. Sandbox destinations are `Data/Platform/UI/frostveil-sandbox/notice.txt` and `Data/Textures/FrostveilSandbox/banner.txt`. These are disposable sandbox paths, never actual game paths.

Only these four files are proposed for publication. Private key, operator approval, local profiles, logs, source snapshots, key-possession proof, NSIS build and native-looking installer seed fixtures are **not upload assets**.

## Signing identity and final manifest ordering

- Ed25519 key ID: **frostveil-level-b-test-20261015**.
- Public SPKI DER SHA-256 fingerprint:

  `c9d19a50b06f2d55c5e9a31c6ba85b947c021581faa56c44231679223ce31391`

- Expiration: **2026-10-21T10:33:00.783Z** / **21 October 2026, 17:33:00.783 Asia/Bangkok**.
- `revoked: false`; approval profile currently **publicationApproved: false**.
- A dedicated private PEM is stored outside both source repositories in a protected user-local directory. Windows inheritance is disabled on its parent; access is limited to this user and SYSTEM. It is excluded from Git, candidate uploads and packaged binaries. Its location is intentionally omitted.
- Offline key-possession proof signs a domain-separated, nonrelease challenge and is independently verified. It is not a V1 manifest or placeholder release signature.
- No production trust root is generated, registered or pinned.

The unsigned template contains no invented package asset IDs. After explicit approval: verify original bytes and plan; reject existing tag/release; create draft; upload the three fixed assets; read actual asset IDs, sizes, names and digests; independently download and hash those draft bytes; finalize V1 using actual IDs; sign using this exact test key; independently verify with the existing verifier; upload `frostveil-manifest.json`; re-read and verify all draft asset bindings/bytes; publish the prerelease. Failures leave the draft unpublished. There is no delete, overwrite, replacement or post-publication mutation operation.

Final manifest size/SHA cannot be honestly specified before GitHub allocates asset IDs. Approval must expressly cover deriving that fourth file from this frozen template and the actual upload identities. Any different payload, tag, pack, key or template requires renewed review. Expired or revoked profiles fail closed; an expired candidate must not be silently renewed.

## GitHub preflight — actual read-only findings

Rechecked during Stage A and again before this report:

| Check | Actual finding |
|---|---|
| Account / repository | kaktv2016 / kaktv2016/frostveil-distribution |
| Visibility / default branch | PUBLIC / main |
| Permissions | admin, maintain, push, pull available |
| Remote main | 1c223f11fcdf59529efa3f5800f6c0f7505a87c9 |
| Releases / tags | **0 / 0** |
| GitHub API | Read-only metadata/settings requests succeeded |
| Immutable Releases | **enabled=false; enforced_by_owner=false** |
| Environment | production-distribution; owner required reviewer; prevent_self_review=false |
| Administrator bypass | **can_admins_bypass=true** — protection gap |
| Environment branch policy | custom policy, main only |
| Existing workflows | validation/preparation, contents:read; no automatic public publishing job |

Existing public source validation succeeded at [GitHub Actions run 38616397948](https://github.com/kaktv2016/frostveil-distribution/actions/runs/38616397948). That run validates the existing public commit, **not the new local Stage A changes**.

Requested settings changes, requiring separate explicit approval: enable Immutable Releases before publishing; disable environment administrator bypass while preserving existing owner-review and main restrictions. Neither has been changed. GitHub documents that [immutability protects future releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes); it must be checked again before publication.

The local publisher refuses mutation unless these settings are verified and the exact explicit operator approval is valid. Environment rules govern workflow deployments; they do not automatically require approval for every direct owner API call. This test therefore uses the brief's **explicit local approval gate** for direct API publication; it does not execute or bypass a protected workflow job. No unrestricted write workflow has been introduced. If GitHub cannot apply these settings, stop and report the limitation before altering this reviewed publication path.

## Source and implementation scope

Launcher base HEAD is unchanged: **5eb2cf773deaaa47b460b17e02926913d856a90b**. Distribution HEAD remains the public **1c223f11fcdf59529efa3f5800f6c0f7505a87c9**. Both working trees contain local, uncommitted changes; previous L3/L4-A/L4-B changes are preserved.

New local source is not represented by either HEAD. No additional source push is technically required for this bounded test using the reviewed local tooling. The public distribution commit does not yet contain the Stage A test-tag/publisher extensions. No source push is included in this approval request. A later source publication must be separately authorized. The frozen release target remains the existing public commit, rather than silently substituting a future revision.

Local distribution tooling inventory: `.local/level-b-distribution-source-hashes.json` in the Launcher directory; 29 files, snapshot SHA-256 **5e06d2938994ea9ac8e316c85c416c829cbf698e0a815fba1a60d11ea3ac6d34**. Shared source compatibility inventory is maintained in `frostveil-distribution/compatibility/source-snapshot.json` and its audit passed.

Changes reuse the existing V1 verifier, release preparer, GitHub provider/downloader and L4-A installer:

- Fixed test-tag support with exact repository/pack/version/key/expiry restrictions; normal production still has empty publisher pins.
- Operator-only explicit `--distribution-level-b --level-b-profile <absolute-public-profile.json>` mode. Main process reads and validates the profile; renderer supplies no key/path.
- No-argument sandbox IPC; existing sandbox grants and receipts control every write.
- Approval-bound publication plan and authenticated CLI adapter. Approval is checked before adapter creation and every API operation; no default publication.
- Test mode panel shows tag, key/fingerprint/expiry and **TEST DISTRIBUTION — SANDBOX ONLY**. GitHub test is disabled while approval is false. Normal Check Trusted Distribution cannot become READY from this candidate.
- Real network sandbox runner supports fresh install/receipt/rollback, distinct local signed 0.0.0 baseline to downloaded 0.0.1 upgrade/backups/rollback, and interruption recovery. Persistent version-ledger protections remain enabled.

Major affected Launcher paths: `src/main/distribution/{level-b,publication,level-b-runner,policy,github,transport,service}.ts`, `src/main/modpack/schema.ts`, `src/main/installer/synthetic.ts`, main/preload/shared contracts/DistributionPanel, tests, smoke and candidate-preparation scripts, package version/lock and this report/plan. Distribution changes include mirrored shared source/snapshot, `scripts/build/{entry,gh-publication,publish-level-b,external-input}`, package command and focused tests. No SkyMP code was modified in this milestone.

## Verification performed

| Verification | Result and scope |
|---|---|
| Launcher typecheck | Passed |
| Full Launcher regression suite | **244/244 passed**, 0 failed/skipped; preserves previous 230 tests |
| New Level B cases | 14 passed: strict profile/trust, approval ordering, actual fixture-ID finalization, publication collision/corrupt/incomplete draft and loopback installer integration |
| Distribution tooling typecheck/build/audit | Passed |
| Distribution tests | **4/4 passed**, including two new CLI containment regressions |
| Main/preload/React and Windows unpacked/NSIS | Built **0.1.5** successfully |
| Source Electron smoke with actual candidate public profile | Passed; exact external test identity shown, unapproved operation refused |
| Normal-mode source Electron smoke | Passed; explicit test profile absent |
| Packaged Electron smoke with same persistent candidate public profile | Passed; existing L1–L4-B fixture behavior preserved |
| Existing L1/L3/L4-A/L4-B artifact audits | All passed |
| Candidate-specific packaged privacy check | Public key, fingerprint and key ID absent from packaged main; profile remains external; no private material packaged |
| Actual publisher CLI with pending approval | Rejected, exit 1, before GitHub mutation |
| Fresh independent security review | One P2 found and fixed; follow-up found no remaining Important/Critical issue in reviewed scope |

The review fix anchors approval/private-key path checks to the script repository using `import.meta.url`, validates canonical containment against distribution and Launcher repositories, rejects linked ancestors and unsafe files before reads. Tests reproduce unrelated working-directory invocation and Windows junction rejection.

Controlled loopback bytes went through the existing downloader/installer for six fresh/upgrade/backup/rollback/recovery checks. These are **local network results only**. The current-key recovery scenario uses an injected interruption and service reopening; the preserved regression suite separately tests terminated child processes. No actual anonymous GitHub payload was downloaded. No GUI acceptance by the user is claimed for 0.1.5. Prior L4-B 5/5 manual acceptance remains the user's earlier confirmation.

Local evidence logs (ignored): `.local/level-b-tests.txt`, `level-b-typecheck.txt`, `level-b-source-smoke.txt`, `level-b-normal-source-smoke.txt`, `level-b-packaged-smoke.txt`, `level-b-cli-gate.json`, candidate proof/plan, protected before/after and tree-check JSON.

Local NSIS artifact: `release/SkyrimRPLauncher-0.1.5-x64-local.exe`, **112317714 bytes**; SHA-256:

`97450213981c2b43eae060099b3bed5e274c958bca45dcf34a623f5a9d4e1fa8`

Authenticode status: **NotSigned**. This is a local development installer; L2 trusted self-install signing remains a separate unmet gate. It is not a proposed distribution Release asset.

## Rights and protected installation

All proposed payload content is newly written inert ASCII; publisher JSON is nonsecret test identity/scope metadata. No third-party Mods, proprietary masters, DLL/EXE/PEX/ESP/ESM/ESL, archives, executable scripts or Nexus content is proposed for upload. Existing installer native-looking seed fixtures remain original sandbox-only verification bytes and are excluded from the release. This candidate does not authorize redistribution of any future modpack.

- Real compatibility recheck: Skyrim **1.6.1170.0**, SKSE **0.2.2.6** (release 2.2.6), ready; 24 baseline integration files checked read-only; no backup creation requested.
- **53 protected file SHA-256 records unchanged**, including client/SKSE, load-order controls, server settings/manifest and existing rp-world/character state.
- Full game tree: **710 file metadata records unchanged** (size/timestamps/link state; this is not a full-content hash of every archive).
- Save locations: three records unchanged, comprising one existing hashed `steam_autocloud.vdf` and two absent alternative save roots; no actual ESS saves were discovered in these locations.
- Actual Launcher backup APIs were not invoked; fixture smoke uses isolated data. No claim of a complete before/after hash inventory of all existing Launcher backups is made.
- No game/Steam/SKSE launch, server restart, production install, load-order/world write or backup deletion.

## Stage B execution and remaining acceptance

After exact approval, revalidate candidate hashes/key/expiry/account/settings/current tag collision status before any mutation. Publish exactly the single reviewed prerelease. Then use the anonymous public GitHub provider (no CLI token passed to asset endpoints) to retrieve and verify manifest/packages, observe HTTP 200 or allowed redirects, and install downloaded bytes into disposable L4-A sandboxes. Record actual Release URL/IDs/hashes/signature/ownership/backup/rollback/recovery and packaged evidence. Run non-destructive missing-tag/asset checks; use local fixtures for malicious/destructive cases.

The managed transition is **local signed 0.0.0 → real remote 0.0.1**. It is not remote-to-remote upgrade proof and requires no second public Release. No second Release is authorized by this proposal.

Still pending: public publication approval, settings approval/application, actual GitHub delivery and anonymous integration execution. Production key, stable modpack, distribution readiness, real-game installation and L4-C are outside this milestone.

## Explicit approval requested — STOP HERE

Approve all of the following exact scope, or identify exclusions:

1. Enable Immutable Releases for `kaktv2016/frostveil-distribution`.
2. Disable administrator bypass on `production-distribution`, retaining existing owner review/main restrictions. No other repository protection change.
3. Publish the test public identity with key ID/fingerprint/expiry above and create **one** prerelease **test-pack-v0.0.1**, title/source/plan SHA above.
4. Upload exactly the three fixed files with the table's hashes, then the final signed `frostveil-manifest.json` derived only after actual GitHub asset IDs and independent draft-byte verification.
5. Execute anonymous downloads and disposable **sandbox-only** installation/upgrade/rollback/recovery tests.

This request includes **no source commit/push, second release, production trust activation, actual Skyrim write or L4-C**. Publication/settings changes have been stopped because the supplied brief explicitly requires separate authorization. **Stage B is NOT EXECUTED.**
