import {describe,it,expect,afterEach} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseLiteralItemCatalog,parseLiteralItemNames,loadLocalItemNames} from '../electron/local-item-names';
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const string=(s:string)=>{const b=Buffer.from(s+'\0');return Buffer.concat([u32(b.length),b]);};
const abc=(op:number,a:number,b:number,c:number)=>u32((op|(a<<6)|(b<<23)|(c<<14))>>>0);
function encode(constants:(string|number)[],code:Buffer[]){
  const encoded=constants.map(value=>typeof value==='string'?Buffer.concat([Buffer.from([4]),string(value)]):Buffer.concat([Buffer.from([3]),(()=>{const b=Buffer.alloc(8);b.writeDoubleLE(value);return b;})()]));
  return Buffer.concat([Buffer.from('1b4c75615100010404040800','hex'),u32(0),u32(0),u32(0),Buffer.from([0,0,2,8]),u32(code.length),...code,u32(constants.length),...encoded,u32(0),u32(0),u32(0),u32(0)]);
}
function fixture(extra:Buffer[]=[]){
  const constants=['tbl_string','identifiedDisplayName','^00ff00Çöğür İksiri^000000',501];
  return encode(constants,[abc(10,0,0,0),abc(10,1,0,0),abc(9,1,257,258),abc(9,0,259,1),...extra,abc(7,0,0,0),abc(30,0,1,0)]);
}
const folders:string[]=[];afterEach(async()=>{await Promise.all(folders.splice(0).map(folder=>rm(folder,{recursive:true,force:true})));});
describe('data-only installed item name reader',()=>{
  it('classifies the identified type field even when the item name is ambiguous',()=>{
    function read(line:string){
      const constants=['tbl_string','identifiedDisplayName','Card Album',501,'identifiedDescriptionName',line];
      const code=[abc(10,0,0,0),abc(10,1,0,0),abc(9,1,257,258),abc(10,2,0,0),abc(1,3,0,5),abc(34,2,1,1),
        abc(9,1,260,2),abc(9,0,259,1),abc(7,0,0,0),abc(30,0,1,0)];
      return parseLiteralItemCatalog(encode(constants,code)).categories.get(501);
    }
    expect(read('^0000ffType:^000000 Card')).toBe('card');
    expect(read('Type: Costume Gear')).toBe('costume');
    expect(read('Contains a random Costume or Card')).toBeUndefined();
  });
  it('reads only the declared equipment table prefix and requires a true costume flag',()=>{
    function equipment(flag:number){
      return parseLiteralItemCatalog(encode(['tbl_data','costume',400853],[abc(10,0,0,0),abc(10,1,0,0),
        abc(2,2,flag,0),abc(9,1,257,2),abc(9,0,258,1),abc(7,0,0,0),abc(28,1,1,1),abc(30,0,1,0)]),true);
    }
    expect(equipment(1).categories.get(400853)).toBe('costume');
    expect(equipment(0).categories.size).toBe(0);
  });
  it('reads only numeric item keys and literal identified names with Turkish characters',()=>{const result=parseLiteralItemNames(fixture());expect([...result]).toEqual([[501,'Çöğür İksiri']]);});
  it('rejects executable instructions rather than running client code',()=>{expect(()=>parseLiteralItemNames(fixture([abc(28,1,1,1)]))).toThrow('Yürütülebilir');});
  it('rejects conflicting repeated item IDs',()=>{expect(()=>parseLiteralItemNames(fixture([abc(9,0,259,1)]))).toThrow('yinelenmiş');});
  it('rejects truncated bytes, unsupported headers and oversized code vectors',()=>{
    expect(()=>parseLiteralItemNames(fixture().subarray(0,40))).toThrow();const bad=fixture();bad[6]=0;expect(()=>parseLiteralItemNames(bad)).toThrow();
    const huge=fixture();huge.writeUInt32LE(1000001,28);expect(()=>parseLiteralItemNames(huge)).toThrow('sınır');
  });
  it('loads only the sibling System file of a granted Replay path and refreshes changed source data',async()=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'midgard-item-names-'));folders.push(dir);await mkdir(path.join(dir,'Replay'));await mkdir(path.join(dir,'System'));
    await writeFile(path.join(dir,'System','iteminfo_enUS.lub'),fixture());const source=path.join(dir,'Replay','source.rrf');expect((await loadLocalItemNames(source)).get(501)).toBe('Çöğür İksiri');
    expect((await loadLocalItemNames(path.join(dir,'Other','source.rrf'))).size).toBe(0);expect((await loadLocalItemNames(path.join(dir,'Replay','source.txt'))).size).toBe(0);
    await writeFile(path.join(dir,'System','iteminfo_enUS.lub'),Buffer.from('not a Lua table'));expect((await loadLocalItemNames(source)).size).toBe(0);
  });
});
