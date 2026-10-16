import fs from 'node:fs/promises';
import {safeFile,hashFile} from '../files';
import {readPluginHeader} from '../modpack/plugins';
export const SKYUI_SOURCE='https://www.nexusmods.com/skyrimspecialedition/mods/12604';
export const SKYUI_EXPECTED=[
 {name:'SkyUI_SE.esp',size:2433,sha256:'61eb77164ed3632344ac2ccac4c8a4e69c62397999e7d8d558c162fd205616cf'},
 {name:'SkyUI_SE.bsa',size:2947857,sha256:'a9e106beec4c083c8d8b7a7e108ebbc0593f57a0c12f1e4efc5cefdf9af9cfbf'}
] as const;
export async function inspectSkyUI(folder:string){
 const files=[];for(const expected of SKYUI_EXPECTED){
  let verified=false;try{const file=await safeFile(folder,expected.name),stat=await fs.lstat(file);if(stat.nlink!==1)throw Error('Hardlinked external file refused');const h=await hashFile(file,32*1024*1024);verified=h.size===expected.size&&h.sha256===expected.sha256;}catch{/* Missing/unsafe/mismatched is not verified. */}
  files.push({name:expected.name,verified});
 }
 let light=false;if(files.every(f=>f.verified))light=(await readPluginHeader(await safeFile(folder,'SkyUI_SE.esp'))).light;
 return{name:'SkyUI SE 6.0',files,filesVerified:files.every(f=>f.verified),light,installation:'BLOCKED' as const,message:'External-only: redistribution permission is not verified. This supplied version is ESL flagged; activation/gameplay compatibility with SkyMP is not verified. Nothing was installed.'};
}
