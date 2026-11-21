import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {KillCountMonster,KillCountState,KillCountTotals} from '../src/shared/kill-count';
import {createDefaultKillView} from '../src/shared/kill-view';
import {filterKillWorkspace,killWorkspacePage,killWorkspaceScope,sortKillWorkspace,stableKillWorkspace} from '../src/domain/kill-workspace';
import KillCountPanel from '../src/components/KillCountPanel';

function totals(count:number):KillCountTotals{return{totalKills:null,confirmedPersonalKills:0,observedDeaths:count,unknownDeaths:count,killsPerHour:null,knownKillsPerHour:null,durationMs:8*3600000,monsterTypes:1,uncertain:true,range:{min:0,max:count},timeBasis:'replay-start'};}
function monster(monsterId:number,name:string,count:number,time:string|null=null):KillCountMonster{return{monsterId,monsterName:name,totals:totals(count),lastKilledAt:time};}
function state(monsters:KillCountMonster[]):KillCountState{return{countBasis:'own-damage',revision:1,status:'tracking',characters:[{characterKey:'a',characterName:'Çağrı',sessionId:null,status:'tracking',available:true,monsters:monsters.slice(0,2),totals:totals(monsters.slice(0,2).reduce((sum,row)=>sum+row.totals.observedDeaths,0))}],monsters,totals:totals(monsters.reduce((sum,row)=>sum+row.totals.observedDeaths,0)),notice:'Synthetic data only'};}
const sample=[monster(1313,'Mobster',34,'2026-11-02T18:42:00Z'),monster(1,'İğneci',12,'2026-11-02T18:50:00Z'),monster(2,'Işık',7),monster(3,'Poring',312,'2026-11-02T17:00:00Z')];

