import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {safeDirectory,safeFile} from '../files';
import {censusRawCache,listCacheDirectory,measureCacheRoots,type RawCacheCensus,type RawCacheRoot} from './cache-census';
import {decideCacheAdmission,reserveRawBytes,type CacheCharge} from './cache-admission';
import {openCacheAccounting,type CacheReservation} from './cache-ledger';
import {admitPackagedCachePolicy,cacheProfileId,cacheScopeId,packagedCachePolicy,type PackagedCachePolicy} from './cache-policy';
import {encodeCacheBoot,readCacheBoot,verifiedLaterCacheBoot} from './cache-boot';
import {assertRuntimeCohort,type RuntimeCohort} from './policy';
import {helperPin,inspectDepotReuse,promoteLegacyDepots} from './depot';

const MiB=1024**2;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const normalized=(value:string)=>path.resolve(value).toLowerCase();
const rootId=(root:RawCacheRoot)=>cacheScopeId(root.path,root.volumeId,root.fileId!);

type Selection={game:string;config:string;backupBytes:number;stagingBytes:number};
type Acquire=(needed:readonly string[])=>Promise<string>;

async function rawRoots(storage:string,selected:string){
 const managed=path.join(storage,'managed-installations');
 const found=new Map([[normalized(selected),selected]]);
 for(const name of await listCacheDirectory(managed,120)){
  if(!/^[a-f0-9]{64}$/i.test(name))throw Error('Cache accounting managed layout is unsafe');
  const raw=path.join(managed,name,'packages','steam-depots');
  found.set(normalized(raw),raw);
 }
 return [...found.values()];
}

function verifyCensus(census:RawCacheCensus){
 if(census.status!=='COMPLETE'){
  const issues=[...new Set(census.issues.map(issue=>issue.code))].join(', ');
  throw Error('Cache accounting census is incomplete: '+issues);
 }
 return census;
}

function occupied(raw:RawCacheCensus,helper:RawCacheCensus,volumeId:string):CacheCharge{
 return {volumeId,rawBytes:raw.volumes.find(row=>row.volumeId===volumeId)?.allocatedBytes??0n,
  helperBytes:helper.volumes.find(row=>row.volumeId===volumeId)?.allocatedBytes??0n};
}

function observed(before:readonly CacheCharge[],raw:RawCacheCensus,helper:RawCacheCensus){
 return before.map(({volumeId,rawBytes,helperBytes})=>{
  const now=occupied(raw,helper,volumeId);
  return {volumeId,rawBytes:now.rawBytes>rawBytes?now.rawBytes-rawBytes:0n,
   helperBytes:now.helperBytes>helperBytes?now.helperBytes-helperBytes:0n};
 });
}

function findRoot(census:RawCacheCensus, id:string){
 const root=census.roots.find(row=>row.state==='PRESENT'&&rootId(row)===id);
 if(!root)throw Error('Cache accounting reservation root identity cannot be reconciled');
 return root;
}

function knownIdentity(census:RawCacheCensus,file:string){
 const value=census.files.find(row=>normalized(row.path)===normalized(file));
 return value?{fileId:value.fileId,generation:value.generation}:null;
}

function physicalGrowth(before:RawCacheCensus,after:RawCacheCensus){
 const occupancy=(census:RawCacheCensus)=>new Map(census.files.map(file=>[
  JSON.stringify([file.volumeId,file.fileId]),file
 ]));
 const earlier=occupancy(before),growth=new Map<string,bigint>();
 for(const [key,file] of occupancy(after)){
  const prior=earlier.get(key);
  // A rewrite can allocate a temporary replacement while the prior file still
  // exists. Charge the entire changed allocation and never net unrelated frees.
  if(prior?.generation===file.generation&&prior.allocatedBytes===file.allocatedBytes)continue;
  growth.set(file.volumeId,(growth.get(file.volumeId)??0n)+file.allocatedBytes);
 }
 return growth;
}

