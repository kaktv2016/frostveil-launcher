// Synthetic metadata and inert bytes only. Never copy local installation evidence here.
export const nativeFixturePaths=['Data/SKSE/Plugins/MpClientPlugin.dll','Data/SKSE/Plugins/SkyrimPlatform.dll','Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll','Data/Platform/Plugins/skymp5-client.js','Data/SKSE/Plugins/versionlib-1-6-1170-0.bin'];
export function packFixture():any{return {
 schemaVersion:1,packId:'fixture-pack',packVersion:'1.0.0',channel:'stable',generatedAt:'2026-10-14T00:00:00.000Z',minimumLauncherVersion:'0.1.0',requiredSkyrimRuntime:'1.6.1170.0',requiredSKSEVersion:'0.2.2.6',requiredSkyMPClientVersion:'fixture-client',serverProfileId:'fixture-server',serverProfileVersion:'1.0.0',
 skyMPClientRequirements:{identity:'fixture-client',nativeFiles:nativeFixturePaths},
 components:[{id:'native',name:'Skyrim masters',category:'native',required:true,dependencies:[]},{id:'rp',name:'งานส่งจดหมาย',category:'developer-owned',required:true,dependencies:['native']},{id:'client',name:'Native client fixture',category:'skse-skymp',required:true,dependencies:['native']}],
 files:[{path:'Data/Skyrim.esm',size:0,sha256:'a'.repeat(64),componentId:'native',role:'native',required:true,ownership:'external-install',permission:'external installation only',distribution:'external-only'}, {path:'Data/Platform/Plugins/rp.js',size:1,sha256:'b'.repeat(64),componentId:'rp',role:'client',required:true,ownership:'custom-rp',permission:'project-owned fixture',distribution:'allowed'},...nativeFixturePaths.map(p=>({path:p,size:1,sha256:'c'.repeat(64),componentId:'client',role:'client',required:true,ownership:'external-install',permission:'Inert external fixture only',distribution:'external-only'}))],
 requiredPlugins:[{filename:'Skyrim.esm',required:true,order:0,masters:[],role:'server-required',sha256:'a'.repeat(64)}],
 distribution:{source:'local-development'},signing:{algorithm:'Ed25519',keyId:'test-only'}
};}
