import {createPublicKey,verify} from 'node:crypto';
import {relativePath} from '../files';
import {productionSource,type PublisherKey} from '../distribution/policy';

export interface RuntimeFile {path:string;size:number;sha256:string;depot:string;}
export interface ManagedRuntimeFile {path:string;size:number;sha256:string;}
export interface RuntimeCohort {
 schemaVersion:1;kind:'frostveil-steam-runtime';runtime:'1.6.1170.0';appId:'489830';language:'english';createdAt:string;expiresAt:string;
 depots:{id:string;manifest:string}[];files:RuntimeFile[];creations:string[];managedFiles:ManagedRuntimeFile[];pluginOrder:string[];
 configuration:{pluginsBase64:string;loadorderBase64:string};
 helper:{version:string;size:number;sha256:string};acquisition:{verified:boolean;receiptSha256:string};
}
const trusted=new WeakMap<object,{fixture:boolean}>();
const hash=/^[a-f0-9]{64}$/;
export function runtimePath(raw:unknown){
 const p=relativePath(raw);
 if(!/^(?:SkyrimSE(?:Launcher)?\.exe|steam_api64\.dll|binkw64\.dll|bink2w64\.dll|(?:Skyrim_Default|High|Low|Medium|Ultra)\.ini|Data\/(?:Skyrim|Update|Dawnguard|HearthFires|Dragonborn)(?: - [A-Za-z0-9 _-]+)?\.(?:esm|bsa)|Data\/(?:cc[A-Za-z0-9_-]+|_ResourcePack)(?: - [A-Za-z0-9 _-]+)?\.(?:esm|esl|bsa)|Data\/MarketplaceTextures\.bsa|Data\/Video\/BGS_Logo\.bik|Skyrim\/SkyrimPrefs\.ini)$/i.test(p))throw Error('Unapproved runtime target');
 return p;
}
export function authenticateRuntimeCohort(raw:unknown,keys:Readonly<Record<string,PublisherKey>>=productionSource.keys,options:{fixture?:boolean}={}):Readonly<RuntimeCohort>{
 if(!raw||typeof raw!=='object')throw Error('Missing signed runtime cohort');
 const e=raw as Record<string,unknown>;
 if(Object.keys(e).sort().join(',')!=='keyId,payloadBase64,signatureBase64'||typeof e.keyId!=='string'||typeof e.payloadBase64!=='string'||typeof e.signatureBase64!=='string'||e.payloadBase64.length>4*1024*1024)throw Error('Invalid runtime envelope');
 const pin=Object.hasOwn(keys,e.keyId)?keys[e.keyId]:undefined;
 if(!pin||pin.revoked||(!options.fixture&&pin.environment!=='production')||pin.expiresAt&&Date.parse(pin.expiresAt)<=Date.now())throw Error('Untrusted runtime publisher');
 const bytes=Buffer.from(e.payloadBase64,'base64'),sig=Buffer.from(e.signatureBase64,'base64'),key=createPublicKey(pin.publicKey);
 if(bytes.toString('base64')!==e.payloadBase64||sig.toString('base64')!==e.signatureBase64||sig.length!==64||key.asymmetricKeyType!=='ed25519'||!verify(null,bytes,key,sig))throw Error('Runtime signature invalid');
 const p=JSON.parse(bytes.toString('utf8')) as RuntimeCohort;
 if(Object.keys(p).sort().join(',')!=='acquisition,appId,configuration,createdAt,creations,depots,expiresAt,files,helper,kind,language,managedFiles,pluginOrder,runtime,schemaVersion'||p.schemaVersion!==1||p.kind!=='frostveil-steam-runtime'||p.appId!=='489830'||p.runtime!=='1.6.1170.0'||p.language!=='english'||!Number.isFinite(Date.parse(p.createdAt))||Date.parse(p.createdAt)>Date.now()+300000||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=Date.now()||Date.parse(p.expiresAt)-Date.parse(p.createdAt)>7*86400000)throw Error('Invalid/expired runtime policy');
 if(!Array.isArray(p.depots)||!p.depots.length||p.depots.length>3||p.depots.some(d=>!['489831','489832','489833'].includes(d.id)||!/^\d{16,20}$/.test(d.manifest))||new Set(p.depots.map(d=>d.id)).size!==p.depots.length)throw Error('Invalid runtime depots');
 if(!p.helper||p.helper.version!=='3.4.0'||!Number.isSafeInteger(p.helper.size)||p.helper.size<1||p.helper.size>100*1024*1024||!hash.test(p.helper.sha256)||p.acquisition?.verified!==true||!hash.test(p.acquisition.receiptSha256))throw Error('Unverified Steam acquisition/helper');
 if(!Array.isArray(p.files)||!p.files.length||p.files.length>2048)throw Error('Invalid cohort inventory');
 const names=new Set<string>();for(const f of p.files){runtimePath(f.path);if(names.has(f.path.toLowerCase())||!Number.isSafeInteger(f.size)||f.size<1||f.size>8*1024**3||!hash.test(f.sha256)||!p.depots.some(d=>d.id===f.depot))throw Error('Invalid runtime file');names.add(f.path.toLowerCase());}
 if(!options.fixture&&(['SkyrimSE.exe','Data/Skyrim.esm','Data/Update.esm','Data/Dawnguard.esm','Data/HearthFires.esm','Data/Dragonborn.esm'].some(n=>!names.has(n.toLowerCase()))||p.depots.length!==3||!p.files.some(f=>/Skyrim - .*\.bsa$/i.test(f.path))))throw Error('Incomplete production cohort');
 if(!Array.isArray(p.creations)||p.creations.length>32||p.creations.some(n=>!/^cc[A-Za-z0-9_-]+\.(?:esm|esl)$/i.test(n)&&n!=='_ResourcePack.esl')||new Set(p.creations.map(n=>n.toLowerCase())).size!==p.creations.length||p.creations.some(n=>!names.has(('Data/'+n).toLowerCase())))throw Error('Invalid Creation baseline');
 if(!Array.isArray(p.managedFiles)||p.managedFiles.length>25000)throw Error('Invalid approved mod inventory');
 const paths=new Set<string>();for(const f of p.managedFiles){const n=managedRuntimePath(f.path);if(paths.has(n.toLowerCase())||names.has(n.toLowerCase())||!Number.isSafeInteger(f.size)||f.size<0||f.size>8*1024**3||!hash.test(f.sha256))throw Error('Invalid managed inventory: '+n);paths.add(n.toLowerCase());}
 if(!Array.isArray(p.pluginOrder)||p.pluginOrder.length>254||new Set(p.pluginOrder.map(n=>n.toLowerCase())).size!==p.pluginOrder.length||p.pluginOrder.some(n=>!/^[-A-Za-z0-9_ .'()]+\.(?:esm|esp|esl)$/i.test(n)||!names.has(('Data/'+n).toLowerCase())&&!paths.has(('Data/'+n).toLowerCase())))throw Error('Invalid production plugin order');
 if(!p.configuration||Object.keys(p.configuration).sort().join(',')!=='loadorderBase64,pluginsBase64')throw Error('Missing verified plugin configuration');
 const decode=(value:string)=>{if(typeof value!=='string'||value.length>1024*1024)throw Error('Invalid plugin template');const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw Error('Invalid plugin template encoding');const text=bytes.toString('utf8');if(/[^\x09\x0a\x0d\x20-\x7e\uFEFF]/.test(text))throw Error('Unsupported plugin template encoding');return text;};
 const plugins=decode(p.configuration.pluginsBase64).replace(/^\uFEFF/,'').split(/\r?\n/).filter(n=>n.startsWith('*')).map(n=>n.slice(1));
 if(plugins.join('|').toLowerCase()!==p.pluginOrder.join('|').toLowerCase())throw Error('Plugin template differs from verified order');
 for(const name of decode(p.configuration.loadorderBase64).replace(/^\uFEFF/,'').split(/\r?\n/).map(n=>n.trim()).filter(n=>n&&!n.startsWith('#')))if(!names.has(('Data/'+name).toLowerCase())&&!paths.has(('Data/'+name).toLowerCase()))throw Error('Unapproved loadorder template member');
 // A frozen, branded result is required by every writer. Raw JSON is never authority.
 const result=JSON.parse(JSON.stringify(p));const freeze=(v:any)=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(result);trusted.set(result,{fixture:options.fixture===true});return result;
}
export function assertRuntimeCohort(p:Readonly<RuntimeCohort>,fixture:boolean){const proof=trusted.get(p);if(!proof||proof.fixture&&!fixture)throw Error('Authenticated runtime capability required');if(Date.parse(p.expiresAt)<=Date.now())throw Error('Runtime policy expired');}
/** This scope may be snapshotted/restored, never installed as runtime payload. */
export function managedRuntimePath(raw:unknown){const p=relativePath(raw);if(!/^Data\//.test(p)&&! /^(?:skse64_(?:loader\.exe|steam_loader\.dll|1_6_1170\.dll)|d3dx9_42\.dll|tbb\.dll|tbbmalloc\.dll|d3d11\.dll|dxgi\.dll|enbseries\.ini|enblocal\.ini)$/i.test(p))throw Error('Unapproved managed runtime snapshot path');if(/^Data\/(?:cc|_ResourcePack)/i.test(p))throw Error('Creation files belong to runtime policy');return p;}
