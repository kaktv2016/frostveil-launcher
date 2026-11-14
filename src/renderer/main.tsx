import {RuntimePanel} from './RuntimePanel';
import {DownloadPanel} from './DownloadPanel';
import {ManagementPanel} from './ManagementPanel';
import {DistributionPanel} from './DistributionPanel';
import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import type {Dashboard,LauncherApi} from '../shared/contracts';
import type {RuntimePreparationState} from '../shared/runtime-contracts';
import './style.css';
import {InstallerPanel} from './InstallerPanel';
import {ModpackPanel} from './ModpackPanel';
declare global{interface Window{launcher:LauncherApi;}}
function olderRuntimeState(next: RuntimePreparationState | undefined, current: RuntimePreparationState | undefined) {
 const nextSelection=next?.selectionRevision??-1;
 const currentSelection=current?.selectionRevision??-1;
 if(nextSelection!==currentSelection)return nextSelection<currentSelection;
 return (next?.revision??-1)<(current?.revision??-1);
}

function App(){
 const [data,setData]=useState<Dashboard|null>(null),[tab,setTab]=useState('Dashboard'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [verifying,setVerifying]=useState(false);
 const [canCancelRuntime,setCanCancelRuntime]=useState(false);
 const mounted=useRef(false);
 const action=useRef({id:0,running:false});
 const verification=useRef(0);
 const currentRuntime=useRef<RuntimePreparationState | undefined>(undefined);
 const dashboard=useRef({selection:-1,updates:0,directory:''});
 const statusSelection=useRef(-1);

 function acceptDashboard(snapshot:Dashboard){
  const selection=snapshot.runtimePreparation?.selectionRevision??-1;
  if(selection<dashboard.current.selection||selection<(currentRuntime.current?.selectionRevision??-1))return;
  if(!olderRuntimeState(snapshot.runtimePreparation,currentRuntime.current))currentRuntime.current=snapshot.runtimePreparation;
  dashboard.current={selection,updates:dashboard.current.updates+1,directory:snapshot.settings.directory??''};
  setData({...snapshot,runtimePreparation:currentRuntime.current});
 }

 async function loadStatus(){
  const {id}=action.current;
  const {updates}=dashboard.current;
  try{
   const snapshot=await window.launcher.status();
   if(!mounted.current||id!==action.current.id)return;
   const selection=snapshot.runtimePreparation?.selectionRevision??-1;
   if(updates===dashboard.current.updates||selection>dashboard.current.selection)acceptDashboard(snapshot);
  }catch{/* The active action or verification reports its own failure. */}
 }

 async function verify(){
  const request=++verification.current;
  const {id}=action.current;
  const current=()=>mounted.current&&request===verification.current&&id===action.current.id;
  setVerifying(true);
  setError('');
  try{
   const snapshot=await window.launcher.scan();
   if(current())acceptDashboard(snapshot);
  }catch(e){
   if(current())setError(e instanceof Error?e.message:'ตรวจการติดตั้งไม่สำเร็จ กรุณาลองตรวจอีกครั้ง');
  }finally{
   if(current())setVerifying(false);
  }
 }

 async function act(fn:()=>Promise<Dashboard>,options:{cancelRuntime?:boolean;verifySelection?:boolean}={}){
  if(action.current.running)return;
  action.current={id:action.current.id+1,running:true};
  const {id}=action.current;
  const originalDirectory=dashboard.current.directory;
  const current=()=>mounted.current&&id===action.current.id;
  let verifySelection=false;
  ++verification.current;
  setVerifying(false);
  setBusy(true);
  setCanCancelRuntime(options.cancelRuntime===true);
  setError('');
  try{
   const snapshot=await fn();
   if(current()){
    acceptDashboard(snapshot);
    verifySelection=options.verifySelection===true&&dashboard.current.directory!==originalDirectory;
   }
  }catch(e){
   if(current()){
    setError(e instanceof Error?e.message:'ดำเนินการไม่สำเร็จ กรุณาตรวจสถานะแล้วลองอีกครั้ง');
    await loadStatus();
   }
  }finally{
   if(current()){
    action.current.running=false;
    setCanCancelRuntime(false);
    setBusy(false);
    if(verifySelection)void verify();
   }
  }
 }

 useEffect(()=>{
  mounted.current=true;
  const unsubscribe=window.launcher.onRuntimePreparation(runtimePreparation=>{
   if(!mounted.current||olderRuntimeState(runtimePreparation,currentRuntime.current))return;
   currentRuntime.current=runtimePreparation;
   const selection=runtimePreparation.selectionRevision??-1;
   const selected=selection===dashboard.current.selection;
   setData(previous=>previous?{...previous,runtimePreparation:selected?runtimePreparation:undefined}:previous);
   if(selection>dashboard.current.selection&&selection>statusSelection.current){
    statusSelection.current=selection;
    void loadStatus();
   }
  });
  void loadStatus();
  void verify();
  return ()=>{mounted.current=false;unsubscribe();};
 },[]);
 useEffect(()=>window.launcher.onProductionDownloads(productionDownloads=>setData(previous=>previous?{...previous,productionDownloads}:previous)),[]);
 useEffect(()=>window.launcher.onUpdate(launcherUpdate=>setData(previous=>previous?{...previous,launcherUpdate}:previous)),[]);
 useEffect(()=>window.launcher.onModpack(modpack=>setData(previous=>previous?{...previous,modpack}:previous)),[]);
 useEffect(()=>window.launcher.onInstaller(installer=>setData(previous=>previous?{...previous,installer}:previous)),[]);
 useEffect(()=>window.launcher.onDistribution(distribution=>setData(previous=>previous?{...previous,distribution}:previous)),[]);
 useEffect(()=>window.launcher.onManagement(management=>setData(previous=>previous?{...previous,management}:previous)),[]);
 useEffect(()=>window.launcher.onManagementFixture(managementFixture=>setData(previous=>previous?{...previous,managementFixture}:previous)),[]);
 useEffect(()=>window.launcher.onGraphicsPack(graphicsPack=>setData(previous=>previous?{...previous,graphicsPack}:previous)),[]);

 async function cancelOperation(cancel:()=>Promise<unknown>){
  const {id}=action.current;
  try{await cancel();}
  catch(e){
   if(mounted.current&&id===action.current.id&&action.current.running)
    setError(e instanceof Error?e.message:'ยกเลิกการดำเนินการไม่สำเร็จ');
  }
 }

 const scan=data?.scan;
 const runtimePhase=data?.runtimePreparation?.phase;
 const showRuntimeCancel=canCancelRuntime&&runtimePhase!==undefined&&
  !['idle','ready','restoring','blocked','cancelled'].includes(runtimePhase);
 const clientFiles=scan?.files.filter(file=>file.component==='client'||file.component==='configuration')??[];
 const clientMatch=clientFiles.length>0&&clientFiles.every(file=>file.status==='LOCAL BASELINE MATCH');
 const refresh=()=>{if(!busy&&!verifying)void verify();};
 const chooseDirectory=()=>act(()=>window.launcher.chooseDirectory(),{verifySelection:true});
 return <div className="shell"><aside><div className="brand"><span className="crest">ᚠ</span><div>FROSTVEIL<span>Skyrim Multiplayer Roleplay</span></div></div><div className="nav-label">YOUR JOURNEY</div><nav>{['Dashboard','Installation','Updates','Diagnostics'].map(name=><button key={name} className={tab===name?'selected':''} onClick={()=>setTab(name)}>{name}<span>›</span></button>)}</nav><div className="aside-bottom"><span className="dot"/>TRUSTED DISTRIBUTION<div>Downloads and installation</div><small>Launcher {data?.version??'0.1.7'} · L4-C</small></div></aside>
 <main><header><div><span className="eyebrow">SKYRIM RP / LAUNCHER FOUNDATION</span><h1>{tab}</h1></div><span className="pill">STEAM · SE 1.6.1170</span></header>{error&&<div className="error" role="alert">{error}</div>}{(tab==='Dashboard'||tab==='Installation')&&data?.verificationWarning&&<p className="muted" role="status">{data.verificationWarning}</p>}
 {(tab==='Dashboard'||tab==='Installation')&&data?.steamSelectionRequired&&<section className="panel" data-testid="steam-ambiguous-selection">
  <p role="status">พบ Skyrim Special Edition ใน Steam มากกว่าหนึ่งโฟลเดอร์ กรุณาเลือกโฟลเดอร์เกมที่จะใช้</p>
  {tab==='Dashboard'&&<button className="primary" disabled={busy} onClick={chooseDirectory}>Select folder</button>}
 </section>}
 <RuntimePanel state={data?.runtimePreparation} busy={busy} canCancel={showRuntimeCancel} onInspect={()=>act(()=>window.launcher.inspectRuntime(),{cancelRuntime:true})} onPrepare={()=>act(()=>window.launcher.prepareRuntime(),{cancelRuntime:true})} onRestore={()=>act(()=>window.launcher.restoreRuntime())} onCancel={()=>void cancelOperation(()=>window.launcher.cancelRuntime())}/>{tab==='Dashboard'&&<><section className="hero"><svg className="mountains" viewBox="0 0 800 280" aria-hidden="true"><path d="M0 260 155 100 255 205 430 15 605 190 710 70 800 260Z"/><path d="m365 90 65-75 76 83-75-37Z" className="snow"/></svg><div className="hero-content"><span className="eyebrow">A WORLD TO CALL YOUR OWN</span><h2>Your story starts here.</h2><p>กลับสู่โลก Skyrim กับตัวละครและเรื่องราวของคุณ</p><div className="hero-foot"><button className="primary" disabled={busy||!data?.settings.directory} onClick={()=>act(()=>window.launcher.play(),{cancelRuntime:true})}>{busy?'WORKING…':'PLAY SKYRIM RP'}<span>↗</span></button><span className="muted">ตรวจและซ่อมไฟล์เซิร์ฟเวอร์อัตโนมัติก่อนเข้าเกม<br/>Launch through your existing SKSE</span></div>{busy&&data?.productionDownloads&&<p role="status">{data.productionDownloads.message}</p>}</div></section>
 <div className="cards"><article><span className="eyebrow">GAME RUNTIME</span><h3>{scan?.runtime||'Not scanned'}</h3><p>{scan?.runtime==='1.6.1170.0'?'Pinned Steam runtime detected':'Exact version requires verification'}</p></article><article><span className="eyebrow">SKSE</span><h3>{scan?.skseRuntime==='0.2.2.6'?'2.2.6':scan?.skseRuntime||'Not scanned'}</h3><p>{scan?.skseLoader==='0.2.2.6'&&scan.skseRuntime==='0.2.2.6'?'Loader + matching runtime DLL detected':'Loader/runtime verification required'}</p></article><article><span className="eyebrow">SKYMP CLIENT</span><h3>{clientMatch?'Baseline match':'Needs verification'}</h3><p>Local solo-verified file hashes</p></article><article><span className="eyebrow">WORLD &amp; ANTI-CHEAT</span><h3>{data?.graphicsPack?.installed?'Verified':'Required (R2)'}</h3><p>{data?.graphicsPack?.installed?'27 plugins · SHA-256 locked':'Auto-verified on Play'}</p></article></div>
 <section className="panel"><div className="section-title"><h3>Installation readiness</h3><button className="secondary" disabled={busy||verifying} onClick={refresh}>{verifying?'Verifying…':'Re-scan'}</button></div><p className={scan?.ready?'ok':'muted'}>{scan?.ready?'READY — local compatibility baseline matches':'NOT READY — scan or select your existing installation'}</p>{data?.productionDownloads?.installed?<p className="ok">✓ Signed server pack files verified</p>:<p className="muted">ℹ กด Play เพื่อตรวจและดาวน์โหลดไฟล์ที่ขาดให้อัตโนมัติ</p>}{data?.graphicsPack?.installed?<p className="ok">✓ Mandatory World &amp; Graphics Pack v{data?.graphicsPack?.version ?? '1.0.1'} verified (46/46 SHA-256 Anti-Cheat hashes match)</p>:<p className="muted">ℹ กด Play เพื่อตรวจสอบความถูกต้องของไฟล์โลกและ Anti-Cheat อัตโนมัติ</p>}<p className="muted">Play checks the signed pack before launching. Missing approved SKSE, SkyMP, SkyUI and graphics files download automatically. Skyrim itself must be installed through Steam.</p>{scan?.errors.slice(0,4).map(e=><p className="failure" key={e}>{e}</p>)}</section></>}
 {tab==='Installation'&&<><section className="panel"><span className="eyebrow">EXISTING GAME INSTALLATION</span><h3>Skyrim Special Edition</h3><p className="path">{data?.settings.directory||'No installation selected'}</p><div className="actions"><button className="primary" disabled={busy} onClick={chooseDirectory}>Select folder</button><button className="secondary" disabled={busy||verifying} onClick={refresh}>{verifying?'Verifying…':'Re-scan installation'}</button></div></section><section className="panel"><h3>Baseline backup</h3><p>สำรองเฉพาะไฟล์ client/config ที่กำหนด ไม่รวมตัวเกมหรือ saves</p><button className="secondary" disabled={busy||!data?.settings.directory} onClick={()=>act(()=>window.launcher.backup())}>Create Baseline Backup</button>{data?.backup&&<><p className="ok">VERIFIED · {data.backup.files} files · {data.backup.bytes.toLocaleString()} bytes</p><p className="path">{data.backup.directory}</p>{data.backup.skipped.map(p=><p key={p}>Not backed up: {p}</p>)}</>}</section><section className="panel"><h3>Component evidence</h3><div className="file-list">{scan?.files.map(file=><div key={file.path}><span>{file.path}</span><small className={file.status==='LOCAL BASELINE MATCH'?'ok':'failure'}>{file.status}</small></div>)}</div></section></>}
 {tab==='Updates'&&<><section className="panel"><h3>Launcher updates</h3><p>Installed: {data?.version} · Available: {data?.launcherUpdate?.availableVersion??'Not detected'}{data?.launcherUpdate?.minimumLauncherVersion?` · Min launcher: ${data.launcherUpdate.minimumLauncherVersion}`:''}</p><p>Publisher trust: {data?.launcherUpdate?.publisherTrust??'unconfigured'} · Verification: {data?.launcherUpdate?.verification??'unconfigured'}{data?.launcherUpdate?.keyId?` · Key: ${data.launcherUpdate.keyId}`:''}</p><p className="path">https://github.com/kaktv2016/frostveil-launcher/releases</p><p className="ok">{data?.launcherUpdate?.state??'idle'}</p><p>{data?.launcherUpdate?.message}</p><label>Active update channel: Stable <select disabled={busy} value={data?.settings.channel??'stable'} onChange={e=>act(()=>window.launcher.setChannel(e.target.value as 'stable'|'beta'))}><option value="stable">Stable</option><option value="beta" disabled>Beta — disabled in L2</option></select></label><p className="muted">Beta isolation is not yet verified. Retained beta preferences do not enable beta updates.</p>{data?.launcherUpdate?.releaseNotes&&<p className="release-notes">{data.launcherUpdate.releaseNotes}</p>}{data?.launcherUpdate?.progress&&<div><progress aria-label="Download progress" max="100" value={data.launcherUpdate.progress.percent}/><p>{data.launcherUpdate.progress.percent.toFixed(1)}% · {data.launcherUpdate.progress.transferred.toLocaleString()} / {data.launcherUpdate.progress.total.toLocaleString()} bytes · {data.launcherUpdate.progress.bytesPerSecond.toLocaleString()} bytes/s</p></div>}<div className="actions">{!['downloading','installing','downloaded','deferred'].includes(data?.launcherUpdate?.state??'')&&<button className="secondary" disabled={busy} onClick={()=>act(()=>window.launcher.checkUpdate())}>{data?.launcherUpdate?.state==='error'?'Retry / Check for Updates':'Check for Updates'}</button>}{data?.launcherUpdate?.canDownload&&<button className="primary" disabled={busy} onClick={()=>act(()=>window.launcher.downloadUpdate())}>Download Update</button>}{data?.launcherUpdate?.canInstall&&<button className="primary" disabled={busy} onClick={()=>act(()=>window.launcher.installUpdate())}>Restart &amp; Update</button>}{data?.launcherUpdate?.state==='downloaded'&&<button className="secondary" disabled={busy} onClick={()=>act(()=>window.launcher.deferUpdate())}>Later</button>}</div><p className="muted">Self-install requires an Ed25519-verified release manifest, verified installer hashes, and an installed NSIS build. Unpacked/development builds cannot self-install.</p>{data?.launcherUpdate?.recoveryFallback&&<p className="muted">{data.launcherUpdate.recoveryFallback}</p>}</section><DownloadPanel state={data?.productionDownloads} external={data?.externalMod} graphicsPack={data?.graphicsPack} busy={busy} onDownload={()=>act(()=>window.launcher.downloadServerFiles())} onCancel={()=>void cancelOperation(()=>window.launcher.cancelServerFiles())} onSource={()=>act(()=>window.launcher.openSkyUISource())} onInspect={()=>act(()=>window.launcher.inspectSkyUI())} onDownloadGraphics={()=>act(()=>window.launcher.downloadGraphicsPack())} onCancelGraphics={()=>void cancelOperation(()=>window.launcher.cancelGraphicsPack())}/><ManagementPanel state={data?.management} fixture={data?.managementFixture} busy={busy} onInspect={()=>act(()=>window.launcher.inspectManagement())} onPrepare={intent=>act(()=>window.launcher.prepareManagement(intent))} onApply={hash=>act(()=>window.launcher.applyManagement(hash))} onCancel={()=>void cancelOperation(()=>window.launcher.cancelManagement())} onRollback={()=>act(()=>window.launcher.rollbackManagement())} onRecover={()=>act(()=>window.launcher.recoverManagement())} onFixture={()=>act(()=>window.launcher.runManagementFixture())}/><details className="panel" data-testid="development-tools"><summary>Developer tests</summary><ModpackPanel state={data?.modpack} busy={busy} onScan={()=>void act(()=>window.launcher.scanModpack())} onCancel={()=>{void window.launcher.cancelModpackScan().catch(()=>setError('Could not cancel scan'));}}/><DistributionPanel onRunLevelB={()=>void act(()=>window.launcher.runLevelBSandbox())} state={data?.distribution} busy={busy} onCheck={()=>void act(()=>window.launcher.checkDistribution())} onRun={()=>void act(()=>window.launcher.runDistributionSandbox())} onCancel={()=>void window.launcher.cancelDistribution().catch(()=>setError('Could not cancel distribution'))} onRollback={()=>void act(()=>window.launcher.rollbackDistribution())} onRecover={()=>void act(()=>window.launcher.recoverDistribution())}/><InstallerPanel state={data?.installer} busy={busy} onRun={()=>void act(()=>window.launcher.runInstallerSandbox())} onCancel={()=>{void window.launcher.cancelInstallerSandbox().catch(()=>setError('Could not cancel sandbox'));}}/></details></>}
 {tab==='Diagnostics'&&<section className="panel"><h3>Local diagnostics</h3><p>Last scan: {scan?.scannedAt??'Not scanned'}</p><p className="path">{scan?.directory}</p><p>SKSE loader: {scan?.skseLoader||'UNVERIFIED'} · runtime DLL: {scan?.skseRuntime||'UNVERIFIED'}</p><p>Optional SkyrimSELauncher.exe: {scan?.nativeLauncherAvailable?'Detected':'Not detected — SKSE launch path used'}</p><p>Server connectivity: NOT TESTED</p><p>Installation scans are read-only. Applying a reviewed plan requires confirmation.</p>{scan?.errors.map(e=><p className="failure" key={e}>{e}</p>)}<div className="events">{data?.events.map((event,i)=><p key={i}>{event}</p>)}</div></section>}
 <footer><span>{busy?'Operation in progress…':verifying?'Verifying installation…':'READY'}</span><span>Game launch ≠ verified multiplayer connection</span></footer></main></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
