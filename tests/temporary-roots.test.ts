import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createInstallerSandbox,reopenSandboxInstaller} from '../src/main/updates';import {MetadataStore} from '../src/main/installer/metadata';
test('authenticated cache survives Windows Explorer restart from base TEMP into an RDS session TEMP', {skip:process.platform!=='win32'},async()=>{
 const originalTemp=process.env.TEMP,originalTmp=process.env.TMP,base=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(base,'frostveil-session-test-')),temp=path.join(root,'Temp'),session=path.join(temp,'2');await fs.mkdir(session,{recursive:true});
 try{process.env.TEMP=temp;process.env.TMP=temp;const grant=await createInstallerSandbox();await MetadataStore.create(grant);await fs.writeFile(path.join(grant.payloads,'sentinel.txt'),'retained');process.env.TEMP=session;process.env.TMP=session;
  const reopened=await reopenSandboxInstaller(grant.directory);assert.equal(reopened.grant.id,grant.id);assert.equal(await fs.readFile(path.join(reopened.grant.payloads,'sentinel.txt'),'utf8'),'retained');const next=await createInstallerSandbox();assert.equal(path.dirname(next.directory),await fs.realpath(temp));
 }finally{if(originalTemp===undefined)delete process.env.TEMP;else process.env.TEMP=originalTemp;if(originalTmp===undefined)delete process.env.TMP;else process.env.TMP=originalTmp;assert.equal(path.dirname(path.resolve(root)),base);await fs.rm(root,{recursive:true,force:true});}
});
