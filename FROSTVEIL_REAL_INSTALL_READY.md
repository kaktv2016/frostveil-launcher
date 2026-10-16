# Frostveil real installation readiness

Date: 2026-10-16. **NOT READY FOR AUTHORIZATION — PRODUCTION RELEASE PENDING**.
**REAL SKYRIM INSTALL NOT YET EXECUTED. PRODUCTION PLAYER ACCEPTANCE PENDING.**

This task authorizes production release work A–D only. It excludes applying a pack
to the real game. No game write, plugin activation, save mutation or server restart
was performed. Protected comparison currently checks 63 paths with zero changes.

## Intended production identity

| Field | Value / state |
|---|---|
| Repository | `kaktv2016/frostveil-distribution` |
| Pack ID | `frostveil-rp-pack` |
| Version / channel / tag | `1.0.0` / `stable` / `pack-v1.0.0` |
| Publisher | `frostveil-modpack-publisher-20261016` |
| Public SPKI SHA-256 | `7eded189b364ffc31c5c9730c7b73c0b13424b60576313a0197a6327b5633369` |
| Publisher key possession / expiry | Verified locally; expires 2027-10-16T00:00:00.000Z |
| Production trust pin | ACTIVATED in source after encrypted USB recovery verification; final packaged audit pending |
| Actual release / asset IDs | NOT AVAILABLE — not published |
| Authenticated published manifest hash | NOT AVAILABLE |
| Final ManagedPlan SHA-256 planHash | **NOT AVAILABLE — no actual production metadata; do not substitute candidate IDs or a synthetic plan** |

## Files under consideration

Only the following first-party targets are approved for the first release:

| Target | Expected scope | Current planning state |
|---|---|---|
| `Data/Frostveil/settings.json` | Pack identity/runtime metadata | Reviewed unsigned local payload prepared |
| `Data/Frostveil/readme.txt` | Source-supported RP command reference | Reviewed unsigned local payload prepared |
| `Data/Interface/Frostveil/hud-reference.html` | Static reference document | Reviewed unsigned local payload prepared |

The exact add/replace/verify/conflict operations must be derived from the existing
ownership receipt and freshly observed target bytes after public metadata exists.
No unmanaged file may be adopted or overwritten. Modified owned files require a
conflict result, not a forced repair. The new content does not replace the actual
SkyMP client scripts or in-game HUD.

All 29 runtime requirements are verification-only. They are not payloads, and the
pack must not install/replace Bethesda masters, SkyrimSE.exe, SKSE or SkyMP DLLs.
No additional plugin is included in the first-party payload set. Expected plugin
operations are none; confirm the actual activation planner output before approval.

## Current compatibility evidence

- Real installed Skyrim **1.6.1170.0**, SKSE release **2.2.6** (resource version
  **0.2.2.6**); current L1 runtime baseline passes.
- **29/29** external-only file requirements match local hashes/resource versions.
- Server snapshot freshly inspected against five official masters and
  `Skyrim - Misc.bsa`. Snapshot match is offline evidence only.
- Preflight is **UNVERIFIED** because active Creation Club light/ESL plugin behavior
  against the pinned SkyMP build remains unverified. No hard preflight blockers
  were observed. Preserve the warning; do not change activation to bypass it.
- Live server compatibility and production player acceptance are **UNVERIFIED**.

## Ownership, backups and rollback

Final ownership/conflict results, target identity and observed-byte hashes are
pending an actual authenticated ManagedPlan. Record them from the existing L4-C
planner, not from assumptions that the files are absent.

Expected backup scope is Launcher-private management storage under the existing
`SkyrimRPLauncher/managed-installations/<installation-identity>/` transaction tree,
outside the game directory. The final report must include the exact selected
storage/transaction paths produced by the engine. Existing L1 backups remain intact.

Rollback must restore verified original bytes for replacements and remove only
unchanged files added by that transaction, while preserving unmanaged files and
rejecting changed ownership/identity. Pending interrupted journals require explicit
recovery review. Production-download sandbox rollback/recovery is still pending.

## Required before a real installation can be approved

1. Complete verified offline backup, production pins, audited push and remote CI.
2. Publish the one approved stable Launcher and Modpack release using actual asset
   IDs, final hashes and independently verified Ed25519 signatures.
3. Verify anonymous production downloads and install those exact bytes into a
   disposable Skyrim-shaped sandbox; prove backup, rollback and recovery.
4. Reinspect the real installation read-only. Generate the real ManagedPlan from
   authenticated production metadata and current ownership/compatibility evidence.
5. Record exact target, operations, conflicts, backup scope, plugin operations,
   compatibility findings and deterministic planHash. Plans are short-lived and
   filesystem-bound; any change/expiry requires a fresh plan and matching approval.
6. Obtain separate owner authorization identifying that exact planHash and target.
   The existing native confirmation must still present the same reviewed plan.

No approval is being requested for a missing plan. This document will be updated
with the real production metadata and plan before the first game-write approval.
