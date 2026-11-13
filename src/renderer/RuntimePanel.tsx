import React from 'react';
import type {RuntimePreparationState} from '../shared/runtime-contracts';
/** Preserve the helper's QR modules without font gaps or ClearType fringing.
 * Full-block console cells are half a module wide and one module tall. */
function SteamQr({text}:{text:string}){
 const rows=text.split('\n').slice(0,80),width=Math.max(1,...rows.map(r=>Math.min(r.length,256)))+16,height=rows.length*2+16;
 const marks:React.ReactNode[]=[];
 rows.forEach((row,y)=>{for(let x=0;x<Math.min(row.length,256);x++){
  if(row[x]==='█'){const start=x;while(x+1<row.length&&row[x+1]==='█')x++;marks.push(<rect key={y+':'+start} x={start+8} y={y*2+8} width={x-start+1} height={2}/>);}
  else if(row[x]==='▀'||row[x]==='▄')marks.push(<rect key={y+':'+x} x={x+8} y={y*2+8+(row[x]==='▄'?1:0)} width={1} height={1}/>);
 }});
 return <svg role="img" aria-label="Steam Guard login QR" viewBox={`0 0 ${width} ${height}`} width={width*4} height={height*4} shapeRendering="crispEdges" style={{background:'#fff',color:'#000',whiteSpace:'pre',maxWidth:'100%',height:'auto',display:'block'}}><rect width={width} height={height} fill="#fff"/><g fill="#000">{marks}</g></svg>;
}
const recoveryGuidance = {
 checking: 'กำลังตรวจข้อมูลกู้คืนของการติดตั้งที่เลือก',
 absent: '',
 recoverable: 'คุณสามารถคืนไฟล์ก่อนติดตั้ง Frostveil จากข้อมูลกู้คืนในเครื่องได้',
 foreign: 'เลือกโฟลเดอร์เกมเดิมที่เริ่มเตรียมไว้ เพื่อคืนไฟล์ของโปรไฟล์นี้',
 unsafe: 'ตรวจข้อมูลกู้คืนไม่ได้ กรุณาเก็บไฟล์สำรองไว้และให้ทีม Frostveil ตรวจสอบก่อนดำเนินการ',
} satisfies Record<NonNullable<RuntimePreparationState['recovery']>, string>;

export function RuntimePanel({state,busy,canCancel=busy,onInspect,onPrepare,onRestore,onCancel}:{state?:RuntimePreparationState;busy:boolean;canCancel?:boolean;onInspect:()=>void;onPrepare:()=>void;onRestore:()=>void;onCancel:()=>void}){
 const recovery=state?.recovery;
 const restoreAvailable=state?.canRestore&&(recovery===undefined||recovery==='recoverable');
 const preparationBlocked=recovery==='foreign'||recovery==='unsafe';
 const guidance=state?.recoveryMessage??(recovery?recoveryGuidance[recovery]:'');
 const bytes=(n:number)=>new Intl.NumberFormat('th-TH',{maximumFractionDigits:1}).format(n/1024**3)+' GB';
 return <section className="panel" data-testid="runtime-preparation">
  <h3>Steam Skyrim · 1.6.1170.0</h3>
  <p>ตรวจเกม → เตรียม 1.6.1170 → จัดชุดส่วนเสริม → ติดตั้ง modpack → เปิดเกม</p>
  <p role="status">{state?.message??'กด Play เพื่อเตรียมเกมอัตโนมัติ รองรับ Steam Windows / English'}</p>
  {guidance&&guidance!==state?.message&&<p className="muted">{guidance}</p>}
  {!!state?.changedFiles&&<p>{state.changedFiles} ไฟล์ · ดาวน์โหลด {bytes(state.downloadBytes)} · สำรองต้นฉบับ {bytes(state.backupBytes)} · staging {bytes(state.stagingBytes)}</p>}
  {state?.authQr&&<div><p>เปิดแอป Steam บนมือถือ → Steam Guard → สแกน QR นี้และอนุมัติ ไม่ต้องส่งรหัสผ่านหรือรหัสยืนยัน</p><SteamQr text={state.authQr}/></div>}
  <div className="actions"><button disabled={busy} className="secondary" onClick={onInspect}>ตรวจและดูพื้นที่</button><button disabled={busy||preparationBlocked} className="primary" onClick={onPrepare}>เตรียมเกม</button><button disabled={busy||!restoreAvailable} className="secondary" onClick={onRestore}>คืนชุดก่อนติดตั้ง Frostveil</button>{busy&&canCancel&&<button className="secondary" onClick={onCancel}>ยกเลิกการเตรียมเกม</button>}</div>
  <p className="muted">เก็บชุด RP ไว้หลังปิดเกม สำรองเฉพาะไฟล์ที่เปลี่ยน ไม่สร้างเกมอีกชุด และไม่แก้เซฟของผู้เล่น</p>
 </section>;
}