async function retainedFiles(census:RawCacheCensus,folder:string,requested:CacheReservation['requested'],rescan:()=>Promise<RawCacheCensus>){
 const observations=new Map(census.files.map(file=>[normalized(file.path),file]));
 const verified=[];
 for(const file of requested){
  const absolute=path.join(folder,...file.path.split('/')),observation=observations.get(normalized(absolute));
  if(!observation||observation.linkCount!==1)throw Error('Cache accounting has no safe verified file observation');
  const handle=await fs.open(await safeFile(folder,file.path),'r');
  try{
   const before=await handle.stat({bigint:true}),hash=createHash('sha256');
   let size=0;
   for await(const block of handle.createReadStream({autoClose:false})){
    size+=block.length;
    if(size>file.size)throw Error('Acquired raw file grew during accounting verification');
    hash.update(block);
   }
   const after=await handle.stat({bigint:true}),current=await fs.lstat(absolute,{bigint:true});
   if(before.nlink!==1n||before.dev!==current.dev||before.ino!==current.ino||
      before.ctimeNs!==after.ctimeNs||before.mtimeNs!==after.mtimeNs||after.nlink!==1n||
      size!==file.size||BigInt(size)!==observation.logicalBytes||hash.digest('hex')!==file.sha256){
    throw Error('Acquired raw file changed during accounting verification');
   }
   verified.push({path:file.path,size,sha256:file.sha256,fileId:observation.fileId,generation:observation.generation,links:1});
  }finally{await handle.close();}
 }
 const currentByPath=new Map((await rescan()).files.map(file=>[normalized(file.path),file]));
 for(const file of requested){
  const key=normalized(path.join(folder,...file.path.split('/')));
  const earlier=observations.get(key),current=currentByPath.get(key);
  if(!earlier||!current||earlier.volumeId!==current.volumeId||earlier.fileId!==current.fileId||
     earlier.generation!==current.generation||current.linkCount!==1){
   throw Error('Acquired raw identity changed after accounting verification');
  }
 }
 return verified;
}

