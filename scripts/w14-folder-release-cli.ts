import {createPrivateKey} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {noLinks,safeFile} from '../src/main/files';
import {prepareW14FolderRelease} from './prepare-w14-folder-release';

async function readBounded(file:string,maxBytes:number){
 await noLinks(file);
 const before=await fs.lstat(file,{bigint:true});
 if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>BigInt(maxBytes))throw Error('Unsafe input file');
 const handle=await fs.open(file,'r');
 try{
  const info=await handle.stat({bigint:true});
  if(!info.isFile()||info.nlink!==1n||info.ino!==before.ino||info.dev!==before.dev||info.size!==before.size||
     (await fs.realpath(file)).toLowerCase()!==path.resolve(file).toLowerCase())throw Error('Input file changed at open');
  const bytes=Buffer.alloc(Number(info.size));
  for(let offset=0;offset<bytes.length;){
   const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
   if(!bytesRead)throw Error('Truncated input file');
   offset+=bytesRead;
  }
  return bytes;
 }finally{await handle.close();}
}

async function main(input:string,output:string,planSha256:string){
 if(!/^[A-Za-z]:[\\/]/.test(input)||!/^[A-Za-z]:[\\/]/.test(output))throw Error('Expected local Windows paths');
 const root=path.resolve(output);
 await noLinks(root);
 const plan=await readBounded(await safeFile(path.resolve(input),'folder-release-plan.json'),65536);
 return prepareW14FolderRelease(input,root,plan,planSha256,async()=>{
  const signerFile=path.join(os.homedir(),'.codex','frostveil-signing','production-candidates-20261016','launcher-update-private.pem');
  const bytes=await readBounded(signerFile,8192);
  try{return createPrivateKey(bytes);}finally{bytes.fill(0);}
 });
}

const [input,output,planSha256,...extra]=process.argv.slice(2);
if(process.platform!=='win32'||!input||!output||!planSha256||extra.length){
 console.error('Usage (Windows): node w14-folder-release.cjs <approved-input-root> <private-output-parent> <confirmed-plan-sha256>');
 process.exitCode=1;
}else{
 main(input,output,planSha256).then(result=>console.log(JSON.stringify(result,null,2))).catch(()=>{
  console.error(JSON.stringify({status:'BLOCKED',qualification:'NOT_RUN',reason:'Could not prepare the approved W14 release packet'}));
  process.exitCode=1;
 });
}
