import {createPublicKey,verify} from 'node:crypto';
import {object,MAX_METADATA,validateManifest,validateServerProfile} from './schema';
import type {PackManifest,ServerProfile} from '../../shared/modpack-contracts';
export interface TrustedBundle {trust:'AUTHENTICATED'|'LOCAL DEVELOPMENT ONLY'|'MISSING TRUST KEY'|'INVALID'|'NOT CONFIGURED';manifest?:PackManifest;server?:ServerProfile;}
// No production key or distribution URL has been approved. Separate from L2 Authenticode.
export const remoteTrust:RemoteSource|null=null;
export interface RemoteSource {url:string;keys:Readonly<Record<string,string>>;assetSources:readonly string[];}
export function verifyEnvelope(raw:unknown,keys:Readonly<Record<string,string>>,sources:readonly string[]):TrustedBundle {
 try{const e=object(raw,['keyId','payloadBase64','signatureBase64']);if(typeof e.keyId!=='string'||!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(e.keyId))return{trust:'INVALID'};if(!Object.hasOwn(keys,e.keyId))return{trust:'MISSING TRUST KEY'};
  if(typeof e.payloadBase64!=='string'||typeof e.signatureBase64!=='string'||e.payloadBase64.length>Math.ceil(MAX_METADATA*4/3)||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.payloadBase64))return{trust:'INVALID'};
  const payload=Buffer.from(e.payloadBase64,'base64'),signature=Buffer.from(e.signatureBase64,'base64'),key=createPublicKey(keys[e.keyId]!);if(key.asymmetricKeyType!=='ed25519'||signature.length!==64||signature.toString('base64')!==e.signatureBase64||!verify(null,payload,key,signature))return{trust:'INVALID'};
  const bundle=object(JSON.parse(payload.toString('utf8')),['manifest','server']);const manifest=validateManifest(bundle.manifest,sources),server=validateServerProfile(bundle.server);if(manifest.signing.keyId!==e.keyId||manifest.distribution.source!=='signed-release')return{trust:'INVALID'};return{trust:'AUTHENTICATED',manifest,server};
 }catch{return{trust:'INVALID'};}
}
/** Developer-controlled fixed source, never renderer/manifest input. No redirects or asset fetches. */
export async function loadRemoteProfile(source:RemoteSource|null,fetcher:typeof fetch=fetch):Promise<TrustedBundle> {
 if(!source)return{trust:'NOT CONFIGURED'};const u=new URL(source.url);if(u.protocol!=='https:'||u.hostname!=='github.com'||u.username||u.password||u.hash||u.search||!/^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\/releases\/download\/[^/]+\/[^/]+\.json$/.test(u.pathname))throw Error('Unapproved remote profile source');
 if(!Object.keys(source.keys).length)return{trust:'MISSING TRUST KEY'};
 try{const signal=AbortSignal.timeout(10000);let current=source.url,r=await fetcher(current,{redirect:'manual',signal});
  if([301,302,303,307,308].includes(r.status)){const location=r.headers.get('location');if(!location)return{trust:'INVALID'};const asset=new URL(location,current);if(asset.protocol!=='https:'||asset.hostname!=='release-assets.githubusercontent.com'||asset.port||asset.username||asset.password||asset.hash||!/^\/github-production-release-asset\/\d+\/[a-f0-9-]{36}$/.test(asset.pathname))return{trust:'INVALID'};await r.body?.cancel();current=asset.href;r=await fetcher(current,{redirect:'manual',signal});}
  if(r.status!==200||r.url&&r.url!==current||!r.body)return{trust:'INVALID'};
  const reader=r.body.getReader();let length=0;const parts:Uint8Array[]=[];try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>6*1024*1024){await reader.cancel();return{trust:'INVALID'};}parts.push(chunk.value);}}finally{reader.releaseLock();}return verifyEnvelope(JSON.parse(Buffer.concat(parts).toString('utf8')),source.keys,source.assetSources);
 }catch{return{trust:'INVALID'};}
}
