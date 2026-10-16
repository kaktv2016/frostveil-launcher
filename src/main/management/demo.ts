import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {createManagedFixture,withManagedWrite} from '../installer/managed-target';
import {SandboxInstaller} from '../installer/engine';
import {MetadataStore} from '../installer/metadata';
import {makeSyntheticPackage} from '../installer/synthetic';
import {hashFile,safeFile} from '../files';
import {readOrderInputs,readPluginHeader} from '../modpack/plugins';
import {validateManifest} from '../modpack/schema';
import {authenticateRelease,type DistributionSource,type AuthenticatedRelease} from '../distribution/policy';
import {DistributionTransport} from '../distribution/transport';
import {PackageDownloader} from '../distribution/download';
import {PlanAuthorizer} from './authorization';
import {prepareManagementPlan} from './planner';
import {planActivation,type ActivationHeader} from './activation';
import type {ManagedPlan,ManagementIntent} from '../../shared/management-contracts';
import type {InstallJournal} from '../../shared/installer-contracts';

export interface ManagementFixtureResult {checks:string[];directory:string;realGameWrites:false;downloadRequests:number;originalActivationRestored:boolean;ownedFiles:number;transactions:string[];}
const MANAGED_PATHS=['Data/Interface/Frostveil/notice.html','Data/Interface/Frostveil/banner.css'] as const;
const PLUGIN='FrostveilFixture.esp';
const ORIGINAL_PROFILE='# Existing synthetic user profile\r\n';
const USER_CONTENT='USER CONTENT MUST SURVIVE\r\n';
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function assertFixture(value:unknown,message:string):asserts value{if(!value)throw Error('Management fixture: '+message);}
function pluginBytes(){const master=Buffer.from('Skyrim.esm\0'),field=Buffer.alloc(6),header=Buffer.alloc(24);field.write('MAST');field.writeUInt16LE(master.length,4);header.write('TES4');header.writeUInt32LE(field.length+master.length,4);return Buffer.concat([header,field,master]);}

/**
 * The UI exercises the production planning/authorization/transaction code on a
 * generated managed-fixture capability. No destination or trust override is
 * accepted. All runtime claims and original content here are synthetic only.
 */
