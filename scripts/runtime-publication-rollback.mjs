import {createHash} from 'node:crypto';
const hash=b=>b===null?null:createHash('sha256').update(b).digest('hex');
/** Restore exactly our metadata mutation; never overwrite another publisher. */
export async function rollbackRuntimeMetadata({original,ourSHA256,readCurrent,putOriginal,deleteCurrent}){
 const current=await readCurrent(),before=hash(original),now=hash(current);
 if(now===ourSHA256){if(original===null)await deleteCurrent();else await putOriginal(original);}
 else if(now!==before)throw Error('Concurrent R2 policy change; refusing destructive rollback');
 if(hash(await readCurrent())!==before)throw Error('R2 rollback verification failed');
 return 'verified';
}
