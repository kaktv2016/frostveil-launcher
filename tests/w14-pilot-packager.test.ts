import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createW14PilotPlan,validateFolderPin} from '../scripts/package-w14-pilot.mjs';
import {readW14ContentBuildPin} from '../scripts/w14-content-build-pin.mjs';

const repo='C:\\fixture\\launcher';
const privateRoot='C:\\fixture\\private-candidates\\launcher-v2-p0';
const contentPinFile='C:\\fixture\\content-pin.json';
const contentPin={folder:'D:\\Frostveil\\content',runtimeSha256:'a'.repeat(64),
 packReleaseSha256:'b'.repeat(64),packEnvelopeSha256:'c'.repeat(64)};

test('W14 plan pins a unique Windows x64 NSIS Pilot package to the private output and folder',()=>{
 const plan=createW14PilotPlan({repo,privateRoot,release:'candidate',version:'0.1.6',
  updateFolder:'D:\\Frostveil\\pilot-feed',contentPinFile,contentPin,outputDir:`${privateRoot}\\w14-pilot\\candidate-0.1.6`,
  cachePolicyRevision:1,cachePolicyFile:'C:\\fixture\\policy.json'});
 assert.deepEqual(plan.buildCommand,['node','scripts/build.mjs','--w14-update-folder=D:\\Frostveil\\pilot-feed',
  `--w14-content-pin=${contentPinFile}`,
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

test('W14 plan requires and compiles an independently pinned content folder',()=>{
 const plan=createW14PilotPlan({repo,privateRoot,release:'candidate',version:'0.1.6',
  updateFolder:'D:\\Frostveil\\feed',contentPinFile,contentPin,
  cachePolicyRevision:1,cachePolicyFile:'C:\\fixture\\policy.json'});
 assert.ok(plan.buildCommand.includes(`--w14-content-pin=${contentPinFile}`));
 assert.deepEqual(plan.contentPin,contentPin);
 assert.ok(plan.buildCommand.includes('--w14-update-folder=D:\\Frostveil\\feed'));
 assert.throws(()=>createW14PilotPlan({repo,privateRoot,release:'prior',version:'0.1.5',
  updateFolder:'D:\\Frostveil\\feed'}),/content pin/i);
 assert.throws(()=>createW14PilotPlan({repo,privateRoot,release:'candidate',version:'0.1.6',
  updateFolder:'D:\\Frostveil\\feed',contentPinFile}),/content pin/i);
});

test('W14 plan rejects malformed or non-canonical content pins',()=>{
 const base={repo,privateRoot,release:'prior',version:'0.1.5',updateFolder:'D:\\Frostveil\\feed',
  contentPinFile:'C:\\fixture\\pin.json',contentPin:{folder:'D:\\Frostveil\\content',
   runtimeSha256:'a'.repeat(64),packReleaseSha256:'b'.repeat(64),packEnvelopeSha256:'c'.repeat(64)}};
 assert.throws(()=>createW14PilotPlan({...base,contentPinFile:'C:\\fixture\\..\\pin.json'}),/canonical/i);
 assert.throws(()=>createW14PilotPlan({...base,contentPin:{...base.contentPin,runtimeSha256:'A'.repeat(64)}}),/content pin/i);
 assert.throws(()=>createW14PilotPlan({...base,contentPin:{...base.contentPin,folder:'\\\\server\\feed'}}),/content folder/i);
});

test('W14 content pin reader rejects linked files and preserves the exact validated folder pin',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'w14-content-pin-'));
 t.after(async()=>{
  assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));
  await fs.rm(root,{recursive:true,force:true});
 });
 const file=path.join(root,'content-pin.json'),link=path.join(root,'linked-content-pin.json');
 await fs.writeFile(file,JSON.stringify(contentPin),{flag:'wx'});
 assert.deepEqual(await readW14ContentBuildPin(file),contentPin);
 await fs.link(file,link);
 await assert.rejects(readW14ContentBuildPin(file),/unsafe|linked/i);
 await fs.unlink(link);
 await fs.writeFile(file,JSON.stringify({...contentPin,extra:'unexpected'}));
 await assert.rejects(readW14ContentBuildPin(file),/content pin fields/i);
});

test('W14 plan rejects output escape, overwrite target, unsafe folder syntax and partial cache policy',()=>{
 const base={repo,privateRoot,release:'prior',version:'0.1.5',updateFolder:'D:\\Frostveil\\pilot-feed',contentPinFile,contentPin};
 assert.throws(()=>createW14PilotPlan({...base,outputDir:'C:\\outside\\candidate'}),/private output root/);
 assert.throws(()=>createW14PilotPlan({...base,outputDir:`${privateRoot}\\existing`,outputExists:true}),/already exists/);
 assert.throws(()=>validateFolderPin('\\\\server\\share\\feed'),/absolute local drive path/);
 assert.throws(()=>validateFolderPin('D:\\Frostveil\\..\\feed'),/canonical/);
 assert.throws(()=>createW14PilotPlan({...base,cachePolicyRevision:4}),/both cache policy/i);
 assert.throws(()=>createW14PilotPlan({...base,release:'candidate'}),/cache policy/i);
});
