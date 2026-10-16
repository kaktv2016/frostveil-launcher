# Player-controlled Launcher update and Modpack delivery implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this existing-flow continuation task by task. The owner selected execution of the three-step release/install/modpack plan in chat.

**Goal:** Players download trusted server files through Launcher, explicitly review/apply supported content, and upgrade the real public0.1.6 Launcher to public0.1.7 through GitHub.

**Architecture:** Reuse the existing production Ed25519 sources, GitHub transports, bounded package downloader and managed transaction engine. Add a download-only acquisition adapter and user-facing controls; retain separate native authorization before game writes. Treat supplied SkyUI6.0 ESP/BSA as external-only until redistribution permission and runtime support are established.

**Tech stack:** Existing Electron44/TypeScript/React/NSIS/Node24.11.1; no new dependencies.

**Spec:** Owner request2026-10-16 plus screenshot's next-release/real-install/modpack plan. Additional owner constraint: never deploy the example directly to a player's game; player chooses download/install in Launcher.

## Constraints

- Preserve both pinned production identities; no private keys in source/artifacts.
- Do not mutate real Skyrim, DLLs, server configuration/world/player state or mod-work.
- Publish at most one new Launcher release v0.1.7 after real source changes and passing validation. Preserve v0.1.6 and pack-v1.0.0.
- SkyUI files: ESP2433bytes SHA25661eb77164ed3632344ac2ccac4c8a4e69c62397999e7d8d558c162fd205616cf, BSA2947857bytes SHA256a9e106beec4c083c8d8b7a7e108ebbc0593f57a0c12f1e4efc5cefdf9af9cfbf. Actual header says6.0, ESL flag512,7SKI_ quests; BSA105 has71 UI/script entries.
- Nexus author page forbids mirrors. Never upload supplied SkyUI bytes without evidence; awaiting owner provenance/permission response. Source link/manual verification is allowed; do not describe external download as automatic GitHub delivery.
- No blanket ESL bypass. Only data-only Frostveil text/reference files with zero plugin operations may use a narrowly verified unchanged-light warning; active light gameplay remains UNVERIFIED. SkyUI6.0 activation stays blocked.
- Full public-to-public updater installation test runs only on a disposable GitHub Windows runner, avoiding the owner's real Launcher registry/shortcuts/user data.

## Task1 — Persistent download-only acquisition

Files: src/main/management/downloads.ts, shared management contracts, Main/preload, renderer controls, tests/production-downloads.test.ts.

- [x] RED: actual signed loopback bytes stage without a game root; unknown signatures/cache corruption/unsafe pointers fail; existing streamed-downloader cancellation/resume regressions remain passing.
- [x] Implement ProductionDownloads using existing generated sandbox capability, MetadataStore and PackageDownloader. Main owns fixed source/provider; renderer cannot supply paths/URLs/keys.
- [x] Expose download/cancel and truthful download-only state; stage into existing managed installation cache on later review without rewriting unowned game files.
- [x] GREEN: tests and source Electron smoke verify downloader controls and game-write separation.

## Task2 — Safe player install and external component explanation

Files: management eligibility helper/service/planner tests; renderer management/download panels; external SkyUI source/read-only audit helper.

- [x] RED: existing-light UNVERIFIED may permit only exact Frostveil data/reference extension/prefix set, ready runtime, no hard blockers/managers, zero activation writes and unchanged server master indices. Script/plugin/BSA/native/unknown cases remain refused.
- [x] Implement scoped eligibility on prepare and both revalidation paths; retain warning and live UNVERIFIED. Never edit activation to clear warnings.
- [x] Provide fixed official SkyUI source action and read-only file verification/ESL warning. No automatic SkyUI install and no license claims.
- [x] Derive fresh-player L1 baseline only from authenticated production metadata when local baseline is absent; preserve supplied local profiles and all native external-only requirements.
- [x] GREEN: meaningful transaction/security tests, fixture real install/rollback/recovery and protected-file comparison.

## Task3 — Actual public Launcher upgrade

Files: package version0.1.7, release audit/version expectations, read-only GitHub download/upgrade script and manually dispatched Windows workflow.

- [x] Tests/typecheck/NSIS/package/privacy/source+packaged smoke pass; normal reviewed commit/push; release-source CI passes.
- [x] Rebuild final sealed installer after changes. Draft-first v0.1.7 with actual asset IDs, independent readback and production signature. No old release edits or setting changes.
- [x] Anonymous normal production engine download verification.
- [x] Dispatch isolated Windows public upgrade: download authentic old v0.1.6 installer, install only in fresh runner, launch its actual app, use normal public updater IPC to acquire/install v0.1.7, verify old exit/new window/process/version and preserved settings/ownership/backups. No substitute callback, key or loopback transport.
- [x] Record exact source/release IDs/hashes and results. Manual game smoke instructions remain for owner; no game launch by agent.

## Review focus

- Missing legitimate runtime dependencies cannot be downloaded/repackaged as third-party authorized content.
- Unknown or changed local mods must never be silently overwritten/adopted.
- Download-only completion never implies installed status or multiplayer compatibility.
- MSIX/8.3 path spellings require existing root identity/link protections, never weaker containment.
- Failed public updater or unavailable SkyUI permission remains an explicit incomplete acceptance item, not a PASS.

## Verified outcome

Public v0.1.7 release 414941556, application source 0eb5a8c178fc56cfedcd30e22d1e001981961687. Windows CI 38900192464 passed 436/436 tests and all package/smoke gates. Actual anonymous public installed-app update plus normal UI pack acquisition passed hosted run 38902696119 using harness source 77f191ca7571e136fb1bce8aec0d04872119aae3. Harness-only corrections and earlier failed attempts are recorded in FROSTVEIL_PLAYER_DELIVERY_REPORT.md; published application/assets were unchanged. No real game writes. SkyUI remains external-only/BLOCKED pending redistribution permission and compatibility evidence.
