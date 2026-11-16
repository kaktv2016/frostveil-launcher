import {Readable} from 'node:stream';
import {lt} from 'semver';
import {localW14Folder,openProtectedW14File,readW14Json} from '../protected-w14-folder';
import {authenticateRuntimeCohort} from '../runtime/policy';
import {authenticateRelease,parseRelease,productionSource,type AuthenticatedRelease,type DistributionSource,type ReleaseMetadata} from './policy';
import {assertW14ContentPairing} from './w14-content-compatibility';

interface W14ContentPin {
 folder:string;
 runtimeSha256:string;
 packReleaseSha256:string;
 packEnvelopeSha256:string;
}

declare const FROSTVEIL_W14_CONTENT_PIN:string|undefined;
export const packagedW14ContentPin:W14ContentPin|undefined=typeof FROSTVEIL_W14_CONTENT_PIN==='undefined'
 ?undefined:JSON.parse(Buffer.from(FROSTVEIL_W14_CONTENT_PIN,'base64').toString('utf8'));

const assetLimit=32*1024*1024;
const sha256=/^[a-f0-9]{64}$/;

export class W14ContentFolder {
 private readonly root?:string;
 private authorized?:{release:AuthenticatedRelease;expires:number};
 readonly transport;

 constructor(private readonly pin:W14ContentPin|undefined,private readonly source:DistributionSource=productionSource,private readonly launcherVersion?:string){
  this.transport={testOnly:source.mode==='sandbox-test',request:(suffix:string,signal?:AbortSignal,headers?:Record<string,string>)=>this.request(suffix,signal,headers)};
  if(!pin)return;
  if(![pin.runtimeSha256,pin.packReleaseSha256,pin.packEnvelopeSha256].every(value=>sha256.test(value))){
   throw Error('Invalid W14 content pin');
  }
  this.root=localW14Folder(pin.folder);
 }

 private async read(reference:string,max:number,digest:string,signal?:AbortSignal,size?:number){
  try{return await readW14Json(await openProtectedW14File(this.root!,reference,max,signal),size,digest,signal);}
  catch(error){
   signal?.throwIfAborted();
   const code=(error as NodeJS.ErrnoException).code;
   if(code==='ENOENT')throw Error('A pinned W14 content file is missing');
   if(code==='ERR_W14_FOLDER_PERMISSIONS')throw Error('Private W14 content folder permissions failed verification');
   throw Error('W14 content file refused: '+(error instanceof Error&&error.message.includes('digest')?'digest mismatch':'unsafe or invalid file'));
  }
 }

 private async authenticate(signal?:AbortSignal){
  const pin=this.pin;
  if(!this.root||!pin)throw Error('The W14 content pin is missing from this package');
  const now=Date.now();
  const [runtimeEnvelope,packRelease]=await Promise.all([
   this.read('runtime.json',4*1024*1024,pin.runtimeSha256,signal),
   this.read('pack-release.json',1024*1024,pin.packReleaseSha256,signal),
  ]);
  const runtime=authenticateRuntimeCohort(runtimeEnvelope,this.source.keys,{fixture:this.source.mode==='sandbox-test'});
  const release=parseRelease(packRelease);
  const manifestAsset=release.assets.find(asset=>asset.name==='frostveil-manifest.json');
  if(!release.immutable||!manifestAsset||manifestAsset.digest!=='sha256:'+pin.packEnvelopeSha256){
   throw Error('W14 content pack does not bind an immutable signed envelope');
  }
  const envelope=await this.read('assets/'+manifestAsset.id,6*1024*1024,pin.packEnvelopeSha256,signal,manifestAsset.size);
  const verified=authenticateRelease(envelope,this.source,release);
  const {manifest,server,packages}=verified;
  const assetsById=new Map(release.assets.map(asset=>[asset.id,asset]));
  if(packages.some(pkg=>assetsById.get(pkg.assetId)?.digest!=='sha256:'+pkg.sha256))throw Error('W14 content pack asset digest is missing');
  if(this.launcherVersion&&lt(this.launcherVersion,manifest.minimumLauncherVersion))throw Error('W14 content requires a newer Launcher');
  if([runtime.createdAt,manifest.generatedAt,server.generatedAt,release.published_at].some(value=>Date.parse(value)>now)){
   throw Error('W14 content is not yet valid');
  }
  assertW14ContentPairing(runtime,verified);
  const runtimeKeyId=(runtimeEnvelope as {keyId:string}).keyId;
  const expiries=[runtime.expiresAt,server.expiresAt,this.source.keys[runtimeKeyId]?.expiresAt,this.source.keys[manifest.signing.keyId]?.expiresAt];
  const expires=Math.min(...expiries.map(value=>Date.parse(value??'')));
  if(!Number.isFinite(expires)||expires<=Date.now())throw Error('W14 content or publisher has expired');
  signal?.throwIfAborted();
  this.authorized={release:verified,expires};
  return {runtime,verified};
 }

 async runtime(signal:AbortSignal){return (await this.authenticate(signal)).runtime;}

 async resolve(channel:'stable'|'beta',exactTag?:string,signal?:AbortSignal){
  if(channel!==this.source.channel)throw Error('W14 content does not authorize this channel');
  const {verified}=await this.authenticate(signal);
  if(exactTag!==undefined&&exactTag!==verified.release.tag_name)throw Error('W14 content tag does not match the pinned pack');
  return structuredClone(verified.release);
 }

 async envelope(release:ReleaseMetadata,signal?:AbortSignal){
  const {verified}=await this.authenticate(signal);
  if(JSON.stringify(release)!==JSON.stringify(verified.release))throw Error('W14 content release differs from the pinned metadata');
  return structuredClone(verified.envelope) as {keyId:string;payloadBase64:string;signatureBase64:string};
 }

 private async request(suffix:string,signal?:AbortSignal,headers:Record<string,string>={}){
  const id=/^\/releases\/assets\/([1-9]\d{0,15})$/.exec(suffix);
  const auth=this.authorized;
  const asset=auth?.release.packages.find(item=>item.assetId===Number(id?.[1]));
  if(!id||!auth||auth.expires<=Date.now()||!asset||!this.root)throw Error('W14 content payload is not authorized');
  const {handle,opened}=await openProtectedW14File(this.root,'assets/'+id[1],assetLimit,signal);
  try{
   if(opened.size!==BigInt(asset.size))throw Error('W14 content payload size mismatch');
   if(auth.expires<=Date.now())throw Error('W14 content has expired');
   const etag='"'+asset.sha256+'"',requestHeaders=new Headers(headers);
   const range=/^bytes=([1-9]\d*)-$/.exec(requestHeaders.get('range')??'');
   const offset=range&&requestHeaders.get('if-range')===etag?Number(range[1]):0;
   const responseHeaders=new Headers({etag});
   if(offset>=asset.size){
    await handle.close();
    responseHeaders.set('content-range','bytes */'+asset.size);
    return new Response(null,{status:416,headers:responseHeaders});
   }
   responseHeaders.set('content-length',String(asset.size-offset));
   if(offset)responseHeaders.set('content-range',`bytes ${offset}-${asset.size-1}/${asset.size}`);
   const body=Readable.toWeb(handle.createReadStream({signal,start:offset,end:asset.size-1})) as ReadableStream<Uint8Array>;
   return new Response(body,{status:offset?206:200,headers:responseHeaders});
  }catch(error){await handle.close();throw error;}
 }
}
