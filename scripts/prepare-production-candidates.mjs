// Offline candidate preparation only. Does not modify productionSource/productionLauncherUpdateSource or publish to GitHub.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {generateKeyPairSync,createPrivateKey,createPublicKey,createHash,sign,verify} from 'node:crypto';
import {build} from 'esbuild';

const root=path.resolve('.');
const outDir=path.join(root,'.local','production-candidates');
const modpackOutDir=path.join(outDir,'modpack-pack-v1.0.0');
const signingDir=path.join(os.homedir(),'.codex','frostveil-signing','production-candidates-20261016');

if(signingDir.startsWith(root+path.sep)){
 throw Error('Private signing directory must remain outside repository workspace');
}

await fs.mkdir(signingDir,{recursive:true});
const icacls=spawnSync('icacls',[
 signingDir,
 '/inheritance:r',
 '/grant:r',
 'NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
 `${os.userInfo().username}:(OI)(CI)(F)`
],{encoding:'utf8',windowsHide:true});
if(icacls.status!==0){
 throw Error('Failed to apply restrictive ACL to signing directory: '+(icacls.stderr||icacls.stdout));
}

await build({
 stdin:{
  contents:`
   export {prepareRelease} from './src/main/distribution/prepare';
   export {authenticateRelease} from './src/main/distribution/policy';
   export {validateLauncherUpdateManifest,signLauncherUpdateManifest,authenticateLauncherUpdate} from './src/main/update-integrity';
  `,
  resolveDir:root
 },
 outfile:'.local/production-candidates-core.cjs',
 bundle:true,
 platform:'node',
 format:'cjs',
 packages:'external'
});
const core=createRequire(import.meta.url)('../.local/production-candidates-core.cjs');

async function loadOrCreateEd25519Key(filename){
 const file=path.join(signingDir,filename);
 try{
  const existing=await fs.readFile(file,'utf8');
  const priv=createPrivateKey(existing);
  const pub=createPublicKey(priv);
  return{
   privateKey:priv,
   publicKeyPem:pub.export({type:'spki',format:'pem'}).toString(),
   fingerprint:createHash('sha256').update(pub.export({type:'spki',format:'der'})).digest('hex')
  };
 }catch(error){
  if(error.code!=='ENOENT')throw error;
  const pair=generateKeyPairSync('ed25519');
  const pem=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  await fs.writeFile(file,pem,{flag:'wx',mode:0o600});
  const pub=createPublicKey(pair.privateKey);
  return{
   privateKey:pair.privateKey,
   publicKeyPem:pub.export({type:'spki',format:'pem'}).toString(),
   fingerprint:createHash('sha256').update(pub.export({type:'spki',format:'der'})).digest('hex')
  };
 }
}

const launcherKeyId='frostveil-launcher-update-20261016';
const modpackKeyId='frostveil-modpack-publisher-20261016';
const expiresAt='2027-10-16T00:00:00.000Z';

const launcherKey=await loadOrCreateEd25519Key('launcher-update-private.pem');
const modpackKey=await loadOrCreateEd25519Key('modpack-publisher-private.pem');

if(launcherKey.fingerprint===modpackKey.fingerprint){
 throw Error('Launcher Update and Modpack Publisher keys must be cryptographically distinct');
}
if([launcherKey.fingerprint,modpackKey.fingerprint].includes('c9d19a50b06f2d55c5e9a31c6ba85b947c021581faa56c44231679223ce31391')){
 throw Error('Production candidate keys must never reuse the Level B test identity');
}

// Verify offline key possession for both keys
for(const [id,k] of [[launcherKeyId,launcherKey],[modpackKeyId,modpackKey]]){
 const msg=Buffer.from(`FROSTVEIL PRODUCTION CANDIDATE KEY CHECK:${id}:${k.fingerprint}`);
 const sig=sign(null,msg,k.privateKey);
 if(!verify(null,msg,createPublicKey(k.publicKeyPem),sig)){
  throw Error('Offline Ed25519 verification failed for '+id);
 }
}

