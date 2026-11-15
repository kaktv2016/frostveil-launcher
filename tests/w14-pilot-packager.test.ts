import test from 'node:test';
import assert from 'node:assert/strict';
import {createW14PilotPlan,validateFolderPin} from '../scripts/package-w14-pilot.mjs';

const repo='C:\\fixture\\launcher';
const privateRoot='C:\\fixture\\private-candidates\\launcher-v2-p0';

test('W14 plan pins a unique Windows x64 NSIS Pilot package to the private output and folder',()=>{
 const plan=createW14PilotPlan({repo,privateRoot,release:'candidate',version:'0.1.6',
  updateFolder:'D:\\Frostveil\\pilot-feed',outputDir:`${privateRoot}\\w14-pilot\\candidate-0.1.6`,
  cachePolicyRevision:1,cachePolicyFile:'C:\\fixture\\policy.json'});
 assert.deepEqual(plan.buildCommand,['node','scripts/build.mjs','--w14-update-folder=D:\\Frostveil\\pilot-feed',
  '--p0-cache-policy-revision=1','--p0-cache-policy-file=C:\\fixture\\policy.json']);
 assert.ok(plan.packageCommand.includes('--win'));
 assert.ok(plan.packageCommand.includes('nsis'));
 assert.ok(plan.packageCommand.includes('--x64'));
 assert.ok(plan.packageCommand.includes('--publish'));
 assert.ok(plan.packageCommand.includes('never'));
 assert.ok(plan.packageCommand.includes('-c.appId=dev.skyrimrp.launcher.w14-pilot'));
 assert.ok(plan.packageCommand.includes('-c.productName=Frostveil Launcher W14 Pilot'));
 assert.ok(plan.packageCommand.includes(`-c.directories.output=${privateRoot}\\w14-pilot\\candidate-0.1.6`));
 assert.ok(plan.packageCommand.includes('-c.extraMetadata.version=0.1.6'));
 assert.equal(plan.artifactName,'FrostveilLauncher-W14Pilot-0.1.6-x64.exe');
});

test('W14 plan rejects output escape, overwrite target, unsafe folder syntax and partial cache policy',()=>{
 const base={repo,privateRoot,release:'prior',version:'0.1.5',updateFolder:'D:\\Frostveil\\pilot-feed'};
 assert.throws(()=>createW14PilotPlan({...base,outputDir:'C:\\outside\\candidate'}),/private output root/);
 assert.throws(()=>createW14PilotPlan({...base,outputDir:`${privateRoot}\\existing`,outputExists:true}),/already exists/);
 assert.throws(()=>validateFolderPin('\\\\server\\share\\feed'),/absolute local drive path/);
 assert.throws(()=>validateFolderPin('D:\\Frostveil\\..\\feed'),/canonical/);
 assert.throws(()=>createW14PilotPlan({...base,cachePolicyRevision:4}),/both cache policy/i);
 assert.throws(()=>createW14PilotPlan({...base,release:'candidate'}),/cache policy/i);
});
