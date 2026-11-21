import { _electron as electron } from 'playwright';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
const env={...process.env,MIDGARD_USER_DATA:path.resolve('.qa/icon-profile')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:['.'],env});
try{
  const page=await app.firstWindow();await page.waitForSelector('.brand svg');
  const base64=await page.evaluate(async()=>{
    const svg=document.querySelector('.brand svg').outerHTML.replace('class="rune small"','xmlns="http://www.w3.org/2000/svg" width="180" height="198" style="color:#d0b375"');
    const img=new Image();img.src='data:image/svg+xml;base64,'+btoa(svg);await img.decode();
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const ctx=canvas.getContext('2d');
    ctx.fillStyle='#101827';ctx.fillRect(0,0,256,256);ctx.drawImage(img,38,26,180,198);return canvas.toDataURL('image/png').split(',')[1];
  });
  const png=Buffer.from(base64,'base64');const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
  await mkdir('build',{recursive:true});await writeFile('build/icon.png',png);await writeFile('build/icon.ico',Buffer.concat([header,png]));
}finally{await app.close();}
