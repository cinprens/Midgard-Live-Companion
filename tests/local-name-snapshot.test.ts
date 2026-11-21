import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadLocalNameSnapshot} from '../electron/local-name-snapshot';

let directory: string, file: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(),'midgard-own-name-snapshot-'));
  file = path.join(directory,'names.json');
});
afterEach(async () => {await rm(directory,{recursive:true,force:true});});

const valid = {cards:[[10,'Çiçek Kartı'],[55,'Sky Card']],costumes:[[94000,'[Costume] Hat']],monsters:[[10,'Orc Warrior']]};
const empty = {cards:new Map(),costumes:new Map(),monsters:new Map()};

describe('read-only local name snapshot', () => {
  it('returns exact display names, permits distinct monster and item namespaces and keeps the file intact', async () => {
    const source = JSON.stringify(valid);
    await writeFile(file,source);
    const data = await loadLocalNameSnapshot(file);
    expect([...data.cards]).toEqual(valid.cards);
    expect([...data.costumes]).toEqual(valid.costumes);
    expect([...data.monsters]).toEqual(valid.monsters);
    expect(await readFile(file,'utf8')).toBe(source);
  });
  it('never creates missing files or directories', async () => {
    expect(await loadLocalNameSnapshot(path.join(directory,'missing', 'names.json'))).toEqual(empty);
    expect(await loadLocalNameSnapshot(directory)).toEqual(empty);
    expect(await readdir(directory)).toEqual([]);
  });
  it.each([
    {cards:[[10,'A'],[10,'A']]}, {cards:[[55,'B'],[10,'A']]}, {costumes:[[10,'Hat']]},
    {cards:[['10','A']]}, {cards:[[0,'A']]}, {monsters:[[4294967296,'A']]}, {costumes:[[1,'\u0000hat']]},
    {cards:[[1,'  ']]}, {monsters:[[3,'A','extra']]}, {cards:{bad:1}}, {monsters:[[5,'x'.repeat(301)]]},
  ])('rejects the complete snapshot on a malformed group %j', async changed => {
    await writeFile(file,JSON.stringify({...valid,...changed}));
    expect(await loadLocalNameSnapshot(file)).toEqual(empty);
  });
  it('rejects incomplete JSON, missing groups, NUL bytes, invalid UTF-8 and oversized files', async () => {
    for(const invalid of [Buffer.from('{'),Buffer.from('{"cards":[],"monsters":[]}'),Buffer.from([0x7b,0,0x7d]),
      Buffer.from([0xfe,0xbb,0xff]),Buffer.alloc(4*1024*1024+1,0x20)]){
      await writeFile(file,invalid);
      expect(await loadLocalNameSnapshot(file)).toEqual(empty);
    }
  });
});
