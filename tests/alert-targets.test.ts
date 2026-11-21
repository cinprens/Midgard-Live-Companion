import {describe, expect, it} from 'vitest';
import {parseTargetId, targetIsActive, targetPatch, type AlertTarget} from '../src/domain/alert-targets';
import {createDefaultAlertPreferences, validateAlertPreferences} from '../src/domain/notifications';

describe('quick alert targets', () => {
  const cases: AlertTarget[] = [
    {type:'item', id:909}, {type:'item', id:603}, {type:'item', id:746},
    {type:'monster', id:1002}, {type:'map', id:'prt_fild08'},
  ];
  it.each(cases)('adds, re-adds and removes $type $id without changing other preferences', target => {
    const before = validateAlertPreferences({
      selectedCardIds:[4317,603,746], selectedMonsterIds:[1313], cityMaps:['prontera'],
      enabled:{card:false, monster:false, city:false, 'old-blue-box':false}, muted:true, volume:28,
    });
    expect(targetIsActive(before, target)).toBe(false);
    const added = validateAlertPreferences(targetPatch(before, target, true), before);
    expect(targetIsActive(added, target)).toBe(true);
    expect(validateAlertPreferences(targetPatch(added, target, true), added)).toEqual(added);
    const removed = validateAlertPreferences(targetPatch(added, target, false), added);
    expect(targetIsActive(removed, target)).toBe(false);
    expect(removed).toMatchObject({muted:true, volume:28, selectedMonsterIds:[1313], selectedCardIds:target.id===746?[4317,603]:[4317,603,746], cityMaps:['prontera']});
    if(target.type==='item')expect(added.enabled.card).toBe(true);
  });
  it('presents an old enabled Glass Bead as one removable ordinary target without changing old profiles on load',()=>{
    const prefs=validateAlertPreferences({selectedCardIds:[972],enabled:{'glass-bead':true}});
    const glass={type:'item',id:746} as const;
    expect(targetIsActive(prefs,glass)).toBe(true);
    expect(prefs.selectedCardIds).toEqual([972]);
    const removed=validateAlertPreferences(targetPatch(prefs,glass,false),prefs);
    expect(targetIsActive(removed,glass)).toBe(false);
    const again=validateAlertPreferences(targetPatch(removed,glass,true),removed);
    expect(again.enabled['glass-bead']).toBe(false);
    expect(again.selectedCardIds).toEqual([972,746]);
  });
  it('rejects a new target past the storage limit and permits re-enabling an existing one', () => {
    const prefs = {...createDefaultAlertPreferences(), selectedCardIds:Array.from({length:512}, (_, i) => i + 1)};
    expect(() => validateAlertPreferences(targetPatch(prefs, {type:'item', id:999}, true), prefs)).toThrow();
    expect(validateAlertPreferences(targetPatch(prefs, {type:'item', id:511}, true), prefs)).toEqual(prefs);
  });
  it('accepts decimal IDs with an optional # and rejects malformed input', () => {
    expect(parseTargetId(' #4294967295 ')).toBe(0xffffffff);
    for (const invalid of ['0', '0x10', '1.2', '2e3', '-2', '#', '', '4294967296']) expect(parseTargetId(invalid)).toBeNull();
  });
});