await fs.mkdir(modpackOutDir,{recursive:true});
const sourceAssetsDir=path.join(modpackOutDir,'source-assets');
const releaseAssetsDir=path.join(modpackOutDir,'release-assets');
await fs.mkdir(sourceAssetsDir,{recursive:true});
await fs.mkdir(releaseAssetsDir,{recursive:true});

const ownedPayloads=[
 {
  targetPath:'Data/Frostveil/settings.json',
  assetName:'frostveil-client-settings.json',
  componentId:'frostveil-rp-core',
  role:'configuration',
  assetId:1001,
  content:JSON.stringify({
   schemaVersion:1,
   packId:'frostveil',
   packVersion:'1.0.0',
   server:'Skyrim RP (SkyMP Phase 2.5)',
   runtime:'1.6.1170.0',
   skse:'0.2.2.6',
   features:['identity-whisper','medical-system','law-enforcement','economy-handover','emotes-animations','3d-labels']
  },null,2)+'\n'
 },
 {
  targetPath:'Data/Frostveil/readme.txt',
  assetName:'frostveil-client-readme.txt',
  componentId:'frostveil-rp-core',
  role:'configuration',
  assetId:1002,
  content:[
   'FROSTVEIL ROLEPLAY — CLIENT MODPACK v1.0.0',
   '=========================================',
   'Managed by Frostveil Launcher. Do not edit managed files manually.',
   '',
   'Core Roleplay Commands:',
   '  /say, /s, /w, /b, /me, /do, /r, /G, /dep, /gov',
   '  /name <Alias>, /desc <Appearance>, /clear_desc',
   '  /med, /revive <id>, /heal <id>, /bleedout',
   '  /cuff <id>, /search <id>, /fine <id> <gold> <reason>, /jail <id> <sec> <cell>',
   '  /use <item>, /give <id> <item> <count>, /pay <id> <gold>',
   '  /anim <preset>, /stopanim',
   ''
  ].join('\r\n')
 },
 {
  targetPath:'Data/Interface/Frostveil/hud-reference.html',
  assetName:'frostveil-hud-reference.html',
  componentId:'frostveil-rp-ui',
  role:'visual',
  assetId:1003,
  content:[
   '<!doctype html>',
   '<html lang="th">',
   '<head><meta charset="utf-8"><title>Frostveil RP Reference</title></head>',
   '<body data-pack="frostveil" data-version="1.0.0">',
   '<h1>Frostveil Roleplay HUD Reference (v1.0.0)</h1>',
   '<p>F2: Toggle Cursor | F6: Hide/Show Chat | Enter: Focus Chat</p>',
   '</body>',
   '</html>',
   ''
  ].join('\n')
 }
];

const sourceMapping={};
const allowedFiles=[];
const releaseAssetsMeta=[];

for(const item of ownedPayloads){
 const bytes=Buffer.from(item.content,'utf8');
 const sha256=createHash('sha256').update(bytes).digest('hex');
 await fs.writeFile(path.join(sourceAssetsDir,item.assetName),bytes);
 sourceMapping[item.assetName]=item.assetName;
 allowedFiles.push({
  path:item.targetPath,
  size:bytes.length,
  sha256,
  componentId:item.componentId,
  role:item.role,
  required:true,
  ownership:'custom-rp',
  permission:'Original first-party Frostveil RP asset; redistribution authorized',
  distribution:'allowed',
  package:{
   owner:'kaktv2016',
   repo:'frostveil-distribution',
   tag:'pack-v1.0.0',
   assetId:item.assetId,
   assetName:item.assetName,
   size:bytes.length,
   sha256,
   componentId:item.componentId,
   packVersion:'1.0.0',
   rights:{
    kind:'owned',
    evidence:'First-party Frostveil client configuration and UI reference created in frostveil-launcher',
    scope:'redistribution',
    reviewer:'frostveil-owner'
   }
  }
 });
 releaseAssetsMeta.push({
  id:item.assetId,
  name:item.assetName,
  size:bytes.length,
  state:'uploaded',
  digest:'sha256:'+sha256
 });
}

