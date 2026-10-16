# Frostveil real Skyrim installation readiness

Date:2026-10-16. **REAL SKYRIM INSTALL NOT YET EXECUTED · PRODUCTION PLAYER ACCEPTANCE PENDING.**

Production publication, signatures, anonymous downloads and disposable installation/recovery passed. The real target remains **UNVERIFIED**, with no authorization requested and no writes to Skyrim/profile files. Owner approval A–D does not include E.

## Actual production identity

- [pack-v1.0.0](https://github.com/kaktv2016/frostveil-distribution/releases/tag/pack-v1.0.0), release ID414698726, pack ID `frostveil-rp-pack`, stable, immutable.
- Approved publisher `frostveil-modpack-publisher-20261016`; full public fingerprint `7eded189b364ffc31c5c9730c7b73c0b13424b60576313a0197a6327b5633369`; key expires2027-10-16.
- Signed production payload SHA-256 `8558058fe274a57a8e4aa419e300e2d63fdb0888d6693411268ddae80b268fc4`; signature verified with pinned production key and independent Ed25519 verifier.
- Skyrim1.6.1170.0, SKSE2.2.6(resource0.2.2.6), existing SkyMP client. 29 external requirements are verification-only.
- Offline server snapshot expiry **2026-10-23T08:09:13.587Z**; live server compatibility remains UNVERIFIED.

## Exact read-only ManagedPlan

Plan SHA-256: **`d6c33c4954edbf0bb9868551e7622f44ec041793d01f7d3c6d8ec751a73a4c0b`**. Independently recomputed from canonical JSON.

Generated:2026-10-16T08:13:14.611Z. Expires:2026-10-16T08:18:14.611Z. Target class:`real-skyrim`. Machine-specific target UUID and filesystem identities remain in the private local plan evidence.

The full personal target/observation evidence is retained locally in ignored `.local/production-release/real-managed-plan.json`; it is not published as player configuration. Target: existing Steam Skyrim Special Edition installation and its current native Windows activation profile. Explicit private audit metadata stores identity/HMAC evidence outside Git/cloud/game files. Registration did not grant write permission. Codex MSIX redirected newly created LocalAppData metadata children and root-identity validation refused that path; installed-Launcher storage/receipt binding remains unverified and requires a fresh plan in that app before approval.

| Relative target | Planned operation | Bytes | Approved SHA-256 |
|---|---|---:|---|
| `Data/Frostveil/settings.json` | add | 370 | `9a1d1d16c7271d816fd91f0699999ec516fdc0df26dae7dae67f35c85170bd21` |
| `Data/Frostveil/readme.txt` | add | 897 | `4bf195a94902b870f688522b3461a1b0c3abacdec8e55cc66340bca4a82ce921` |
| `Data/Interface/Frostveil/hud-reference.html` | add | 457 | `5bb5168fca942c7321bbedef569d26496eebcf14564d36093a6effa1817a9425` |

Observed ownership/conflicts: 0 existing owned receipt entries; 0 planned targets currently exist. Unmanaged files must never be adopted/overwritten. Blockers and original observations are bound into the plan hash; installation must refuse changed files/roots/receipt/manifest/channel or an expired plan.

Plugin configuration operations: **0**. Existing plugins.txt, loadorder.txt, Skyrim.ccc, masters, DLLs, SKSE, saves and rp-world are outside these three operations. No network/gameplay changes are supplied by these static payloads.

## Current eligibility and remaining findings

**BLOCKED; NEW PREFLIGHT/PLAN REQUIRED BEFORE OWNER APPROVAL**

- BLOCKER: Real preflight UNVERIFIED: resolve compatibility findings before any authorization
- Manual evidence: Existing active light/ESL plugins are preserved; their gameplay compatibility with the pinned SkyMP build is unverified.

Client file hashes/offline five-master correspondence do not prove live multiplayer compatibility. Preserve Creation Club uncertainty until validated with the actual matching clients/server. No activation change was made to hide it.

## Backup and rollback

Exact backup template bound to this audit target:
`%USERPROFILE%/.codex/frostveil-planning/production-release-20261016/managed-installations/6599e50a0edd6a6eadfe6b9475b43d3a50b529869940610dbf056ff482a8d162/metadata/transactions/<future-transaction-id>/backup/<operation-index>.bin`.

The installed Launcher's separately generated plan normally uses its own `%LOCALAPPDATA%/SkyrimRPLauncher` metadata root. That different storage/receipt/target binding must be inspected and its exact backup path presented with its new hash; this audit path is not silently substituted for installed-app ownership.

Transaction IDs are generated only during an actually authorized apply; none exists for this read-only plan. Existing targets require attributable ownership and verified byte backups before replacement. For currently absent targets, rollback restores absence and the prior ownership receipt. Journal/authentication/staging remain outside Skyrim, with temporary same-directory rename files only during a future approved transaction. No backup/apply/recovery transaction was executed against this real target.

## Required next authorization

First resolve the real preflight findings and refresh the offline snapshot if expired. Then regenerate a fresh eligible ManagedPlan against the current root identities/ownership/production release. Its short-lived planHash will differ from this evidence record. Present the exact three operations, target and backup policy for **separate approval E**, then require Main's native confirmation for that same current hash and revalidate immediately before apply. This report/hash is not an authorization token and cannot authorize an expired or blocked plan.

After a separately approved installation, the owner performs actual Launcher/SKSE/game login, chat/profile/job regression and matching multi-client validation. A later separately approved Launcher release is needed to prove a public-to-public update. No L5/Nexus or automatic real-game apply is included.
