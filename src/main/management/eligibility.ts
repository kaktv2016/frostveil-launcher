import type {ManagedPreflight} from './preflight';
import type {AuthenticatedRelease} from '../distribution/policy';
import type {ManagedPlan} from '../../shared/management-contracts';

export const EXISTING_LIGHT_NOTICE='Existing active light/ESL plugins are preserved; their gameplay compatibility with the pinned SkyMP build is unverified.';
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const inert=(p:string)=>/^data\/frostveil\/[a-z0-9_/-]+\.(?:ini|json|txt)$/i.test(p)||/^data\/interface\/frostveil\/[a-z0-9_/-]+\.(?:html|css|json|png)$/i.test(p);
function warningOnly(p:ManagedPreflight){
 return p.status==='UNVERIFIED'&&p.runtime?.ready&&!p.managerDetected&&!p.processActive&&!p.blockers.length&&p.activation?.status==='ready'&&p.permissions.gameReadable&&p.permissions.gameWriteAccess&&p.permissions.configReadable&&p.permissions.configWriteAccess&&p.manual.length===1&&p.manual[0]===EXISTING_LIGHT_NOTICE&&p.activation.active.some(n=>p.plugins.some(x=>same(x.name,n)&&(x.light||/\.esl$/i.test(n))));
}
/** File installation readiness is distinct from unverified live gameplay. No plugin exception. */
export function installPreflightIssue(p:ManagedPreflight,b:AuthenticatedRelease):string|undefined{
 if(p.blockers.length)return p.blockers[0];if(p.status==='READY')return;
 const files=b.manifest.files.filter(f=>f.distribution==='allowed');
 if(warningOnly(p)&&files.length>0&&files.every(f=>inert(f.path)&&f.ownership==='custom-rp'&&['configuration','visual'].includes(f.role)&&b.manifest.components.find(c=>c.id===f.componentId)?.category==='developer-owned')&&b.manifest.requiredPlugins.every(r=>r.role==='server-required'&&same(p.activation!.order[r.order]??'',r.filename))&&!p.activation!.configWrites.length)return;
 return p.manual[0]??'Installation preflight is not ready';
}
/** Receipt-derived removals and activation changes must satisfy the same narrow exception. */
export function finalPlanPreflightIssue(p:ManagedPreflight,b:AuthenticatedRelease,plan:ManagedPlan):string|undefined{
 const issue=installPreflightIssue(p,b);if(issue)return issue;if(p.status==='READY')return;
 const unchanged=(before:string[],after:string[])=>before.length===after.length&&before.every((n,i)=>same(n,after[i]!));
 if(plan.actions.every(a=>inert(a.path)&&a.action!=='configuration')&&unchanged(p.activation!.order,plan.pluginPlan.order)&&unchanged(p.activation!.active,plan.pluginPlan.active))return;
 return 'Existing-light exception cannot remove non-inert managed files or change activation; resolve compatibility before preparing this plan';
}
/** Restoration may only undo the same inert operations without changing plugin order. */
export function restorationPreflightIssue(p:ManagedPreflight,paths:string[],order:string[]):string|undefined{
 if(p.blockers.length)return p.blockers[0];if(p.status==='READY')return;
 if(warningOnly(p)&&paths.length>0&&paths.every(inert)&&!p.activation!.configWrites.length&&p.activation!.order.length===order.length&&order.every((n,i)=>same(n,p.activation!.order[i]!)))return;
 return p.manual[0]??'Recovery preflight is not ready';
}
