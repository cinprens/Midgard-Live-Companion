import {describe, expect, it} from 'vitest';
import {emptyLiveTelemetry} from '../src/parser/telemetry';
import type {LiveTelemetry} from '../src/parser/types';
import type {AnalysisSummary, LiveStreamState} from '../src/shared/types';
import {intervalForReplayCharacter, replayExperienceCharacters} from '../src/domain/replay-experience';
import {summarizeReplayStarts, type ReplayExperiencePoint} from '../src/domain/replay-experience-comparison';

const characterKey = 'recorded:47:Test';
const start = {level:12,amount:150,required:1000};
function recorded(filename:string, folder='c:/Replay', day=21, amount=150):ReplayExperiencePoint {
  return {character:'Test',characterKey,identity:JSON.stringify([folder,47,'Test']),filename,sourcePath:`${folder}/${filename}`,
    startedAt:`2026-11-${day}T08:00:00`,jobClassId:3,baseLevel:12,jobLevel:50,exp:{base:{...start,amount}}};
}
function source(id:string, telemetry:Partial<LiveTelemetry> = {}, options:Partial<LiveStreamState> = {}):LiveStreamState {
  const point = recorded(id+'.rrf');
  const summary:AnalysisSummary = {startedAt:point.startedAt,playerId:47,characterName:'Test',mapName:null,durationMs:0,
    deaths:0,personalKills:0,inferredKills:0,partyKills:0,unknownKills:0,damage:0,exp:null,drops:null,monsters:[],timeline:[],
    liveTelemetry:{...emptyLiveTelemetry(),...telemetry}};
  return {id,filename:point.filename,sourcePath:point.sourcePath!,status:'following',revision:1,readPosition:0,fileSize:0,
    bytesReadTotal:0,lastActivityAt:null,lastSuccessfulReadAt:null,diagnostics:[],packetCount:10,eventCount:3,compatibility:'skadi-unverified',
    summary,character:{key:characterKey,name:'Test',source:'recorded',playerId:47},...options};
}

