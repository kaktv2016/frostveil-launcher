import {inflateSync} from 'node:zlib';

/** Bounded decoder for local BSA assets. Caller must authenticate the output hash. */
export function decodeBsaPayload(raw:Buffer,record:{compressed:boolean;embeddedName:boolean;bsaVersion:number},expectedSize:number):Buffer{
 if(!Number.isSafeInteger(expectedSize)||expectedSize<1||expectedSize>128*1024*1024)throw Error('BSA size limit');
 if(record.embeddedName){if(!raw.length||raw[0]!+1>raw.length)throw Error('BSA embedded name truncated');raw=raw.subarray(raw[0]!+1);}
 if(!record.compressed){if(raw.length!==expectedSize)throw Error('BSA size mismatch');return raw;}
 if(raw.length<4||raw.readUInt32LE(0)!==expectedSize)throw Error('BSA declared size mismatch');
 raw=raw.subarray(4);
 if(record.bsaVersion!==105){if(![103,104].includes(record.bsaVersion))throw Error('Unsupported BSA version');const out=inflateSync(raw,{maxOutputLength:expectedSize});if(out.length!==expectedSize)throw Error('BSA inflated size mismatch');return out;}
 const out=Buffer.alloc(expectedSize);let written=0;
 const block=(data:Buffer,minimumOffset=0)=>{
  let pos=0;
  const byte=()=>{if(pos>=data.length)throw Error('LZ4 block truncated');return data[pos++]!;};
  const length=(n:number)=>{if(n===15){let v;do{v=byte();n+=v;if(n>expectedSize)throw Error('LZ4 length limit');}while(v===255);}return n;};
  while(pos<data.length){const token=byte(),literals=length(token>>>4);if(pos+literals>data.length||written+literals>out.length)throw Error('LZ4 literal size');data.copy(out,written,pos,pos+literals);pos+=literals;written+=literals;if(pos===data.length)break;
   const offset=byte()|(byte()<<8),count=length(token&15)+4;if(!offset||written-offset<minimumOffset||written+count>out.length)throw Error('LZ4 invalid offset/size');
   for(let i=0;i<count;i++){out[written]=out[written-offset]!;written++;}
  }
 };
 if(raw.length>=4&&raw.readUInt32LE(0)===0x184d2204){
  if(raw.length<7)throw Error('LZ4 frame truncated');const flags=raw[4]!;if(flags>>>6!==1||flags&1)throw Error('Unsupported LZ4 frame/dictionary');
  let pos=7+(flags&8?8:0);if(flags&8){if(raw.length<14||raw.readBigUInt64LE(6)!==BigInt(expectedSize))throw Error('LZ4 frame content size');}
  for(;;){if(pos+4>raw.length)throw Error('LZ4 frame truncated');const word=raw.readUInt32LE(pos);pos+=4;if(word===0)break;const size=word&0x7fffffff;if(!size||pos+size>raw.length)throw Error('LZ4 frame block size');const data=raw.subarray(pos,pos+size);pos+=size;
   if(word>>>31){if(written+size>out.length)throw Error('LZ4 uncompressed size');data.copy(out,written);written+=size;}else block(data,flags&0x20?written:0);
   if(flags&0x10)pos+=4;
  }
  if(flags&4)pos+=4;if(pos!==raw.length)throw Error('LZ4 trailing/truncated data');
 }else block(raw);
 if(written!==expectedSize)throw Error('LZ4 output size mismatch');return out;
}
