import fs from 'node:fs/promises';
import {createReadStream,lstatSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function relativePath(value:unknown):string {
 if(typeof value!=='string'||!value||value.length>512||/[\\:<>"|?*\x00-\x1f]/.test(value)||path.posix.isAbsolute(value))throw Error('Unsafe relative path');
 const parts=value.split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe path segment');
 return value;
}
export function contained(root:string,target:string):boolean {const p=path.relative(path.resolve(root),path.resolve(target));return p===''||(!p.startsWith('..'+path.sep)&&p!=='..'&&!path.isAbsolute(p));}
export function checkExistingAncestors(target:string):void{
 const absolute=path.resolve(target),parsed=path.parse(absolute);let current=parsed.root;
 for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){current=path.join(current,part);try{if(lstatSync(current).isSymbolicLink())throw Error('Redirected directory is not allowed');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}}
}
export async function noLinks(target:string):Promise<void>{
 const absolute=path.resolve(target),parsed=path.parse(absolute);let current=parsed.root;
 for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw Error('Redirected paths are not allowed');}
}
/** Validate each existing ancestor before creating a directory below it. */
export async function safeDirectory(target:string):Promise<void>{
 const absolute=path.resolve(target),parsed=path.parse(absolute);let current=parsed.root;
 for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  try{if((await fs.lstat(current)).isSymbolicLink())throw Error('Redirected directory is not allowed');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await fs.mkdir(current);}
 }
 await noLinks(absolute);
}
export async function safeFile(root:string,relative:string):Promise<string>{
 const checked=relativePath(relative),file=path.resolve(root,...checked.split('/'));
 if(!contained(root,file))throw Error('File escapes installation');
 await noLinks(file);
 if(!contained(await fs.realpath(root),await fs.realpath(file)))throw Error('File escapes real installation');
 if(!(await fs.stat(file)).isFile())throw Error('Expected regular file');
 return file;
}
export async function hashFile(file:string,maxBytes=512*1024*1024):Promise<{size:number;sha256:string}>{
 const stat=await fs.stat(file);if(!stat.isFile()||stat.size>maxBytes)throw Error('File size limit exceeded');
 const hash=createHash('sha256');let bytes=0;
 for await(const chunk of createReadStream(file)){bytes+=chunk.length;if(bytes>maxBytes)throw Error('File grew beyond limit');hash.update(chunk);}
 if(bytes!==stat.size)throw Error('File changed while hashing');return{size:bytes,sha256:hash.digest('hex')};
}
