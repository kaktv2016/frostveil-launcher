import {assertSharedPluginCompatibility} from '../modpack/compatibility';
import {OFFICIAL} from '../modpack/plugins';
import {helperPin} from '../runtime/depot';
import type {RuntimeCohort} from '../runtime/policy';
import type {AuthenticatedRelease} from './policy';

export function assertW14ContentPairing(runtime:Readonly<RuntimeCohort>,{manifest,server}:AuthenticatedRelease){
 if(manifest.requiredSkyrimRuntime!==runtime.runtime||manifest.requiredSKSEVersion!=='0.2.2.6'){
  throw Error('Signed runtime and pack disagree on the W14 profile');
 }
 if(runtime.depots.length!==3||runtime.helper.version!==helperPin.version||
    runtime.helper.size!==helperPin.size||runtime.helper.sha256!==helperPin.sha256){
  throw Error('Signed helper or depot set differs from the Launcher pins');
 }
 assertSharedPluginCompatibility(manifest,server);
 const managed=new Set(runtime.managedFiles.map(file=>file.path.toLowerCase()));
 if(manifest.skyMPClientRequirements.nativeFiles.some(file=>!managed.has(file.toLowerCase()))){
  throw Error('Signed runtime lacks a required native client inventory entry');
 }
 const runtimeFiles=new Map([...runtime.files,...runtime.managedFiles].map(file=>[file.path.toLowerCase(),file]));
 let commonRequiredFiles=0;
 for(const file of manifest.files){
  const peer=runtimeFiles.get(file.path.toLowerCase());
  if(!file.required||!peer)continue;
  if(peer.sha256!==file.sha256||peer.size!==file.size)throw Error('Signed runtime and pack file length or SHA-256 conflict');
  commonRequiredFiles++;
 }
 const implicitMasters=OFFICIAL.filter(name=>runtimeFiles.has(('Data/'+name).toLowerCase()));
 const declaredOrder=[...new Set([...implicitMasters,...runtime.creations,...runtime.pluginOrder].map(name=>name.toLowerCase()))];
 const declaredSharedSlots=server.plugins.map(plugin=>declaredOrder.indexOf(plugin.filename.toLowerCase()));
 if(!declaredSharedSlots.length||declaredSharedSlots.some((slot,i)=>slot<0||(i>0&&slot<declaredSharedSlots[i-1]!))){
  throw Error('Signed runtime and server plugin order conflict');
 }
 return commonRequiredFiles;
}
