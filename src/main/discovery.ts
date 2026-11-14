import fs from 'node:fs/promises';
import path from 'node:path';
import vdf from 'vdf-parser';
import type {BigIntStats} from 'node:fs';
import {noLinks,relativePath,safeFile} from './files';

const maxMetadataBytes=1024*1024;
const manifestName='appmanifest_489830.acf';
type VdfObject=Record<string,unknown>;

function object(value:unknown):VdfObject|undefined{
 return value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype?value as VdfObject:undefined;
}

export async function canonicalSteamPath(input:string){
 if(!path.isAbsolute(input)||input.split(/[\\/]/).includes('..'))throw Error('Steam paths cannot contain parent segments');
 const resolved=path.resolve(input);
 await noLinks(resolved);
 const canonical=await fs.realpath(resolved);
 // Recheck the original chain after resolution so a redirected spelling
 // cannot be accepted solely because its destination is a real directory.
 await noLinks(resolved);
 await noLinks(canonical);
 return canonical;
}

async function readVdf(file:string):Promise<VdfObject>{
 await noLinks(file);
 const checkMetadata=(stat:BigIntStats)=>{
  if(!stat.isFile()||stat.nlink!==1n||stat.size>BigInt(maxMetadataBytes))throw Error('Invalid Steam metadata');
  return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
 };
 const initial=await fs.lstat(file,{bigint:true}),stamp=checkMetadata(initial);
 const handle=await fs.open(file,'r');
 try{
  if(checkMetadata(await handle.stat({bigint:true}))!==stamp)throw Error('Steam metadata changed during open');
  const buffer=Buffer.alloc(Number(initial.size)+1);
  let offset=0;
  while(offset<buffer.length){
   const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,null);
   if(!bytesRead)break;
   offset+=bytesRead;
  }
  await noLinks(file);
  if(checkMetadata(await fs.lstat(file,{bigint:true}))!==stamp||offset!==Number(initial.size)){
   throw Error('Steam metadata changed during read');
  }
  const parsed=object(vdf.parse<unknown>(buffer.subarray(0,offset).toString('utf8').replace(/^\uFEFF/,''),{types:false,arrayify:true}));
  if(!parsed)throw Error('Invalid Steam metadata');
  return parsed;
 }finally{await handle.close();}
}

async function steamAppState(manifest:string){
 const state=object((await readVdf(manifest)).AppState);
 if(!state||state.appid!=='489830'||typeof state.installdir!=='string')throw Error('Invalid Steam App 489830 metadata');
 let folder:string;
 try{folder=relativePath(state.installdir);}
 catch(cause){throw Error('Invalid Steam App 489830 installation directory',{cause});}
 if(folder.includes('/'))throw Error('Invalid Steam App 489830 installation directory');
 return {state,folder};
}

function bytes(value:unknown){
 return value===undefined?0n:typeof value==='string'&&/^\d{1,20}$/.test(value)?BigInt(value):undefined;
}

function assertIdleEnglish(state:VdfObject,allowMissingLanguage=false){
 const staging=bytes(state.StagingSize);
 const downloaded=bytes(state.BytesDownloaded),toDownload=bytes(state.BytesToDownload);
 const staged=bytes(state.BytesStaged),toStage=bytes(state.BytesToStage);
 if(state.StateFlags!=='4'||staging!==0n||downloaded===undefined||toDownload===undefined||
    staged===undefined||toStage===undefined||downloaded<toDownload||staged<toStage){
  throw Error('Steam installation is updating or incomplete; wait for Steam to finish');
 }
 const user=object(state.UserConfig),mounted=object(state.MountedConfig);
 if(state.UserConfig!==undefined&&!user||state.MountedConfig!==undefined&&!mounted)throw Error('Invalid Steam English language metadata');
 const languages=[user?.language,mounted?.language].filter(language=>language!==undefined);
 if(!allowMissingLanguage&&!languages.length||languages.some(language=>language!=='english'))throw Error('Only the verified English Steam runtime cohort is supported');
}

async function gameDirectoryIdentity(game:string){
 if(await canonicalSteamPath(game)!==game)throw Error('Steam installation identity changed');
 const stat=await fs.lstat(game,{bigint:true});
 if(!stat.isDirectory())throw Error('Steam installation identity changed');
 return stat.dev+':'+stat.ino;
}

export async function readIdleSteamInstallation(game:string,manifest:string,allowMissingLanguage=false){
 const steamapps=path.resolve(game,'../..');
 if(path.basename(path.dirname(game)).toLowerCase()!=='common'||path.basename(steamapps).toLowerCase()!=='steamapps'||
    path.join(steamapps,manifestName)!==manifest){
  throw Error('Steam installation identity changed');
 }
 const gameIdentity=await gameDirectoryIdentity(game);
 const {state,folder}=await steamAppState(manifest);
 if(await gameDirectoryIdentity(game)!==gameIdentity)throw Error('Steam installation identity changed');
 if(path.basename(game).toLowerCase()!==folder.toLowerCase())throw Error('Steam installation identity changed');
 assertIdleEnglish(state,allowMissingLanguage);
 return state.InstalledDepots??{};
}

export async function steamLibraries(roots:readonly string[]){
 const libraries=new Set<string>();
 const addLibrary=async(input:unknown)=>{
  if(typeof input!=='string'||!path.isAbsolute(input))return;
  try{libraries.add(await canonicalSteamPath(input));}catch{/* Invalid or redirected library. */}
 };
 for(const root of roots)await addLibrary(root);
 for(const root of [...libraries]){
  try{
   const file=await safeFile(root,'steamapps/libraryfolders.vdf');
   const data=await readVdf(file);
   const folders=object(data.libraryfolders??data.LibraryFolders);
   for(const [key,value] of Object.entries(folders??{})){
    if(/^\d+$/.test(key))await addLibrary(typeof value==='string'?value:object(value)?.path);
   }
  }catch{/* A missing or unsafe catalog cannot contribute alternate libraries. */}
 }
 return libraries;
}

export async function discoverSteam(roots:string[],{requireIdle=false}:{requireIdle?:boolean}={}):Promise<string[]>{
 const libraries=await steamLibraries(roots);
 const installs=new Set<string>();
 for(const library of libraries){
  try{
   const manifest=await safeFile(library,'steamapps/'+manifestName);
   const {state,folder}=await steamAppState(manifest);
   if(requireIdle)assertIdleEnglish(state);
   const game=await canonicalSteamPath(path.join(library,'steamapps','common',folder));
   if((await fs.lstat(game)).isDirectory())installs.add(game);
  }catch{/* Stale, invalid or redirected installations are excluded. */}
 }
 return [...installs];
}
