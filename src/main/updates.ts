import {relativePath} from './files';
import type {Channel,PackManifest,UpdateState,FutureUpdates} from '../shared/contracts';
export const futureUpdates:FutureUpdates={github:null,trustedManifestKeys:{}};
export function updateState(channel:Channel):UpdateState{return{launcher:futureUpdates.github?'NOT AVAILABLE IN L1':'NOT CONFIGURED',modpack:'NOT AVAILABLE IN L1',channel};}
export function validateManifest(raw:unknown,sources:readonly string[]):PackManifest {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid manifest');const value=raw as PackManifest;
 if(value.schemaVersion!==1||!['stable','beta'].includes(value.channel)||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(value.packVersion)||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(value.minimumLauncherVersion)||![value.requiredSkyrimRuntime,value.requiredSKSEVersion,value.requiredSkyMPClientVersion].every(v=>typeof v==='string'&&v.length>0&&v.length<100)||!Array.isArray(value.files)||value.files.length>2000)throw Error('Unsupported/missing manifest fields');
 const targets=new Set<string>();
 for(const file of value.files){const relative=relativePath(file.path),key=relative.toLowerCase();
  // Only explicitly managed mod/client subtrees; no vanilla masters, binaries or saves.
  if(!/^(data\/platform\/|data\/skse\/plugins\/)/.test(key)||/\.(esm|esp|esl|bsa)$/i.test(relative)||/(?:^|\/)(?:skyrimse|skse64|steam_api)/i.test(key)||targets.has(key))throw Error('Forbidden or duplicate target');targets.add(key);
  if(!Number.isSafeInteger(file.size)||file.size<0||file.size>512*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256)||typeof file.componentId!=='string'||!file.componentId||!['launcher','skymp','custom-rp','third-party-permitted','external-install'].includes(file.ownership)||typeof file.permission!=='string'||!file.permission)throw Error('Invalid file metadata');
  const url=new URL(file.url);if(url.protocol!=='https:'||url.username||url.password||url.hash||!sources.some(prefix=>{const allowed=new URL(prefix);return allowed.protocol==='https:'&&url.origin===allowed.origin&&url.pathname.startsWith(allowed.pathname)&&!/%2f|%5c|%2e/i.test(url.pathname);}))throw Error('Unauthorized download source');
 }
 // Parsing validates shape only. No API applies it; signatures/keys must be verified in L2.
 return structuredClone(value);
}
