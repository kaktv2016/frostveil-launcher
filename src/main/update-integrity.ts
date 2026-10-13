import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {authenticode} from './windows';
export async function verifyDownloadedInstaller(file:string,sha512:string,publishers:readonly string[],signature=authenticode):Promise<void>{
 if(!publishers.length||!file.toLowerCase().endsWith('.exe'))throw Error('Trusted NSIS installer required');
 const hash=createHash('sha512');for await(const chunk of createReadStream(file))hash.update(chunk);
 if(hash.digest('base64')!==sha512)throw Object.assign(Error('Update checksum failed'),{code:'ERR_UPDATER_CHECKSUM_MISMATCH'});
 const signer=await signature(file);
 if(!signer.valid||!publishers.includes(signer.subject))throw Object.assign(Error('Update signer failed'),{code:'ERR_UPDATER_INVALID_SIGNATURE'});
}
