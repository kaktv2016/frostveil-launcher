import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {build as viteBuild} from 'vite';
import { _electron as electron, expect } from '@playwright/test';

const root = process.env.FROSTVEIL_W09_EVIDENCE_ROOT;
assert.ok(root && path.isAbsolute(root), 'Set an absolute FROSTVEIL_W09_EVIDENCE_ROOT');
await fs.mkdir(root, {recursive: true});
const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'w09-ui-'));
const appRoot = path.join(runRoot, 'app');
const fixtureRoot = path.join(runRoot, 'fixture');
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(testsDir, '..');
await fs.mkdir(appRoot, {recursive: true});
await fs.mkdir(fixtureRoot, {recursive: true});
for (const dir of ['game-a/Data', 'game-b/Data', 'depot/Data', 'documents', 'appdata', 'local/Skyrim Special Edition']) {
  await fs.mkdir(path.join(fixtureRoot, dir), {recursive: true});
}
const gameA = path.join(fixtureRoot, 'game-a');
const gameB = path.join(fixtureRoot, 'game-b');
const config = path.join(fixtureRoot, 'local/Skyrim Special Edition');
const originalRuntime = Buffer.from('original runtime bytes');
const changedRuntime = Buffer.from('prepared runtime bytes');
const runtime = ['SkyrimSE.exe', ...['Skyrim', 'Update', 'Dawnguard', 'HearthFires', 'Dragonborn'].map(x=>`Data/${x}.esm`), 'Data/Skyrim - Meshes0.bsa'];
const baseline = [
  {path:'SkyrimSE.exe',component:'game'},
  {path:'skse64_loader.exe',component:'skse'},
  {path:'skse64_1_6_1170.dll',component:'skse'},
  {path:'Data/client-fixture.ini',component:'client'},
];
for (const file of new Set([...runtime, ...baseline.map(x=>x.path)])) {
  const bytes = file === 'SkyrimSE.exe' ? changedRuntime : Buffer.from('inert W09 ' + file);
  await fs.writeFile(path.join(fixtureRoot,'depot',file),bytes);
  if (file !== 'SkyrimSE.exe') await fs.writeFile(path.join(gameA,file),bytes);
}
await fs.writeFile(path.join(fixtureRoot,'inputs.json'),JSON.stringify({createdAt:new Date().toISOString(),runtime,baseline}));
const setMode = (name, value) => fs.writeFile(path.join(fixtureRoot, name+'-mode'), value);
await setMode('provider','stall');
await setMode('policy','fail');
await setMode('apply','ok');
for (const game of [gameA, gameB]) await fs.writeFile(path.join(game, 'SkyrimSE.exe'), originalRuntime);
await fs.writeFile(path.join(gameA, 'SkyrimSE.exe'), changedRuntime);

const storage = path.join(fixtureRoot, 'local', 'SkyrimRPLauncher');
await fs.mkdir(storage, {recursive: true});
await fs.writeFile(path.join(storage, 'compatibility-profile.json'), JSON.stringify({id:'w09-fixture',runtime:'1.6.1170.0',skseVersion:'0.2.2.6',skseDll:'skse64_1_6_1170.dll',evidence:'W09 synthetic fixture',files:[],backupFiles:[]}));
await fs.writeFile(path.join(storage, 'settings.json'), JSON.stringify({directory:'',channel:'stable'}));
const seeded = await seedRecovery(gameA, config, storage, originalRuntime, changedRuntime);
await fs.writeFile(path.join(fixtureRoot, 'selection.txt'), gameB);
await fs.writeFile(path.join(fixtureRoot, 'markers.jsonl'), '');
await fs.writeFile(path.join(appRoot, 'bootstrap.cjs'), bootstrapSource());