export async function accountDepotAcquisition(
 storage:string, selection:Selection, policy:Readonly<RuntimeCohort>, cache:string,
 requested:readonly string[], signal:AbortSignal, acquire:Acquire, pin:PackagedCachePolicy=packagedCachePolicy
){
 const reuse=await inspectDepotReuse(policy,cache,requested);
 if(!reuse.missing.length&&!reuse.legacy.length)return reuse.folder;
 const {roots:[storageRoot]}=await measureCacheRoots([storage]);
 if(storageRoot?.state!=='PRESENT')throw Error('Cache accounting storage root is absent');
 const scopeId=rootId(storageRoot);
 const profileId=cacheProfileId(selection.game,selection.config);
 const cohortDigest=digest(JSON.stringify({depots:policy.depots,files:policy.files}));
 const raw=path.dirname(cache),tools=path.join(storage,'runtime-tools');

 return openCacheAccounting(path.join(storage,'runtime-cache-accounting'),scopeId,async ledger=>{
  signal.throwIfAborted();
  const locked=await inspectDepotReuse(policy,cache,requested);
  if(!locked.missing.length&&!locked.legacy.length)return locked.folder;
  const active=await ledger.readActive();
  if(active){
   const boot=await readCacheBoot();
   if(!verifiedLaterCacheBoot(boot,active.hostBootId,active.createdAt)){
    throw Error('Cache accounting recovery required; previous helper quiescence is unverified');
   }
   const catchup=verifyCensus(await censusRawCache(await rawRoots(storage,raw)));
   const helper=verifyCensus(await censusRawCache([tools]));
   findRoot(catchup,active.rawRootId);
   await ledger.reconcile(active.operationId,{quiescent:true,censusStable:true,
    rawRootId:active.rawRootId,rawVolumeId:active.rawVolumeId,hostBootId:encodeCacheBoot(boot),
    observed:observed(active.beforeAllocated,catchup,helper)});
  }
  if(!locked.missing.length)return promoteLegacyDepots(cache,locked.legacy);

  const candidate=admitPackagedCachePolicy(pin,{scopeId,profileId,cohortDigest});
  const missing=policy.files.filter(file=>locked.missing.includes(file.path));
  const boot=await readCacheBoot();
  const paths=await rawRoots(storage,raw);
  const measureRaw=async()=>{
   const verifyRoots=async()=>{
    const latest=await rawRoots(storage,raw);
    if(JSON.stringify(latest.map(normalized).sort())!==JSON.stringify(paths.map(normalized).sort())){
     throw Error('Cache accounting managed roots changed during acquisition');
    }
   };
   await verifyRoots();
   const result=verifyCensus(await censusRawCache(paths));
   await verifyRoots();
   return result;
  };
  const measureHelper=async()=>verifyCensus(await censusRawCache([tools]));
  const payloads=path.dirname(raw);
  const capacity=await measureCacheRoots([storage,selection.game,selection.config,payloads,raw,tools]);
  const currentStorage=capacity.roots.find(row=>normalized(row.path)===normalized(storage));
  if(currentStorage?.state!=='PRESENT'||rootId(currentStorage)!==scopeId)throw Error('Cache accounting storage scope changed');
  const selectionVolume=(root:string)=>capacity.roots.find(row=>normalized(row.path)===normalized(root))!.volumeId;
  const targetVolumeIds=new Set([selectionVolume(selection.game),selectionVolume(selection.config)]);
  const rawVolumeId=selectionVolume(raw);
  const helperVolumeId=selectionVolume(tools);
  const payloadVolumeId=selectionVolume(payloads);
  const [rawBefore,helperBefore]=await Promise.all([measureRaw(),measureHelper()]);
  const volumes=new Map([...capacity.volumes,...rawBefore.volumes,...helperBefore.volumes]
   .map(row=>[row.volumeId,row]));
  const requestedVolumeIds=new Set(capacity.roots.map(row=>row.volumeId));
  if(candidate&&([...requestedVolumeIds,...rawBefore.volumes.map(row=>row.volumeId)].some(id=>!candidate.volumes.has(id))||
    [...candidate.volumes.keys()].some(id=>!volumes.has(id)))){
   throw Error('Cache accounting policy volume scope does not match the measured roots');
  }
  const budgets=[...volumes.values()].map(volume=>{
   const allocation=volume.allocationUnitBytes;
   const row=candidate?.volumes.get(volume.volumeId);
   // Stage one full additional copy on the raw volume plus the bounded
   // file-list/control allowance. Existing retained and partial data stay charged.
   const rawRequestBytes=volume.volumeId===rawVolumeId
    ? reserveRawBytes(missing.map(file=>file.size),allocation)*2n+reserveRawBytes([64*1024],allocation)
    : 0n;
   const helperFloor=volume.volumeId===helperVolumeId?
    reserveRawBytes([helperPin.archiveSize,helperPin.size,helperPin.size],allocation):0n;
   const helperBytes=helperFloor+(row?.helperBytes??0n);
   const recoveryFloor=volume.volumeId===payloadVolumeId?BigInt(selection.backupBytes):0n;
   const stagingFloor=BigInt(selection.stagingBytes)*BigInt(Number(volume.volumeId===payloadVolumeId)+Number(targetVolumeIds.has(volume.volumeId)));
   const reservedRecovery=row?.recoveryBytes??(requestedVolumeIds.has(volume.volumeId)?128n*BigInt(MiB):0n);
   const allSamples=[...capacity.volumes,...rawBefore.volumes,...helperBefore.volumes]
    .filter(sample=>sample.volumeId===volume.volumeId);
   if(allSamples.some(sample=>sample.allocationUnitBytes!==allocation))throw Error('Cache accounting allocation unit changed');
   const availableBytes=allSamples.reduce((available,sample)=>sample.availableBytes<available?sample.availableBytes:available,volume.availableBytes);
   return {volumeId:volume.volumeId,rawAllocatedBytes:occupied(rawBefore,helperBefore,volume.volumeId).rawBytes,
    rawLogicalBytes:rawBefore.volumes.find(value=>value.volumeId===volume.volumeId)?.logicalBytes??0n,
    availableBytes,rawCapBytes:row?.rawCapBytes??null,rawRequestBytes,helperBytes,
    recoveryBytes:reservedRecovery+recoveryFloor,stagingBytes:(row?.stagingBytes??0n)+stagingFloor};
  });
  const decision=decideCacheAdmission({volumes:budgets,outstanding:[],enforceRawCap:!!candidate});
  if(decision.disposition!=='ADMIT')throw Error('Cache accounting admission refused: '+decision.issues
   .map(row=>[row.reason,row.volumeId,row.shortfallBytes?.toString()].filter(Boolean).join(' ')).join(', '));
  signal.throwIfAborted();
  assertRuntimeCohort(policy,false);
  if(candidate&&candidate.expiresAt<=Date.now())throw Error('Cache accounting policy expired before acquisition');
  await safeDirectory(raw);
  const {roots:[rawRoot]}=await measureCacheRoots([raw]);
  if(rawRoot?.state!=='PRESENT'||rawRoot.volumeId!==rawVolumeId)throw Error('Cache accounting raw root changed during reservation');
  const priorRoot=rawBefore.roots.find(row=>normalized(row.path)===normalized(raw));
  if(!priorRoot||priorRoot.state==='PRESENT'&&priorRoot.fileId!==rawRoot.fileId)throw Error('Cache accounting raw root changed during census');
  const charges=budgets.map(row=>({volumeId:row.volumeId,rawBytes:row.rawRequestBytes,helperBytes:row.helperBytes}));
  const reservation=await ledger.reserve({operationId:randomUUID(),policyId:candidate?.id??'ordinary-runtime-accounting',
   profileId,targetId:profileId,rawRootId:rootId(rawRoot),rawVolumeId,cohortDigest,hostBootId:encodeCacheBoot(boot),
   requested:missing.map(file=>({path:file.path,size:file.size,sha256:file.sha256,depot:file.depot,
    manifest:policy.depots.find(depot=>depot.id===file.depot)!.manifest,
    before:knownIdentity(rawBefore,path.join(locked.folder,...file.path.split('/')))})),
   charges,beforeAllocated:charges.map(row=>occupied(rawBefore,helperBefore,row.volumeId)),
   reviewAfterMs:candidate?.reviewAfterMs??null});
  let source:string|undefined,error:unknown;
  try{
   signal.throwIfAborted();
   assertRuntimeCohort(policy,false);
   if(candidate&&candidate.expiresAt<=Date.now())throw Error('Cache accounting policy expired before helper launch');
   source=await acquire(locked.missing);
  }
  catch(failure){error=failure;}
  const [after,helperAfter]=await Promise.all([measureRaw(),measureHelper()]);
  findRoot(after,reservation.rawRootId);
  const rawGrowth=physicalGrowth(rawBefore,after),helperGrowth=physicalGrowth(helperBefore,helperAfter);
  const measured=charges.map(({volumeId})=>({
   volumeId,rawBytes:rawGrowth.get(volumeId)??0n,helperBytes:helperGrowth.get(volumeId)??0n,
  }));
  if([...rawGrowth.keys(),...helperGrowth.keys()].some(id=>!charges.some(row=>row.volumeId===id))){
   throw Error('Cache accounting detected growth on a volume outside the reservation');
  }
  if(source&&normalized(source)!==normalized(locked.folder))throw Error('Unexpected acquisition location during accounting');
  const verified=source?await retainedFiles(after,source,reservation.requested,measureRaw):[];
  const status=await ledger.settle(reservation.operationId,{quiescent:true,censusStable:true,
   rawRootId:reservation.rawRootId,rawVolumeId,observed:measured,outcome:source?'verified':'failed',files:verified});
  if(status==='overrun')throw Error('Cache accounting helper overrun: '+measured.map((row,index)=>{
   const reserved=charges[index]!;
   return row.volumeId+' raw observed/reserved '+row.rawBytes+'/'+reserved.rawBytes+
    ' helper observed/reserved '+row.helperBytes+'/'+reserved.helperBytes;
  }).join(', '));
  if(error)throw error;
  if(!source)throw Error('Cache accounting acquisition did not return a verified source');
  await promoteLegacyDepots(cache,locked.legacy);
  return source;
 });
}
