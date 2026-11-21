import {describe, expect, it} from 'vitest';
import {replayTrackAtCap, skadiNextLevelRequirement, usesRebalancedExp} from '../src/domain/skadi-level-cap';

const current='2026-11-21T07:12:00';
describe('Skadi Global level rules',()=>{
  it('applies the Base 70 to 80 change at the service reopening',()=>{
    expect(usesRebalancedExp('2026-11-12T07:44:59')).toBe(false);
    expect(usesRebalancedExp('2026-11-12T07:45:00')).toBe(true);
    expect(replayTrackAtCap('base',70,'2026-11-11T18:00:00')).toBe(true);
    expect(replayTrackAtCap('base',70,current)).toBe(false);
    expect(replayTrackAtCap('base',80,current)).toBe(true);
    expect(replayTrackAtCap('base',80,null)).toBe(false);
    expect(replayTrackAtCap('base',81,current)).toBe(false);
  });
  it('uses destination-level costs corroborated by the post-patch Skadi recordings',()=>{
    expect(skadiNextLevelRequirement('base',1)).toBe(2400);
    expect(skadiNextLevelRequirement('base',57)).toBe(16874400);
    expect(skadiNextLevelRequirement('base',64)).toBe(119575100);
    expect(skadiNextLevelRequirement('base',79)).toBe(896248000);
    expect(skadiNextLevelRequirement('base',80)).toBeNull();
    expect(skadiNextLevelRequirement('job',51,7)).toBe(2086562);
  });
  it('separates Novice, first-job and second-job caps; unsupported classes stay unknown',()=>{
    for(const [job,cap] of [[0,10],[2,50],[7,70]]) {
      expect(replayTrackAtCap('job',cap,current,job)).toBe(true);
      expect(replayTrackAtCap('job',cap-1,current,job)).toBe(false);
      expect(skadiNextLevelRequirement('job',cap,job)).toBeNull();
    }
    expect(replayTrackAtCap('job',50,current,8)).toBe(false);
    expect(replayTrackAtCap('job',70,current,9900)).toBe(false);
    expect(skadiNextLevelRequirement('job',40,9900)).toBeNull();
  });
});
