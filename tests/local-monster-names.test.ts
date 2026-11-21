import {describe,it,expect,afterEach} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadCalculatorMonsterNames,parseCalculatorMonsterNames} from '../electron/local-monster-names';
const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function directory(){const dir=await mkdtemp(path.join(os.tmpdir(),'midgard-monsters-'));folders.push(dir);await mkdir(path.join(dir,'Veriler'));await mkdir(path.join(dir,'resources','app','data'),{recursive:true});return dir;}
const payload=(name='Çöl Yaratığı')=>JSON.stringify({monsters:[{id:1127,name,hp:999,drops:[{price:999}]}],privateSettings:{price:123}});
describe('read-only Ragnarok Calculator monster names',()=>{
  it('selects only numeric ID and Unicode name metadata and rejects conflicting/invalid identities',()=>{
    expect([...parseCalculatorMonsterNames(payload())]).toEqual([[1127,'Çöl Yaratığı']]);
    expect(()=>parseCalculatorMonsterNames('{"monsters":[{"id":1,"name":"A"},{"id":1,"name":"B"}]}')).toThrow();
    expect(()=>parseCalculatorMonsterNames('{"monsters":[{"id":"1","name":"A"}]}')).toThrow();
    expect(()=>parseCalculatorMonsterNames('{"monsters":[{"id":1,"name":"\\u0000"}]}')).toThrow();
    expect(()=>parseCalculatorMonsterNames('{"monsters":{}}')).toThrow();
  });
  it('uses the saved SQLite catalog before the bundled baseline without changing the database',async()=>{
    const dir=await directory(),file=path.join(dir,'Veriler','ragnarok.sqlite');const db=new DatabaseSync(file);
    db.exec('CREATE TABLE current_catalog(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE private_prices(id INTEGER,price INTEGER); INSERT INTO private_prices VALUES(1,999);');
    db.prepare('INSERT INTO current_catalog VALUES(1,?)').run(payload('Güncel Yaratık'));db.close();
    await writeFile(path.join(dir,'resources','app','data','catalog.json'),payload('Eski Yaratık'));const before=await readFile(file);
    const result=await loadCalculatorMonsterNames(dir);expect(result.source).toBe('calculator-sqlite');expect(result.names.get(1127)).toBe('Güncel Yaratık');expect(await readFile(file)).toEqual(before);
  });
  it('falls back to the installed baseline when the current_catalog table has no saved row',async()=>{
    const dir=await directory();const db=new DatabaseSync(path.join(dir,'Veriler','ragnarok.sqlite'));db.exec('CREATE TABLE current_catalog(id INTEGER PRIMARY KEY,payload TEXT)');db.close();
    await writeFile(path.join(dir,'resources','app','data','catalog.json'),payload());const result=await loadCalculatorMonsterNames(dir);expect(result.source).toBe('calculator-bundled');expect(result.names.get(1127)).toBe('Çöl Yaratığı');
  });
  it('does not create a missing Calculator database or invent names from corrupt metadata',async()=>{
    const dir=await directory();await writeFile(path.join(dir,'resources','app','data','catalog.json'),'not JSON');expect((await loadCalculatorMonsterNames(dir)).names.size).toBe(0);
    await expect(readFile(path.join(dir,'Veriler','ragnarok.sqlite'))).rejects.toThrow();
  });
});
