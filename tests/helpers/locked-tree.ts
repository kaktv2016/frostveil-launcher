import fs from 'node:fs/promises';
// Test-only cleanup for the owned disposable NSIS directory.
export async function removeLockedTree(target:string,remove=()=>fs.rm(target,{recursive:true,force:true}),wait=()=>new Promise<void>(r=>setTimeout(r,250))):Promise<void>{
 for(let attempt=0;;attempt++){
  try{await remove();return;}
  catch(error){const code=(error as NodeJS.ErrnoException).code;if(!['EBUSY','EPERM','ENOTEMPTY'].includes(code??'')||attempt>=31)throw error;await wait();}
 }
}
