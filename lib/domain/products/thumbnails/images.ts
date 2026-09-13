import sharp from 'sharp';
import {createHash}from'node:crypto';
export type ThumbnailImage={data:Buffer;width:number;height:number};
const MAX_BYTES=5*1024*1024,MAX_PIXELS=16_000_000;
function icoImage(source:Buffer):Buffer|{data:Buffer;raw:{width:number;height:number;channels:4}}{
 const count=source.readUInt16LE(4);if(!count||count>256||source.length<6+count*16)throw new Error('invalid_ico');
 const entries=Array.from({length:count},(_,i)=>{const p=6+i*16;return {size:(source[p]||256)*(source[p+1]||256),length:source.readUInt32LE(p+8),offset:source.readUInt32LE(p+12)};}).sort((a,b)=>b.size-a.size);
 for(const e of entries){
  if(e.offset<6+count*16||e.length<8||e.offset+e.length>source.length)continue;const b=source.subarray(e.offset,e.offset+e.length);
  if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return b;
  if(b.length<40||b.readUInt32LE(0)!==40||b.readUInt32LE(16)!==0)continue;
  const width=b.readInt32LE(4),signedHeight=b.readInt32LE(8),height=Math.abs(signedHeight)/2,depth=b.readUInt16LE(14);
  if(width<1||width>512||height<1||height>512||!Number.isInteger(height)||![1,4,8,24,32].includes(depth))continue;
  const paletteCount=depth<=8?(b.readUInt32LE(32)||2**depth):0;
  if(paletteCount>256)continue;
  const pixelOffset=40+paletteCount*4;
  const stride=Math.ceil(width*depth/32)*4,maskStride=Math.ceil(width/32)*4,maskOffset=pixelOffset+stride*height;
  if(b.length<maskOffset)continue;const data=Buffer.alloc(width*height*4);let anyAlpha=false;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const sy=signedHeight>0?height-1-y:y,o=(y*width+x)*4;
   let p=pixelOffset+sy*stride+Math.floor(x*depth/8);
   if(depth<=8){const shift=8-depth-(x*depth)%8,index=(b[p]>>shift)&(2**depth-1);if(index>=paletteCount)throw new Error('invalid_ico_palette');p=40+index*4;}
   data[o]=b[p+2];data[o+1]=b[p+1];data[o+2]=b[p];data[o+3]=depth===32?b[p+3]:255;if(data[o+3])anyAlpha=true;
  }
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const o=(y*width+x)*4,sy=signedHeight>0?height-1-y:y;if(!anyAlpha)data[o+3]=255;if(b.length>=maskOffset+maskStride*height&&(b[maskOffset+sy*maskStride+Math.floor(x/8)]&(128>>(x%8))))data[o+3]=0;}
  return {data,raw:{width,height,channels:4}};
 }throw new Error('unsupported_ico');
}
export async function normalizeThumbnail(source:Buffer):Promise<ThumbnailImage>{
 if(!source.length||source.length>MAX_BYTES)throw new Error('image_size');
 const prefix=source.toString('utf8');
 if(/<(?:[\w.-]+:)?svg\b/i.test(prefix)){
  const svg=source.toString('utf8');
  if(source.length>256*1024||svg.includes('\\')||/<!DOCTYPE|<!ENTITY|@import|xml-stylesheet|<(?:[\w.-]+:)?script\b|<(?:[\w.-]+:)?foreignObject\b|<(?:[\w.-]+:)?image\b|(?:href|src)\s*=\s*["'](?!#)|url\(\s*["']?(?!#)/i.test(svg))throw new Error('unsafe_svg');
 }
 const ico=source.length>=6&&source.readUInt32LE(0)===65536?icoImage(source):source;
 const input=Buffer.isBuffer(ico)?sharp(ico,{limitInputPixels:MAX_PIXELS}):sharp(ico.data,{raw:ico.raw,limitInputPixels:MAX_PIXELS});
 const meta=await input.metadata();
 if(!meta.width||!meta.height||meta.width<16||meta.height<16||meta.width>10000||meta.height>10000||meta.width*meta.height>MAX_PIXELS)throw new Error('image_dimensions');
 if(!meta.format||!['png','jpeg','webp','gif','svg','raw','avif'].includes(meta.format))throw new Error('image_format');
 const result=await input.rotate().resize({width:1200,height:630,fit:'inside',withoutEnlargement:true}).timeout({seconds:3}).webp({quality:82}).toBuffer({resolveWithObject:true});
 return {data:result.data,width:result.info.width,height:result.info.height};
}
export async function defaultThumbnail(name:string):Promise<ThumbnailImage>{
 const colors=['#2d4a8a','#7a3aa0','#2a7a5a','#a05a2a','#8a2d4a','#4a2d8a','#2a6a8a'];
 const hash=createHash('sha256').update(name).digest();const initials=name.match(/[A-Za-z0-9]/g)?.slice(0,2).join('').toUpperCase()||'N';
 const data=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" rx="32" fill="${colors[hash[0]%colors.length]}"/><text x="160" y="178" font-family="sans-serif" font-size="96" font-weight="700" text-anchor="middle" fill="white">${initials}</text><text x="160" y="273" font-family="sans-serif" font-size="20" text-anchor="middle" fill="white">nomorevibe</text></svg>`)).webp({quality:82}).toBuffer();
 return {data,width:320,height:320};
}
