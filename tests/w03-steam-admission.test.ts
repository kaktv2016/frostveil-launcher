import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {discoverSteam} from '../src/main/discovery';
import {assertSteamIdle,verifySteamRecoverySelection,verifySteamSelection} from '../src/main/runtime/steam';
import {canonicalTemporaryRoot} from '../src/main/temporary-root';

const gameName='Skyrim Special Edition';
const folderLink=process.platform==='win32'?'junction':'dir';
const acf=(overrides:Record<string,string>={})=>{
 const fields={appid:'489830',installdir:gameName,StateFlags:'4',...overrides};
 return '"AppState" { '+Object.entries(fields).map(([key,value])=>`"${key}" "${value}"`).join(' ')+' "UserConfig" { "language" "english" } }';
};

async function fixture(t:TestContext){
 const base=await canonicalTemporaryRoot();
 const root=await fs.realpath(await fs.mkdtemp(path.join(base,'fv-w03-admission-')));
 t.after(async()=>{
  assert.equal(await fs.realpath(root),root);
  assert.equal(path.dirname(root),base);
  assert.match(path.basename(root),/^fv-w03-admission-/);
  await fs.rm(root,{recursive:true,force:true});
 });
 const host=path.join(root,'Host');
 await fs.mkdir(path.join(host,'steamapps'),{recursive:true});
 const vdf=path.join(host,'steamapps','libraryfolders.vdf');
 const library=async(name:string,contents=acf())=>{
  const location=path.join(root,name),steamapps=path.join(location,'steamapps');
  const game=path.join(steamapps,'common',gameName);
  const manifest=path.join(steamapps,'appmanifest_489830.acf');
  await fs.mkdir(game,{recursive:true});
  await fs.writeFile(manifest,contents);
  return {location,game,manifest};
 };
 const libraries=(...locations:string[])=>fs.writeFile(vdf,'"libraryfolders" { '+locations.map((location,index)=>`"${index}" { "path" ${JSON.stringify(location)} }`).join(' ')+' }');
 return {root,host,vdf,library,libraries};
}

test('W03 admission counts only canonical, idle English Steam installations for auto-selection',async t=>{
 const f=await fixture(t);
 const valid=await f.library('Valid');
 const wrongApp=await f.library('WrongApp',acf({appid:'1946180'}));
 const wrongLanguage=await f.library('WrongLanguage',acf().replace('"english"','"french"'));
 const missingLanguage=await f.library('MissingLanguage',acf().replace(' "UserConfig" { "language" "english" }',''));
 const conflictingLanguage=await f.library('ConflictingLanguage',acf().replace(/ }$/, ' "MountedConfig" { "language" "french" } }'));
 const busy=await f.library('Busy',acf({StateFlags:'1024'}));
 const incomplete=await f.library('Incomplete',acf({BytesToDownload:'100',BytesDownloaded:'not-a-number'}));
 const damaged=await f.library('BadDirectory',acf({installdir:'Other/Skyrim'}));
 const duplicateApp=await f.library('DuplicateApp',acf().replace('"appid" "489830"','"appid" "489830" "appid" "489830"'));
 const spelling=f.root+path.sep+'.'+path.sep+'Valid';
 await f.libraries(wrongApp.location,wrongLanguage.location,missingLanguage.location,conflictingLanguage.location,busy.location,incomplete.location,damaged.location,duplicateApp.location,spelling,valid.location);
 assert.deepEqual(await discoverSteam([f.host],{requireIdle:true}),[valid.game]);
 await assert.rejects(verifySteamSelection(missingLanguage.game,[f.host]),/English/);
 await assert.rejects(verifySteamSelection(conflictingLanguage.game,[f.host]),/English/);
 const selected=await verifySteamSelection(valid.game,[f.host]);
 const second=await f.library('Second');
 await f.libraries(valid.location,second.location);
 assert.deepEqual(new Set(await discoverSteam([f.host],{requireIdle:true})),new Set([valid.game,second.game]));
 assert.equal((await verifySteamSelection(selected.game,[f.host])).game,valid.game);
 await assertSteamIdle(selected);
 await f.libraries(second.location);
 await assert.rejects(assertSteamIdle(selected),/library|Steam installation changed/i);
 await f.libraries(valid.location,second.location);
 await fs.writeFile(valid.manifest,acf().replace('"english"','"french"'));
 await assert.rejects(verifySteamSelection(selected.game,[f.host]),/English/);
 await assert.rejects(assertSteamIdle(selected),/English/);
 assert.deepEqual(await discoverSteam([f.host],{requireIdle:true}),[second.game]);
 await f.libraries(wrongApp.location,wrongLanguage.location,busy.location);
 assert.deepEqual(await discoverSteam([f.host],{requireIdle:true}),[]);
 await assert.rejects(verifySteamSelection(selected.game,[f.host]),/verified Steam Skyrim installation/i);
});

