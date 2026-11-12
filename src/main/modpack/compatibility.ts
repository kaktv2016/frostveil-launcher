import {lt} from 'semver';import type {PackManifest,ServerProfile,FileEvidence,PluginEvidence,PackResult,Reason,PlanItem} from '../../shared/modpack-contracts';
import {nativeClientTargets} from './native-requirements';
interface Evaluation {manifest:PackManifest|null;server:ServerProfile|null;files:FileEvidence[];plugins:PluginEvidence|null;runtime:{ready:boolean;runtime:string;skseLoader:string;skseRuntime:string}|null;trust:string;launcherVersion:string;channel:string;now?:number;}

export function samePluginNames(left:readonly string[],right:readonly string[]):boolean {
 return left.length===right.length&&left.every((name,i)=>name.toLowerCase()===right[i]!.toLowerCase());
}

function sharedPluginMismatch(pack:PackManifest,server:ServerProfile):string|undefined {
 const shared=pack.requiredPlugins.filter(plugin=>plugin.role==='server-required').sort((a,b)=>a.order-b.order);
 const names=new Set(shared.map(plugin=>'data/'+plugin.filename.toLowerCase()));
 const files=new Map(pack.files.map(file=>[file.path.toLowerCase(),file]));
 for(const file of pack.files){
  if(file.required&&file.role==='shared-plugin'&&/^data\/[^/]+\.(?:esm|esp|esl)$/i.test(file.path)&&!names.has(file.path.toLowerCase()))
   return 'Shared plugin file lacks a required server slot: '+file.path;
 }
 if(shared.length!==server.plugins.length)return 'Manifest shared plugin set differs from server snapshot';
 for(const [i,plugin] of shared.entries()){
  const peer=server.plugins[i]!;
  const file=files.get('data/'+plugin.filename.toLowerCase());
  if(!plugin.required||!peer.required||peer.role!=='server-required'||!file?.required||
     !['native','shared-plugin'].includes(file.role))
   return 'Conflicting shared plugin role: '+plugin.filename;
  if(peer.filename.toLowerCase()!==plugin.filename.toLowerCase()||peer.order!==plugin.order)
   return 'Shared plugin name or full index differs: '+plugin.filename;
  if(!samePluginNames(peer.masters,plugin.masters))return 'Shared plugin master sequence differs: '+plugin.filename;
  if(peer.sha256!==plugin.sha256||file.sha256!==plugin.sha256||peer.size!==file.size)
   return 'Shared plugin SHA-256 or size differs: '+plugin.filename;
 }
}

function unsupportedServerPlugin(plugin:ServerProfile['plugins'][number]):boolean {
 return !plugin.headerVerified||plugin.light||plugin.filename.toLowerCase().endsWith('.esl');
}

export function assertSharedPluginCompatibility(pack:PackManifest,server:ServerProfile):void {
 const mismatch=sharedPluginMismatch(pack,server);
 if(mismatch)throw Error('Signed shared plugin compatibility mismatch: '+mismatch);
 const unsupported=server.plugins.find(unsupportedServerPlugin);
 if(unsupported)throw Error('Signed shared plugin header is unverified or light/ESL: '+unsupported.filename);
}

