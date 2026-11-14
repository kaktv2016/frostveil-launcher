import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {dump} from 'js-yaml';

const verifierPath=path.resolve('scripts/verify-artifacts.mjs');

async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'frostveil-release-artifacts-'));
 const version='0.1.30';
 const installerName=`SkyrimRPLauncher-${version}-x64-local.exe`;
 const installer=Buffer.from('synthetic inert NSIS artifact');
 const sha512=createHash('sha512').update(installer).digest('base64');
 await fs.mkdir(path.join(root,'release','win-unpacked','resources'),{recursive:true});
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({version}));
 await fs.writeFile(path.join(root,'release','win-unpacked','resources','app-update.yml'),dump({provider:'github',owner:'kaktv2016',repo:'frostveil-launcher',private:false}));
 await fs.writeFile(path.join(root,'release',installerName),installer);
 await fs.writeFile(path.join(root,'release','latest.yml'),dump({
  version,
  files:[{url:installerName,sha512,size:installer.length}],
  path:installerName,
  sha512
 }));
 return{root,installerName,installer,sha512};
}

function verify(root:string){
 return spawnSync(process.execPath,[verifierPath],{cwd:root,encoding:'utf8'});
}

test('accepts release metadata bound to the exact pinned local installer bytes',async()=>{
 const {root}=await fixture();
 try{
  const result=verify(root);
  assert.equal(result.status,0,result.stderr);
 }finally{
  await fs.rm(root,{recursive:true,force:true});
 }
});

test('rejects an installer filename that differs from the package version pin',async()=>{
 const {root}=await fixture();
 try{
  const metadataPath=path.join(root,'release','latest.yml');
  const metadata=await fs.readFile(metadataPath,'utf8');
  await fs.writeFile(metadataPath,metadata.replace('SkyrimRPLauncher-0.1.30-x64-local.exe','SkyrimRPLauncher-0.1.31-x64-local.exe'));
  const result=verify(root);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/pinned NSIS installer filename/);
 }finally{
  await fs.rm(root,{recursive:true,force:true});
 }
});

test('rejects an installer size that differs from the local artifact',async()=>{
 const {root,installerName,sha512,installer}=await fixture();
 try{
  const metadataPath=path.join(root,'release','latest.yml');
  await fs.writeFile(metadataPath,dump({version:'0.1.30',files:[{url:installerName,sha512,size:installer.length+1}],path:installerName,sha512}));
  const result=verify(root);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/installer size/);
 }finally{
  await fs.rm(root,{recursive:true,force:true});
 }
});

test('rejects an installer SHA-512 that differs from the local artifact',async()=>{
 const {root,installerName,installer}=await fixture();
 try{
  const metadataPath=path.join(root,'release','latest.yml');
  const wrongHash=createHash('sha512').update('different installer').digest('base64');
  await fs.writeFile(metadataPath,dump({version:'0.1.30',files:[{url:installerName,sha512:wrongHash,size:installer.length}],path:installerName,sha512:wrongHash}));
  const result=verify(root);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/installer SHA-512/);
 }finally{
  await fs.rm(root,{recursive:true,force:true});
 }
});

test('rejects a package version that is not a stable semantic version',async()=>{
 const {root}=await fixture();
 try{
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({version:'../outside'}));
  const result=verify(root);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/stable semantic version/);
 }finally{
  await fs.rm(root,{recursive:true,force:true});
 }
});

test('rejects an empty installer even when metadata declares its empty-file hash',async()=>{
 const {root,installerName}=await fixture();
 try{
  const installerPath=path.join(root,'release',installerName);
  await fs.writeFile(installerPath,Buffer.alloc(0));
  const emptySha512=createHash('sha512').update(Buffer.alloc(0)).digest('base64');
  await fs.writeFile(path.join(root,'release','latest.yml'),dump({
   version:'0.1.30',
   files:[{url:installerName,sha512:emptySha512,size:0}],
   path:installerName,
   sha512:emptySha512
  }));
  const result=verify(root);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/must not be empty/);
 }finally{
  await fs.rm(root,{recursive:true,force:true});
 }
});

test('rejects a hard-linked installer artifact',async()=>{
 const {root,installerName,installer}=await fixture();
 try{
  const installerPath=path.join(root,'release',installerName);
  const aliasPath=path.join(root,'release','installer-alias.exe');
  await fs.writeFile(aliasPath,installer);
  await fs.rm(installerPath);
  await fs.link(aliasPath,installerPath);
  const result=verify(root);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/regular file without links/);
 }finally{
  await fs.rm(root,{recursive:true,force:true});
 }
});