describe('Kill Count dense workspace selectors',()=>{
  it('uses raw observation counts consistently even when only some personal kills are proven',()=>{
    const partial={...monster(5,'Partial',99),totals:{...totals(99),confirmedPersonalKills:1}};
    expect(sortKillWorkspace([sample[0],partial],'count-desc').map(row=>row.monsterId)).toEqual([5,1313]);
    expect(partial.totals.totalKills).toBeNull();expect(partial.totals.confirmedPersonalKills).toBe(1);
  });
  it('sorts all supported keys, with unknown times after actual Replay times',()=>{
    expect(sortKillWorkspace(sample,'count-desc').map(row=>row.monsterId)).toEqual([3,1313,1,2]);
    expect(sortKillWorkspace(sample,'count-asc').map(row=>row.monsterId)).toEqual([2,1,1313,3]);
    expect(sortKillWorkspace(sample,'recent-desc').map(row=>row.monsterId)).toEqual([1,1313,3,2]);
    expect(sortKillWorkspace(sample,'name-asc').map(row=>row.monsterId)).toEqual([2,1,1313,3]);
  });
  it('matches Turkish plain keyboard queries and Monster IDs while favorite filters leave totals untouched',()=>{
    const source=state(sample),before=JSON.stringify(source);
    expect(filterKillWorkspace(sample,'igneci',false,[]).map(row=>row.monsterId)).toEqual([1]);
    expect(filterKillWorkspace(sample,'isik',false,[]).map(row=>row.monsterId)).toEqual([2]);
    expect(filterKillWorkspace(sample,'#1313',false,[]).map(row=>row.monsterId)).toEqual([1313]);
    expect(filterKillWorkspace(sample,'',true,[2,1313]).map(row=>row.monsterId)).toEqual([1313,2]);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('scopes character observations and durations without mutating the global snapshot',()=>{
    const source=state(sample),before=JSON.stringify(source);
    expect(killWorkspaceScope(source,null).monsters).toBe(source.monsters);
    expect(killWorkspaceScope(source,'a').totals.observedDeaths).toBe(46);
    expect(killWorkspaceScope(source,'removed')).toMatchObject({available:false,monsters:[]});
    expect(JSON.stringify(source)).toBe(before);
  });
  it('preserves accepted order through live count changes and reveals new types only on explicit capture',()=>{
    const ids=sortKillWorkspace(sample,'count-desc').map(row=>row.monsterId),changed=sample.map(row=>row.monsterId===2?monster(2,'Işık',9999):row),newRow=monster(99,'New',50000);
    const frozen=stableKillWorkspace([...changed,newRow],ids);
    expect(frozen.monsters.map(row=>row.monsterId)).toEqual(ids);expect(frozen.pending).toBe(1);
    expect(frozen.monsters.find(row=>row.monsterId===2)?.totals.observedDeaths).toBe(9999);
    const refreshed=stableKillWorkspace([...changed,newRow],sortKillWorkspace([...changed,newRow],'count-desc').map(row=>row.monsterId));
    expect(refreshed.pending).toBe(0);expect(refreshed.monsters[0].monsterId).toBe(99);
  });
  it('bounds each allowed page size and clamps empty or stale pages',()=>{
    const many=Array.from({length:10000},(_,index)=>monster(index+1,`Yaratık ${index}`,index));
    for(const size of [25,50,100] as const)expect(killWorkspacePage(many,2,size).items).toHaveLength(size);
    expect(killWorkspacePage(sample,999,25)).toMatchObject({page:0,pages:1,from:1,to:4});
    expect(killWorkspacePage([],99,50)).toMatchObject({page:0,pages:1,from:0,to:0,items:[]});
  });
});

describe('Kill Count workspace SSR contracts',()=>{
  it('renders only fifty rows with ten thousand creature types and preserves the source',()=>{
    const many=Array.from({length:10000},(_,index)=>monster(index+1,`Yaratık ${index}`,index+1)),source=state(many),before=JSON.stringify(source);
    const html=renderToStaticMarkup(createElement(KillCountPanel,{state:source,characters:[],view:createDefaultKillView()}));
    expect(html.match(/data-kill-monster=/g)).toHaveLength(50);
    expect(html.match(/<div class="summary-kill-kpis">(.*?)<\/div>/)?.[1].match(/<section>/g)).toHaveLength(3);
    expect(html).toContain('Hasarına göre kesim');expect(html).toContain('Takip süresi');expect(html).toContain('Yaratık türü');expect(html).toContain('Kill Count canavar ara');
    expect(html).toContain('data-kill-all-total="true">50.005.000');
    for(const removed of ['Son görülme','Replay zamanı','Av geçmişi','Kayıt arşivi','Sıralamayı yenile'])expect(html).not.toContain(removed);
    expect(html).not.toContain('data-price-item-id');expect(html).not.toContain('Karşılaştır');expect(html).not.toContain('CSV');
    expect(JSON.stringify(source)).toBe(before);
  });
  it('keeps favorites and alert targets separate without restoring the retired analytics or event-time panels',()=>{
    const hunt={revision:1,session:null,targets:[{monsterId:1313,monsterName:'Mobster',deathCount:34,rawObservations:34,duplicateCandidates:0,lastDeathAt:null,lastIntervalMs:240000,completedIntervals:2,averageIntervalMs:300000,sinceLastDeathMs:120000,continuityBroken:false},{monsterId:1,monsterName:'İğneci',deathCount:1,rawObservations:1,duplicateCandidates:0,lastDeathAt:null,lastIntervalMs:null,completedIntervals:0,averageIntervalMs:null,sinceLastDeathMs:null,continuityBroken:true}],notice:'Synthetic'};
    const view={...createDefaultKillView(),favoriteIds:[2],pinnedTargetId:1},targets=[1313];
    const html=renderToStaticMarkup(createElement(KillCountPanel,{state:state(sample),characters:[],hunt,targetIds:targets,view}));
    expect(html).toContain('aria-label="Işık favori" aria-pressed="true"');expect(html).toContain('aria-label="Mobster favori" aria-pressed="false"');
    expect(html).toContain('aria-label="1313 yaratığını kaldır"');expect(html).not.toContain('aria-label="2 yaratığını kaldır"');expect(html).toContain('Bildirim hedeflerini düzenle');
    for(const removed of ['data-hunt-monster=','Av performansı özeti','Önceki 7 gün karşılaştırması','data-hunt-metric=','Son görülme'])expect(html).not.toContain(removed);
    expect(targets).toEqual([1313]);expect(view.favoriteIds).toEqual([2]);
    expect(hunt.targets.map(row=>row.monsterId)).toEqual([1313,1]);
  });
  it('does not invent wall-clock ages or personal kills from observational rows',()=>{
    const anchored=state([{...sample[0],totals:{...sample[0].totals,timeBasis:'observation-anchor'}}]);
    const html=renderToStaticMarkup(createElement(KillCountPanel,{state:anchored,characters:[]}));
    expect(html).toContain('data-summary-kills="true">34');expect(html).toContain('hasara dayalı tahmindir');
    expect(html).toContain('Tarihi doğrulanamayan kesimler Tümü içinde korunur');
    for(const removed of ['data-kill-metric=','18:42:00','2026-11-02T18:42:00Z','Son görülme'])expect(html).not.toContain(removed);
    expect(anchored.totals).toMatchObject({totalKills:null,confirmedPersonalKills:0,unknownDeaths:34});
  });
});