const fixtureModule = path.join(testsDir, 'w09-renderer-fixture.ts');
const imports = {
  './runtime/service': `export { RuntimePreparation } from ${JSON.stringify(fixtureModule)};`,
  './management/downloads': `export { ProductionDownloads } from ${JSON.stringify(fixtureModule)};`,
  './management/graphics-pack': `export { GraphicsPackService } from ${JSON.stringify(fixtureModule)};`,
  './windows': `import {fixtureWindows as w} from ${JSON.stringify(fixtureModule)}; export const {gameRunning,steamRoots,fileVersion,startSkse,authenticode}=w;`,
  './discovery': `import {fixtureDiscovery as d} from ${JSON.stringify(fixtureModule)}; export const {discoverSteam}=d;`,
  './client-repair': `import {fixtureClientRepair as c} from ${JSON.stringify(fixtureModule)}; export const {clientRequirementForScan,nativeRequirementForScan,planClientForWholePlay}=c;`,
  './graphics-source-plan': `import {fixtureGraphicsSourcePlan as g} from ${JSON.stringify(fixtureModule)}; export const {loadGraphicsSourcePlan,graphicsSourceDirectories}=g;`,
  './update-bootstrap': `export { createUpdater } from ${JSON.stringify(fixtureModule)};`,
};
const mainFile = path.join(appRoot, 'main.cjs');
const mainBuild = await build({entryPoints:[path.join(repo,'src/main/index.ts')],outfile:mainFile,bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',plugins:[{
  name:'w09-importer-scoped-inert-adapters',
  setup(builder){
    builder.onResolve({filter:/^\.\/runtime\/service$|^\.\/management\/downloads$|^\.\/management\/graphics-pack$|^\.\/windows$|^\.\/discovery$|^\.\/client-repair$|^\.\/graphics-source-plan$|^\.\/update-bootstrap$/}, args=>{
      if (path.basename(args.importer)!=='index.ts') return;
      const contents=imports[args.path];
      if (!contents) throw Error('Unexpected W09 importer alias '+args.path);
      return {path:args.path,namespace:'w09-fixture'};
    });
    builder.onLoad({filter:/.*/,namespace:'w09-fixture'}, args=>({contents:imports[args.path],loader:'js',resolveDir:repo}));
    builder.onResolve({filter:/^\.\.?\/windows$/}, args=>{
      if (!['managed-target.ts','service.ts'].includes(path.basename(args.importer))) return;
      return {path:'./windows',namespace:'w09-runtime-windows'};
    });
    builder.onLoad({filter:/.*/,namespace:'w09-runtime-windows'},()=>({contents:`export const gameRunning=async()=>false; export const steamRoots=async()=>[]; export const fileVersion=async()=> '1.6.1170.0';`,loader:'js'}));
  }
}]});
assert.ok(mainBuild.errors.length===0);
await build({entryPoints:[path.join(repo,'src/preload/index.ts')],outfile:path.join(appRoot,'preload.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron']});
await viteBuild({configFile:path.join(repo,'vite.config.ts'),root:path.join(repo,'src/renderer'),build:{outDir:path.join(appRoot,'renderer'),emptyOutDir:true}});
await fs.writeFile(path.join(appRoot,'package.json'), JSON.stringify({name:'frostveil-w09-fixture',version:'0.0.0',main:'bootstrap.cjs'}));

