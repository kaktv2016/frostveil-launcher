import type {FileHandle} from 'node:fs/promises';

/** Read the embedded fixed file version of an x64 PE from an open file. */
export async function readPeVersion(_path:string,file:FileHandle,size:number):Promise<string>{
 const invalid=()=>Error('Invalid x64 PE version resource');
 const read=async(offset:number,length:number)=>{
  if(offset<0||length<0||offset+length>size)throw invalid();
  const bytes=Buffer.alloc(length);
  for(let cursor=0;cursor<length;){
   const {bytesRead}=await file.read(bytes,cursor,length-cursor,offset+cursor);
   if(!bytesRead)throw invalid();
   cursor+=bytesRead;
  }
  return bytes;
 };
 const dos=await read(0,64);
 if(dos.readUInt16LE(0)!==0x5a4d)throw invalid();
 const peOffset=dos.readUInt32LE(60),coff=await read(peOffset,24);
 if(coff.readUInt32LE(0)!==0x4550||coff.readUInt16LE(4)!==0x8664)throw invalid();
 const sections=coff.readUInt16LE(6),optionalSize=coff.readUInt16LE(20);
 if(sections<1||sections>96||optionalSize<136||optionalSize>4096)throw invalid();
 const optional=await read(peOffset+24,optionalSize);
 if(optional.readUInt16LE(0)!==0x20b||optional.readUInt32LE(108)<3)throw invalid();
 const resourceRva=optional.readUInt32LE(128),resourceSize=optional.readUInt32LE(132);
 if(!resourceRva||resourceSize<16||resourceSize>16*1024*1024)throw invalid();
 const sectionTable=await read(peOffset+24+optionalSize,sections*40);
 const rvaToOffset=(rva:number,length:number)=>{
  const matches:number[]=[];
  for(let i=0;i<sectionTable.length;i+=40){
   const start=sectionTable.readUInt32LE(i+12),delta=rva-start;
   const rawSize=sectionTable.readUInt32LE(i+16);
   if(delta>=0&&delta+length<=rawSize)matches.push(sectionTable.readUInt32LE(i+20)+delta);
  }
  if(matches.length!==1)throw invalid();
  const offset=matches[0]!;
  if(offset+length>size)throw invalid();
  return offset;
 };
 const root=rvaToOffset(resourceRva,resourceSize);
 const within=(offset:number,length:number)=>{
  if(offset+length>resourceSize)throw invalid();
  return read(root+offset,length);
 };
 const entries=async(offset:number)=>{
  const header=await within(offset,16);
  const count=header.readUInt16LE(12)+header.readUInt16LE(14);
  if(count>512)throw invalid();
  const rows=await within(offset+16,count*8);
  return Array.from({length:count},(_,i)=>({name:rows.readUInt32LE(i*8),child:rows.readUInt32LE(i*8+4)}));
 };
 const directoryOffset=(child:number)=>{
  if((child>>>31)!==1)throw invalid();
  return child&0x7fffffff;
 };
 const types=(await entries(0)).filter(entry=>entry.name===16);
 if(types.length!==1)throw invalid();
 const names=await entries(directoryOffset(types[0]!.child));
 if(names.length>32)throw invalid();
 let version:string|undefined,leaves=0;
 for(const name of names){
  for(const language of await entries(directoryOffset(name.child))){
   if(++leaves>64||(language.child>>>31)!==0)throw invalid();
   const data=await within(language.child,16);
   const rva=data.readUInt32LE(0),length=data.readUInt32LE(4);
   if(length<92||rva<resourceRva||rva-resourceRva+length>resourceSize)throw invalid();
   const value=await read(rvaToOffset(rva,length),92);
   if(value.readUInt16LE(0)<92||value.readUInt16LE(0)>length||value.readUInt16LE(2)!==52||
      value.readUInt16LE(4)!==0||value.toString('utf16le',6,38)!=='VS_VERSION_INFO\0'||
      value.readUInt32LE(40)!==0xfeef04bd)throw invalid();
   const candidate=[50,48,54,52].map(offset=>value.readUInt16LE(offset)).join('.');
   if(version!==undefined&&candidate!==version)throw invalid();
   version=candidate;
  }
 }
 if(version===undefined)throw invalid();
 return version;
}
