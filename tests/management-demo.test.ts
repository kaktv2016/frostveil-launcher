import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runManagementFixtureDemo} from '../src/main/management/demo';

test('management UI fixture executes signed download/install/update/repair/remove and config rollback on Windows filesystem',async()=>{
 const stages:string[]=[];const result=await runManagementFixtureDemo(stage=>stages.push(stage));
 try{
  assert.equal(result.realGameWrites,false);
  assert.equal(path.dirname(result.directory).toLowerCase(),(await fs.realpath(os.tmpdir())).toLowerCase());
  assert.match(path.basename(result.directory),/^frostveil-l4c-/);
  assert.ok(result.checks.length>=6);
  assert.ok(result.checks.some(x=>/activation.*rollback|rollback.*activation/i.test(x)));
  assert.ok(result.checks.some(x=>/missing.*repair|repair.*missing/i.test(x)));
  assert.ok(result.checks.some(x=>/unknown|unrelated/i.test(x)));
  assert.ok(result.downloadRequests>=5);
  assert.equal(result.originalActivationRestored,true);
  assert.equal(result.ownedFiles,3);
  assert.equal(await fs.readFile(path.join(result.directory,'installation/unrelated-user-file.txt'),'utf8'),'USER CONTENT MUST SURVIVE\r\n');
  assert.match(await fs.readFile(path.join(result.directory,'profile/plugins.txt'),'utf8'),/^# Existing synthetic user profile\r\n\*FrostveilFixture.esp\r\n$/);
  assert.ok(stages.includes('download'));
  assert.ok(stages.includes('rollback'));
 }finally{if(result.directory&&path.dirname(result.directory).toLowerCase()===(await fs.realpath(os.tmpdir())).toLowerCase()&&/^frostveil-l4c-[a-z0-9]+$/i.test(path.basename(result.directory)))await fs.rm(result.directory,{recursive:true,force:true});}
});
