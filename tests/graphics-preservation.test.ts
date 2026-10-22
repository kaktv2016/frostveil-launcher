import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {GraphicsPackService}from'../src/main/management/graphics-pack';
test('graphics verification never removes mods named in remote forbiddenPlugins',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'fv-preserve-'));try{await fs.mkdir(path.join(root,'Data'));const name='Lux Via.esp',file=path.join(root,'Data',name);await fs.writeFile(file,'existing mod');const s=new GraphicsPackService(root);await (s as any).verifyIntegrityFiles(root,{forbiddenPlugins:[name],integrityFiles:{}});assert.equal(await fs.readFile(file,'utf8'),'existing mod');}finally{await fs.rm(root,{recursive:true,force:true});}});
test('graphics activation preserves enabled player mods omitted by canonical manifest',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'fv-order-'));try{await fs.writeFile(path.join(root,'plugins.txt'),'# player\r\n*Lux Via.esp\r\n*Existing addon.esp\r\n*SkyUI_SE.esp\r\n');const s=new GraphicsPackService(root);await (s as any).activatePlugins({activePlugins:['Lux.esp'],masterPlugins:[],forbiddenPlugins:['Lux Via.esp']},root);const text=await fs.readFile(path.join(root,'plugins.txt'),'utf8');assert.match(text,/\*Lux Via\.esp/);assert.match(text,/\*Existing addon\.esp/);assert.equal((text.match(/\*SkyUI_SE\.esp/g)||[]).length,1);}finally{await fs.rm(root,{recursive:true,force:true});}});

test('nested FOMOD repair preserves source folders and existing normal textures',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'fv-nested-'));try{const source=path.join(root,'Data/textures/common/textures/EmbersHD/source.dds'),normal=path.join(root,'Data/textures/effects/HighFrequencyNormals.dds');await fs.mkdir(path.dirname(source),{recursive:true});await fs.mkdir(path.dirname(normal),{recursive:true});await fs.writeFile(source,'source');await fs.writeFile(normal,'existing normal');const s=new GraphicsPackService(root);await (s as any).repairNestedEmbersFolders(root);assert.equal(await fs.readFile(source,'utf8'),'source');assert.equal(await fs.readFile(normal,'utf8'),'existing normal');}finally{await fs.rm(root,{recursive:true,force:true});}});

test('old graphics patch cannot re-enforce a source-repaired mesh or bypass plugin verification',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fv-source-order-'));try{
  const s=new GraphicsPackService(root);await fs.mkdir(path.join(root,'Data/meshes'),{recursive:true});await fs.writeFile(path.join(root,'Data/meshes/light.nif'),'genuine new mesh');
  s.setSourceRepairTargets(['Data/meshes/light.nif']);
  const result=await (s as any).verifyIntegrityFiles(root,{integrityFiles:{'Data/meshes/light.nif':{size:3,sha256:'old'},'Data/Lux.esp':{size:1,sha256:'required'}}});
  assert.deepEqual(result,{valid:false,mismatched:['Data/Lux.esp']});
  assert.throws(()=>s.setSourceRepairTargets(['Data/Lux.esp']),/asset|target/i);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('only exact Frostveil navigation assets can delegate legacy integrity to the pinned Play recipe',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fv-nav-delegate-'));try{
  const s=new GraphicsPackService(root);s.setSourceRepairTargets(['Data/FrostveilCourierNavigation.esp','Data/Interface/Frostveil/CourierQuestTint.swf']);
  const result=await(s as any).verifyIntegrityFiles(root,{integrityFiles:{'Data/FrostveilCourierNavigation.esp':{size:1,sha256:'old'},'Data/Lux.esp':{size:1,sha256:'required'}}});
  assert.deepEqual(result,{valid:false,mismatched:['Data/Lux.esp']});
  for(const p of ['Data/Other.esp','Data/Interface/map.swf','Data/Interface/hudmenu.swf','SkyrimSE.exe'])assert.throws(()=>s.setSourceRepairTargets([p]),/asset|target/i);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