const devProfile=JSON.parse(await fs.readFile(path.join(root,'.local','modpack-development.json'),'utf8'));
const nowMs=Date.now();
const nowIso=new Date(nowMs).toISOString();
const serverExpiresIso=new Date(nowMs+7*86400000).toISOString();

const candidateManifest={
 schemaVersion:1,
 packId:'frostveil',
 packVersion:'1.0.0',
 channel:'stable',
 generatedAt:nowIso,
 minimumLauncherVersion:'0.1.6',
 requiredSkyrimRuntime:devProfile.manifest.requiredSkyrimRuntime,
 requiredSKSEVersion:devProfile.manifest.requiredSKSEVersion,
 requiredSkyMPClientVersion:devProfile.manifest.requiredSkyMPClientVersion,
 serverProfileId:'frostveil-production-server',
 serverProfileVersion:'1.0.0',
 components:[
  ...devProfile.manifest.components,
  {
   id:'frostveil-rp-core',
   name:'Frostveil Roleplay Core Client Reference & Metadata',
   category:'developer-owned',
   required:true,
   dependencies:['client']
  },
  {
   id:'frostveil-rp-ui',
   name:'Frostveil Roleplay Interface Reference Overlay',
   category:'developer-owned',
   required:true,
   dependencies:['frostveil-rp-core']
  }
 ],
 files:[
  ...devProfile.manifest.files,
  ...allowedFiles
 ],
 requiredPlugins:devProfile.manifest.requiredPlugins,
 distribution:{
  source:'signed-release',
  release:{
   owner:'kaktv2016',
   repo:'frostveil-distribution',
   tag:'pack-v1.0.0'
  }
 },
 signing:{
  algorithm:'Ed25519',
  keyId:modpackKeyId
 },
 skyMPClientRequirements:devProfile.manifest.skyMPClientRequirements
};

const candidateServer={
 ...devProfile.server,
 id:'frostveil-production-server',
 version:'1.0.0',
 packId:'frostveil',
 packVersion:'1.0.0',
 generatedAt:nowIso,
 expiresAt:serverExpiresIso,
 limitations:[
  'Creation Club light plugins (.esl / FE-flagged .esp) present in Skyrim.ccc are treated as implicit local masters; SkyMP server only loads the 5 official Bethesda .esm masters.'
 ]
};

const candidateModpackSource={
 mode:'production',
 contentPolicy:'skyrim-mod-content',
 packId:'frostveil',
 channel:'stable',
 keys:{
  [modpackKeyId]:{
   publicKey:modpackKey.publicKeyPem,
   environment:'production',
   revoked:false,
   expiresAt
  }
 },
 permittedReviews:[]
};

const candidateReleaseMeta={
 id:900100,
 tag_name:'pack-v1.0.0',
 draft:false,
 prerelease:false,
 immutable:true,
 published_at:nowIso,
 body:'Frostveil Server Modpack v1.0.0 (Candidate — Pending Owner Authorization)',
 assets:releaseAssetsMeta
};

const preparedModpack=await core.prepareRelease(
 candidateManifest,
 candidateServer,
 sourceAssetsDir,
 sourceMapping,
 modpackKey.privateKey,
 candidateModpackSource,
 candidateReleaseMeta
);

for(const asset of preparedModpack.assets){
 await fs.writeFile(path.join(releaseAssetsDir,asset.name),asset.bytes);
}
await fs.writeFile(
 path.join(releaseAssetsDir,'frostveil-manifest.json'),
 JSON.stringify(preparedModpack.envelope,null,2)+'\n'
);

