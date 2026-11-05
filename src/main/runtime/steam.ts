import fs from 'node:fs/promises';
import path from 'node:path';
import vdf from 'vdf-parser';
import {createHash} from 'node:crypto';
import {discoverSteam} from '../discovery';
import {safeFile,noLinks} from '../files';
export interface SteamSelection {game:string;manifest:string;language:'english';}
const selections=new WeakSet<object>();
export async function verifySteamSelection(game:string,roots:string[]):Promise<SteamSelection>{
 const canonical=await fs.realpath(game);await noLinks(canonical);
 const found=await discoverSteam(roots);if(!found.some(n=>path.resolve(n).toLowerCase()===canonical.toLowerCase()))throw Error('Select a verified Steam Skyrim installation (App 489830)');
 const manifest=await safeFile(path.resolve(canonical,'../..'),'appmanifest_489830.acf');
 const selection:SteamSelection=Object.freeze({game:canonical,manifest,language:'english'});selections.add(selection);await assertSteamIdle(selection);return selection;
}
export async function assertSteamIdle(selection:SteamSelection){
 if(!selections.has(selection))throw Error('Verified Steam selection required');
 await noLinks(selection.manifest);const s=await fs.stat(selection.manifest);if(s.nlink!==1||s.size>1024*1024)throw Error('Invalid Steam installation metadata');
 const a=vdf.parse(await fs.readFile(selection.manifest,'utf8'),false).AppState;
 if(a?.appid!=='489830'||typeof a.installdir!=='string'||path.basename(selection.game).toLowerCase()!==a.installdir.toLowerCase())throw Error('Steam installation identity changed');
 if(a.StateFlags!=='4'||Number(a.StagingSize??0)!==0||Number(a.BytesDownloaded??0)<Number(a.BytesToDownload??0)||Number(a.BytesStaged??0)<Number(a.BytesToStage??0))throw Error('Steam installation is updating or incomplete; wait for Steam to finish');
 if((a.UserConfig?.language??a.MountedConfig?.language??'english')!=='english')throw Error('Only the verified English Steam runtime cohort is supported');
 return createHash('sha256').update(JSON.stringify(a.InstalledDepots??{})).digest('hex');
}
export function isSteamSelection(value:SteamSelection){return selections.has(value);}
