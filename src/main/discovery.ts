import fs from 'node:fs/promises';
import path from 'node:path';
import vdf from 'vdf-parser';
import {relativePath} from './files';
async function readVdf(file:string):Promise<Record<string,any>>{const stat=await fs.stat(file);if(stat.size>1024*1024)throw Error('Steam metadata too large');return vdf.parse(await fs.readFile(file,'utf8'),false);}
export async function discoverSteam(roots:string[]):Promise<string[]>{
 const libraries=new Set(roots.filter(r=>typeof r==='string'&&path.isAbsolute(r)));
 for(const root of [...libraries]){try{const data=await readVdf(path.join(root,'steamapps/libraryfolders.vdf'));for(const value of Object.values(data.libraryfolders??data.LibraryFolders??{})){const folder=typeof value==='string'?value:(value as {path?:unknown})?.path;if(typeof folder==='string'&&path.isAbsolute(folder))libraries.add(folder);}}catch{/* manual fallback remains available */}}
 const installs:string[]=[];
 for(const library of libraries){try{const data=await readVdf(path.join(library,'steamapps/appmanifest_489830.acf'));const state=data.AppState;if(state?.appid!=='489830'||typeof state.installdir!=='string')continue;relativePath(state.installdir);if(state.installdir.includes('/'))continue;const folder=path.join(library,'steamapps/common',state.installdir);if((await fs.stat(folder)).isDirectory())installs.push(folder);}catch{/* stale libraries are excluded */}}
 return [...new Set(installs)];
}
