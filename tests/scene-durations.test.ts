import {describe,expect,it} from 'vitest';
import {getSceneSeconds,readSceneDurations,SCENE_KINDS,updateSceneDuration} from '../src/shared/scene-durations';

describe('taskbar scene durations',()=>{
  it('retains valid preferences while using five seconds for missing or damaged fields',()=>{
    expect(Object.values(readSceneDurations(null))).toEqual(SCENE_KINDS.map(()=>5));
    const saved=readSceneDurations({card:12,costume:60,item:0,monster:'3',weight:1.5,death:1});
    expect(saved).toEqual({item:5,death:1,city:5,weight:5,monster:5,card:12,costume:60});
    expect(getSceneSeconds(undefined,'weight')).toBe(5);
  });
  it('updates one category at a time and rejects invalid writes',()=>{
    const prior=readSceneDurations({card:13});
    expect(updateSceneDuration(prior,'weight',1)).toEqual({...prior,weight:1});
    expect(updateSceneDuration(prior,'monster',60)).toEqual({...prior,monster:60});
    for(const bad of [0,61,3.25,Infinity,'5',null])expect(()=>updateSceneDuration(prior,'weight',bad)).toThrow();
    for(const bad of ['glass-bead','__proto__',{},null])expect(()=>updateSceneDuration(prior,bad,4)).toThrow();
    expect(prior.weight).toBe(5);
  });
});
