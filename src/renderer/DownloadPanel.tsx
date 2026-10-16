import React from 'react';
import type {Dashboard} from '../shared/contracts';
export function DownloadPanel({state,external,busy,onDownload,onCancel,onSource,onInspect}:{state:Dashboard['productionDownloads'];external:Dashboard['externalMod'];busy:boolean;onDownload:()=>void;onCancel:()=>void;onSource:()=>void;onInspect:()=>void}){
 return <section className="panel" data-testid="production-download-panel"><div className="section-title"><h3>Server files &amp; mods</h3><button className="primary" disabled={busy} onClick={onDownload}>Download Server Files</button></div>
 <p>ดาวน์โหลดไฟล์ที่เซิร์ฟเวอร์กำหนดจาก GitHub และตรวจลายเซ็นก่อนเก็บไว้ใน cache ขั้นตอนนี้ยังไม่ติดตั้งหรือแก้ไฟล์เกม</p>
 <p data-testid="production-download-status" className={state?.phase==='complete'?'ok':'muted'}>{state?.message??'Not downloaded'}</p>
 <p>Pack: {state?.packId??'Not checked'} · Version: {state?.version??'Unknown'} · Signature: {state?.signature??'UNVERIFIED'} · Installation: NOT INSTALLED BY DOWNLOAD</p>
 {state?.totalBytes? <><progress aria-label="Server files download" max={state.totalBytes} value={state.bytes}/><p>{state.bytes.toLocaleString()} / {state.totalBytes.toLocaleString()} bytes</p></>:null}
 {state?.files.map(f=><p className="path" key={f.name}>{f.verified?'✓':'…'} {f.name} · {f.size.toLocaleString()} bytes</p>)}
 {!!state?.externalRequirements&&<p className="muted">{state.externalRequirements} external game/runtime requirements are verified from the player's own installation; they are not included in this download.</p>}
 {['checking','downloading'].includes(state?.phase??'')&&<button className="secondary" onClick={onCancel}>Cancel Download</button>}
 <p>เมื่อดาวน์โหลดเสร็จ ให้เลือกเกมและกด Review Install ด้านล่าง ตรวจรายการแล้วจึงกด Apply Reviewed Plan เพื่อยืนยันติดตั้งด้วยตัวเอง</p>
 <hr/><h3>SkyUI · external mod</h3><p>SkyUI ไม่ได้รวมอยู่ใน GitHub pack ของเรา ผู้เล่นดาวน์โหลดจากเจ้าของได้เอง ไฟล์ตัวอย่างรุ่น 6.0 เป็น ESL จึงยังไม่เปิดให้ Launcher ติดตั้งจนกว่าจะยืนยันความเข้ากันได้กับ SkyMP</p>
 <div className="actions"><button className="secondary" disabled={busy} onClick={onSource}>SkyUI Official Download</button><button className="secondary" disabled={busy} onClick={onInspect}>Check My SkyUI Files</button></div>
 {external&&<><p className="muted">{external.message}</p>{external.files.map(f=><p key={f.name}>{f.name}: {f.verified?'Matches supplied 6.0 reference':'Missing / different version / unsafe file'}</p>)}<p>Files verified: {String(external.filesVerified)} · ESL: {String(external.light)} · Installation: {external.installation}</p></>}
 </section>;
}
