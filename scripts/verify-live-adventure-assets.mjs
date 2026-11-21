import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import path from 'node:path';

const names=['feminine-1','feminine-2','feminine-3','feminine-4','masculine-1','masculine-2','masculine-3','scene','loot-card','loot-costume','loot-generic'];
const output=path.resolve('.qa',`live-adventure-assets-${Date.now()}`),assets=[];
const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
for(const id of names){
  const file=path.resolve('src/assets/live/adventure',`${id}.png`),bytes=await readFile(file);
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a',`${id}: valid PNG signature`);
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),depth=bytes[24],colorType=bytes[25];
  assert.equal(depth,8,`${id}: 8-bit PNG`);assert.equal(bytes[28],0,`${id}: noninterlaced PNG`);
  assert.ok(width>=512&&height>=512,`${id}: sufficient source resolution`);
  assert.ok([2,6].includes(colorType),`${id}: RGB or RGBA`);
  const chunks=[];for(let offset=8;offset<bytes.length;){const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);if(type==='IDAT')chunks.push(bytes.subarray(offset+8,offset+8+length));offset+=length+12;}
  const channels=colorType===6?4:3,stride=width*channels,raw=inflateSync(Buffer.concat(chunks));
  assert.equal(raw.length,height*(stride+1),`${id}: decoded scanline length`);
  let previous=Buffer.alloc(stride),cursor=0,minAlpha=255,maxAlpha=0,transparentPixels=0,visiblePixels=0;
  for(let y=0;y<height;y++){
    const filter=raw[cursor++],row=Buffer.from(raw.subarray(cursor,cursor+stride));cursor+=stride;assert.ok(filter<=4,`${id}: PNG filter`);
    for(let x=0;x<stride;x++){
      const left=x>=channels?row[x-channels]:0,above=previous[x],corner=x>=channels?previous[x-channels]:0;
      row[x]=(row[x]+(filter===1?left:filter===2?above:filter===3?Math.floor((left+above)/2):filter===4?paeth(left,above,corner):0))&255;
      if(x%channels===channels-1){const alpha=channels===4?row[x]:255;minAlpha=Math.min(minAlpha,alpha);maxAlpha=Math.max(maxAlpha,alpha);if(alpha===0)transparentPixels++;if(alpha>=230)visiblePixels++;}
    }
    previous=row;
  }
  const transparentFraction=transparentPixels/(width*height),visibleFraction=visiblePixels/(width*height);
  if(id!=='scene'){assert.equal(colorType,6,`${id}: alpha channel required`);assert.equal(minAlpha,0,`${id}: real transparency`);assert.ok(transparentFraction>.2,`${id}: transparent surrounding area`);assert.ok(visibleFraction>.1,`${id}: visible subject`);}
  const sha256=createHash('sha256').update(bytes).digest('hex');assert.ok(!assets.some(asset=>asset.sha256===sha256),`${id}: distinct artwork`);
  assets.push({id,file,width,height,bytes:bytes.length,colorType,minAlpha,maxAlpha,transparentFraction,visibleFraction,sha256});
}
await mkdir(output,{recursive:true});const report={generatedAt:new Date().toISOString(),tool:'built-in imagegen',success:true,characters:7,feminine:4,masculine:3,lootCategories:3,assets};
await writeFile(path.join(output,'asset-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({output,success:true,assets:assets.length,totalBytes:assets.reduce((sum,asset)=>sum+asset.bytes,0)},null,2));
