import {describe,expect,it} from 'vitest';
import {ReferenceGameNames} from '../electron/reference-game-names';

describe('reference names on a clean installation',()=>{
  it('provides searchable card, costume and monster names without a game directory',()=>{
    const names=new ReferenceGameNames().alertTargets(new Map(),new Map(),[],new Map());
    expect(new Map(names.items).get(4001)).toBe('Poring Card');
    expect(new Map(names.rareItems).get(4001)).toBe('card');
    expect(new Map(names.rareItems).get(5914)).toBe('costume');
    expect(new Map(names.monsters).get(1002)).toBe('Poring');
  });

  it('keeps same-ID server differences below installed, imported and observed evidence',()=>{
    const reference=new ReferenceGameNames({
      cards:new Map([[5914,'Snapshot card']]),costumes:new Map(),monsters:new Map([[1002,'Snapshot monster']]),
    });
    const snapshot=reference.alertTargets(new Map(),new Map(),[],new Map());
    expect(new Map(snapshot.items).get(5914)).toBe('Snapshot card');
    expect(new Map(snapshot.rareItems).get(5914)).toBe('card');
    expect(new Map(snapshot.monsters).get(1002)).toBe('Snapshot monster');
    const installed=reference.alertTargets(new Map([[5914,'Installed ordinary item']]),new Map(),[
      {itemId:4001,name:'Imported ordinary item',category:'etc'},
    ],new Map([[1002,'Current monster']]));
    expect(new Map(installed.items).get(5914)).toBe('Installed ordinary item');
    expect(new Map(installed.rareItems).has(5914)).toBe(false);
    expect(new Map(installed.rareItems).has(4001)).toBe(false);
    expect(new Map(installed.monsters).get(1002)).toBe('Current monster');
    const proven=reference.alertTargets(new Map(),new Map([[5914,'costume']]),[
      {itemId:5914,name:'Imported name',category:'card'},
    ],new Map());
    expect(new Map(proven.items).get(5914)).toBe('Imported name');
    expect(new Map(proven.rareItems).get(5914)).toBe('costume');
  });
});
