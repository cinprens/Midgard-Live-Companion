import {describe,expect,it} from 'vitest';
import {createDefaultHuntAnalyticsPreferences,validateHuntAnalyticsPreferences} from '../src/shared/hunt-analytics-preferences';

describe('separate hunt analysis preferences',()=>{
  it('preserves selected context without adding notification or kill view fields',()=>{
    const preferences={...createDefaultHuntAnalyticsPreferences(),characterKey:'character:1',sharedCharacterKeys:['character:1','character:2'],monsterId:1313};
    const result=validateHuntAnalyticsPreferences(preferences);
    expect(result).toEqual(preferences);result.sharedCharacterKeys.pop();expect(preferences.sharedCharacterKeys).toHaveLength(2);
  });
  it('rejects malformed and oversized context instead of replacing unrelated settings',()=>{
    const defaults=createDefaultHuntAnalyticsPreferences();
    for(const patch of [{scope:'all'},{characterKey:''},{characterKey:'a\n'},{sharedCharacterKeys:['a','a']},{sharedCharacterKeys:Array.from({length:33},(_,i)=>String(i))},{monsterId:0},{trendDays:365},{reference:'all-time'},{metric:'kills'},{selectedMonsterIds:[1313]}])expect(()=>validateHuntAnalyticsPreferences({...defaults,...patch})).toThrow();
  });
});
