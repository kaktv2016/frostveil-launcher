import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {extractFile} from '@electron/asar';
import {verifyW14UpdateAcl} from '../src/main/windows.ts';
import {admitPackagedCachePolicy} from '../src/main/runtime/cache-policy.ts';
import {assertProductionTrust} from './production-trust-audit.mjs';

export const W14_PRIVATE_ROOT=path.win32.join(os.homedir(),'AppData','Local','FrostveilWorkflow','private-candidates','launcher-v2-p0');
const VERSION=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const execute=promisify(execFile);

export function validateFolderPin(value){
 if(typeof value!=='string'||!/^[A-Za-z]:\\[^<>:"|?*\x00-\x1f]+$/.test(value)||/\//.test(value))
  throw Error('W14 update folder must be an absolute local drive path');
 const normalized=path.win32.normalize(value);
 if(normalized!==value||value.split('\\').some(part=>part==='.'||part==='..'||/[ .]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)))
  throw Error('W14 update folder must use canonical Windows path syntax');
 return normalized;
}

export function createW14PilotPlan({repo,privateRoot=W14_PRIVATE_ROOT,release,version,updateFolder,outputDir,
 cachePolicyRevision,cachePolicyFile,outputExists=false}){
 if(!['prior','candidate'].includes(release))throw Error('W14 release must be prior or candidate');
 if(typeof version!=='string'||!VERSION.test(version))throw Error('W14 package version must be an explicit stable x.y.z version');
 const folder=validateFolderPin(updateFolder);
 const root=validateFolderPin(privateRoot),output=validateFolderPin(outputDir??path.win32.join(root,`w14-${release}-${version}`));
 const rootPrefix=root.endsWith('\\')?root:root+'\\';
 if(!output.toLowerCase().startsWith(rootPrefix.toLowerCase()))throw Error('W14 output must be under the approved private output root');
 if(outputExists)throw Error('W14 output directory already exists; choose a new path to preserve prior artifacts');
 if((cachePolicyRevision===undefined)!==(cachePolicyFile===undefined)||release==='candidate'&&cachePolicyFile===undefined)
  throw Error('Both cache policy revision and file are required for a W14 candidate');
 if(cachePolicyRevision!==undefined&&(!Number.isSafeInteger(cachePolicyRevision)||cachePolicyRevision<1))
  throw Error('W14 cache policy arguments are invalid');
 const buildCommand=['node','scripts/build.mjs',`--w14-update-folder=${folder}`];
 if(cachePolicyRevision!==undefined)buildCommand.push(`--p0-cache-policy-revision=${cachePolicyRevision}`,`--p0-cache-policy-file=${validateFolderPin(cachePolicyFile)}`);
 const artifactName=`FrostveilLauncher-W14Pilot-${version}-x64.exe`;
 const packageCommand=['node','node_modules/electron-builder/cli.js','--win','nsis','--x64','--publish','never',
  `-c.appId=dev.skyrimrp.launcher.w14-pilot`,`-c.productName=Frostveil Launcher W14 Pilot`,
  `-c.directories.output=${output}`,`-c.extraMetadata.version=${version}`,`-c.win.artifactName=${artifactName}`];
 return {repo,privateRoot:root,release,version,updateFolder:folder,outputDir:output,artifactName,buildCommand,packageCommand};
}

async function assertSafeOutput(plan){
 const root=await fs.realpath(plan.privateRoot);
 if(path.win32.resolve(root).toLowerCase()!==plan.privateRoot.toLowerCase())throw Error('Approved W14 private root resolves through a link or alias');
 if(!await verifyW14UpdateAcl(root,root,root))throw Error('W14 private output parent must have a protected ACL');
 const relative=path.win32.relative(root,plan.outputDir);
 if(!relative||relative==='..'||relative.includes('\\')||path.win32.isAbsolute(relative))throw Error('W14 output must be a new direct child of the private output root');
}

function run(executable,args,cwd,env=process.env){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd,env,stdio:'inherit',shell:false,windowsHide:true});
  child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(Error(`${path.basename(executable)} failed (code=${code}, signal=${signal})`)));
 });
}

async function hashFile(file){
 const before=await fs.lstat(file,{bigint:true});
 if(!before.isFile()||before.nlink!==1n||before.size<2n||before.size>300n*1024n*1024n)throw Error('Unexpected W14 NSIS artifact');
 const sha256=createHash('sha256'),sha512=createHash('sha512');let bytes=0;
 const handle=await fs.open(file,'r');
 try{
  const opened=await handle.stat({bigint:true});
  if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.nlink!==1n)throw Error('W14 installer changed at open');
  for await(const chunk of handle.createReadStream({autoClose:false})){
   bytes+=chunk.length;
   if(BigInt(bytes)>before.size)throw Error('W14 installer grew while hashing');
   sha256.update(chunk);sha512.update(chunk);
  }
  const after=await handle.stat({bigint:true});
  if(BigInt(bytes)!==before.size||after.ctimeNs!==before.ctimeNs||after.mtimeNs!==before.mtimeNs||after.nlink!==1n)throw Error('W14 installer changed while hashing');
 }finally{await handle.close();}
 return {sha256:sha256.digest('hex'),sha512:sha512.digest('base64'),bytes};
}

async function requireUnsignedInstaller(file){
 const powershell=path.win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const {stdout}=await execute(powershell,['-NoProfile','-NonInteractive','-Command',
  '$ErrorActionPreference="Stop"; $signature=Get-AuthenticodeSignature -LiteralPath $env:FROSTVEIL_W14_INSTALLER; [string]$signature.Status'],{
  env:{...process.env,FROSTVEIL_W14_INSTALLER:file},windowsHide:true,timeout:15000,maxBuffer:16384});
 const status=stdout.trim();
 if(status!=='NotSigned')throw Error('W14 offline packaging requires confirmed NotSigned Authenticode status');
 return status;
}

