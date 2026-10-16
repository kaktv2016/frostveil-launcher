import assert from 'node:assert/strict';import {listPackage,extractFile} from '@electron/asar';
const archive='release/win-unpacked/resources/app.asar',entries=listPackage(archive),main=extractFile(archive,'dist/main.cjs').toString();
assert.equal(entries.some(p=>/(?:^|[\/\\])(?:metadata|l4a-sandbox|transactions|auth-key|ownership\.json|installer-sandbox-session\.json)(?:[\/\\]|$)/i.test(p)),false,'Installer evidence or private metadata packaged');
assert.equal(/BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY/.test(main),false,'Private signing key packaged');
assert.ok(main.includes('createInstallerSandbox'));assert.ok(main.includes('recovery-required'));assert.ok(main.includes('realInstallEnabled: false'));assert.ok(main.includes('generateKeyPairSync'));assert.ok(main.includes('await MetadataStore.create(grant)'));
const pkg=JSON.parse(extractFile(archive,'package.json').toString());assert.equal(pkg.version,JSON.parse(await (await import('node:fs/promises')).readFile('package.json','utf8')).version);console.log('L4-A sandbox-only implementation/current recovery ordering/privacy verified in packaged app; no journals, receipts, backups or private keys included.');
