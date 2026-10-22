// Seals reviewable local delivery. Never publishes, deploys or installs into Skyrim.
import fs from'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';import{extractFile}from'@electron/asar';import{assertProductionTrust}from'./production-trust-audit.mjs';
const out=path.resolve('.local/navigation-runtime-fix'),delivery=path.join(out,'delivery'),planPath=path.join(delivery,'deployment-plan.json'),plan=JSON.parse(await fs.readFile(planPath)),asset=path.resolve('../mod-work/frostveil-courier-navigation');
const hash=b=>createHash('sha256').update(b).digest('hex'),identity=async file=>{const b=await fs.readFile(file);return{path:path.resolve(file),size:b.length,sha256:hash(b)};};
const rpLog=await fs.readFile('../skymp/rp-gamemode/.local/navigation-admin/current-regression.log','utf8'),launcherLog=await fs.readFile(path.join(out,'launcher-regression.log'),'utf8'),smoke=await fs.readFile(path.join(out,'packaged-smoke.log'),'utf8');
assert.match(rpLog,/pass 221\b/);assert.match(rpLog,/fail 0\b/);assert.match(launcherLog,/pass 477\b/);assert.match(launcherLog,/fail 0\b/);assert.match(smoke,/smoke PASSED/);
const fixture=JSON.parse(await fs.readFile(path.join(out,'candidate-fixture-result.json')));assert.equal(fixture.passed,true);
const main=extractFile('release/win-unpacked/resources/app.asar','dist/main.cjs').toString();const trust=assertProductionTrust(main);
assert.ok(main.includes(plan.recipe.sha256));assert.ok(main.includes('01264ed1a000ec8bbc75bfaa8f7548b687169fd144ac5e4d22d9c540fc7b0290'));
assert.equal(JSON.parse(extractFile('release/win-unpacked/resources/app.asar','package.json')).version,'0.1.18');
plan.installer=await identity('release/SkyrimRPLauncher-0.1.18-x64-local.exe');
plan.automated={rp:221,launcher:477,typechecks:'PASS',gamemodeBuild:'PASS',nsisBuild:'PASS',packagedSmoke:'PASS',candidateFixture:fixture,nativeServerAddon:{recordMapping:'PASS',loadIndices:[1,5],nativeClientUI:'PENDING'},review:{important:'Map tint isolation and recycled-clip restoration fixed',additional:'InventoryWeight post-write failures and float32 rounding covered',nativeProof:'PENDING'},trust};
const reportPath=path.resolve('../skymp/docs/rp-development/FROSTVEIL_COURIER_NAVIGATION_ADMIN_REPORT.md');
const report=await fs.readFile(reportPath,'utf8');assert.ok(!report.includes('## 2026-10-21: runtime correction and colored map delivery'),'Already sealed; inspect existing result before generating another source snapshot');
const section=`
## 2026-10-21: runtime correction and colored map delivery

**LOCAL CANDIDATE READY; NOT PUBLISHED OR DEPLOYED. Native Skyrim acceptance remains pending.** This section supersedes older version/candidate references above. No installed game, live server, world, economic rate or player schema was changed during preparation.

### Fixes and delivery

- The currently installed 3400-byte navigation ESP is the original release. Corrected regular ESP is 3460 bytes, optional alias flags 0x20a with VTCK=NULL; real server-addon record mapping passed at full indices 1 and 5. Native start/bind/stage/objective operations now execute only on update VM callbacks. Promise continuations carry primitive results; stale callbacks cannot resurrect cancelled jobs. Manual untracking survives refresh and door routing changes.
- Map tint is an additive 4591-byte AVM1/SWF8 helper loaded through the installed Ui API. It does not replace Map/HUD/SkyUI/font files. Only quest icons with Courier:/Frostveil: labels are selected: gold while tracked, green within 200 units in the destination world/cell. This is a visual hint; delivery/rank/payment remain server-authoritative. Each pass restores recycled clips before selecting owned icons. Native compass icons retain their original colors because HUD compass data lacks an unambiguous quest ID; unrelated quests are not recolored.
- Administrator speed uses a reversible InventoryWeight refresh across frames to invalidate cached movement speed. Observed-delta readback handles native calls that write then throw, including restoration, and tolerates native float32 rounding. Disposal/disconnect cleanup stays subscribed until owned changes are restored. TCL remains Debug.toggleCollisions behind explicit idempotent state. Native TCL/physical movement are not yet certified; external console TCL changes and full save transitions remain limitations described above.
- Private OS-operator session approval is still required. Current local account allowlist is owner; no current game session was available during this preparation. Offline profile/name/connection IDs never automatically grant rights. Owner approval must bind the current session, expire after 30 minutes, and be renewed after reconnect/server restart. No public administrator authentication is claimed.
- Launcher **0.1.18** is necessary to authorize exactly the corrected ESP and additive SWF in the hash-pinned R2 recipe, and prevent the legacy graphics integrity patch from restoring the old ESP. Existing client JS **0.1.17** is retained. Recipe **1.0.13** has **649 files**, with all prior **647 entries byte-for-byte unchanged**. No graphics/beam color, brightness or animation changed.
- Signed modpack **pack-v1.0.6** candidate was independently authenticated against LOCAL placeholder release IDs. Actual GitHub asset IDs must be rebound and signed again during the approved publication; this is not a public release. ESP/SWF bytes are acquired through R2 before signed-pack verification, which adopts matching bytes and activates the plugin without downloading them again from GitHub.

### Validation and review

- Gamemode typechecks/build and **221/221 regression tests PASS**. Includes strict native-VM context, late start/stage callbacks, cancellation/reconnect/loading, explicit door handoff/manual tracking, permission forgery/revocation, duplicate movement packets, speed cleanup and tint isolation/recycled clips.
- Launcher typecheck/build and **477/477 tests PASS**. One existing security fixture used today's hardcoded key expiry; its environment-mismatch case now uses a future fixture date, while expiry-refusal tests and all production key pins remain unchanged.
- Final packaged Electron fixture smoke PASS; no Skyrim/Steam/SKSE launch. Actual candidate fixture verifies 649/647 parity, ESP/SWF hashes, original ESP backup, interrupted-apply rollback, running-game refusal, second Play zero writes, and no legacy ESP reintroduction. Signed-pack integration verifies plugin activation and zero duplicate GitHub payload acquisitions after R2 repair.
- One independent read-only review found two map tint defects (unrelated quests/recycled clips) and InventoryWeight exception accounting. All reproduced before correction and now have passing regressions. These tests establish code/asset behavior, not real Skyrim UI rendering or flight.

### Artifacts and hashes

| Artifact | SHA-256 |
| --- | --- |
| Corrected FrostveilCourierNavigation.esp | ${plan.navigation[0].sha256} |
| CourierQuestTint.swf | ${plan.navigation[1].sha256} |
| Server gamemode bundle | ${plan.server.bundle.sha256} |
| R2 recipe 1.0.13 | ${plan.recipe.sha256} |
| Launcher 0.1.18 installer | ${plan.installer.sha256} |

Concrete delivery directory: C:/Users/basba/OneDrive/Desktop/skyrim-rp/skyrim-rp-launcher/.local/navigation-runtime-fix/delivery. deployment-plan.json and SHA256SUMS contain final installer, payload/archive, corresponding source snapshots and rollback identities. No source commit/push. Production signing roots are unchanged and valid until 2027-10-16; private keys are not included.

After the single publication/deployment approval: publish content-addressed R2 payload/recipe; bind actual GitHub modpack asset IDs and sign immutable pack-v1.0.6; publish signed Launcher 0.1.18 plus corresponding source; replace only server gamemode JS and navigation ESP, preserving the six-entry order and existing session-stability wrapper. Restart verified localhost server in a visible PowerShell. Back up code/config only, no world snapshot/reset/migration. Update/repair clients through Launcher Play only. Keep old immutable objects/releases. Server rollback restores previous bundle/config/ESP together while retaining current world/economy; client repair retains atomic originals, and version-ledger-compatible corrections use a new forward release.

### One owner gameplay checklist

1. Exit Skyrim, update Launcher to 0.1.18, press Play and let it repair automatically. Reopen once to confirm Play remains ready without another download.
2. Keep the current distant Courier contract: inspect journal, Map and compass. Confirm the native marker, gold Map icon, green near arrival, and unchanged beam. Untrack manually, refresh/reconnect as appropriate, and verify no duplicate markers. Deliver/cancel clears only Frostveil state.
3. After explicit operator approval of this owner session: /admin navtest on. Enter Riften then Bee and Barb; verify door routing. Compare /admin navtest doors only if needed. /admin navtest off restores the real job; no test reward.
4. /admin fly on -> fly through a wall -> repeat on (no reversal) -> fly off (normal collision). /admin speed 2 -> speed 3 -> speed reset -> /admin reset. Confirm original speed/collision, and no grant to another character.

**Unproven and required before completion:** actual native Quest start; Map/compass icons and Map labels; city/building door routing; helper injection and native gold/green appearance; actual TCL flight/off, physical speed/reset, and cleanup under real disconnect/load. No current Skyrim process or live owner session existed for those checks. The active goal remains incomplete until this evidence is obtained.
`;
await fs.appendFile(reportPath,section);
const navStage=path.join(out,'navigation-source-stage'),launcherStage=path.join(out,'launcher-source-stage');
for(const dir of [navStage,launcherStage]){await fs.mkdir(dir,{recursive:false});}
for(const name of ['build.cjs','build-ui.cjs','catalogue.json','README.md','ui-build.json'])await fs.copyFile(path.join(asset,name),path.join(navStage,name));await fs.cp(path.join(asset,'ui'),path.join(navStage,'ui'),{recursive:true});
await fs.copyFile('../skymp/skymp5-server/LICENSE',path.join(navStage,'LICENSE-AGPL-3.0'));await fs.copyFile('../research/navigation-color/toolchain/haxe210/haxe-2.10-win/LICENSE.txt',path.join(navStage,'HAXE-STDLIB-LICENSE.txt'));
await fs.copyFile(reportPath,path.join(navStage,'FROSTVEIL_COURIER_NAVIGATION_ADMIN_REPORT.md'));
for(const name of ['src','tests','scripts','client-ui'])await fs.cp('../skymp/rp-gamemode/'+name,path.join(navStage,'rp-gamemode',name),{recursive:true});
for(const name of ['package.json','tsconfig.json','tsconfig.type-tests.json','README.md'])await fs.copyFile('../skymp/rp-gamemode/'+name,path.join(navStage,'rp-gamemode',name));
const navZip=path.join(delivery,'FrostveilCourierNavigation-source.zip');execFileSync('tar.exe',['-acf',navZip,'.'],{cwd:navStage,windowsHide:true});plan.modpack.correspondingSource=await identity(navZip);
for(const name of ['src','tests','scripts','assets'])await fs.cp(name,path.join(launcherStage,name),{recursive:true});for(const name of ['package.json','package-lock.json','THIRD_PARTY_NOTICES.md'])await fs.copyFile(name,path.join(launcherStage,name));
await fs.copyFile(reportPath,path.join(launcherStage,'FROSTVEIL_COURIER_NAVIGATION_ADMIN_REPORT.md'));await fs.cp(navStage,path.join(launcherStage,'navigation-and-rp-source'),{recursive:true});
await fs.mkdir(path.join(launcherStage,'graphics-repair-metadata'));await fs.copyFile(path.join(delivery,'source-repair-plan.json'),path.join(launcherStage,'graphics-repair-metadata/source-repair-plan.json'));
const launcherZip=path.join(delivery,'FrostveilLauncher-0.1.18-source.zip');execFileSync('tar.exe',['-acf',launcherZip,'.'],{cwd:launcherStage,windowsHide:true});plan.correspondingSource=await identity(launcherZip);
plan.report=await identity(reportPath);plan.status='SEALED_LOCAL_CANDIDATE_AWAITING_SINGLE_DEPLOYMENT_APPROVAL';
const bytes=Buffer.from(JSON.stringify(plan,null,2)+'\n');await fs.writeFile(planPath,bytes);await fs.writeFile(path.join(delivery,'deployment-plan.sha256'),hash(bytes)+'\n');
const artifacts=[plan.installer,plan.correspondingSource,plan.modpack.correspondingSource,plan.server.bundle,{path:path.join(delivery,'source-repair-plan.json'),...plan.recipe},plan.archive,...plan.modpack.assets.map(a=>({...a,path:path.join(delivery,'modpack/reviewed-content',a.name)}))];
for(const artifact of artifacts){const actual=await identity(artifact.path);assert.equal(actual.sha256,artifact.sha256);assert.equal(actual.size,artifact.size);}
await fs.writeFile(path.join(delivery,'SHA256SUMS'),artifacts.map(a=>a.sha256+'  '+path.relative(delivery,a.path).replaceAll('\\','/')).join('\n')+'\n');
console.log(JSON.stringify({status:plan.status,approvalPlanSHA256:hash(bytes),installer:plan.installer,modpackSource:plan.modpack.correspondingSource,launcherSource:plan.correspondingSource,realGameWrites:0,serverWrites:0,nativeGameplay:'PENDING'}));
