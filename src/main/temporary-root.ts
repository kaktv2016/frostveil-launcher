import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {noLinks} from './files';
/** RDS may change TEMP from Temp to Temp/2 across Explorer-based NSIS restart. */
export async function canonicalTemporaryRoot(){
 await noLinks(os.tmpdir());const selected=await fs.realpath(os.tmpdir()),parent=path.dirname(selected);
 if(process.platform==='win32'&&/^\d+$/.test(path.basename(selected))&&/^(temp|_temp)$/i.test(path.basename(parent))){await noLinks(parent);return fs.realpath(parent);}
 return selected;
}
