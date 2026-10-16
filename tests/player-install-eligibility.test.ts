import test from 'node:test';import assert from 'node:assert/strict';import * as api from '../src/main/updates';
const fn=api as any;
function fixture(){const names=['Skyrim.esm','Update.esm','Dawnguard.esm','HearthFires.esm','Dragonborn.esm'];return{preflight:{status:'UNVERIFIED',blockers:[] as string[],manual:['Existing active light/ESL plugins are preserved; their gameplay compatibility with the pinned SkyMP build is unverified.'],runtime:{ready:true},managerDetected:false,processActive:false,permissions:{gameReadable:true,gameWriteAccess:true,configReadable:true,configWriteAccess:true},plugins:[{name:'ccFixture.esl',light:true}],activation:{status:'ready',active:[...names,'ccFixture.esl'],order:names,configWrites:[]}},bundle:{manifest:{components:[{id:'frostveil',category:'developer-owned'}],files:[{path:'Data/Frostveil/settings.json',componentId:'frostveil',distribution:'allowed',ownership:'custom-rp',role:'configuration'}],requiredPlugins:names.map((filename,order)=>({filename,order,role:'server-required'}))}}};}
test('unchanged existing light plugins allow only inert Frostveil content while warnings remain unverified',()=>{assert.equal(typeof fn.installPreflightIssue,'function');const f=fixture();assert.equal(fn.installPreflightIssue(f.preflight,f.bundle),undefined);assert.equal(f.preflight.status,'UNVERIFIED');assert.equal(f.preflight.manual.length,1);});
for(const attack of ['script','plugin','bsa','third-party','client-plugin','activation-write','server-index','unknown-warning','bad-runtime','manager','process','permission'])test('existing-light exception refuses '+attack,()=>{
 assert.equal(typeof fn.installPreflightIssue,'function');const f=fixture(),p=f.preflight as any,b=f.bundle as any;
 if(attack==='script')b.manifest.files[0].path='Data/Scripts/change.pex';if(attack==='plugin')b.manifest.files[0].path='Data/Extra.esp';if(attack==='bsa')b.manifest.files[0].path='Data/Extra.bsa';if(attack==='third-party')b.manifest.files[0].ownership='third-party-permitted';if(attack==='client-plugin')b.manifest.requiredPlugins.push({filename:'SkyUI_SE.esp',order:5,role:'client-only'});if(attack==='activation-write')p.activation.configWrites.push({path:'@config/plugins.txt'});if(attack==='server-index')p.activation.order.reverse();if(attack==='unknown-warning')p.manual.push('Unknown compatibility condition');if(attack==='bad-runtime')p.runtime.ready=false;if(attack==='manager')p.managerDetected=true;if(attack==='process')p.processActive=true;if(attack==='permission')p.permissions.gameWriteAccess=false;
 assert.equal(typeof fn.installPreflightIssue(p,b),'string');
});
test('preflight hard blockers always win over a ready-looking status',()=>{assert.equal(typeof fn.installPreflightIssue,'function');const f=fixture();f.preflight.status='READY';f.preflight.blockers.push('unsafe path');assert.match(fn.installPreflightIssue(f.preflight,f.bundle),/unsafe path/);});
test('restoration of inert files is possible with the same warning but plugin or changed-order recovery remains blocked',()=>{
 assert.equal(typeof fn.restorationPreflightIssue,'function');const f=fixture();assert.equal(fn.restorationPreflightIssue(f.preflight,['Data/Frostveil/settings.json'],f.preflight.activation.order),undefined);assert.equal(typeof fn.restorationPreflightIssue(f.preflight,['@config/plugins.txt'],f.preflight.activation.order),'string');assert.equal(typeof fn.restorationPreflightIssue(f.preflight,['Data/Frostveil/settings.json'],[...f.preflight.activation.order].reverse()),'string');
});

for(const attack of ['obsolete-plugin','obsolete-archive','obsolete-script','activation-write','changed-order','changed-active','none'])test('existing-light final plan checks receipt removals and recomputed activation: '+attack,()=>{
 const f=fixture(),plan:any={actions:[{path:'Data/Frostveil/settings.json',action:'add'}],pluginPlan:{order:f.preflight.activation.order,active:f.preflight.activation.active}};
 if(attack.startsWith('obsolete-'))plan.actions.push({path:attack==='obsolete-plugin'?'Data/Legacy.esp':attack==='obsolete-archive'?'Data/Legacy.bsa':'Data/Scripts/Legacy.pex',action:'remove'});
 if(attack==='activation-write')plan.actions.push({path:'@config/plugins.txt',action:'configuration'});
 if(attack==='changed-order')plan.pluginPlan.order=[...plan.pluginPlan.order].reverse();
 if(attack==='changed-active')plan.pluginPlan.active=plan.pluginPlan.active.slice(0,-1);
 assert.equal(typeof fn.finalPlanPreflightIssue,'function');
 assert.equal(typeof fn.finalPlanPreflightIssue(f.preflight,f.bundle,plan),attack==='none'?'undefined':'string');
});
