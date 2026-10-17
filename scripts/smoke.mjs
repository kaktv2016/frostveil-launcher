import {_electron as electron,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'skyrim-launcher-smoke-'));
const files=['SkyrimSE.exe','skse64_loader.exe','skse64_1_6_1170.dll','Data/Platform/Plugins/skymp5-client.js'];
const entries=[];
for(const [i,file] of files.entries()){const content=Buffer.from('INERT FIXTURE, NEVER EXECUTABLE '+file);await fs.mkdir(path.dirname(path.join(fixture,'game',file)),{recursive:true});await fs.writeFile(path.join(fixture,'game',file),content);entries.push({path:file,size:content.length,sha256:createHash('sha256').update(content).digest('hex'),component:i===0?'game':i===3?'client':'skse'});}
await fs.writeFile(path.join(fixture,'profile.json'),JSON.stringify({id:'fixture',runtime:'1.6.1170.0',skseVersion:'0.2.2.6',skseDll:files[2],files:entries,backupFiles:[files[3]],evidence:'inert synthetic smoke fixture'}));
await fs.mkdir('.local',{recursive:true});
const levelBProfile=process.env.LAUNCHER_LEVEL_B_PROFILE;const levelBArgs=levelBProfile?['--distribution-level-b','--level-b-profile',levelBProfile]:[];const env={...process.env,SKYRIM_LAUNCHER_FIXTURE:fixture};delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
 app=await electron.launch({executablePath:process.env.LAUNCHER_SMOKE_EXE||undefined,args:process.env.LAUNCHER_SMOKE_EXE?['--smoke',...levelBArgs]:['.','--smoke',...levelBArgs],env,timeout:30000});
 const window=await app.firstWindow();const errors=[];window.on('pageerror',e=>errors.push(e.message));
 await window.getByText('READY — local compatibility baseline matches',{exact:true}).waitFor({timeout:30000});
 assert.equal(await window.evaluate(()=>typeof window.require),'undefined');
 assert.deepEqual(await window.evaluate(()=>Object.keys(window.launcher).sort()),['downloadServerFiles','cancelServerFiles','openSkyUISource','inspectSkyUI','onProductionDownloads','applyManagement','cancelManagement','inspectManagement','onManagement','onManagementFixture','prepareManagement','recoverManagement','rollbackManagement','runManagementFixture','backup','cancelDistribution','cancelInstallerSandbox','cancelModpackScan','checkDistribution','checkUpdate','chooseDirectory','deferUpdate','downloadUpdate','installUpdate','onDistribution','onInstaller','onModpack','onUpdate','play','previewDistribution','recoverDistribution','rollbackDistribution','runDistributionSandbox','runInstallerSandbox','runLevelBSandbox','scan','scanModpack','setChannel','status'].sort());
 await window.screenshot({path:'.local/dashboard.png'});
 await window.getByRole('button',{name:/^Installation/}).click();
 await window.getByRole('button',{name:'Create Baseline Backup',exact:true}).click();
 await window.getByText(/VERIFIED · 1 files/).waitFor();
 const snapshot=await window.evaluate(()=>window.launcher.status());assert.equal(snapshot.backup.verified,true);
 await window.getByRole('button',{name:'Select folder',exact:true}).click();
 await window.getByRole('button',{name:/^Updates/}).click();
 await window.getByTestId('production-download-panel').waitFor();await expect(window.getByRole('button',{name:'Download & Install Server Files',exact:true})).toBeEnabled();await assert.rejects(()=>window.evaluate(()=>window.launcher.downloadServerFiles()));await assert.rejects(()=>window.evaluate(()=>window.launcher.openSkyUISource()));await assert.rejects(()=>window.evaluate(()=>window.launcher.inspectSkyUI()));await window.getByTestId('management-tests').locator('summary').click();await window.getByTestId('development-tools').locator('summary').click();await window.getByTestId('management-panel').waitFor();const initialManagement=(await window.evaluate(()=>window.launcher.status())).management;const review=window.getByRole('button',{name:'Review Install',exact:true});if(initialManagement.productionConfigured)await expect(review).toBeEnabled();else await expect(review).toBeDisabled();await expect(window.getByRole('button',{name:'Apply Reviewed Plan',exact:true})).toBeDisabled();await assert.rejects(()=>window.evaluate(()=>window.launcher.applyManagement('f'.repeat(64))));await window.getByRole('button',{name:'Run Realistic Modpack Fixture',exact:true}).click();await window.getByTestId('management-fixture-status').filter({hasText:'REALISTIC SANDBOX VERIFIED'}).waitFor({timeout:90000});const managed=(await window.evaluate(()=>window.launcher.status())).managementFixture;assert.equal(managed.phase,'complete');assert.ok(managed.checks.length>=8);await window.screenshot({path:'.local/l4c-management-ui.png',fullPage:true});
 await window.getByRole('button',{name:'Scan Modpack',exact:true}).click();
 await window.getByTestId('pack-status').filter({hasText:'Not Configured'}).waitFor();
 assert.equal((await window.evaluate(()=>window.launcher.status())).scan.ready,true);
 // Only synthetic metadata/bytes in the temporary fixture. No real profiles or game assets.
 const header=Buffer.alloc(24);header.write('TES4');header.writeUInt32LE(1,8);
 await fs.writeFile(path.join(fixture,'game/Data/Skyrim.esm'),header);
 const hash=createHash('sha256').update(header).digest('hex'),now=Date.now();
 const native={filename:'Skyrim.esm',required:true,order:0,masters:[],role:'server-required',sha256:hash};
 const pack={schemaVersion:1,packId:'synthetic-pack',packVersion:'1.0.0',channel:'stable',generatedAt:new Date(now).toISOString(),minimumLauncherVersion:'0.1.0',requiredSkyrimRuntime:'1.6.1170.0',requiredSKSEVersion:'0.2.2.6',requiredSkyMPClientVersion:'synthetic-client',serverProfileId:'synthetic-server',serverProfileVersion:'1.0.0',components:[{id:'native',name:'Native fixture',category:'native',required:true,dependencies:[]},{id:'client',name:'ไคลเอนต์ทดสอบ',category:'skse-skymp',required:true,dependencies:['native']}],files:[{path:'Data/Skyrim.esm',size:24,sha256:hash,componentId:'native',role:'native',required:true,ownership:'external-install',permission:'External only',distribution:'external-only'},{...entries[3],component:undefined,componentId:'client',role:'client',required:true,ownership:'external-install',permission:'External only',distribution:'external-only'}],requiredPlugins:[native],distribution:{source:'local-development'},signing:{algorithm:'Ed25519',keyId:'synthetic-only'}};
 const natives=['Data/SKSE/Plugins/MpClientPlugin.dll','Data/SKSE/Plugins/SkyrimPlatform.dll','Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll','Data/SKSE/Plugins/versionlib-1-6-1170-0.bin'];
 for(const relative of natives){await fs.mkdir(path.dirname(path.join(fixture,'game',relative)),{recursive:true});await fs.writeFile(path.join(fixture,'game',relative),'inert');pack.files.push({path:relative,size:5,sha256:createHash('sha256').update('inert').digest('hex'),componentId:'client',role:'client',required:true,ownership:'external-install',permission:'Synthetic only',distribution:'external-only'});}
 pack.skyMPClientRequirements={identity:'synthetic-client',nativeFiles:[...natives,entries[3].path]};
 const server={schemaVersion:1,id:'synthetic-server',version:'1.0.0',packId:pack.packId,packVersion:'1.0.0',runtime:pack.requiredSkyrimRuntime,skseVersion:pack.requiredSKSEVersion,clientIdentity:pack.requiredSkyMPClientVersion,generatedAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString(),source:'offline-skymp-export',engineCommit:'a'.repeat(40),plugins:[{...native,size:24,crc32:0,light:false,headerVerified:true}],archives:[],limitations:[]};
 await fs.mkdir(path.join(fixture,'order'));await fs.writeFile(path.join(fixture,'order/plugins.txt'),'# synthetic empty activation');await fs.writeFile(path.join(fixture,'game/Skyrim.ccc'),'');
 await fs.writeFile(path.join(fixture,'modpack-development.json'),JSON.stringify({manifest:pack,server}));
 await window.getByRole('button',{name:'Scan Modpack',exact:true}).click();
 await window.getByTestId('pack-status').filter({hasText:'Compatible — offline profile comparison'}).waitFor();
 let packState=(await window.evaluate(()=>window.launcher.status())).modpack;
 assert.equal(packState.trust,'LOCAL DEVELOPMENT ONLY');assert.equal(packState.result.live,'UNVERIFIED');assert.equal(packState.enforcement,false);assert.equal(packState.files.length,6);
 await expect(window.getByRole('button',{name:'Scan Modpack',exact:true})).toBeEnabled();
 // Cancel travels through the same validated IPC while the scan handler owns the mutation lock.
 await window.evaluate(async()=>{let stop;const unsub=window.launcher.onModpack(s=>{if(s.phase==='scanning'){unsub();stop=window.launcher.cancelModpackScan();}});await window.launcher.scanModpack();if(stop)await stop;});
 assert.equal((await window.evaluate(()=>window.launcher.status())).modpack.phase,'cancelled');
 // The narrow preload has no path argument; renderer-supplied extras cannot change scope.
 await window.evaluate(()=>window.launcher.scanModpack({path:'arbitrary'}));
 assert.equal((await window.evaluate(()=>window.launcher.status())).modpack.files.length,6);
 await window.getByRole('button',{name:'Scan Modpack',exact:true}).click();
 await window.getByTestId('pack-status').filter({hasText:'Compatible — offline profile comparison'}).waitFor();
 await expect(window.getByRole('button',{name:'Scan Modpack',exact:true})).toBeEnabled();
 await window.screenshot({path:'.local/modpack.png',fullPage:true});
 await window.getByRole('button',{name:'Run Sandbox Test',exact:true}).click();
 await window.getByTestId('installer-status').filter({hasText:'Sandbox demo passed'}).waitFor({timeout:60000});
 await expect(window.getByRole('button',{name:'Run Sandbox Test',exact:true})).toBeEnabled();
 const installer=(await window.evaluate(()=>window.launcher.status())).installer;assert.equal(installer.phase,'complete');assert.equal(installer.realInstallEnabled,false);assert.equal(installer.transactionState,'rolled-back');assert.equal(installer.checks.length,5);
 await window.screenshot({path:'.local/installer-sandbox.png',fullPage:true});
 if(levelBProfile){const expected=JSON.parse(await fs.readFile(levelBProfile,'utf8')),snapshot=await window.evaluate(()=>window.launcher.status());assert.equal(snapshot.distribution.levelBTest.keyId,expected.keyId);assert.equal(snapshot.distribution.levelBTest.fingerprint,expected.fingerprint);assert.equal(snapshot.distribution.levelBTest.publicationApproved,false);await window.getByTestId('level-b-mode').filter({hasText:'TEST DISTRIBUTION'}).waitFor();await assert.rejects(()=>window.evaluate(()=>window.launcher.runLevelBSandbox()));await expect(window.getByRole('button',{name:'Run Approved GitHub Sandbox',exact:true})).toBeDisabled();}
 else assert.equal((await window.evaluate(()=>window.launcher.status())).distribution.levelBTest,undefined);
 await window.getByRole('button',{name:'Run Local Network Sandbox',exact:true}).click();
 await window.getByTestId('distribution-status').filter({hasText:'Local network sandbox passed'}).waitFor({timeout:60000});
 const distribution=(await window.evaluate(()=>window.launcher.status())).distribution;assert.equal(distribution.phase,'complete');assert.equal(distribution.realInstallEnabled,false);assert.equal(distribution.checks.length,5);assert.equal(distribution.sourceMode,'LOCAL LOOPBACK TEST');assert.ok(distribution.downloadedPackages>=8);
 await window.getByRole('button',{name:'Rollback Sandbox Update',exact:true}).click();
 await window.getByTestId('distribution-status').filter({hasText:'Sandbox rollback verified'}).waitFor();
 assert.equal((await window.evaluate(()=>window.launcher.status())).distribution.installedVersion,'1.0.1');
 await window.getByRole('button',{name:'Recover Distribution Sandbox',exact:true}).click();
 await window.getByTestId('distribution-status').filter({hasText:'Sandbox recovery verified'}).waitFor();
 await window.screenshot({path:'.local/distribution-sandbox.png',fullPage:true});
 await assert.rejects(()=>window.evaluate(()=>window.launcher.setChannel('beta')));
 await window.getByRole('combobox').selectOption('stable');
 assert.equal((await window.evaluate(()=>window.launcher.status())).settings.channel,'stable');
 await assert.rejects(()=>window.evaluate(()=>window.launcher.setChannel('nightly')));
 await window.getByRole('button',{name:'Check for Updates',exact:true}).click();
 await window.getByText('available',{exact:true}).waitFor();
 await window.getByRole('button',{name:'Download Update',exact:true}).click();
 await window.getByText('downloaded',{exact:true}).waitFor();
 await window.getByRole('button',{name:'Later',exact:true}).click();
 await window.getByText('deferred',{exact:true}).waitFor();
 await assert.rejects(()=>window.evaluate(()=>window.launcher.installUpdate()));
 await window.screenshot({path:'.local/updates.png'});
 await window.getByRole('button',{name:/^Dashboard/}).click();
 await window.getByRole('button',{name:/PLAY SKYRIM RP/}).click();
 await window.getByRole('alert').filter({hasText:'Real game launch blocked in fixture smoke'}).waitFor();
 assert.equal(errors.length,0);
 for(const entry of entries){assert.equal(createHash('sha256').update(await fs.readFile(path.join(fixture,'game',entry.path))).digest('hex'),entry.sha256);}
 // Exercise the incompatible Dashboard using fixture files, never real game files.
 await fs.unlink(path.join(fixture,'game','SkyrimSE.exe'));
 await window.getByRole('button',{name:'Re-scan',exact:true}).click();
 await window.getByText('NOT READY — scan or select your existing installation',{exact:true}).waitFor();
 assert.equal(await window.getByRole('button',{name:/PLAY SKYRIM RP/}).isEnabled(),true);
 await window.getByRole('button',{name:/PLAY SKYRIM RP/}).click();
 await window.getByRole('alert').filter({hasText:'Installation is incompatible or unverified'}).waitFor();
 const security=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];const p=w.webContents.getLastWebPreferences();return{contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,sandbox:p.sandbox,webSecurity:p.webSecurity};});
 assert.deepEqual(security,{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true});
 await fs.writeFile('.local/smoke-report.json',JSON.stringify({status:'PASSED',fixtureOnly:true,realGameLaunch:false,security,checks:['ready and incompatible dashboards','no Node/raw IPC exposure','verified fixture backup','directory selection','channel validation','Play safely blocked in smoke','fixture game unchanged before intentional missing-file scenario','no renderer errors']},null,2));
 console.log('Electron fixture smoke PASSED; no real game/Steam/SKSE launched.');
}finally{if(app)await app.close();await fs.rm(fixture,{recursive:true,force:true});}
