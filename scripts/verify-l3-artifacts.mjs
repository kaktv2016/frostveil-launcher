import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {listPackage,extractFile} from '@electron/asar';
const archive='release/win-unpacked/resources/app.asar',entries=listPackage(archive);
assert.equal(entries.some(p=>/(?:^|[\/\\])(?:\.local|tests|modpack-development\.json|rp-world)(?:[\/\\]|$)/i.test(p)),false,'Private research/test/world data packaged');
assert.equal(entries.some(p=>/(?:SkyrimSE\.exe|skse64_loader\.exe|skse64_\d.*\.dll|SkyrimPlatform(?:Impl)?\.dll|MpClientPlugin\.dll|\.esm|\.esp|\.esl|\.bsa)$/i.test(p)),false,'Game/mod binaries packaged');
const profile=JSON.parse(extractFile(archive,'assets/local-baseline.json').toString());assert.equal(profile.files.length,0,'Private baseline packaged');
const main=extractFile(archive,'dist/main.cjs').toString();assert.ok(main.includes('mandatoryPackPolicy = false'));assert.ok(main.includes('data/platform/distribution/runtimedependencies/skyrimplatformimpl.dll'));assert.ok(main.includes('release-assets.githubusercontent.com'));assert.equal(/C:[/\\]+Users[/\\]+[^/\\]+/i.test(main),false,'Personal path in bundled main');
const pkg=JSON.parse(extractFile(archive,'package.json').toString()),source=JSON.parse(await fs.readFile('package.json','utf8'));assert.equal(pkg.version,source.version);assert.equal(pkg.build?.appId??source.build.appId,'dev.skyrimrp.launcher');
console.log('L3 package metadata/privacy and current core verified; no private profile or game assets packaged.');
