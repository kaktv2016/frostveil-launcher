import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {load} from 'js-yaml';
import semver from 'semver';

async function verifyArtifacts(root=process.cwd()){
 const releaseDir=path.join(root,'release');
 const metadata=load(await fs.readFile(path.join(releaseDir,'win-unpacked','resources','app-update.yml'),'utf8'));
 if(metadata.provider!=='github'||metadata.owner!=='kaktv2016'||metadata.repo!=='frostveil-launcher'||metadata.private===true){
  throw Error('Incorrect update provider');
 }

 const latest=load(await fs.readFile(path.join(releaseDir,'latest.yml'),'utf8'));
 const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 if(typeof pkg.version!=='string'||semver.valid(pkg.version)!==pkg.version||semver.prerelease(pkg.version)!==null){
  throw Error('Package version must be a stable semantic version');
 }
 if(latest.version!==pkg.version){
  throw Error('Release metadata version does not match package version');
 }

 const installerName=`SkyrimRPLauncher-${pkg.version}-x64-local.exe`;
 if(latest.path!==installerName||!Array.isArray(latest.files)||latest.files.length!==1){
  throw Error('latest.yml must name the pinned NSIS installer filename exactly once');
 }

 const installerMetadata=latest.files[0];
 if(!installerMetadata||installerMetadata.url!==installerName){
  throw Error('latest.yml file URL does not match the pinned NSIS installer filename');
 }
 if(typeof installerMetadata.size!=='number'||!Number.isSafeInteger(installerMetadata.size)||installerMetadata.size<0){
  throw Error('Invalid installer size in latest.yml');
 }

 const installerPath=path.join(releaseDir,installerName);
 const installerStat=await fs.lstat(installerPath);
 if(!installerStat.isFile()||installerStat.isSymbolicLink()||installerStat.nlink!==1){
  throw Error('NSIS installer must be a regular file without links');
 }
 if(installerStat.size===0){
  throw Error('NSIS installer must not be empty');
 }
 if(installerMetadata.size!==installerStat.size){
  throw Error('latest.yml installer size does not match local installer');
 }

 const digest=createHash('sha512');
 let bytesRead=0;
 for await(const chunk of createReadStream(installerPath)){
  digest.update(chunk);
  bytesRead+=chunk.length;
 }
 if(bytesRead!==installerStat.size){
  throw Error('NSIS installer changed while it was being verified');
 }
 const actualSha512=digest.digest('base64');
 if(installerMetadata.sha512!==actualSha512||latest.sha512!==actualSha512){
  throw Error('latest.yml installer SHA-512 does not match local installer');
 }
 console.log('NSIS installer/latest.yml/app-update.yml verified; publisher trust is a separate gate.');
}

verifyArtifacts().catch(error=>{
 console.error(error instanceof Error?error.message:String(error));
 process.exitCode=1;
});
