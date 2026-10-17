import React from 'react';
import type {Dashboard} from '../shared/contracts';
export function DownloadPanel({state,external,graphicsPack,busy,onDownload,onCancel,onSource,onInspect,onDownloadGraphics,onCancelGraphics}:{state:Dashboard['productionDownloads'];external:Dashboard['externalMod'];graphicsPack?:Dashboard['graphicsPack'];busy:boolean;onDownload:()=>void;onCancel:()=>void;onSource:()=>void;onInspect:()=>void;onDownloadGraphics?:()=>void;onCancelGraphics?:()=>void;}){
 return <section className="panel" data-testid="production-download-panel"><div className="section-title"><h3>Server files &amp; mods</h3><button className="primary" disabled={busy} onClick={onDownload}>{state?.installed?'Reinstall Server Files':'Download & Install Server Files'}</button></div>
 <p>กด Play เพื่อตรวจ hash และติดตั้งไฟล์เซิร์ฟเวอร์ที่ขาดหรือไม่ตรงให้อัตโนมัติ ปุ่มนี้ใช้ซ่อมไฟล์แยกได้เช่นกัน</p>
 <p data-testid="production-download-status" className={state?.installed||state?.phase==='complete'?'ok':'muted'}>{state?.message??'Not downloaded'}</p>
 <p>Pack: {state?.packId??'Not checked'} · Version: {state?.version??'Unknown'} · Signature: {state?.signature??'UNVERIFIED'} · Installation: {state?.installed?'INSTALLED & ACTIVATED (Ready to play)':'NOT INSTALLED'}</p>
 {state?.totalBytes? <><progress aria-label="Server files download" max={state.totalBytes} value={state.bytes}/><p>{state.bytes.toLocaleString()} / {state.totalBytes.toLocaleString()} bytes</p></>:null}
 {state?.files.map(f=><p className="path" key={f.name}>{f.verified?'✓':'…'} {f.name} · {f.size.toLocaleString()} bytes</p>)}
 {!!state?.externalRequirements&&<p className="muted">{state.externalRequirements} external game/runtime requirements are verified from the player's own installation; they are not included in this download.</p>}
 {['checking','downloading'].includes(state?.phase??'')&&<button className="secondary" onClick={onCancel}>Cancel Download</button>}
 <p className="ok">ระบบจะดูแลการติดตั้งและเปิด mod ใน plugins.txt ให้เสร็จสิ้นโดยอัตโนมัติ ไม่ต้องแก้ไขไฟล์เอง</p>
 <hr/>
 <div className="section-title">
  <h3>Frostveil Graphics &amp; World Pack (Mandatory • Anti-Cheat)</h3>
  <button className="primary" disabled={busy || graphicsPack?.phase==='downloading' || graphicsPack?.phase==='extracting'} onClick={onDownloadGraphics}>
   {graphicsPack?.installed ? 'Verify & Repair Graphics Pack' : 'Install Mandatory Graphics Pack (6.77 GB)'}
  </button>
 </div>
 <p>ม็อดกราฟิก แสงเงา ต้นไม้ สะพาน และโมเดลโลก 27 ตัว (บังคับเหมือนกันทุกคนเพื่อความยุติธรรม 100% ป้องกันการปิดหญ้า/ปรับขนาด Hitbox และล็อกค่า SHA-256 ทุกไฟล์ก่อนเข้าเล่น)</p>
 <p className={graphicsPack?.installed ? 'ok' : 'muted'}>{graphicsPack?.message ?? 'Mandatory Graphics & World Pack ready to verify from Cloudflare R2.'}</p>
 <p>Status: {graphicsPack?.installed ? `VERIFIED & LOCKED (v${graphicsPack.version ?? '1.0.1'} · 27 plugins · SHA-256 Anti-Cheat)` : 'REQUIRED BEFORE PLAY'}{graphicsPack?.speedMBps ? ` · Speed: ${graphicsPack.speedMBps.toFixed(1)} MB/s` : ''}</p>
 {graphicsPack?.totalBytes && (graphicsPack.phase==='downloading' || graphicsPack.bytes>0) ? <>
  <progress aria-label="Graphics pack download" max={graphicsPack.totalBytes} value={graphicsPack.bytes}/>
  <p>{(graphicsPack.bytes / (1024 * 1024)).toFixed(0)} MB / {(graphicsPack.totalBytes / (1024 * 1024)).toFixed(0)} MB</p>
 </> : null}
 {['checking','downloading','extracting'].includes(graphicsPack?.phase??'')&&<button className="secondary" onClick={onCancelGraphics}>Cancel Download</button>}
 <p className="ok">ระบบจะตรวจสอบ SHA-256 ทั้ง 46 ไฟล์ ลบม็อดที่ถูกแบน (เช่น RaceMenuPlugin.esp) และล็อกลำดับ Master-First ใน plugins.txt อัตโนมัติทุกครั้งที่กด Play</p>
 <hr/><h3>SkyUI · UI mod</h3><p>SkyUI เป็น dependency ภายนอกที่ต้องติดตั้งจากแหล่งทางการ แพ็กนี้ไม่แจกไฟล์ SkyUI; Launcher ตรวจไฟล์และเปิดใช้งานตามรายการที่เซิร์ฟเวอร์กำหนด</p>
 <div className="actions"><button className="secondary" disabled={busy} onClick={onSource}>SkyUI Official Download</button><button className="secondary" disabled={busy} onClick={onInspect}>Check My SkyUI Files</button></div>
 {external&&<><p className="muted">{external.message}</p>{external.files.map(f=><p key={f.name}>{f.name}: {f.verified?'Matches supplied 6.0 reference':'Missing / different version / unsafe file'}</p>)}<p>Files verified: {String(external.filesVerified)} · ESL: {String(external.light)} · Installation: {external.installation}</p></>}
 </section>;
}