const classification={
 generatedAt:nowIso,
 summary:{
  totalManifestFiles:candidateManifest.files.length,
  externalOnlyCount:devProfile.manifest.files.length,
  distributableOwnedCount:allowedFiles.length,
  thirdPartyRedistributedCount:0
 },
 categories:[
  {
   category:'official-bethesda-masters-and-executables',
   distribution:'external-only',
   files:['SkyrimSE.exe','Data/Skyrim.esm','Data/Update.esm','Data/Dawnguard.esm','Data/HearthFires.esm','Data/Dragonborn.esm'],
   rationale:'Proprietary Bethesda/Steam files; verified by SHA-256 and PE version in L1/L3, never redistributed or overwritten.'
  },
  {
   category:'skse-and-skymp-client-runtime',
   distribution:'external-only',
   files:devProfile.manifest.files.filter(f=>f.componentId!=='native').map(f=>f.path),
   rationale:'Existing L1 SKSE 2.2.6 and SkyMP/SkyrimPlatform runtime and UI baseline; verified by SHA-256, protected from Modpack overwrite.'
  },
  {
   category:'skymp-rp-gamemode-server-script',
   distribution:'server-only',
   files:['skymp/rp-gamemode/dist/server/gamemode.js'],
   rationale:'Runs on SkyMP server and synchronizes client events over SkyMP network transport; not installed into player Skyrim directory.'
  },
  {
   category:'frostveil-owned-client-modpack',
   distribution:'allowed',
   files:allowedFiles.map(f=>({path:f.path,assetName:f.package.assetName,size:f.size,sha256:f.sha256,rights:f.package.rights})),
   rationale:'First-party Frostveil RP client metadata, command guide, and HUD reference created in this project; safe to distribute and manage in Data/Frostveil and Data/Interface/Frostveil.'
  }
 ]
};

const candidateIdentitiesSummary={
 status:'PREPARED_NOT_ACTIVATED',
 privateKeyStorage:'%USERPROFILE%\\.codex\\frostveil-signing\\production-candidates-20261016',
 privateKeyAcl:'NT AUTHORITY\\SYSTEM:(OI)(CI)(F) and current user (OI)(CI)(F) only; inheritance removed',
 launcherUpdateChannel:{
  repository:'kaktv2016/frostveil-launcher',
  keyId:launcherKeyId,
  algorithm:'Ed25519',
  environment:'production',
  spkiSha256:launcherKey.fingerprint,
  publicKeyPem:launcherKey.publicKeyPem,
  expiresAt,
  revoked:false,
  pinnedInShippedCode:false
 },
 serverModpackChannel:{
  repository:'kaktv2016/frostveil-distribution',
  keyId:modpackKeyId,
  algorithm:'Ed25519',
  environment:'production',
  spkiSha256:modpackKey.fingerprint,
  publicKeyPem:modpackKey.publicKeyPem,
  expiresAt,
  revoked:false,
  pinnedInShippedCode:false
 }
};

await fs.writeFile(path.join(outDir,'candidate-identities.json'),JSON.stringify(candidateIdentitiesSummary,null,2)+'\n');
await fs.writeFile(path.join(modpackOutDir,'component-classification.json'),JSON.stringify(classification,null,2)+'\n');
await fs.writeFile(path.join(modpackOutDir,'unsigned-manifest-and-server.json'),JSON.stringify({manifest:candidateManifest,server:candidateServer},null,2)+'\n');
await fs.writeFile(path.join(modpackOutDir,'release-metadata-template.json'),JSON.stringify(candidateReleaseMeta,null,2)+'\n');
await fs.writeFile(path.join(modpackOutDir,'preparation-summary.json'),JSON.stringify(preparedModpack.summary,null,2)+'\n');

console.log(JSON.stringify({
 launcherUpdateKey:{keyId:launcherKeyId,fingerprint:launcherKey.fingerprint,expiresAt},
 modpackPublisherKey:{keyId:modpackKeyId,fingerprint:modpackKey.fingerprint,expiresAt},
 modpackCandidate:preparedModpack.summary
},null,2));
