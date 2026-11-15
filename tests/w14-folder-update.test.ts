import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test,{type TestContext} from 'node:test';
import {restrictFixtureFeed} from './helpers/restricted-update-folder';
import {FolderLauncherUpdateTransport} from '../src/main/update-folder';
import {NsisEngine} from '../src/main/updater-engine';
import {
 LAUNCHER_MANIFEST_ASSET,authenticateLauncherUpdate,productionLauncherUpdateSource,
 signLauncherUpdateManifest,w14PilotLauncherUpdateSource,type LauncherUpdateManifest,type LauncherUpdateSource
} from '../src/main/update-integrity';

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t:TestContext){
 const temp=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'w14-update-folder-'));
 t.after(async()=>{
  assert.equal(path.dirname(await fs.realpath(root)),temp);
  await fs.rm(root,{recursive:true,force:true});
 });
 const feed=path.join(root,'feed'),assets=path.join(feed,'assets'),storageDir=path.join(root,'launcher');
 await fs.mkdir(feed);
 await restrictFixtureFeed(feed,root);
 await fs.mkdir(assets);
 const key=generateKeyPairSync('ed25519');
 const keyId='w14-folder-fixture';
 const now=Date.now(),publishedAt=new Date(now-1000).toISOString(),expiresAt=new Date(now+60000).toISOString();
 const source:LauncherUpdateSource={...w14PilotLauncherUpdateSource,mode:'disposable-test',keys:{[keyId]:{
  environment:'test',publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString(),expiresAt,revoked:false
 }}};
 const bytes=Buffer.from('MZ inert W14 installer');
 const manifest:LauncherUpdateManifest={schemaVersion:1,keyId,owner:source.owner,repo:source.repo,tag:'v0.2.0',version:'0.2.0',
  channel:'w14-pilot',releaseId:201,minimumLauncherVersion:'0.1.0',publishedAt,expiresAt,releaseNotes:'W14 fixture',
  installer:{assetId:202,assetName:'W14-0.2.0.exe',size:bytes.length,sha256:digest(bytes),
   sha512:createHash('sha512').update(bytes).digest('base64')}};
 const envelope=signLauncherUpdateManifest(manifest,key.privateKey),signed=Buffer.from(JSON.stringify(envelope));
 const release={id:201,tag_name:manifest.tag,draft:false,prerelease:false,published_at:publishedAt,body:'',assets:[
  {id:202,name:manifest.installer.assetName,size:bytes.length,state:'uploaded',digest:'sha256:'+digest(bytes)},
  {id:203,name:LAUNCHER_MANIFEST_ASSET,size:signed.length,state:'uploaded',digest:'sha256:'+digest(signed)}
 ]};
 const latest=path.join(feed,'latest.json');
 const writeLatest=()=>fs.writeFile(latest,JSON.stringify(release));
 await writeLatest();
 await fs.writeFile(path.join(assets,'202'),bytes);
 await fs.writeFile(path.join(assets,'203'),signed);
 const transport=new FolderLauncherUpdateTransport(feed);
 const engine=new NsisEngine([],{source,transport,storageDir,installedVersion:'0.1.0',now:()=>now});
 return {root,feed,assets,storageDir,source,manifest,release,envelope,signed,bytes,engine,transport,writeLatest,now};
}

test('W14 reads and verifies a folder update without fetching over HTTP',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw Error('Network must not be used');});
 const f=await fixture(t);
 assert.equal((await f.engine.check()).version,'0.2.0');
 await f.engine.download();
 assert.deepEqual(await fs.readFile(f.engine.getVerifiedFilePath()!),f.bytes);
 const ledger=JSON.parse(await fs.readFile(path.join(f.storageDir,'launcher-update-history-w14-pilot.json'),'utf8'));
 assert.equal(ledger.channel,'w14-pilot');
 await assert.rejects(fs.stat(path.join(f.storageDir,'launcher-update-history.json')),{code:'ENOENT'});
});

test('W14 signs the release identity and accepts the same key only in its own channel',async t=>{
 const f=await fixture(t);
 assert.equal(w14PilotLauncherUpdateSource.keys,productionLauncherUpdateSource.keys);
 assert.throws(()=>authenticateLauncherUpdate(f.envelope,{...f.source,channel:'stable'},f.release,'0.1.0'),/identity mismatch/i);
 f.release.id++;
 await f.writeLatest();
 await assert.rejects(f.engine.check(),/release.*identity|release.*manifest/i);
});

test('W14 refuses replaced manifest or installer bytes',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.assets,'203'),Buffer.alloc(f.signed.length,0x20));
 await assert.rejects(f.engine.check(),/digest|hash/i);
 await fs.writeFile(path.join(f.assets,'203'),f.signed);
 await f.engine.check();
 await fs.writeFile(path.join(f.assets,'202'),Buffer.alloc(f.bytes.length,0x20));
 await assert.rejects(f.engine.download(),/checksum/i);
 assert.equal(f.engine.getVerifiedFilePath(),undefined);
});

test('W14 accepts only canonical local roots and refuses hard-linked assets',async t=>{
 const f=await fixture(t);
 assert.throws(()=>new FolderLauncherUpdateTransport('\\\\host\\share\\feed'),/local/i);
 assert.throws(()=>new FolderLauncherUpdateTransport(f.root+'\\..\\feed'),/unsafe/i);
 await f.engine.check();
 await fs.link(path.join(f.assets,'202'),path.join(f.root,'alias'));
 await assert.rejects(f.engine.download(),/private update folder|linked/i);
});

test('W14 refuses junctions in the asset path and a signed downgrade',async t=>{
 const f=await fixture(t);
 const newer=new NsisEngine([],{source:f.source,transport:f.transport,storageDir:f.storageDir,installedVersion:'0.3.0',now:()=>f.now});
 await assert.rejects(newer.check(),/downgrade/i);
 const linkedRoot=path.join(f.root,'other-feed');
 await fs.mkdir(linkedRoot);
 await restrictFixtureFeed(linkedRoot,f.root);
 await fs.writeFile(path.join(linkedRoot,'latest.json'),JSON.stringify(f.release));
 const junction=path.join(linkedRoot,'assets');
 await fs.symlink(f.assets,junction,'junction');
 try{
  const linkedFeed=new FolderLauncherUpdateTransport(linkedRoot);
  const engine=new NsisEngine([],{source:f.source,transport:linkedFeed,storageDir:f.storageDir,installedVersion:'0.1.0',now:()=>f.now});
  await assert.rejects(engine.check(),/unsafe or inaccessible/i);
 }finally{await fs.unlink(junction);}
});

test('W14 rejects a folder whose ACL still inherits from its parent',async t=>{
 const f=await fixture(t);
 const unprotected=path.join(f.root,'inherited');
 await fs.mkdir(unprotected);
 await fs.writeFile(path.join(unprotected,'latest.json'),JSON.stringify(f.release));
 await assert.rejects(new FolderLauncherUpdateTransport(unprotected).json('/releases/latest'),/folder permissions/i);
});