export function evaluateCompatibility(input:Evaluation):PackResult {
 const {manifest:pack,server,files,plugins,runtime}=input;const reasons:Reason[]=[],plan:PlanItem[]=[];const result:PackResult={status:'Unverified',local:'UNVERIFIED',server:'UNVERIFIED',live:'UNVERIFIED',reasons,plan,knownDownloadBytes:0};
 if(!pack||!server){result.status='Not Configured';result.server='NOT CONFIGURED';reasons.push({code:'not-configured',detail:'SERVER PROFILE NOT CONFIGURED',required:true});return result;}
 if(!['AUTHENTICATED','LOCAL DEVELOPMENT ONLY'].includes(input.trust)){reasons.push({code:'trust',detail:'Manifest authenticity not verified: '+input.trust,required:true});return result;}
 let incompatible=false,unknown=false,update=false,scanError=false;
 const issue=(code:string,detail:string,kind:'incompatible'|'unknown'|'update'|'scan-error',required=true)=>{reasons.push({code,detail,required});if(!required)return;if(kind==='incompatible')incompatible=true;else if(kind==='unknown')unknown=true;else if(kind==='update')update=true;else scanError=true;};
 const now=input.now??Date.now();if(Date.parse(server.expiresAt)<=now||Date.parse(server.generatedAt)>now+5*60000)issue('stale-profile','Offline server snapshot expired or is from the future','unknown');
 const native=pack.skyMPClientRequirements;
 if(!native||native.identity!==pack.requiredSkyMPClientVersion||nativeClientTargets(pack.requiredSkyrimRuntime).some(target=>!native.nativeFiles.some(p=>p.toLowerCase()===target)))issue('client-identity','SkyMP native/runtime identity requirements incomplete or misplaced','unknown');
 else for(const target of native.nativeFiles){const expected=pack.files.find(f=>f.path.toLowerCase()===target.toLowerCase()),observed=files.find(f=>f.path.toLowerCase()===target.toLowerCase());if(!expected?.required||!observed||observed.status!=='verified'||observed.observedHash!==expected.sha256)issue('client-identity','SkyMP native/runtime identity not verified: '+target,'unknown');}
 if(server.id!==pack.serverProfileId||server.version!==pack.serverProfileVersion||server.packId!==pack.packId||server.packVersion!==pack.packVersion||server.runtime!==pack.requiredSkyrimRuntime||server.skseVersion!==pack.requiredSKSEVersion||server.clientIdentity!==pack.requiredSkyMPClientVersion)issue('profile-binding','Server snapshot and selected pack identities/versions disagree','incompatible');
 if(pack.channel!==input.channel)issue('channel','Pack channel mismatch','incompatible');if(lt(input.launcherVersion,pack.minimumLauncherVersion))issue('launcher-version','Minimum launcher version not met','incompatible');
 if(!runtime)issue('runtime-unverified','Runtime compatibility evidence unavailable','unknown');else if(runtime.runtime!==pack.requiredSkyrimRuntime||runtime.skseLoader!==pack.requiredSKSEVersion||runtime.skseRuntime!==pack.requiredSKSEVersion)issue('runtime','Skyrim/SKSE runtime mismatch','incompatible');else if(!runtime.ready)issue('baseline','Existing L1 readiness gate failed','unknown');
 if(sharedPluginMismatch(pack,server))issue('server-plugins','Manifest shared plugin list differs from server snapshot','incompatible');
 for(const p of server.plugins)if(unsupportedServerPlugin(p))issue('unsupported-server-plugin','Pinned server plugin handling unverified: '+p.filename,'unknown');
 let allFiles=true;
 for(const f of pack.files){const observed=files.find(x=>x.path.toLowerCase()===f.path.toLowerCase());let status=observed?.status??'unknown';if(status==='optional-missing'&&f.required)status='missing';if(status==='verified'&&(observed?.observedHash!==f.sha256||observed.observedSize!==f.size))status='unknown';
  const allowed=f.distribution==='allowed'&&['custom-rp','third-party-permitted'].includes(f.ownership)&&!!f.permission;
  let action:PlanItem['action']='none';if(status!=='verified'&&status!=='optional-missing'){if(f.required)allFiles=false;
   if(status==='missing'||status==='outdated'){action=allowed?(status==='missing'?'download-missing':'replace-outdated'):'verify-external';issue(status,f.path+': '+status,allowed?'update':'incompatible',f.required);}
   else if(status==='modified'){action='review-conflict';issue('modified',f.path+': content differs, ownership conflict requires review','incompatible',f.required);}
   else if(status==='incompatible'){action='verify-external';issue('file-version',f.path+': version incompatible','incompatible',f.required);}
   else{action='unsupported';issue(status,f.path+': '+(observed?.reason??'Cryptographic verification unavailable'),status==='scan-error'?'scan-error':'unknown',f.required);}
  }
  const component=pack.components.find(c=>c.id===f.componentId)!;plan.push({component:component.name,problem:status,expected:f.version??f.sha256,observed:observed?.observedVersion??observed?.observedHash??'Not observed',required:f.required,action,distributionAllowed:allowed,bytes:allowed&&['download-missing','replace-outdated'].includes(action)?f.size:undefined});
 }
 for(const c of pack.components){for(const dep of c.dependencies){const health=pack.files.filter(f=>f.componentId===dep).every(f=>files.some(x=>x.path.toLowerCase()===f.path.toLowerCase()&&x.status==='verified'&&x.observedHash===f.sha256));if(!health){issue('dependency',c.name+' requires verified '+dep,'unknown',c.required);plan.push({component:c.name,problem:'Dependency not verified: '+dep,expected:dep,observed:'Unverified',required:c.required,action:'resolve-dependency',distributionAllowed:false});}}}
 if(!plugins||plugins.source==='unverified')issue('plugin-order','Effective plugin activation/order is unverified','unknown');
 for(const p of pack.requiredPlugins){const observed=plugins?.plugins.find(x=>x.filename.toLowerCase()===p.filename.toLowerCase());if(!observed||observed.status!=='verified'&&(observed.status!=='optional-missing'||p.required)){
  issue('plugin',p.filename+': '+(observed?.reason??observed?.status??'No evidence'),observed?.status==='scan-error'?'scan-error':observed?.status==='missing'||observed?.status==='incompatible'||observed?.status==='optional-missing'&&p.required?'incompatible':'unknown',p.required);
  plan.push({component:p.filename,problem:observed?.reason??'Plugin activation/order unverified',expected:'Active with validated master/order requirements',observed:observed?.status??'unknown',required:p.required,action:'review-order',distributionAllowed:false});}}
 result.local=allFiles?'VERIFIED':scanError||unknown?'UNVERIFIED':'MISMATCH';result.server=incompatible||update?'MISMATCH':unknown||scanError?'UNVERIFIED':'OFFLINE SNAPSHOT MATCH';result.status=scanError?'Scan Error':incompatible?'Incompatible':unknown?'Unverified':update?'Update Required':'Compatible';result.knownDownloadBytes=plan.reduce((sum,p)=>sum+(p.bytes??0),0);return result;
}
export function enforcePackGate(enforcement:boolean,result:PackResult|undefined,trust:string){if(enforcement&&(trust!=='AUTHENTICATED'||result?.status!=='Compatible'))throw Error('Mandatory server pack verification failed');}
