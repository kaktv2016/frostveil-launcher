import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalSteamPath,readIdleSteamInstallation,steamLibraries} from '../discovery';
export interface SteamSelection {game:string;manifest:string;language:'english';}
const selections=new WeakMap<object,{use:'prepare'|'restore';roots:readonly string[]}>();
async function assertListedLibrary(game:string,roots:readonly string[]){
 if(!(await steamLibraries(roots)).has(path.resolve(game,'../../..'))){
  throw Error('Select a verified Steam Skyrim installation (App 489830) from a registered library');
 }
}

async function verifySelection(game:string,roots:string[],use:'prepare'|'restore'):Promise<SteamSelection>{
 const canonical=await canonicalSteamPath(game);
 await assertListedLibrary(canonical,roots);
 const manifest=path.resolve(canonical,'../../appmanifest_489830.acf');
 await readIdleSteamInstallation(canonical,manifest,use==='restore');
 const selection:SteamSelection=Object.freeze({game:canonical,manifest,language:'english'});
 selections.set(selection,{use,roots:[...roots]});
 return selection;
}
export function verifySteamSelection(game:string,roots:string[]){
 return verifySelection(game,roots,'prepare');
}
/** The caller must establish authenticated journal ownership before offline Restore. */
export function verifySteamRecoverySelection(game:string,roots:string[]){
 return verifySelection(game,roots,'restore');
}
export async function assertSteamIdle(selection:SteamSelection){
 const authority=selections.get(selection);
 if(!authority)throw Error('Verified Steam selection required');
 if(authority.use==='prepare')await assertListedLibrary(selection.game,authority.roots);
 let depots;
 try{depots=await readIdleSteamInstallation(selection.game,selection.manifest,authority.use==='restore');}
 catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')throw Error('Steam installation changed; App 489830 metadata is unavailable',{cause:error});
  throw error;
 }
 return createHash('sha256').update(JSON.stringify(depots)).digest('hex');
}
export function isSteamSelection(value:SteamSelection){return selections.has(value);}