async function gitSnapshot(repo){
 const runGit=args=>new Promise((resolve,reject)=>{
  const child=spawn('git',args,{cwd:repo,stdio:['ignore','pipe','inherit'],shell:false,windowsHide:true});
  let value='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>value+=chunk);
  child.once('error',reject);child.once('exit',code=>code===0?resolve(value.trim()):reject(Error(`git ${args[0]} failed`)));
 });
 return {commit:await runGit(['rev-parse','HEAD']),clean:(await runGit(['status','--porcelain'])).length===0};
}

async function main(argv){
 const options=Object.create(null);
 for(const arg of argv){const match=/^--([a-z-]+)=(.*)$/.exec(arg);if(!match||Object.hasOwn(options,match[1]))throw Error(`Invalid or duplicate argument: ${arg}`);options[match[1]]=match[2];}
 const allowed=new Set(['release','version','update-folder','output-parent','output','cache-policy-revision','cache-policy-file','dry-run']);
 for(const key of Object.keys(options))if(!allowed.has(key))throw Error(`Unknown argument: --${key}`);
 for(const key of ['release','version','update-folder'])if(!options[key])throw Error(`Missing required argument: --${key}=...`);
 if(process.platform!=='win32')throw Error('W14 NSIS packaging requires Windows');
 const repo=process.cwd(),privateRoot=options['output-parent']??W14_PRIVATE_ROOT;
 const policyRevision=options['cache-policy-revision']===undefined?undefined:Number(options['cache-policy-revision']);
 const plan=createW14PilotPlan({repo,privateRoot,release:options.release,version:options.version,updateFolder:options['update-folder'],outputDir:options.output,
  cachePolicyRevision:policyRevision,cachePolicyFile:options['cache-policy-file']});
 await assertSafeOutput(plan);
 if(options['dry-run']==='true'){process.stdout.write(JSON.stringify(plan,null,2)+'\n');return;}
 if(options['dry-run']!==undefined)throw Error('--dry-run accepts only true');
 const source=await gitSnapshot(repo);
 if(!source.clean)throw Error('W14 package evidence requires a clean source worktree');
 let cachePolicySha256;
 if(options['cache-policy-file']){
  const file=options['cache-policy-file'],stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>65536||
     (await fs.realpath(file)).toLowerCase()!==file.toLowerCase())throw Error('Unsafe W14 cache policy input');
  const bytes=await fs.readFile(file,'utf8');
  cachePolicySha256=createHash('sha256').update(bytes).digest('hex');
  const {scopeId,profileId,cohortDigest}=JSON.parse(bytes);
  admitPackagedCachePolicy({required:true,revision:policyRevision,bytes,sha256:cachePolicySha256},{scopeId,profileId,cohortDigest});
 }
 await fs.mkdir(plan.outputDir);
 const buildArgs=plan.buildCommand.slice(1);
 await run(process.execPath,buildArgs,repo);
 const main=await fs.readFile(path.join(repo,'dist','main.cjs'));
 const text=main.toString('utf8');
 assertProductionTrust(text);
 if(!text.includes(JSON.stringify(plan.updateFolder))||text.includes('FROSTVEIL_W14_UPDATE_TEST')||
    (cachePolicySha256&&!text.includes(JSON.stringify(cachePolicySha256))))throw Error('W14 compiled folder or cache policy pin mismatch');
 const artifact=path.join(plan.outputDir,plan.artifactName);
 const buildEnv={...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'};
 for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD'])delete buildEnv[key];
 await run(process.execPath,plan.packageCommand.slice(1),repo,buildEnv);
 const builtFrom=await gitSnapshot(repo);
 if(!builtFrom.clean||builtFrom.commit!==source.commit)throw Error('W14 source changed while packaging');
 const asar=path.join(plan.outputDir,'win-unpacked','resources','app.asar');
 if(!extractFile(asar,'dist/main.cjs').equals(main)||JSON.parse(extractFile(asar,'package.json').toString('utf8')).version!==plan.version)
  throw Error('W14 packaged main bundle or version mismatch');
 if(!await verifyW14UpdateAcl(plan.privateRoot,plan.outputDir,artifact))throw Error('W14 output ACL changed while packaging');
 const authenticodeStatus=await requireUnsignedInstaller(artifact);
 const identity=await hashFile(artifact);
 const receipt={schemaVersion:1,kind:'frostveil-w14-pilot-package',release:plan.release,version:plan.version,architecture:'x64',target:'nsis',
  publish:'never',appId:'dev.skyrimrp.launcher.w14-pilot',productName:'Frostveil Launcher W14 Pilot',updateFolder:plan.updateFolder,
  qualification:'NOT_RUN',sourceCommit:source.commit,sourceClean:source.clean,cachePolicyRevision:policyRevision,cachePolicySha256,
  mainSha256:createHash('sha256').update(main).digest('hex'),artifact:{name:plan.artifactName,authenticodeStatus,...identity},createdAt:new Date().toISOString()};
 const receiptPath=path.join(plan.outputDir,`w14-package-receipt-${plan.release}-${plan.version}.json`);
 await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 process.stdout.write(JSON.stringify({receiptPath,...receipt},null,2)+'\n');
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve('scripts/package-w14-pilot.mjs'))
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
