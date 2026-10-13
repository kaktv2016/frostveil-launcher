import fs from 'node:fs/promises';
import {load} from 'js-yaml';
const metadata=load(await fs.readFile('release/win-unpacked/resources/app-update.yml','utf8'));
if(metadata.provider!=='github'||metadata.owner!=='kaktv2016'||metadata.repo!=='frostveil-launcher'||metadata.private===true)throw Error('Incorrect update provider');
const latest=load(await fs.readFile('release/latest.yml','utf8'));
const pkg=JSON.parse(await fs.readFile('package.json','utf8'));
if(latest.version!==pkg.version||!Array.isArray(latest.files)||!latest.files.length)throw Error('Incorrect latest.yml');
for(const file of latest.files){if(typeof file.url!=='string'||file.url.includes('/')||file.url.includes('\\')||!file.url.endsWith('.exe')||!file.sha512)throw Error('Invalid NSIS metadata');await fs.stat('release/'+file.url);}
console.log('NSIS installer/latest.yml/app-update.yml verified; publisher trust is a separate gate.');
