import fs from 'node:fs/promises';
import path from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const DRIVE_PATH = /^[A-Za-z]:\\[^<>:"|?*\x00-\x1f]+$/;

function canonicalLocalPath(value, label) {
 if(typeof value!=='string'||!DRIVE_PATH.test(value)||value.includes('/'))throw Error(`Invalid ${label}`);
 const normalized=path.win32.normalize(value);
 if(normalized!==value||value.split('\\').some(part=>part==='.'||part==='..'||/[ .]$/.test(part)||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)))throw Error(`Non-canonical ${label}`);
 return normalized;
}

export function validateW14ContentPin(value) {
 if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join(',')!=='folder,packEnvelopeSha256,packReleaseSha256,runtimeSha256'){
  throw Error('Invalid W14 content pin fields');
 }
 const folder=canonicalLocalPath(value.folder,'W14 content folder');
 for(const name of ['runtimeSha256','packReleaseSha256','packEnvelopeSha256']){
  if(typeof value[name]!=='string'||!HASH.test(value[name]))throw Error('Invalid W14 content pin digest');
 }
 return {folder,runtimeSha256:value.runtimeSha256,packReleaseSha256:value.packReleaseSha256,packEnvelopeSha256:value.packEnvelopeSha256};
}

export function encodeW14ContentBuildPin(pin){
 return Buffer.from(JSON.stringify(pin),'utf8').toString('base64');
}

export async function readW14ContentBuildPin(file) {
 const canonicalFile=canonicalLocalPath(file,'W14 content pin file');
 const before=await fs.lstat(canonicalFile,{bigint:true});
 if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>65536n)throw Error('Unsafe W14 content pin file');
 const handle=await fs.open(canonicalFile,'r');
 try{
  const opened=await handle.stat({bigint:true});
  if(!opened.isFile()||opened.nlink!==1n||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||
     (await fs.realpath(canonicalFile)).toLowerCase()!==canonicalFile.toLowerCase())throw Error('W14 content pin file changed at open');
  const bytes=Buffer.alloc(Number(opened.size));
  for(let offset=0;offset<bytes.length;){
   const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
   if(!bytesRead)throw Error('Truncated W14 content pin file');
   offset+=bytesRead;
  }
  const after=await handle.stat({bigint:true});
  if(after.size!==opened.size||after.nlink!==1n||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs)throw Error('W14 content pin file changed while reading');
  return validateW14ContentPin(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
 }finally{await handle.close();}
}
