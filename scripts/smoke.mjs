import {_electron as electron} from '@playwright/test';
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
const env={...process.env,SKYRIM_LAUNCHER_FIXTURE:fixture};delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
 app=await electron.launch({executablePath:process.env.LAUNCHER_SMOKE_EXE||undefined,args:process.env.LAUNCHER_SMOKE_EXE?['--smoke']:['.','--smoke'],env,timeout:30000});
 const window=await app.firstWindow();const errors=[];window.on('pageerror',e=>errors.push(e.message));
 await window.getByText('READY — local compatibility baseline matches',{exact:true}).waitFor({timeout:30000});
 assert.equal(await window.evaluate(()=>typeof window.require),'undefined');
 assert.deepEqual(await window.evaluate(()=>Object.keys(window.launcher).sort()),['backup','chooseDirectory','play','scan','setChannel','status']);
 await window.screenshot({path:'.local/dashboard.png'});
 await window.getByRole('button',{name:/^Installation/}).click();
 await window.getByRole('button',{name:'Create Baseline Backup',exact:true}).click();
 await window.getByText(/VERIFIED · 1 files/).waitFor();
 const snapshot=await window.evaluate(()=>window.launcher.status());assert.equal(snapshot.backup.verified,true);
 await window.getByRole('button',{name:'Select folder',exact:true}).click();
 await window.getByRole('button',{name:/^Updates/}).click();
 await window.getByRole('combobox').selectOption('beta');
 assert.equal((await window.evaluate(()=>window.launcher.status())).settings.channel,'beta');
 await assert.rejects(()=>window.evaluate(()=>window.launcher.setChannel('nightly')));
 await window.getByRole('button',{name:/^Dashboard/}).click();
 await window.getByRole('button',{name:/PLAY SKYRIM RP/}).click();
 await window.getByRole('alert').filter({hasText:'Real game launch blocked in fixture smoke'}).waitFor();
 assert.equal(errors.length,0);
 for(const entry of entries){assert.equal(createHash('sha256').update(await fs.readFile(path.join(fixture,'game',entry.path))).digest('hex'),entry.sha256);}
 // Exercise the incompatible Dashboard using fixture files, never real game files.
 await fs.unlink(path.join(fixture,'game','SkyrimSE.exe'));
 await window.getByRole('button',{name:'Re-scan',exact:true}).click();
 await window.getByText('NOT READY — scan or select your existing installation',{exact:true}).waitFor();
 assert.equal(await window.getByRole('button',{name:/PLAY SKYRIM RP/}).isDisabled(),true);
 const security=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];const p=w.webContents.getLastWebPreferences();return{contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,sandbox:p.sandbox,webSecurity:p.webSecurity};});
 assert.deepEqual(security,{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true});
 await fs.writeFile('.local/smoke-report.json',JSON.stringify({status:'PASSED',fixtureOnly:true,realGameLaunch:false,security,checks:['ready and incompatible dashboards','no Node/raw IPC exposure','verified fixture backup','directory selection','channel validation','Play safely blocked in smoke','fixture game unchanged before intentional missing-file scenario','no renderer errors']},null,2));
 console.log('Electron fixture smoke PASSED; no real game/Steam/SKSE launched.');
}finally{if(app)await app.close();await fs.rm(fixture,{recursive:true,force:true});}
