import {createHash} from 'node:crypto';
import {canonicalBytes} from '../distribution/policy';

/** Clone only JSON data; accessors, serialization hooks and lossy JSON values are refused. */
export function freezePlan<T>(raw:T):Readonly<T>{
 const ancestors=new WeakSet<object>();let nodes=0;
 function clone(value:unknown,depth:number):unknown{
  if(++nodes>100000||depth>100)throw Error('Installation plan exceeds supported bounds');
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(typeof value!=='object'||ancestors.has(value))throw Error('Installation plan must contain finite JSON data');
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw Error('Installation plan must contain plain JSON data');
  const keys=Reflect.ownKeys(value);
  if(keys.some(key=>typeof key!=='string'))throw Error('Installation plan contains non-JSON keys');
  const fields=(keys as string[]).filter(key=>!(array&&key==='length'));
  if(array&&(fields.length!==value.length||fields.some((key,index)=>key!==String(index))))throw Error('Installation plan contains non-JSON array entries');
  ancestors.add(value);
  try{
   const entries=fields.map(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw Error('Installation plan contains non-JSON properties');
    return[key,clone(descriptor.value,depth+1)] as const;
   });
   return Object.freeze(array?entries.map(([,entry])=>entry):Object.fromEntries(entries));
  }finally{ancestors.delete(value);}
 }
 return clone(raw,0) as Readonly<T>;
}

export function planDigest(plan:unknown):string{
 const bytes=canonicalBytes(freezePlan(plan));
 if(bytes.length>4*1024*1024)throw Error('Installation plan exceeds supported bounds');
 return createHash('sha256').update(bytes).digest('hex');
}

interface Authorization {digest:string;issuedAt:number;expiresAt:number;}

/**
 * Main-only confirmation boundary. Main must validate production policy, publisher/rights,
 * target, processes and compatibility before request(), and revalidate before execution.
 * This generic authorization does not grant filesystem or production-distribution access.
 * Never expose the confirmation callback or an authorization override through IPC, flags or environment.
 */
export class PlanAuthorizer {
 private readonly tokens=new WeakMap<object,Authorization>();
 constructor(private readonly confirm:(plan:unknown,hash:string)=>Promise<boolean>,private readonly ttlMs=120000,private readonly now=Date.now){
  if(typeof confirm!=='function'||typeof now!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<=0||ttlMs>300000)throw Error('Invalid Main plan authorization configuration');
 }
 private time():number{const value=this.now();if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid authorization clock');return value;}
 async request(plan:unknown):Promise<object>{
  const snapshot=freezePlan(plan),digest=planDigest(snapshot),started=this.time();
  if(await this.confirm(snapshot,digest)!==true)throw Error('Installation plan authorization declined');
  const issuedAt=this.time();
  if(issuedAt<started||!Number.isSafeInteger(issuedAt+this.ttlMs))throw Error('Invalid authorization clock');
  if(planDigest(plan)!==digest)throw Error('Installation plan changed during confirmation');
  const token=Object.freeze(Object.create(null)) as object;
  this.tokens.set(token,{digest,issuedAt,expiresAt:issuedAt+this.ttlMs});
  return token;
 }
 consume(plan:unknown,token:object):void{
  const authorization=this.tokens.get(token);
  if(!authorization)throw Error('Invalid or consumed installation authorization token');
  this.tokens.delete(token);
  const current=this.time();
  if(current<authorization.issuedAt||current>=authorization.expiresAt)throw Error('Installation authorization expired');
  if(planDigest(plan)!==authorization.digest)throw Error('Installation authorization does not match the plan');
 }
}
