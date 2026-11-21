import {describe, expect, it} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {decryptChunk, deriveKeys} from 'rrfparser';
import {latestReplayIntervals, summarizeReplayStarts, type ReplayExperiencePoint} from '../src/domain/replay-experience-comparison';
import {compareReplayFiles, compareTrackedReplays} from '../electron/replay-experience-comparison';

const point = (day:number, amount:number, level=55):ReplayExperiencePoint=>({
  character:'Test',characterKey:'recorded:34:Test',identity:'same-folder-account-name',filename:`sample-${day}.rrf`,
  startedAt:`2026-11-${day}T08:00:00`,jobClassId:8,exp:{base:{level,amount,required:1000},job:{level:23,amount:13,required:900}},
});

describe('net EXP between recording starts',()=>{
  it('does not report a gain across the November Base EXP rebalance; Job remains comparable',()=>{
    const prior={...point(11,100),startedAt:'2026-11-12T07:44:59'};
    const next={...point(12,500),startedAt:'2026-11-12T07:45:00'};
    expect(latestReplayIntervals([next,prior])[0]).toMatchObject({base:null,job:0});
  });
  it('orders embedded times and reads negative and zero net change',()=>{
    const [interval] = latestReplayIntervals([point(19,400),point(16,90),point(18,620)]);
    expect(interval).toMatchObject({base:-220,job:0,before:{filename:'sample-18.rrf'},after:{filename:'sample-19.rrf'}});
  });
  it('uses original threshold for one level and rejects multiple or rolled-back levels',()=>{
    expect(latestReplayIntervals([point(15,900),point(16,200,56)])[0].base).toBe(300);
    for (const level of [53,54,57,58]) expect(latestReplayIntervals([point(15,900),point(16,200,level)])[0].base).toBeNull();
  });
  it('rejects changing thresholds and classes, treats missing tracks independently',()=>{
    const next=point(16,45);
    next.exp.base!.required=800;
    expect(latestReplayIntervals([point(15,900),next])[0]).toMatchObject({base:null,job:0});
    delete next.exp.job;
    expect(latestReplayIntervals([point(15,900),next])[0].job).toBeNull();
    next.jobClassId=10;
    expect(latestReplayIntervals([point(15,900),next])[0]).toMatchObject({base:null,job:null});
  });
  it('separates identities, collapses duplicate copies and rejects timestamp conflicts',()=>{
    const a=point(15,100), b=point(16,120);
    expect(latestReplayIntervals([a,{...b,identity:'other-account-or-name'}])).toEqual([]);
    expect(latestReplayIntervals([a,{...a,filename:'copy.rrf'}])).toEqual([]);
    expect(latestReplayIntervals([a,b,{...a,filename:'copy.rrf'}])).toHaveLength(1);
    expect(latestReplayIntervals([a,b,point(16,130)])).toEqual([]);
  });
  it('shows a single recording for an idle character and omits a conflicting latest snapshot',()=>{
    const first=point(15,100), next=point(16,200);
    const only={...first, identity:'different-character'};
    expect(summarizeReplayStarts([first,next,point(16,120),only])).toEqual({intervals:[],latestStarts:[only]});
    expect(summarizeReplayStarts([next,first]).latestStarts).toEqual([next]);
  });
});

function sample(day:number,amount:number,character='Test',player=34) {
  const header=Buffer.alloc(352);
  header.write('<< Ragnarok Replay File Version 0.05 >>'); header[100]=5;
  header.writeInt16LE(2026,104);header[106]=11;header[107]=day;header[109]=8;
  const keys=deriveKeys({year:2026,month:11,day,hour:8,minute:0,second:0});
  const integer=(v:number,width=4)=>{const b=Buffer.alloc(width);if(width===8)b.writeBigUInt64LE(BigInt(v));else b.writeUInt32LE(v);return b;};
  const chunk=(id:number,data:Buffer)=>{const h=Buffer.alloc(6);h.writeUInt16LE(id);h.writeUInt32LE(data.length,2);return Buffer.concat([h,data]);};
  const meta=chunk(964,Buffer.from(character+'\0'));
  const session=Buffer.concat([chunk(1010,integer(player)),chunk(1014,integer(8)),chunk(1016,integer(55)),
    chunk(1015,integer(amount,8)),chunk(1018,integer(1000,8)),chunk(1019,integer(23))]);
  const section=(slot:number,type:number,start:number,length:number)=>{
    const at=112+10*slot;header.writeUInt16LE(type,at);header.writeInt32LE(length,at+2);header.writeInt32LE(start,at+6);
  };
  section(0,2,352,meta.length);section(1,3,352+meta.length,session.length);
  section(2,1,352+meta.length+session.length,0);
  return Buffer.concat([header,decryptChunk(meta,meta.length,keys),decryptChunk(session,session.length,keys)]);
}

it('reads only recording metadata and isolates names, accounts and unresolved files',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'midgard-netexp-'));
  try {
    const f=(name:string)=>path.join(directory,name+'.rrf');
    await writeFile(f('later-name-old-recording'),sample(15,400));
    await writeFile(f('earlier-name-new-recording'),sample(17,300));
    await writeFile(f('alt'),sample(18,60,'Alt',34));
    await writeFile(f('other-account'),sample(19,90,'Test',45));
    await writeFile(f('incomplete'),Buffer.alloc(50));
    const result=await compareTrackedReplays(directory,[f('alt')]);
    expect(result).toMatchObject({inspected:5,unreadable:1,intervals:[{character:'Test',base:-100,job:null}]});
    await expect(compareReplayFiles([f('alt'),f('earlier-name-new-recording')],true)).rejects.toThrow();
    await expect(compareReplayFiles([f('later-name-old-recording'),f('other-account')],true)).rejects.toThrow();
    await expect(compareReplayFiles([f('later-name-old-recording'),f('incomplete')],true)).rejects.toThrow();
  } finally {await rm(directory,{recursive:true,force:true});}
});
