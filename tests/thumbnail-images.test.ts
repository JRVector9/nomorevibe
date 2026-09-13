import{it,expect}from'vitest';import sharp from'sharp';
import{normalizeThumbnail,defaultThumbnail}from'@/lib/domain/products/thumbnails/images';
it('validates bytes and preserves small icon dimensions without enlarging',async()=>{
 const png=await sharp({create:{width:32,height:32,channels:4,background:'#ff0000'}}).png().toBuffer();
 const v=await normalizeThumbnail(png);expect(v.width).toBe(32);expect((await sharp(v.data).metadata()).format).toBe('webp');
 await expect(normalizeThumbnail(Buffer.from('<html>login</html>'))).rejects.toThrow();
 await expect(normalizeThumbnail(Buffer.from('<svg width="100" height="100"><image href="http://127.0.0.1/a"/></svg>'))).rejects.toThrow();
});
it('reads PNG-backed ICO and produces a branded deterministic default',async()=>{
 const png=await sharp({create:{width:32,height:32,channels:4,background:'#00ff00'}}).png().toBuffer();
 const h=Buffer.alloc(22);h.writeUInt16LE(1,2);h.writeUInt16LE(1,4);h[6]=32;h[7]=32;h.writeUInt32LE(png.length,14);h.writeUInt32LE(22,18);
 expect((await normalizeThumbnail(Buffer.concat([h,png]))).width).toBe(32);
 expect((await defaultThumbnail('Example')).data.equals((await defaultThumbnail('Example')).data)).toBe(true);
});
it('decodes legacy palette ICO favicons, including the transparency mask',async()=>{
 const h=Buffer.alloc(22);h.writeUInt16LE(1,2);h.writeUInt16LE(1,4);h[6]=16;h[7]=16;h.writeUInt32LE(40+8+64+64,14);h.writeUInt32LE(22,18);
 const b=Buffer.alloc(40+8+64+64);b.writeUInt32LE(40,0);b.writeInt32LE(16,4);b.writeInt32LE(32,8);b.writeUInt16LE(1,12);b.writeUInt16LE(1,14);b[42]=255;b[45]=255;b.fill(255,48,112);
 const image=await normalizeThumbnail(Buffer.concat([h,b]));expect(image.width).toBe(16);
});
it('rejects SVG external references even after long comments or with namespace prefixes',async()=>{
 await expect(normalizeThumbnail(Buffer.from('<!--'+'x'.repeat(1500)+'--><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><image href="file:///tmp/icon.png"/></svg>'))).rejects.toThrow('unsafe_svg');
 await expect(normalizeThumbnail(Buffer.from('<s:svg xmlns:s="http://www.w3.org/2000/svg" width="32" height="32"><s:image href="file:///tmp/icon.png"/></s:svg>'))).rejects.toThrow('unsafe_svg');
});
it('rejects encoded SVG external references before rasterization',async()=>{
 const svg='<?xml version="1.0" encoding="UTF-16"?><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><image href="file:///tmp/icon.png"/></svg>';
 await expect(normalizeThumbnail(Buffer.concat([Buffer.from([255,254]),Buffer.from(svg,'utf16le')]))).rejects.toThrow();
});
