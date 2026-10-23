import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {safeDirectory,safeFile,contained} from './files';
import type {GraphicsSourcePlan} from './graphics-source-repair';
import {graphicsSourcePin} from './graphics-source-pin';
import {durableWrite} from './installer/metadata';
export function decodeGraphicsSourcePlan(bytes:Buffer,pin:{size:number;sha256:string}):GraphicsSourcePlan{
 if(bytes.length!==pin.size||createHash('sha256').update(bytes).digest('hex')!==pin.sha256)throw Error('Graphics source recipe hash identity mismatch');
 const result=JSON.parse(bytes.toString('utf8'));if(!['1.0.7','1.0.8','1.0.9','1.0.10','1.0.11','1.0.12','1.0.13','1.0.14','1.0.15','1.0.16','1.0.17','1.0.18','1.0.19'].includes(result.version)||!Array.isArray(result.files))throw Error('Unexpected graphics source recipe');return result;
}
export async function loadGraphicsSourcePlan(storage:string):Promise<GraphicsSourcePlan>{
 const root=path.join(storage,'graphics-source-recipes');await safeDirectory(root);const name=graphicsSourcePin.sha256+'.json';
 try{return decodeGraphicsSourcePlan(await fs.readFile(await safeFile(root,name)),graphicsSourcePin);}catch(e){
  if((e as NodeJS.ErrnoException).code!=='ENOENT'){
   if(!(e instanceof Error)||!e.message.includes('recipe hash identity'))throw e;
   await fs.rename(await safeFile(root,name),path.join(root,name+'.invalid-'+randomUUID()));
  }
 }
 const response=await fetch(graphicsSourcePin.url,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok||!response.body)throw Error('Graphics source recipe download unavailable');
 const parts:Buffer[]=[];let size=0;for await(const part of response.body){size+=part.length;if(size>graphicsSourcePin.size)throw Error('Graphics source recipe exceeds pinned size');parts.push(Buffer.from(part));}
 const bytes=Buffer.concat(parts),plan=decodeGraphicsSourcePlan(bytes,graphicsSourcePin);await durableWrite(path.join(root,name),bytes,true);return plan;
}
export async function graphicsSourceDirectories(storage:string):Promise<string[]>{
 let configured:string[]=[];try{const value=JSON.parse(await fs.readFile(await safeFile(storage,'graphics-sources.json'),'utf8'));if(!Array.isArray(value.directories)||value.directories.some((d:unknown)=>typeof d!=='string'||!path.isAbsolute(d)))throw Error('Invalid graphics source folder configuration');configured=value.directories;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const dirs=[...configured,path.join(os.homedir(),'Downloads')];
 // Never allow sources/transaction staging to be written inside an installation.
 return [...new Set(dirs.map(d=>path.resolve(d)))].filter(d=>!contained(storage,d));
}
