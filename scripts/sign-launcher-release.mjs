// Offline signing and verification of Launcher NSIS release update manifest (frostveil-launcher-update.json).
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createPrivateKey,createPublicKey,createHash} from 'node:crypto';
import {build} from 'esbuild';

const root=path.resolve('.');
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const version=pkg.version;
const installerName=`SkyrimRPLauncher-${version}-x64-local.exe`;
const installerPath=path.join(root,'release',installerName);
const outDir=path.join(root,'.local','production-candidates',`launcher-v${version}`);
const signingDir=path.join(os.homedir(),'.codex','frostveil-signing','production-candidates-20261016');

await build({
 stdin:{
  contents:`
   export {
    LAUNCHER_MANIFEST_ASSET,
    validateLauncherUpdateManifest,
    signLauncherUpdateManifest,
    authenticateLauncherUpdate,
    verifyDownloadedInstaller
   } from './src/main/update-integrity';
  `,
  resolveDir:root
 },
 outfile:'.local/sign-launcher-release-core.cjs',
 bundle:true,
 platform:'node',
 format:'cjs',
 packages:'external'
});
const core=createRequire(import.meta.url)('../.local/sign-launcher-release-core.cjs');

const privatePem=await fs.readFile(path.join(signingDir,'launcher-update-private.pem'),'utf8');
const privateKey=createPrivateKey(privatePem);
const publicKey=createPublicKey(privateKey);
const publicKeyPem=publicKey.export({type:'spki',format:'pem'}).toString();
const fingerprint=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');

const installerBytes=await fs.readFile(installerPath);
const sha512=createHash('sha512').update(installerBytes).digest('base64');
const sha256=createHash('sha256').update(installerBytes).digest('hex');
const nowMs=Date.now();
const publishedAt=new Date(nowMs).toISOString();
const expiresAt='2027-10-16T00:00:00.000Z';
const keyId='frostveil-launcher-update-20261016';

const manifest=core.validateLauncherUpdateManifest({
 schemaVersion:1,
 keyId,
 owner:'kaktv2016',
 repo:'frostveil-launcher',
 tag:`v${version}`,
 version,
 channel:'stable',
 minimumLauncherVersion:'0.1.5',
 publishedAt,
 expiresAt,
 releaseNotes:`Frostveil Launcher v${version} — Ed25519-authenticated auto-update and server Modpack delivery.`,
 installer:{
  assetId:2001,
  assetName:installerName,
  size:installerBytes.length,
  sha512,
  sha256
 }
});

const envelope=core.signLauncherUpdateManifest(manifest,privateKey);
const envelopeBytes=Buffer.from(JSON.stringify(envelope,null,2)+'\n','utf8');
const envelopeSha256=createHash('sha256').update(envelopeBytes).digest('hex');

const simulatedRelease={
 id:800100,
 tag_name:`v${version}`,
 draft:false,
 prerelease:false,
 published_at:publishedAt,
 body:manifest.releaseNotes,
 assets:[
  {
   id:2001,
   name:installerName,
   size:installerBytes.length,
   state:'uploaded',
   digest:'sha256:'+sha256
  },
  {
   id:2002,
   name:core.LAUNCHER_MANIFEST_ASSET,
   size:envelopeBytes.length,
   state:'uploaded',
   digest:'sha256:'+envelopeSha256
  }
 ]
};

const candidateSource={
 mode:'production',
 owner:'kaktv2016',
 repo:'frostveil-launcher',
 channel:'stable',
 keys:{
  [keyId]:{
   publicKey:publicKeyPem,
   environment:'production',
   revoked:false,
   expiresAt
  }
 }
};

const authenticated=core.authenticateLauncherUpdate(envelope,candidateSource,simulatedRelease,'0.1.5');
await core.verifyDownloadedInstaller(installerPath,sha512,[],undefined,{
 envelope,
 source:candidateSource,
 release:simulatedRelease,
 installedVersion:'0.1.5'
});

await fs.mkdir(outDir,{recursive:true});
await fs.writeFile(path.join(outDir,core.LAUNCHER_MANIFEST_ASSET),envelopeBytes);
await fs.writeFile(path.join(outDir,'unsigned-launcher-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await fs.writeFile(path.join(outDir,'release-metadata-template.json'),JSON.stringify(simulatedRelease,null,2)+'\n');
await fs.writeFile(path.join(outDir,'verification-summary.json'),JSON.stringify({
 version,
 tag:`v${version}`,
 keyId,
 fingerprint,
 manifestHash:authenticated.manifestHash,
 installer:{
  assetName:installerName,
  size:installerBytes.length,
  sha256,
  sha512
 },
 publication:'NOT AUTHORIZED — LOCAL PREPARATION ONLY'
},null,2)+'\n');

console.log(JSON.stringify({
 version,
 tag:`v${version}`,
 keyId,
 fingerprint,
 manifestHash:authenticated.manifestHash,
 installerName,
 size:installerBytes.length,
 sha256,
 sha512
},null,2));