export async function runManagementFixtureDemo(onProgress?:(stage:string)=>void):Promise<ManagementFixtureResult>{
 const g=await createManagedFixture();
 assertFixture(g.targetClass==='managed-fixture','generated disposable target required');
 await MetadataStore.create(g);
 const profile=path.join(g.configDirectory!,'plugins.txt'),unknown=path.join(g.installation,'unrelated-user-file.txt');
 await fs.writeFile(profile,ORIGINAL_PROFILE,{flag:'wx'});await fs.writeFile(unknown,USER_CONTENT,{flag:'wx'});
 const checks:string[]=[],transactions:string[]=[];let requests=0;
 const progress=(stage:string)=>onProgress?.(stage);
 // Ephemeral TEST-ONLY key; never persisted, returned, or promoted to production.
 const keys=generateKeyPairSync('ed25519'),keyId='l4c-fixture-only',publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
 const trustedKeys={[keyId]:publicKey},packId='l4c-fixture-'+g.id;
 const source:DistributionSource={mode:'sandbox-test',packId,channel:'stable',keys:{[keyId]:{publicKey,environment:'test',revoked:false}},permittedReviews:[]};
 let networkAssets=new Map<number,{bytes:Buffer;hash:string}>();
 const server=http.createServer((req,res)=>{
  const match=/^\/repos\/kaktv2016\/frostveil-distribution\/releases\/assets\/([1-9]\d*)$/.exec(req.url??'');
  const asset=match?networkAssets.get(Number(match[1])):null;
  if(req.method!=='GET'||!asset){res.writeHead(404).end();return;}
  requests++;res.setHeader('content-type','application/octet-stream');res.setHeader('etag','"'+asset.hash+'"');
  res.setHeader('content-length',asset.bytes.length);res.end(asset.bytes);
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const downloader=new PackageDownloader(g,DistributionTransport.loopback(origin,'sandbox-test'),{onProgress:()=>progress('download')});
 const authority=new PlanAuthorizer(async raw=>{const p=raw as ManagedPlan;if(g.targetClass!=='managed-fixture'||p.targetId!==g.id||p.targetClass!=='managed-fixture')throw Error('Fixture-only authorization refused');return true;});
 const evidence={runtime:{ready:true,runtime:'1.6.1170.0',skseLoader:'0.2.2.6',skseRuntime:'0.2.2.6'},blockers:[],manual:[],managerDetected:false,processActive:false,compatibleComponents:['owned']};
 async function bundle(generation:number,includePlugin:boolean){
  progress('signed-fixture');
  const base=await makeSyntheticPackage(g,generation,true,undefined,MANAGED_PATHS),manifest=structuredClone(base.manifest),snapshot=structuredClone(base.server);
  manifest.packId=packId;manifest.signing.keyId=keyId;snapshot.packId=packId;
  if(includePlugin){
   const bytes=pluginBytes(),digest=sha(bytes),release=manifest.distribution.release!;
   manifest.files.push({path:'Data/'+PLUGIN,size:bytes.length,sha256:digest,componentId:'owned',ownership:'custom-rp',permission:'Original inert TES4 fixture; disposable management test only',role:'visual',required:true,distribution:'allowed',package:{...release,assetId:103,assetName:'fixture-plugin.esp',size:bytes.length,sha256:digest,componentId:'owned',packVersion:manifest.packVersion,rights:{kind:'owned',evidence:'original-synthetic-management-plugin',scope:'redistribution',reviewer:'frostveil'}}});
   manifest.requiredPlugins.push({filename:PLUGIN,required:true,order:1,masters:['Skyrim.esm'],role:'client-only',sha256:digest});
   const cached=path.join(g.payloads,digest+'.bin');try{await fs.writeFile(cached,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if((await hashFile(cached)).sha256!==digest)throw Error('Fixture plugin cache conflict');}
  }
  validateManifest(manifest);
  const payload=Buffer.from(JSON.stringify({manifest,server:snapshot})),envelope={keyId,payloadBase64:payload.toString('base64'),signatureBase64:sign(null,payload,keys.privateKey).toString('base64')};
  const release={id:99,tag_name:manifest.distribution.release!.tag,draft:false,prerelease:false,immutable:false,published_at:manifest.generatedAt,body:'Original disposable management fixture. No public release exists.',assets:manifest.files.filter(f=>f.package).map(f=>({id:f.package!.assetId,name:f.package!.assetName,size:f.size,state:'uploaded',digest:'sha256:'+f.sha256}))};
  const authenticated=authenticateRelease(envelope,source,release);
  networkAssets=new Map();
  // Force the existing downloader to fetch actual loopback response bytes, then
  // independently validate the same cache/stage hashes used by real operations.
  for(const file of authenticated.manifest.files.filter(f=>f.package)){
   const cached=await safeFile(g.payloads,file.sha256+'.bin'),actual=await hashFile(cached);
   assertFixture(actual.sha256===file.sha256&&actual.size===file.size,'synthetic source hash mismatch');
   networkAssets.set(file.package!.assetId,{bytes:await fs.readFile(cached),hash:file.sha256});await fs.unlink(cached);
  }
  return authenticated;
 }
 async function prepare(b:AuthenticatedRelease,intent:ManagementIntent){
  progress('plan');const engine=await SandboxInstaller.open(g,trustedKeys,{launcherVersion:'0.1.6'}),receipt=await engine.receipt();
  const removed=receipt.files.filter(f=>f.packId===packId&&/^Data\/[^/]+\.(esm|esp)$/i.test(f.path)&&(intent==='remove'||!b.manifest.files.some(candidate=>candidate.path.toLowerCase()===f.path.toLowerCase()))).map(f=>path.basename(f.path));
  const pendingHeaders:Record<string,ActivationHeader>={};
  for(const file of b.manifest.files.filter(f=>f.package&&/^Data\/[^/]+\.(esm|esp)$/i.test(f.path)&&!removed.some(name=>'Data/'+name===f.path))){
   const cached=await downloader.acquire(file.package!),verified=await hashFile(cached);
   assertFixture(verified.sha256===file.sha256&&verified.size===file.size,'cached TES4 identity differs from signed manifest');
   pendingHeaders[path.basename(file.path)]=await readPluginHeader(cached);
  }
  const requirements=b.manifest.requiredPlugins.filter(p=>!removed.some(name=>name.toLowerCase()===p.filename.toLowerCase()));
  const activation=await planActivation(g.installation,requirements,await readOrderInputs(g.installation,g.configDirectory!),{pendingHeaders,deactivate:removed});
  const plan=await prepareManagementPlan(g,b,receipt,intent,evidence,activation);
  assertFixture(!plan.blockers.length,'plan blocked: '+plan.blockers.join('; '));return plan;
 }
 async function apply(b:AuthenticatedRelease,plan:ManagedPlan){
  const token=await authority.request(plan);
  return withManagedWrite(g,plan,token,authority,async()=>{
   const engine=await SandboxInstaller.open(g,trustedKeys,{launcherVersion:'0.1.6',channel:'stable',managedPlan:plan,onTransaction:j=>progress(j.state),acquire:async(hash,size,signal)=>{
    const ref=b.packages.find(p=>p.sha256===hash&&p.size===size);if(!ref){assertFixture(plan.actions.some(a=>a.action==='configuration'&&a.sha256===hash&&a.size===size),'acquisition is not bound to a signed asset or reviewed configuration');return;}await downloader.acquire(ref,signal);
   }});
   const result=await engine.install(b.envelope);assertFixture(result.state==='committed','transaction failed: '+result.state+' '+(result.error??''));transactions.push(result.id);return{engine,result,plan};
  });
 }
 async function rollback(applied:{engine:SandboxInstaller;result:InstallJournal;plan:ManagedPlan}){
  progress('rollback');const token=await authority.request(applied.plan);
  const result=await withManagedWrite(g,applied.plan,token,authority,()=>applied.engine.rollback(applied.result.id));
  assertFixture(result.state==='rolled-back','rollback needs manual recovery');return result;
 }
 async function verifyBytes(b:AuthenticatedRelease){for(const file of b.manifest.files.filter(f=>f.distribution==='allowed')){const observed=await hashFile(await safeFile(g.installation,file.path));assertFixture(observed.sha256===file.sha256&&observed.size===file.size,'installed bytes differ from signed manifest');}}
 try{
  const first=await bundle(1,false),fresh=await apply(first,await prepare(first,'install'));await verifyBytes(first);
  assertFixture((await fresh.engine.receipt()).files.length===2,'fresh installation must own exactly two files');
  checks.push('Signed two-file fresh installation verified on the Windows filesystem');
  const second=await bundle(2,true),upgraded=await apply(second,await prepare(second,'update'));await verifyBytes(second);
  assertFixture(upgraded.result.operations.filter(o=>o.path!=='Data/'+PLUGIN&&o.type!=='configuration').every(o=>o.backupVerified),'upgrade backups were not verified');
  assertFixture(await fs.readFile(profile,'utf8')===ORIGINAL_PROFILE+'*'+PLUGIN+'\r\n','TES4 plugin was not activated');
  checks.push('Managed upgrade downloaded verified assets and activated the client-only TES4 plugin');
  const configOperation=upgraded.result.operations.find(o=>o.type==='configuration');
  assertFixture(configOperation?.backupVerified,'activation configuration backup missing');
  const backupIndex=upgraded.result.operations.indexOf(configOperation);
  assertFixture(await fs.readFile(path.join(g.metadata,'transactions',upgraded.result.id,'backup',backupIndex+'.bin'),'utf8')===ORIGINAL_PROFILE,'configuration backup differs from original profile');
  await rollback(upgraded);
  assertFixture(await fs.readFile(profile,'utf8')===ORIGINAL_PROFILE,'activation rollback did not restore original bytes');
  await verifyBytes(first);
  checks.push('Activation configuration backup and rollback restored the exact original profile bytes');
  await apply(second,await prepare(second,'update'));await verifyBytes(second);
  await fs.unlink(path.join(g.installation,...MANAGED_PATHS[0].split('/')));
  const repairPlan=await prepare(second,'repair');assertFixture(repairPlan.actions.some(a=>a.path===MANAGED_PATHS[0]&&a.action==='repair'),'missing owned file was not classified as repair');
  const repaired=await apply(second,repairPlan);await verifyBytes(second);
  checks.push('Missing managed file repair restored the signed bytes and ownership');
  const removal=await apply(second,await prepare(second,'remove'));
  assertFixture((await removal.engine.receipt()).files.length===0,'removal retained managed ownership');
  assertFixture(!(await fs.readFile(profile,'utf8')).includes('*'+PLUGIN),'owned plugin remained enabled after removal');
  for(const file of second.manifest.files.filter(f=>f.distribution==='allowed'))assertFixture(await fs.stat(path.join(g.installation,...file.path.split('/'))).then(()=>false,error=>(error as NodeJS.ErrnoException).code==='ENOENT'),'owned file was not removed');
  checks.push('Controlled removal deleted only owned files and disabled the owned plugin');
  await rollback(removal);await verifyBytes(second);
  assertFixture(await fs.readFile(profile,'utf8')===ORIGINAL_PROFILE+'*'+PLUGIN+'\r\n','removal rollback did not restore activation');
  checks.push('Removal rollback restored owned files, ownership and the prior active plugin configuration');
  assertFixture(await fs.readFile(unknown,'utf8')===USER_CONTENT,'unrelated user file changed');
  checks.push('Unknown user file survived installation, upgrade, repair, removal and rollback');
  const recoveryPlan=await prepare(second,'repair'),token=await authority.request(recoveryPlan);
  const recovery=await withManagedWrite(g,recoveryPlan,token,authority,async()=>{const current=await SandboxInstaller.open(g,trustedKeys,{launcherVersion:'0.1.6',managedPlan:recoveryPlan});return current.recover();});
  assertFixture(recovery.length===0,'unexpected unfinished transaction');checks.push('Persistent journal recovery inspection found no unfinished transaction');
  const ownedFiles=(await repaired.engine.receipt()).files.length;
  assertFixture(ownedFiles===3,'final restored receipt differs');
  progress('complete');
  return{checks,directory:g.directory,realGameWrites:false,downloadRequests:requests,originalActivationRestored:true,ownedFiles,transactions};
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