const bundleSha256 = await hashFile(mainFile);
const executablePath = fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url));
await fs.access(executablePath);
const inputs = {
  main:bundleSha256,
  preload:await hashFile(path.join(appRoot,'preload.cjs')),
  renderer:Object.fromEntries(await Promise.all(
    (await fs.readdir(path.join(appRoot,'renderer','assets'))).sort()
      .map(async name=>[name,await hashFile(path.join(appRoot,'renderer','assets',name))])
  )),
  rendererEntry:await hashFile(path.join(appRoot,'renderer','index.html')),
  electron:await hashFile(executablePath),
  fixture:await hashFile(path.join(fixtureRoot,'inputs.json')),
};
const env = {
  ...process.env,
  LOCALAPPDATA:path.join(fixtureRoot,'local'), APPDATA:path.join(fixtureRoot,'appdata'),
  FROSTVEIL_W09_MODULES:path.join(repo,'node_modules'),
  FROSTVEIL_W09_FIXTURE:fixtureRoot, FROSTVEIL_W09_SELECTION_FILE:path.join(fixtureRoot,'selection.txt'),
};
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
let app;
let passed=false;
const observed={};
try {
  const errors=[];
  async function launch(){
    app=await electron.launch({executablePath,args:[appRoot],env,timeout:25000});
    app.process().stderr?.on('data',bytes=>process.stderr.write(bytes));
    const page=await app.firstWindow({timeout:15000});
    page.on('pageerror',e=>errors.push(e.message));
    return page;
  }
  let page=await launch();
  let panel=page.getByTestId('runtime-preparation');
  const restoreButton=()=>panel.getByRole('button',{name:'คืนชุดก่อนติดตั้ง Frostveil',exact:true});
  const prepareButton=()=>panel.getByRole('button',{name:'เตรียมเกม',exact:true});
  const journalState=async()=>JSON.parse(JSON.parse(await fs.readFile(seeded.journal,'utf8')).body).state;
  const journalIs=state=>expect.poll(journalState,{timeout:15000}).toBe(state);
  const markers=async name=>(await readMarkers(fixtureRoot)).filter(x=>x.name===name).length;
  const waitMarker=(name,count)=>expect.poll(()=>markers(name),{timeout:15000}).toBe(count);
  await expect(panel).toBeVisible({timeout:45000});
  await expect(restoreButton()).toBeEnabled({timeout:15000});
  await waitMarker('provider-baseline-started',1);
  const initialJournalHash=await hashFile(seeded.journal);
  assert.equal(JSON.parse(await fs.readFile(path.join(storage,'settings.json'),'utf8')).directory,gameA);
  observed.discoverBindsRecoveryWhileStartupVerificationStalls=true;
  // Select away and back while the first metadata provider remains unresolved.
  await page.getByRole('button',{name:/^Installation/}).click();
  const choose=page.getByRole('button',{name:'Select folder',exact:true});
  await fs.writeFile(path.join(fixtureRoot,'selection.txt'),gameB);
  await choose.click();
  await expect(restoreButton()).toBeDisabled({timeout:15000});
  await expect(prepareButton()).toBeDisabled();
  observed.selectAwayClearsSelectedTargetsRestore=true;
  await fs.writeFile(path.join(fixtureRoot,'selection.txt'),gameA);
  await choose.click();
  await expect(restoreButton()).toBeEnabled({timeout:15000});
  assert.equal(await markers('runtime-policy-started'),0);
  assert.equal(await markers('provider-inspection-started'),0);
  assert.equal(await hashFile(seeded.journal),initialJournalHash);
  observed.selectBackRestoresSelectedTargetsRecovery=true;
  await restoreButton().click();
  await journalIs('restored');
  await expect(restoreButton()).toBeDisabled();
  assert.deepEqual(await fs.readFile(path.join(gameA,'SkyrimSE.exe')),originalRuntime);
  observed.actualRestoreIpcRestoredOriginalRuntime=true;
  await setMode('provider','ok');
  await page.getByRole('button',{name:/^Dashboard/}).click();
  await expect(page.getByRole('button',{name:'Re-scan',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Re-scan',exact:true}).click();
  await waitMarker('provider-inspection-started',1);
  observed.explicitVerificationInvoked=true;
  const playButton=()=>page.getByRole('button',{name:/^PLAY SKYRIM RP/});
  const alert=()=>page.getByRole('alert');
  await playButton().click();
  await expect(alert()).toContainText('ตรวจข้อมูลยืนยันชุดเกมไม่ได้',{timeout:15000});
  await journalIs('restored');
  await expect(restoreButton()).toBeDisabled();
  assert.deepEqual(await fs.readFile(path.join(gameA,'SkyrimSE.exe')),originalRuntime);
  observed.preApplyRefusalLeavesRestoreDisabledAndOriginalBytes=true;

  await setMode('policy','stall');
  await playButton().click();
  await waitMarker('runtime-policy-started',2);
  await panel.getByRole('button',{name:'ยกเลิกการเตรียมเกม',exact:true}).click();
  await expect(alert()).toContainText('ยกเลิกการเตรียมเกมแล้ว',{timeout:15000});
  await journalIs('restored');
  await expect(restoreButton()).toBeDisabled();
  observed.cancelledPreApplyLeavesNoRecovery=true;

  await page.getByRole('button',{name:/^Updates/}).click();
  const downloadPanel=page.getByTestId('production-download-panel');
  const downloadButton=downloadPanel.getByRole('button',{name:'Download & Install Server Files',exact:true});
  await downloadButton.click();
  await waitMarker('inert-server-download-started',1);
  await downloadPanel.getByRole('button',{name:'Cancel Download',exact:true}).click();
  await waitMarker('inert-server-download-cancelled',1);
  await expect(downloadButton).toBeEnabled();
  observed.serverDownloadCancelReachesActiveMainOperation=true;
  await page.getByRole('button',{name:/^Dashboard/}).click();

  await setMode('policy','ok');
  await prepareButton().click();
  await expect(panel.getByRole('status')).toContainText('ผ่านตรวจแล้ว',{timeout:15000});
  await expect(restoreButton()).toBeEnabled();
  await journalIs('active');
  assert.deepEqual(await fs.readFile(path.join(gameA,'SkyrimSE.exe')),changedRuntime);
  observed.standalonePrepareAppliedFixtureBytes=true;
  await restoreButton().click();
  await journalIs('restored');
  await expect(playButton()).toBeEnabled();

  await setMode('apply','fail');
  await playButton().click();
  await waitMarker('post-write-refusal',1);
  await expect(alert()).toContainText('ต้องกู้คืน',{timeout:15000});
  await journalIs('applying');
  await expect(restoreButton()).toBeEnabled();
  assert.equal(await markers('inert-skse'),0);
  observed.postWriteRefusalOffersRestoreAndDoesNotLaunch=true;

  await app.close();
  app=undefined;
  await setMode('provider','fail');
  page=await launch();
  panel=page.getByTestId('runtime-preparation');
  await waitMarker('provider-inspection-started',2);
  await expect(restoreButton()).toBeEnabled({timeout:15000});
  await expect(page.getByText('ตรวจข้อมูลยืนยันชุดเกมออนไลน์ไม่ได้ ลองกด Re-scan อีกครั้งเมื่อบริการพร้อม',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/^Installation/}).click();
  const selectAfterRestart=page.getByRole('button',{name:'Select folder',exact:true});
  await fs.writeFile(path.join(fixtureRoot,'selection.txt'),gameB);
  await selectAfterRestart.click();
  await expect(prepareButton()).toBeDisabled();
  await expect(restoreButton()).toBeDisabled();
  await fs.writeFile(path.join(fixtureRoot,'selection.txt'),gameA);
  await selectAfterRestart.click();
  await expect(restoreButton()).toBeEnabled();
  await page.getByRole('button',{name:/^Dashboard/}).click();
  observed.restoreFollowsSelectionWhenMetadataFails=true;
  const runtimeFile=path.join(gameA,'SkyrimSE.exe');
  const afterInterruption=await fs.readFile(runtimeFile);
  const conflict=Buffer.from('external fixture modification');
  await fs.writeFile(runtimeFile,conflict);
  await restoreButton().click();
  await expect(alert()).toContainText('เก็บไฟล์เดิมไว้',{timeout:15000});
  await expect(restoreButton()).toBeEnabled();
  assert.deepEqual(await fs.readFile(runtimeFile),conflict);
  observed.restartWithFailedMetadataAndConflictPreservesExternalBytes=true;
  await fs.writeFile(runtimeFile,afterInterruption);
  await restoreButton().click();
  await journalIs('restored');
  await expect(playButton()).toBeEnabled();
  assert.deepEqual(await fs.readFile(runtimeFile),originalRuntime);
  observed.offlineRestoreAfterRestartRestoresOriginalBytes=true;

  await setMode('apply','ok');
  await playButton().click();
  await waitMarker('inert-skse',1);
  await journalIs('active');
  await expect(restoreButton()).toBeEnabled();
  await expect(page.getByText('READY — local compatibility baseline matches',{exact:true})).toBeVisible();
  observed.wholePlayVerifiedAndInvokedOnlyInertSkse=true;
  await restoreButton().click();
  await journalIs('restored');
  assert.deepEqual(await fs.readFile(runtimeFile),originalRuntime);
  const settings=JSON.parse(await fs.readFile(path.join(storage,'settings.json'),'utf8'));
  assert.equal(settings.directory,gameA);
  assert.deepEqual(errors,[]);
  observed.rendererPageErrors=errors;
  observed.mainBundleSha256=bundleSha256;
  observed.security=await app.evaluate(({BrowserWindow})=>{
    const {contextIsolation,nodeIntegration,sandbox,webSecurity}=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {contextIsolation,nodeIntegration,sandbox,webSecurity};
  });
  assert.deepEqual(observed.security,{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true});
  passed=true;
  console.log(JSON.stringify({result:'PASS',observed}));
} finally {
  try {
    if(app) await app.close();
  } catch(error) {
    passed=false;
    throw error;
  } finally {
    const receipt={schemaVersion:1,result:passed?'PASS':'FAIL',scope:'test-only production main IPC, actual built preload and renderer',observed,inputs,runRoot};
    await fs.writeFile(path.join(root,path.basename(runRoot)+'.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
  }
}

function bootstrapSource(){return `const fs=require('node:fs');const path=require('node:path');const e=require('electron');const cp=require('node:child_process');
const fixture=process.env.FROSTVEIL_W09_FIXTURE;const originalFetch=e.net.fetch.bind(e.net);
const renderer=path.join(__dirname,'renderer');const {fileURLToPath}=require('node:url');
const within=(root,file)=>{const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
e.net.fetch=(url,...args)=>{if(!String(url).startsWith('file:')||!within(renderer,fileURLToPath(url)))throw Error('W09 network blocked');return originalFetch(url,...args);};
globalThis.fetch=async()=>{throw Error('W09 global network blocked');};for(const name of ['exec','execFile','spawn','fork','execSync','execFileSync','spawnSync'])cp[name]=()=>{throw Error('W09 process execution blocked: '+name);};
for(const module of ['node:http','node:https'])for(const name of ['request','get'])require(module)[name]=()=>{throw Error('W09 HTTP blocked');};
e.app.setPath('documents',path.join(fixture,'documents'));
e.app.on('browser-window-created',(_event,w)=>{w.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,done)=>done({cancel:!d.url.startsWith('app://launcher/')&&!(d.url.startsWith('file:')&&within(renderer,fileURLToPath(d.url)))}));w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',event=>event.preventDefault());});
e.dialog.showOpenDialog=async()=>{const selected=fs.readFileSync(process.env.FROSTVEIL_W09_SELECTION_FILE,'utf8').trim();if(![path.join(fixture,'game-a'),path.join(fixture,'game-b')].includes(selected))throw Error('W09 invalid selection');return{canceled:false,filePaths:[selected]};};
e.shell.openExternal=async()=>{throw Error('W09 external navigation blocked');};e.shell.openPath=async()=>{throw Error('W09 external path blocked');};
process.env.NODE_PATH=process.env.FROSTVEIL_W09_MODULES;require('node:module').Module._initPaths();
require(path.join(__dirname,'main.cjs'));`}
async function readMarkers(dir){return (await fs.readFile(path.join(dir,'markers.jsonl'),'utf8')).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));}
async function hashFile(file){return createHash('sha256').update(await fs.readFile(file)).digest('hex');}
async function seedRecovery(game,profile,store,beforeBytes,afterBytes){
  const key=createHash('sha256').update(game.toLowerCase()+'\n'+profile.toLowerCase()).digest('hex');
  const directory=path.join(store,'managed-installations',key),metadata=path.join(directory,'metadata'),payloads=path.join(directory,'packages');
  const runtimeMetadata=path.join(metadata,'runtime-preparation');
  await fs.mkdir(runtimeMetadata,{recursive:true});
  await fs.mkdir(path.join(payloads,'runtime-backups'),{recursive:true});
  const id=randomUUID(),authKey=randomBytes(32);
  await fs.writeFile(path.join(metadata,'auth-key'),authKey,{flag:'wx'});
  const roots={};
  for(const rootPath of [directory,game,path.join(game,'Data'),profile,metadata,payloads]){
    const stat=await fs.lstat(rootPath,{bigint:true});
    assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
    roots[rootPath]=`${stat.dev}:${stat.ino}`;
  }
  const grant={targetClass:'real-skyrim',directory,installation:game,configDirectory:profile,metadata,payloads,id,roots};
  const signed=async(file,value)=>{
    const body=JSON.stringify(value),mac=createHmac('sha256',authKey).update(body).digest('hex');
    await fs.writeFile(file,JSON.stringify({body,mac}),{flag:'wx'});
  };
  await signed(path.join(metadata,'sandbox.json'),grant);
  const before={size:beforeBytes.length,sha256:createHash('sha256').update(beforeBytes).digest('hex')};
  const after={size:afterBytes.length,sha256:createHash('sha256').update(afterBytes).digest('hex')};
  await fs.writeFile(path.join(payloads,'runtime-backups',before.sha256),beforeBytes,{flag:'wx'});
  const journal=path.join(runtimeMetadata,'journal.json');
  await signed(journal,{schemaVersion:2,installationId:id,policyHash:'a'.repeat(64),state:'active',wholePlay:{cohortId:'a'.repeat(64),directories:[]},files:[{path:'SkyrimSE.exe',before,after,writer:'runtime'}]});
  return {journal,id,directory};
}
