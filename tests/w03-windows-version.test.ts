import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {canonicalTemporaryRoot} from '../src/main/temporary-root';

test('W03 Windows version reader binds cached results to file identity and can bypass the cache', async t => {
  const temp = await canonicalTemporaryRoot();
  const root = await fs.realpath(await fs.mkdtemp(path.join(temp, 'fv-w03-version-')));
  t.after(async () => {
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, {recursive:true, force:true});
  });
  const exe = path.join(root, 'SkyrimSE.exe');
  const replacement = path.join(root, 'replacement.exe');
  const fixedTime = new Date('2020-01-01T00:00:00Z');
  const firstVersion = '1.6.1170.0';
  const otherVersion = '1.6.0640.0';
  let queries = 0;
  let override: string | undefined;
  const originalExecFile=Object.getOwnPropertyDescriptor(childProcess,'execFile');
  assert.ok(originalExecFile);
  const invoke=promisify(childProcess.execFile);
  const intercepted = Object.assign(() => { throw Error('Unexpected process execution'); }, {
    [promisify.custom]: async (program: string, args: string[], options: {env: NodeJS.ProcessEnv}) => {
      if (options.env.SKYRIM_RP_INSPECT_FILE !== exe) {
        return invoke(program,args,options);
      }
      assert.equal(path.basename(program).toLowerCase(), 'powershell.exe');
      assert.match(args.at(-1) ?? '', /FileVersionInfo.*SKYRIM_RP_INSPECT_FILE/);
      assert.equal(options.env.SKYRIM_RP_INSPECT_FILE, exe);
      queries++;
      const version=override ?? await fs.readFile(exe,'utf8');
      const fixed=args.at(-1)?.includes('FileMajorPart');
      return {stdout:JSON.stringify(fixed&&version?version.split('.').map(Number):version), stderr:''};
    },
  });
  Object.defineProperty(childProcess,'execFile',{...originalExecFile,value:intercepted});
  t.after(()=>Object.defineProperty(childProcess,'execFile',originalExecFile));
  const {fileVersion} = await import('../src/main/windows');
  await fs.writeFile(exe, firstVersion);
  await fs.utimes(exe, fixedTime, fixedTime);
  const before = await fs.stat(exe,{bigint:true});
  assert.equal(await fileVersion(exe),firstVersion);
  assert.equal(await fileVersion(exe),firstVersion);
  assert.equal(queries,1);

  await fs.writeFile(replacement,otherVersion);
  await fs.utimes(replacement,fixedTime,fixedTime);
  await fs.rename(replacement,exe);
  const after = await fs.stat(exe,{bigint:true});
  assert.equal(after.size,before.size);
  assert.equal(after.mtimeNs,before.mtimeNs);
  assert.notEqual(after.ino,before.ino);
  assert.equal(await fileVersion(exe),otherVersion);
  assert.equal(queries,2);

  override = '1.6.640.0';
  assert.equal(await fileVersion(exe),otherVersion);
  assert.equal(await fileVersion(exe,true),'1.6.640.0');
  assert.equal(queries,3);
  override='';
  assert.equal(await fileVersion(exe,true),'');
  assert.equal(queries,4);
});

test('W03 Windows reads a version resource from an extensionless staged executable', {skip:process.platform!=='win32'}, async t => {
  const temp=await canonicalTemporaryRoot();
  const root=await fs.realpath(await fs.mkdtemp(path.join(temp,'fv-w03-pe-')));
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);
    assert.equal(path.dirname(root),temp);
    await fs.rm(root,{recursive:true,force:true});
  });
  // Copy an inert OS executable and query its PE resource without launching it.
  const systemExecutable=path.join(process.env.SystemRoot??'C:\\Windows','System32','cmd.exe');
  const bytes=await fs.readFile(systemExecutable);
  const named=path.join(root,'inert.exe');
  const staged=path.join(root,createHash('sha256').update(bytes).digest('hex'));
  await fs.writeFile(named,bytes,{flag:'wx'});
  await fs.writeFile(staged,bytes,{flag:'wx'});
  const {fileVersion}=await import('../src/main/windows');
  const version=await fileVersion(named,true);
  assert.ok(version,'The inert Windows PE must have a readable version resource');
  assert.equal(await fileVersion(staged,true),version);
});