test('W03 Windows case aliases retain one canonical choice and accept explicit selection', {skip:process.platform!=='win32'}, async t=>{
 const f=await fixture(t);
 const valid=await f.library('Valid');
 const lower=path.join(f.root,'valid');
 if(!await fs.stat(lower).then(()=>true,error=>{
  if(error.code==='ENOENT')return false;
  throw error;
 }))return t.skip('The disposable filesystem is case-sensitive');
 await f.libraries(lower,valid.location);
 assert.deepEqual(await discoverSteam([f.host],{requireIdle:true}),[valid.game]);
 const picked=path.join(lower,'STEAMAPPS','COMMON',gameName.toLowerCase());
 assert.equal((await verifySteamSelection(picked,[f.host])).game,valid.game);
});

test('W03 admission refuses redirected libraries, game paths and Steam metadata',async t=>{
 const f=await fixture(t);
 const valid=await f.library('Valid');
 const linkedLibrary=path.join(f.root,'LinkedLibrary');
 await fs.symlink(valid.location,linkedLibrary,folderLink);
 const redirected=await f.library('Redirected');
 await fs.rmdir(redirected.game);
 await fs.symlink(valid.game,redirected.game,folderLink);
 const hardlinked=await f.library('Hardlinked');
 const detachedManifest=path.join(f.root,'detached.acf');
 await fs.rename(hardlinked.manifest,detachedManifest);
 await fs.link(detachedManifest,hardlinked.manifest);
 await f.libraries(linkedLibrary,redirected.location,hardlinked.location,valid.location);
 assert.deepEqual(await discoverSteam([f.host],{requireIdle:true}),[valid.game]);
 const canonical=await verifySteamSelection(valid.game,[f.host]);
 const alias=path.join(linkedLibrary,'steamapps','common',gameName);
 await assert.rejects(verifySteamSelection(alias,[f.host]),/redirected|verified Steam/i);
 await assert.rejects(verifySteamSelection(linkedLibrary+path.sep+'..'+path.sep+path.relative(f.root,valid.game),[f.host]),/parent|redirected|verified Steam/i);
 await assert.rejects(verifySteamSelection(redirected.game,[f.host]),/redirected|verified Steam/i);
 await assert.rejects(verifySteamSelection(hardlinked.game,[f.host]),/verified Steam|metadata/i);

 const redirectedHost=path.join(f.root,'RedirectedHost');
 await fs.mkdir(redirectedHost);
 await fs.symlink(path.dirname(f.vdf),path.join(redirectedHost,'steamapps'),folderLink);
 assert.deepEqual(await discoverSteam([redirectedHost],{requireIdle:true}),[]);

 await fs.rename(valid.manifest,path.join(f.root,'previous.acf'));
 await fs.writeFile(valid.manifest,Buffer.alloc(1024*1024+1));
 await assert.rejects(assertSteamIdle(canonical),/metadata/i);
 assert.deepEqual(await discoverSteam([f.host],{requireIdle:true}),[]);
});

test('W03 recovery tolerates missing legacy language metadata while new Steam admission remains strict',async t=>{
 const f=await fixture(t);
 const valid=await f.library('Legacy',acf().replace(' "UserConfig" { "language" "english" }',''));
 await assert.rejects(verifySteamSelection(valid.game,[valid.location]),/English/);
 assert.deepEqual(await discoverSteam([valid.location],{requireIdle:true}),[]);
 await assert.rejects(verifySteamSelection(valid.game,[f.host]),/registered library/);
 const recovery=await verifySteamRecoverySelection(valid.game);
 assert.match(await assertSteamIdle(recovery),/^[a-f0-9]{64}$/);
 await fs.writeFile(valid.manifest,acf().replace('"english"','"french"'));
 await assert.rejects(assertSteamIdle(recovery),/English/);
});

test('W03 admission refuses an ACF replaced after the original path was checked',async t=>{
 const f=await fixture(t);
 const valid=await f.library('Valid');
 const selected=await verifySteamSelection(valid.game,[valid.location]);
 const replacement=path.join(f.root,'replacement.acf');
 await fs.writeFile(replacement,acf());
 const open=fs.open;
 let changed=false;
 t.mock.method(fs,'open',async (...args:Parameters<typeof open>)=>{
  if(args[0]===valid.manifest&&!changed){
   changed=true;
   await fs.rename(valid.manifest,path.join(f.root,'prior.acf'));
   await fs.rename(replacement,valid.manifest);
  }
  return open(...args);
 });
 await assert.rejects(assertSteamIdle(selected),/metadata changed/i);
 assert.equal(changed,true);
});
