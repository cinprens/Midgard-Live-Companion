import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {ExpansionStore} from '../electron/expansion-store';
import {HuntAnalyticsClient} from '../electron/hunt-analytics-client';

let directory:string,store:ExpansionStore,client:HuntAnalyticsClient;
const query={monsterId:1313,date:'2026-11-05',scope:{kind:'character',characterKey:'qa:worker'},reference:'previous-7-days',trendDays:7};
beforeAll(async()=>{
  await mkdir('.qa',{recursive:true});directory=await mkdtemp(path.resolve('.qa/hunt-worker-'));
  const workerPath=path.join(directory,'worker.cjs');
  await build({entryPoints:['electron/hunt-analytics-worker.ts'],outfile:workerPath,bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*'],logLevel:'error'});
  const database=path.join(directory,'worker.sqlite');store=new ExpansionStore(database);client=new HuntAnalyticsClient(database,workerPath);
});
afterAll(async()=>{await client?.close();store?.close();if(directory)await rm(directory,{recursive:true,force:true});});

describe('hunt analysis read worker',()=>{
  it('serves bounded summaries and evidence through the actual worker',async()=>{
    const [summary,evidence]=await Promise.all([client.read(query),client.evidence(query)]);
    expect(summary.current.durationMs).toBe(0);expect(summary.current.ratePerHour).toBeNull();expect(summary.days).toHaveLength(7);
    expect(evidence.items).toEqual([]);expect(summary.query.scope.kind).toBe('character');
  });
  it('rejects malformed IPC input without killing subsequent reads or changing preferences',async()=>{
    store.setSetting('test-preserved',{favoriteIds:[1313],volume:42});
    await expect(client.read({...query,scope:{kind:'shared',characterKeys:['duplicate','duplicate']}})).rejects.toThrow();
    await expect(client.evidence({...query,limit:100000})).rejects.toThrow();
    expect((await client.read(query)).current.observations).toBe(0);
    expect(store.getSetting('test-preserved')).toEqual({favoriteIds:[1313],volume:42});
  });
  it('terminates pending access on close instead of leaving the app waiting',async()=>{
    const isolated=new HuntAnalyticsClient(store.filePath,path.join(directory,'worker.cjs'));
    const result=isolated.read(query);const rejection=expect(result).rejects.toThrow(/kapatıldı/);
    await isolated.close();await rejection;await expect(isolated.read(query)).rejects.toThrow(/kapanırken/);
  });
});