describe('Replay EXP character readings',()=>{
  it('separates actual reward, timed balance and negative and zero net changes for Base and Job',()=>{
    const live = source('one',{baseLevel:12, jobLevel:12, recordingStartExp:{base:start,job:start},
      timedExp:{base:{balance:100},job:{balance:150,required:1000}},baseExpGained:403,jobExpGained:0});
    const [row] = replayExperienceCharacters([live]);
    expect(row.base).toMatchObject({startingBalance:150,currentBalance:100,balanceChange:-50,observedGain:403,
      progress:{source:'last-balance',level:12,percent:10,remaining:900}});
    expect(row.job).toMatchObject({balanceChange:0,observedGain:0,progress:{remaining:850}});
  });
  it('distinguishes known zero at recording start from a missing balance and unsupported cap',()=>{
    const [row] = replayExperienceCharacters([source('one',{jobLevel:50,recordingStartJobLevel:50,
      recordingStartExp:{base:{...start,amount:0}}})]);
    expect(row.base).toMatchObject({currentBalance:null,startingBalance:0,observedGain:null,balanceChange:null,
      progress:{source:'recording-start',percent:0,remaining:1000}});
    expect(row.job).toMatchObject({level:50,progress:null,currentBalance:null,observedGain:null});
  });
  it('computes net across one level only and never reuses an old threshold after a reset or an explicit zero',()=>{
    function base(level:number, timed:NonNullable<LiveTelemetry['timedExp']>['base']) {
      return replayExperienceCharacters([source('one',{baseLevel:level,recordingStartExp:{base:start},timedExp:{base:timed}})])[0].base;
    }
    expect(base(13,{balance:0,required:1200})).toMatchObject({balanceChange:850,progress:{remaining:1200}});
    expect(base(14,{balance:75,required:1500}).balanceChange).toBeNull();
    expect(base(12,{balance:1,required:1000,reset:true}).balanceChange).toBeNull();
    expect(base(12,{balance:1,required:0})).toMatchObject({balanceChange:null,progress:{source:'recording-start'}});
    expect(base(12,{balance:150,required:800}).balanceChange).toBeNull();
    expect(base(13,{balance:75})).toMatchObject({balanceChange:925,
      progress:{level:13,source:'last-balance',requirementSource:'official',required:11600,remaining:11525}});
  });
  it('keeps old summaries readable without assigning legacy status values to a new level',()=>{
    const [row] = replayExperienceCharacters([source('old',{baseLevel:13,currentBaseExp:50,nextBaseExp:2000,
      recordingStartExp:{base:start},timedExp:undefined})]);
    expect(row.base).toMatchObject({level:13,currentBalance:50,balanceChange:null,progress:{level:12,source:'recording-start'}});
  });
  it('uses one watched recording per character without summing duplicates, even when the other has missing tracks',()=>{
    const paused = source('paused',{baseExpGained:50},{status:'paused'});
    const active = source('watch',{jobExpGained:10});
    const [automatic] = replayExperienceCharacters([paused,active,active]);
    expect(automatic.stream).toBe(active);
    expect(automatic.streams).toHaveLength(2);
    expect(automatic.base.observedGain).toBeNull();
    const [chosen] = replayExperienceCharacters([paused,active],'paused');
    expect(chosen.base.observedGain).toBe(50);
    expect(chosen.job.observedGain).toBeNull();
  });
  it('loads an archive-only character and a Job cap level without a manual source',()=>{
    const point = recorded('recording.rrf');
    const [row] = replayExperienceCharacters([],null,[point]);
    expect(row.stream).toBeUndefined();
    expect(row).toMatchObject({key:characterKey,name:'Test',filename:point.filename,startedAt:point.startedAt,
      base:{progress:{remaining:850,source:'recording-start'}},job:{level:50,progress:null}});
  });
  it('takes a newer recording start when the watched file is idle but keeps an explicitly chosen recording',()=>{
    const base = source('previous',{baseExpGained:123},{sourceMode:'folder',liveActivity:'idle'});
    const old = {...base,summary:{...base.summary!,startedAt:'2026-11-20T08:00:00'}};
    const latest = recorded('next.rrf');
    const [automatic] = replayExperienceCharacters([old],null,[latest]);
    expect(automatic.filename).toBe(latest.filename);
    expect(automatic.base).toMatchObject({startingBalance:150,observedGain:null});
    const [explicit] = replayExperienceCharacters([old],old.sourcePath,[latest]);
    expect(explicit.filename).toBe(old.filename);
    expect(explicit.base.observedGain).toBe(123);
  });
  it('matches archive gains by character, recording start and folder, ignoring other worlds and conflicting copies',()=>{
    const old = recorded('old.rrf','c:/Replay',20,100);
    const latest = recorded('current.rrf');
    const otherWorld = recorded('current.rrf','c:/other',21,950);
    const otherOld = recorded('old.rrf','c:/other',20,50);
    const archive = summarizeReplayStarts([latest,otherOld,old,otherWorld]);
    const live = source('current',{baseExpGained:12},{sourcePath:'C:\\REPLAY\\current.rrf'});
    const rows = replayExperienceCharacters([live],null,archive.latestStarts);
    expect(rows).toHaveLength(2);
    expect(rows[0].key).not.toBe(rows[1].key);
    expect(rows.map(row=>intervalForReplayCharacter(row,archive.intervals)?.base)).toEqual([50,900]);
    const same = archive.intervals.find(interval=>interval.identity===latest.identity)!;
    expect(intervalForReplayCharacter(rows[0],[same,same])).toBeUndefined();
    expect(intervalForReplayCharacter(rows[0],archive.intervals.map(interval=>({...interval,after:{...interval.after,startedAt:old.startedAt}})))).toBeUndefined();
    expect(summarizeReplayStarts([old,latest,{...latest,jobLevel:49}]).latestStarts).toHaveLength(0);
  });
});
