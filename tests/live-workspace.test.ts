import {describe,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AlertPreferences,AnalysisSummary,AppState,LiveStreamState} from '../src/shared/types';
import type {AutoFarmCharacter,AutoFarmItem,AutoFarmTotals} from '../src/shared/auto-farm';
import type {KillCountCharacter,KillCountMonster,KillCountTotals} from '../src/shared/kill-count';
import type {LiveTelemetry} from '../src/parser/types';
import {createDefaultAlertPreferences} from '../src/domain/notifications';
import {createDefaultLiveView} from '../src/shared/live-view';
import type {LiveAppearanceId} from '../src/shared/live-appearance';
import {buildLiveWorkspaceRows,filterLiveWorkspaceRows,isLiveSourceActive,liveHealthPercent,liveKnownFarmSummary,liveSourceCoverage,liveSourceIssue,liveTargetCount,liveWorkspacePage,paginateLiveSourceFields,selectedLiveSource,stableLiveWorkspaceRows} from '../src/domain/live-workspace';

// Pixel assets are verified by packaged UI QA; rendering behavior uses stable URLs.
vi.mock('../src/components/live-adventure-assets',()=>({LIVE_CHARACTER_ART:Object.fromEntries(['feminine-1','feminine-2','feminine-3','feminine-4','masculine-1','masculine-2','masculine-3'].map(id=>[id,`/art/${id}.png`])),LIVE_SCENE_ART:'/art/scene.png',LIVE_LOOT_ART:{card:'/art/loot-card.png',costume:'/art/loot-costume.png',generic:'/art/loot-generic.png'}}));

const prefs=createDefaultAlertPreferences;
const telemetry=(change:Partial<LiveTelemetry>={}):LiveTelemetry=>({hp:80,maxHp:100,weight:61,maxWeight:100,weightPercent:61,baseLevel:null,jobLevel:null,currentBaseExp:null,currentJobExp:null,nextBaseExp:null,nextJobExp:null,lastBaseExpGain:null,lastJobExpGain:null,baseExpGained:null,jobExpGained:null,currentMap:'SYNTHETIC-map-a',...change});
function stream(id:string,key:string|null='a',change:Partial<LiveStreamState>={},data:Partial<LiveTelemetry>={}):LiveStreamState {
  const summary:AnalysisSummary={durationMs:8*3600000,startedAt:'2026-11-02T12:00:00Z',mapName:'SYNTHETIC-map-a',characterName:'Çağrı',playerId:42,deaths:0,personalKills:0,inferredKills:0,partyKills:0,unknownKills:0,damage:0,exp:null,drops:null,monsters:[],timeline:[],liveTelemetry:telemetry(data)};
  return{id,filename:`SYNTHETIC-${id}.rrf`,sourcePath:`C:\\SYNTHETIC\\${id}.rrf`,status:'following',revision:1,readPosition:100,fileSize:100,bytesReadTotal:100,lastActivityAt:'2026-11-02T12:00:00Z',lastSuccessfulReadAt:null,diagnostics:[],packetCount:10,eventCount:0,summary,character:key===null?undefined:{key,name:key==='a'?'Çağrı':key,source:'recorded',playerId:42},compatibility:'skadi-unverified',...change};
}
const farmTotals=(change:Partial<AutoFarmTotals>={}):AutoFarmTotals=>({knownValue:20,estimatedValue:20,hourlyValue:2.5,knownHourlyValue:2.5,durationMs:8*3600000,unpricedItems:0,unpricedQuantity:0,partial:false,quantity:10,distinctItems:1,timeBasis:'replay-start',...change});
const item=(id:number,price:number|null,quantity=10):AutoFarmItem=>({itemId:id,itemName:`SYNTHETIC-item-${id}`,unitPrice:price,quantity,value:price===null?null:price*quantity,sourceLabel:'Çantaya gelen eşya'});
const farm=(key='a',items:AutoFarmItem[]=[item(603,2)]):AutoFarmCharacter=>({characterKey:key,characterName:'Aynı görünen ad',sessionId:'SYNTHETIC-session',status:'tracking',available:true,items,totals:farmTotals()});
const killTotals=(count:number):KillCountTotals=>({totalKills:null,confirmedPersonalKills:0,observedDeaths:count,unknownDeaths:count,killsPerHour:null,knownKillsPerHour:0,durationMs:8*3600000,monsterTypes:1,uncertain:true,range:{min:0,max:count},timeBasis:'replay-start'});
const killed=(id:number,count:number):KillCountMonster=>({monsterId:id,monsterName:'SYNTHETIC-target',lastKilledAt:'2026-11-02T12:00:00Z',totals:killTotals(count)});
const kill=(key='a',available=true):KillCountCharacter=>({characterKey:key,characterName:'Aynı görünen ad',sessionId:'SYNTHETIC-session',status:'tracking',available,monsters:[killed(1313,12)],totals:killTotals(12)});
function state(streams:LiveStreamState[],farms:AutoFarmCharacter[]=[],kills:KillCountCharacter[]=[]):AppState {
  return{records:[],jobs:[],folderFiles:[],settings:{replayFolder:null,databasePath:'SYNTHETIC-db',watchRequested:false,watchPermissionConfirmed:false,watchActive:false,watchPolicyVerified:false},live:{streams,limits:{maxWorkers:2,memoryBudgetBytes:128*1024*1024,perFileBytes:0,pollIntervalMs:500,settleMs:1000},activeWorkers:0,queuedCount:0,bufferedBytes:0,discovery:{enabled:false,folder:null,blockedReason:null},compatibility:'skadi-unverified',mode:'incremental'},expansion:{databasePath:'SYNTHETIC-db',finance:{version:1,revision:0,prices:[],sessions:[],events:[]},catalog:{counts:{item:0,monster:0,map:0,skill:0,drop:0,experience:0},sources:[],versions:0,licenseNotice:'SYNTHETIC'},autoFarm:{revision:1,status:'tracking',characters:farms,items:farms.flatMap(value=>value.items),prices:[],totals:farmTotals(),notice:'SYNTHETIC'},killCount:{revision:1,status:'tracking',characters:kills,monsters:[killed(1313,34)],totals:killTotals(34),notice:'SYNTHETIC'},inventoryInbox:[],experience:{},alertPreferences:{},persistenceNotice:'SYNTHETIC',error:null}};
}

describe('Replay EXP cap display',()=>{
  const render = async (baseLevel:number, jobLevel:number, jobClassId:number) => {
    const {default:Roster} = await import('../src/components/ReplayExperienceRoster');
    const input = stream('cap-test','a',{},{
      baseLevel, jobLevel, jobClassId,
      timedExp:{base:{balance:100},job:{balance:0,required:1000}},
    });
    input.summary!.startedAt = '2026-11-21T09:00:00';
    return renderToStaticMarkup(createElement(Roster,{state:state([input])}));
  };
  it('shows the terminal status instead of a next-level bar for each capped channel',async()=>{
    const html = await render(80,50,1);
    expect(html).toContain('data-exp-at-cap="base"');
    expect(html).toContain('data-exp-at-cap="job"');
    expect(html).not.toContain('<progress');
    expect(html).not.toContain('Seviyeye kalan');
  });
  it('labels the official threshold on a measured balance while preserving uncapped Job progress',async()=>{
    const html = await render(79,50,7);
    expect(html).toContain('GNJOY tablosu');
    expect(html).toContain('data-exp-remaining');
    expect(html).not.toContain('Seviye sınırında');
    expect((html.match(/<progress /g)??[])).toHaveLength(2);
  });
});

describe('Taskbar party membership',()=>{
  it('uses the pickup stream to select the right portrait, including when character names match',async()=>{
    const {default:TaskbarStrip}=await import('../src/components/TaskbarStrip');
    const source=state([stream('one','a'),stream('two','b',{character:{key:'b',name:'Çağrı',source:'manual',playerId:null}}),stream('three','c')]);
    const html=renderToStaticMarkup(createElement(TaskbarStrip,{state:source,view:{...createDefaultLiveView(),appearanceByCharacter:{a:'masculine-1',b:'feminine-4'}},pending:false,error:'',onExit:()=>{},
      scene:{id:'drop-17',streamId:'two',character:'Çağrı',at:0,itemId:17,itemName:'Şapka',quantity:2,category:'costume',audio:{muted:true,volume:0}}}));
    const scene=html.slice(html.indexOf('class="taskbar-drop-scene"'));
    expect(scene).toContain('data-category="costume"');
    expect(scene).toContain('Kostüm düştü! Çağrı, 2 adet Şapka aldı.');
    expect(scene).toContain('/art/feminine-4.png');
    expect(scene).toContain('/art/loot-costume.png');
    expect(scene).not.toContain('/art/masculine-1.png');
  });
  it('keeps the original avatar for a queued drop after its Replay source leaves the roster',async()=>{
    const {default:TaskbarStrip}=await import('../src/components/TaskbarStrip');
    const html=renderToStaticMarkup(createElement(TaskbarStrip,{state:state([]),view:{...createDefaultLiveView(),appearanceByCharacter:{a:'masculine-2'}},pending:false,error:'',onExit:()=>{},
      scene:{id:'drop-18',streamId:'closed',characterKey:'a',character:'Çağrı',at:0,itemId:18,itemName:'Pupa Card',quantity:1,category:'card',audio:{muted:false,volume:50}}}));
    expect(html).toContain('/art/masculine-2.png');
    expect(html).toContain('/art/loot-card.png');
  });
  it('includes the fourth and fifth character, keeps same-name identities distinct and totals only the displayed sources',async()=>{
    const {default:TaskbarStrip}=await import('../src/components/TaskbarStrip');
    const source=state([
      stream('current','a',{}, {zenyReceived:150}),
      stream('archived','a',{status:'paused'}, {zenyReceived:4000}),
      stream('second','b',{character:{key:'b',name:'Çağrı',source:'manual',playerId:null}}, {zenyReceived:0}),
      stream('third','c',{}, {zenyReceived:50}),stream('fourth','d'),stream('fifth','e'),
    ]);
    const html=renderToStaticMarkup(createElement(TaskbarStrip,{state:source,view:createDefaultLiveView(),pending:false,error:'',onExit:()=>{}}));
    expect(html.match(/<article\b/g)).toHaveLength(5);
    expect(html).toContain('data-stream-id="current"');
    expect(html).not.toContain('data-stream-id="archived"');
    expect(html).toContain('data-stream-id="fifth"');
    expect(html).toContain('Kısmi toplam');
    expect(html).toContain('+200');
  });
});

describe('Live workspace identities and source selection',()=>{
  it('groups by assigned identity while keeping unassigned or identical display names distinct',()=>{
    const unknown={key:'unassigned',name:'Çağrı',source:'unassigned' as const,playerId:null};
    const source=state([stream('one'),stream('two'),stream('three','b',{character:{key:'b',name:'Çağrı',source:'manual',playerId:null}}),stream('four',null,{character:unknown}),stream('five',null,{character:unknown})],[farm(),farm('b')],[kill(),kill('b')]);
    const before=JSON.stringify(source),rows=buildLiveWorkspaceRows(source,prefs());
    expect(rows.map(row=>row.key)).toEqual(['a','b','stream:four','stream:five']);expect(rows[0].streams).toHaveLength(2);
    expect(rows[0].farm?.characterKey).toBe('a');expect(rows[1].kill?.characterKey).toBe('b');expect(rows[2].farm).toBeUndefined();expect(rows[3].kill).toBeUndefined();
    expect(JSON.stringify(source)).toBe(before);
  });
  it('preserves explicit paused source telemetry without mixing active HP or map',()=>{
    const paused=stream('old','a',{status:'paused'},{hp:12,currentMap:'SYNTHETIC-old-map'}),active=stream('new','a',{}, {hp:94,currentMap:'SYNTHETIC-new-map'});
    expect(selectedLiveSource([paused,active])?.id).toBe('new');
    const row=buildLiveWorkspaceRows(state([paused,active]),prefs(),'old')[0];
    expect(row.stream).toBe(paused);expect(liveHealthPercent(row.stream)).toBe(12);expect(row.stream.summary?.liveTelemetry?.currentMap).toBe('SYNTHETIC-old-map');
    expect(buildLiveWorkspaceRows(state([active,paused]),prefs(),'old')[0].stream).toBe(paused);
    expect(selectedLiveSource([paused,active],'not-in-this-group')?.id).toBe('new');expect(selectedLiveSource([])).toBeUndefined();
  });
  it('removes repeated source IDs without duplicating a group or changing input',()=>{
    const first=stream('same'),rows=buildLiveWorkspaceRows(state([first,first,stream('other','b')]),prefs());
    expect(rows).toHaveLength(2);expect(rows[0].streams).toEqual([first]);
  });
  it('restores a paused selected source by its Windows path when runtime IDs change after restart',()=>{
    const path='C:\\Gravity\\Replay\\Chosen.rrf';
    const previous=stream('previous-runtime','a',{status:'paused',sourcePath:path});
    expect(selectedLiveSource([stream('active'),previous],path)?.id).toBe('previous-runtime');
    const restarted=stream('new-runtime','a',{status:'paused',sourcePath:path}, {hp:12,currentMap:'SYNTHETIC-chosen'});
    const row=buildLiveWorkspaceRows(state([stream('new-active'),restarted]),prefs(),'c:/gravity/replay/chosen.rrf')[0];
    expect(row.stream).toBe(restarted);expect(liveHealthPercent(row.stream)).toBe(12);expect(row.stream.summary?.liveTelemetry?.currentMap).toBe('SYNTHETIC-chosen');
  });
  it('uses exact character keys rather than equal names when joining stored farm and kills',()=>{
    const s=stream('one','a',{character:{key:'a',name:'Aynı görünen ad',source:'recorded',playerId:42}});
    const row=buildLiveWorkspaceRows(state([s],[farm('other')],[kill('other')]),prefs())[0];
    expect(row.farm).toBeUndefined();expect(row.kill).toBeUndefined();expect(liveTargetCount(row,1313)).toBeNull();
  });
  it('limits source-active language to file reading and watching modes without age inference',()=>{
    for(const status of ['following','settled','reading','analyzing'] as const)expect(isLiveSourceActive(status)).toBe(true);
    for(const status of ['paused','stopped','queued','error','missing','resource-wait'] as const)expect(isLiveSourceActive(status)).toBe(false);
    const old=stream('old','a',{status:'settled',lastActivityAt:'2000-01-01T00:00:00Z'});
    expect(buildLiveWorkspaceRows(state([old]),prefs())[0].attention).toBe(false);
  });
  it('uses validated folder activity rather than file age or successful reading as live evidence',()=>{
    const waiting=stream('waiting','a',{sourceMode:'folder',liveActivity:'waiting',status:'following',lastActivityAt:'2099-01-01T00:00:00Z',lastSuccessfulReadAt:'2099-01-01T00:00:00Z'});
    expect(isLiveSourceActive(waiting)).toBe(false);expect(isLiveSourceActive({...waiting,liveActivity:undefined})).toBe(false);
    expect(isLiveSourceActive({...waiting,liveActivity:'live',lastValidatedProgressAt:'2026-11-07T00:00:00Z'})).toBe(true);
    expect(isLiveSourceActive({...waiting,liveActivity:'live',status:'queued'})).toBe(true);
    expect(isLiveSourceActive({...waiting,liveActivity:'idle'})).toBe(false);expect(isLiveSourceActive({...waiting,liveActivity:'live',status:'paused'})).toBe(false);
  });
  it('automatically follows the progressing folder source instead of a saved idle recording',()=>{
    const old=stream('old','a',{sourceMode:'folder',liveActivity:'idle',lastActivityAt:'2099-01-01T00:00:00Z'},{hp:12,currentMap:'old-map'});
    const current=stream('current','a',{sourceMode:'folder',liveActivity:'live',lastValidatedProgressAt:'2026-11-07T00:00:01Z'},{hp:94,currentMap:'new-map'});
    const newer=stream('newer','a',{sourceMode:'folder',liveActivity:'live',lastValidatedProgressAt:'2026-11-07T00:00:02Z'});
    const row=buildLiveWorkspaceRows(state([old,current]),prefs(),old.sourcePath)[0];
    expect(row.stream).toBe(current);expect(liveHealthPercent(row.stream)).toBe(94);expect(row.stream.summary?.liveTelemetry?.currentMap).toBe('new-map');
    expect(selectedLiveSource([old,current,newer],current.id)).toBe(newer);
  });
});

describe('Live attention and scoped observations',()=>{
  it('checks weight only on the displayed source rather than a paused historical recording',()=>{
    const source=state([stream('current','a',{}, {weightPercent:42}),stream('old','a',{status:'paused'}, {weightPercent:78})]);
    expect(buildLiveWorkspaceRows(source,prefs())[0].attention).toBe(false);
    expect(buildLiveWorkspaceRows(source,prefs(),'old')[0].attentionReasons).toEqual(['Son bilinen ağırlık uyarı eşiğinde']);
  });
  it('uses per-character weight threshold and reports problems from every source',()=>{
    const source=state([stream('active','a',{}, {weightPercent:78}),stream('missing','a',{status:'missing'}),stream('resource','b',{status:'resource-wait'})]);
    source.expansion!.alertPreferences.a={enabled:{'base-level':false,'job-level':false,'base-90':false,'job-90':false,'valuable-item':false,'item-value':false,'hourly-goal':false,'exp-idle':false},allowEstimated:false,itemValueThreshold:0,hourlyGoal:0,expIdleMinutes:1,cooldownSeconds:1,legacy:{weightThreshold:80}};
    const rows=buildLiveWorkspaceRows(source,prefs());expect(rows[0].threshold).toBe(80);expect(rows[0].attentionReasons).toEqual(['Kaynak dosya bulunamadı']);expect(rows[1].attention).toBe(true);
    source.expansion!.alertPreferences.a.legacy.weightThreshold=78;
    expect(buildLiveWorkspaceRows(source,prefs())[0].attentionReasons).toContain('Son bilinen ağırlık uyarı eşiğinde');
  });
  it('keeps unknown HP unknown and a real zero HP at zero',()=>{
    expect(liveHealthPercent(stream('dead','a',{}, {hp:0}))).toBe(0);
    expect(liveHealthPercent(stream('unknown','a',{}, {hp:null}))).toBeNull();
    expect(liveHealthPercent(stream('invalid','a',{}, {maxHp:0}))).toBeNull();
    expect(liveHealthPercent(stream('excess','a',{}, {hp:120}))).toBe(100);
  });
  it('takes the target count from this character only and keeps missing feed unknown',()=>{
    const row=buildLiveWorkspaceRows(state([stream('one')],[],[kill()]),prefs())[0];
    expect(liveTargetCount(row,1313)).toBe(12);expect(liveTargetCount(row,1001)).toBe(0);expect(liveTargetCount(row,null)).toBeNull();expect(liveTargetCount(row,0x100000000)).toBeNull();
    row.kill={...row.kill!,available:false};expect(liveTargetCount(row,1313)).toBeNull();
  });
});

describe('Read-only known farm summaries',()=>{
  it('distinguishes genuine zero, all unknown prices and partially priced zero values',()=>{
    const row=buildLiveWorkspaceRows(state([stream('one')],[farm('a',[item(603,0),item(746,null)])]),prefs())[0];
    expect(liveKnownFarmSummary(row)).toMatchObject({available:true,knownValue:0,knownHourlyValue:0,partial:true,unpricedItems:1});
    expect(liveKnownFarmSummary(row,new Map([[603,null]]))).toMatchObject({available:true,knownValue:null,knownHourlyValue:null,partial:true,unpricedItems:2});
    expect(liveKnownFarmSummary({...row,farm:undefined})).toMatchObject({available:false,knownValue:null,knownHourlyValue:null});
  });
  it('values overrides without changing prices, quantities, duration or ledger rows',()=>{
    const source=state([stream('one')],[farm()]),before=JSON.stringify(source),row=buildLiveWorkspaceRows(source,prefs())[0];
    expect(liveKnownFarmSummary(row,new Map([[603,35000]]))).toMatchObject({knownValue:350000,knownHourlyValue:43750,durationMs:28800000,partial:false});
    row.farm!.totals.durationMs=0;expect(liveKnownFarmSummary(row).knownHourlyValue).toBeNull();row.farm!.totals.durationMs=28800000;
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe('Dense live list filtering and stable pagination',()=>{
  it('matches Turkish accents, selected source map and stored filenames',()=>{
    const row=buildLiveWorkspaceRows(state([stream('kayit','a',{character:{key:'a',name:'Işık Çığ',source:'manual',playerId:null}}, {currentMap:'SYNTHETIC-İğne'}),stream('other','a',{status:'paused'}, {currentMap:'SYNTHETIC-old'})]),prefs())[0],view=createDefaultLiveView();
    expect(filterLiveWorkspaceRows([row],'isik cig',view)).toEqual([row]);expect(filterLiveWorkspaceRows([row],'igne',view)).toEqual([row]);expect(filterLiveWorkspaceRows([row],'kayit',view)).toEqual([row]);
    expect(filterLiveWorkspaceRows([row],'SYNTHETIC-old',view)).toEqual([]);
  });
  it('filters favorites and attention without changing the source or totals',()=>{
    const source=state([stream('a'),stream('b','b',{}, {weightPercent:78})],[farm(),farm('b')]),before=JSON.stringify(source),rows=buildLiveWorkspaceRows(source,prefs()),view=createDefaultLiveView();
    expect(filterLiveWorkspaceRows(rows,'',{...view,onlyAttention:true}).map(row=>row.key)).toEqual(['b']);
    expect(filterLiveWorkspaceRows(rows,'',{...view,favoriteKeys:['a'],filter:'favorites'}).map(row=>row.key)).toEqual(['a']);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('keeps accepted order and announces a new group instead of jumping the current list',()=>{
    const rows=buildLiveWorkspaceRows(state([stream('first','a'),stream('second','b')]),prefs());
    const stable=stableLiveWorkspaceRows([...rows].reverse(),['a','b']);expect(stable.rows.map(row=>row.key)).toEqual(['a','b']);expect(stable.pending).toBe(0);
    expect(stableLiveWorkspaceRows(rows,['a'])).toMatchObject({rows:[rows[0]],pending:1});
  });
  it('keeps an accepted source visible when its initially unknown recorded identity arrives',()=>{
    const assigned=buildLiveWorkspaceRows(state([stream('source-a','a')]),prefs());
    expect(stableLiveWorkspaceRows(assigned,['stream:source-a'])).toMatchObject({rows:assigned,pending:0});
    expect(stableLiveWorkspaceRows(assigned,['stream:source-a','a']).rows).toHaveLength(1);
  });
  it('retains row position through explicit identity reassignment without accepting new file paths',()=>{
    const accepted=new Map([['old-character',['C:\\SYNTHETIC\\chosen.rrf']],['other-old',['C:\\SYNTHETIC\\merged.rrf']]]);
    const updated=buildLiveWorkspaceRows(state([stream('new-id','new-character',{sourcePath:'c:/synthetic/CHOSEN.rrf'}),stream('merged-id','new-character',{sourcePath:'C:\\SYNTHETIC\\merged.rrf'}),stream('new-source','other',{sourcePath:'C:\\SYNTHETIC\\never-accepted.rrf'})]),prefs());
    const stable=stableLiveWorkspaceRows(updated,['old-character','other-old'],accepted);
    expect(stable.rows.map(row=>row.key)).toEqual(['new-character']);expect(stable.pending).toBe(1);expect(stable.rows[0].streams).toHaveLength(2);
    expect(stableLiveWorkspaceRows(updated,['old-character'],new Map([['old-character',['C:\\SYNTHETIC\\gone.rrf']]]))).toMatchObject({rows:[],pending:2});
  });
  it('pages one thousand sources and ten thousand priced items without per-item copies',()=>{
    const source=state(Array.from({length:1000},(_,i)=>stream(`source-${i}`,`character-${i}`)),[farm('character-0',Array.from({length:10000},(_,i)=>item(i+1,i%2===0?1:null,1)))]),before=JSON.stringify(source),rows=buildLiveWorkspaceRows(source,prefs());
    expect(rows).toHaveLength(1000);expect(liveWorkspacePage(rows,0,3).rows).toHaveLength(3);expect(liveWorkspacePage(rows,9999,6)).toMatchObject({page:166,from:997,to:1000});expect(liveWorkspacePage(rows,0,10000).rows).toHaveLength(10);
    expect(liveKnownFarmSummary(rows[0])).toMatchObject({knownValue:5000,partial:true,unpricedItems:5000});expect(JSON.stringify(source)).toBe(before);
    expect(liveWorkspacePage([],0,0)).toMatchObject({rows:[],page:0,pages:1,from:0,to:0,size:1});
  });
});

describe('Live source health and measured field pagination',()=>{
  it('distinguishes a stopped source group from partially available cumulative observations',()=>{
    const failed=stream('failed','a',{status:'error'}),healthy=stream('healthy'),paused=stream('paused','a',{status:'paused'});
    expect(liveSourceCoverage([failed])).toEqual({total:1,blocked:1,allBlocked:true,label:'Son doğru özet'});
    expect(liveSourceCoverage([failed,healthy])).toEqual({total:2,blocked:1,allBlocked:false,label:'1 kaynak eksik'});
    expect(liveSourceCoverage([failed,paused]).allBlocked).toBe(false);
    expect(liveSourceCoverage([])).toEqual({total:0,blocked:0,allBlocked:false,label:null});
  });
  it('uses plain language without turning bag baseline uncertainty into a reader failure',()=>{
    const source=stream('one');source.summary!.inventoryBaselineKnown=false;
    expect(liveSourceIssue(source)).toBeNull();expect(liveSourceCoverage([source]).blocked).toBe(0);
    expect(liveSourceIssue({...source,status:'error',diagnostics:['SYNTHETIC internal packet 0xFFFF']})).toEqual({label:'Okuma durdu',reason:'Kayıt çözümlenemedi. Son doğru veriler gösteriliyor.'});
    expect(liveSourceIssue({...source,status:'error',summary:null})?.reason).toContain('Geçerli veri bekleniyor');
    expect(liveSourceIssue({...source,status:'missing'})?.reason).toContain('Kaynak dosya bulunamadı');
  });
  it('paginates complete Unicode diagnostics and newlines according to measured capacity',()=>{
    const value='İlk satır\n\nÇanta 🎒 gözlemi; '+('uzun tanı metni / 漢字 🧪\n'.repeat(35)),fields=[{label:'Açıklama 1',value},{label:'Kaynak yolu',value:'C:\\SYNTHETIC\\'+('x'.repeat(400))+'.rrf'}];
    const pages=paginateLiveSourceFields(fields,text=>Array.from(text).length<=37);
    expect(pages.length).toBeGreaterThan(20);expect(pages.every(page=>Array.from(page.value).length<=37)).toBe(true);
    expect(pages.filter(page=>page.label.startsWith('Açıklama 1')).map(page=>page.value).join('')).toBe(value);
    expect(pages.filter(page=>page.label.startsWith('Kaynak yolu')).map(page=>page.value).join('')).toBe(fields[1].value);
  });
  it('adjusts page capacity without discarding any diagnostic text',()=>{
    const fields=[{label:'Hata',value:'bir iki üç dört beş altı yedi sekiz dokuz'}];
    const small=paginateLiveSourceFields(fields,text=>text.length<=9),large=paginateLiveSourceFields(fields,text=>text.length<=18);
    expect(small.length).toBeGreaterThan(large.length);expect(small.map(page=>page.value).join('')).toBe(fields[0].value);expect(large.map(page=>page.value).join('')).toBe(fields[0].value);
  });
});

describe('Dense live workspace rendering',()=>{
  async function render(source:AppState,selected:string|null=null,appearanceByCharacter:Record<string,LiveAppearanceId>={}){
    const {default:LiveWorkspace}=await import('../src/components/LiveWorkspace');
    const noop=()=>{};
    return renderToStaticMarkup(createElement(LiveWorkspace,{state:source,prefs:prefs(),audioReady:true,busy:false,recentNotifications:[],view:{...createDefaultLiveView(),appearanceByCharacter,characterKey:selected,sourcePath:selected?source.live!.streams.find(item=>item.character?.key===selected)?.sourcePath??null:null},pinnedTargetId:1313,onViewChange:noop,onPinnedTarget:noop,onAddFiles:noop,onAudioToggle:noop,onControl:noop,onAssign:noop,onOpenFinance:noop,onOpenKillCount:noop,onAddFolder:noop,onRefreshSources:noop}));
  }
  it('offers one folder choice and no repeated individual file picker',async()=>{
    const html=await render(state([]));
    expect((html.match(/>Replay klasörünü seç<\/button>/g)??[])).toHaveLength(1);
    expect(html).not.toContain('Dosya ekle');expect(html).not.toContain('Dosya seç');expect(html).toContain('Sonraki açılışlarda seçimin hatırlanır');
  });
  it('keeps a selected empty folder in a clear automatic waiting state',async()=>{
    const source=state([]);source.settings.replayFolder='C:\\SYNTHETIC\\Replay';source.live!.discovery={enabled:true,folder:source.settings.replayFolder,blockedReason:null,candidateCount:8};
    const html=await render(source);
    expect(html).toContain('Klasörü değiştir');expect(html).toContain('Replay bekleniyor');expect(html).toContain('8 kayıt bulundu');
    expect(html).not.toContain('Dosya seç');expect(html).not.toContain('Dosya ekle');
  });
  it('shows waiting, live and idle activity clearly while retaining the last telemetry',async()=>{
    for(const[liveActivity,label]of [['waiting','Bekleniyor'],['live','Canlı'],['idle','Durdu']] as const){
      const source=state([stream('one','a',{sourceMode:'folder',liveActivity,lastSuccessfulReadAt:'2026-11-07T00:00:00Z'})]);
      source.live!.discovery={enabled:true,folder:'C:\\SYNTHETIC\\Replay',blockedReason:null};
      const html=await render(source,'a',{a:'masculine-1'});expect(html).toContain(`<strong>${label}</strong>`);expect(html).toContain('%80');
      expect(html.includes('data-live-animating="true"')).toBe(liveActivity==='live');
    }
  });
  it('renders only three initial source groups and no price fields for one thousand sources and ten thousand items',async()=>{
    const source=state(Array.from({length:1000},(_,i)=>stream(`source-${i}`,`character-${i}`)),[farm('character-0',Array.from({length:10000},(_,i)=>item(i+1,i%2===0?1:null,1)))]),before=JSON.stringify(source);
    const html=await render(source);
    expect((html.match(/class="live-character-row"/g)??[])).toHaveLength(3);
    expect(html).not.toContain('data-price-item-id');expect(html).not.toContain('character-farm-items');expect(html).not.toContain('SYNTHETIC-item-9999');
    expect(html).toContain('Canlı takip');expect(JSON.stringify(source)).toBe(before);
  });
  it('shows selected character raw observations separately from the shared target total',async()=>{
    const source=state([stream('one')],[farm()],[kill()]);
    source.expansion!.targetHunt={revision:1,session:null,targets:[{monsterId:1313,monsterName:'Mobster',deathCount:34,rawObservations:50,duplicateCandidates:16,lastDeathAt:null,lastIntervalMs:null,completedIntervals:0,averageIntervalMs:null,sinceLastDeathMs:null,continuityBroken:true}],notice:'SYNTHETIC'};
    const html=await render(source,'a');
    expect(html).toContain('data-live-global-target="true">34 ortak gözlem');expect(html).toContain('data-live-character-target="true">12');
    expect(html).toContain('Bu karakterin kayıtlarında');expect(html).toContain('Tüm kaynaklar');expect(html).not.toContain('12 kişisel kill');
    expect(html).not.toContain('data-price-item-id');
  });
  it('renders known zero farm value without inventing zero for an unknown price',async()=>{
    const known=await render(state([stream('one')],[farm('a',[item(603,0)])]),'a');
    expect(known).toContain('≈0 Zeny');
    const unknown=await render(state([stream('one')],[farm('a',[item(603,null)])]),'a');
    expect(unknown).toContain('Fiyat bekleniyor');expect(unknown).not.toContain('≈0 Zeny');
    expect(unknown).toContain('data-live-character-target="true">—');
  });
  it('keeps the last values visible and marks reader failure before opening source details',async()=>{
    const failed=stream('one','a',{status:'error',lastActivityAt:new Date().toISOString(),lastSuccessfulReadAt:new Date(Date.now()-120000).toISOString(),diagnostics:['SYNTHETIC internal packet 0xFFFF']},{hp:73,weightPercent:42});
    const source=state([failed],[farm()],[kill()]);
    source.expansion!.targetHunt={revision:1,session:null,targets:[{monsterId:1313,monsterName:'Mobster',deathCount:34,rawObservations:50,duplicateCandidates:16,lastDeathAt:null,lastIntervalMs:null,completedIntervals:0,averageIntervalMs:null,sinceLastDeathMs:null,continuityBroken:true}],notice:'SYNTHETIC'};
    const html=await render(source,'a');
    expect(html).toContain('data-live-read-health="stopped"');expect(html).toContain('Kayıt çözümlenemedi. Son doğru veriler gösteriliyor.');
    expect(html).toContain('Okuma durdu');expect(html).toContain('Son doğru:');expect(html).toContain('2 dk önce');expect(html).toContain('%73');expect(html).toContain('≈20 Zeny');expect(html).toContain('data-live-character-target="true">12');expect(html).toContain('data-live-global-target="true">34 ortak gözlem');
    expect(html).not.toContain('Son dosya değişimi');expect(html).not.toContain('0xFFFF');
  });
  it('keeps cumulative counts available when another source for the character is healthy',async()=>{
    const source=state([stream('failed','a',{status:'error'}),stream('healthy','a')],[farm('a',[item(603,2),item(746,null)])],[kill()]);
    source.expansion!.targetHunt={revision:1,session:null,targets:[{monsterId:1313,monsterName:'Mobster',deathCount:34,rawObservations:50,duplicateCandidates:16,lastDeathAt:null,lastIntervalMs:null,completedIntervals:0,averageIntervalMs:null,sinceLastDeathMs:null,continuityBroken:true}],notice:'SYNTHETIC'};
    const html=await render(source,'a');
    expect(html).toContain('data-live-read-health="partial"');expect(html).toContain('Bazı kaynaklar okunamıyor; toplamlar eksik olabilir.');expect(html).toContain('1 kaynak eksik');expect(html).toContain('Kısmi fiyat');expect(html).not.toContain('Son doğru özet');expect(html).toContain('≈20 Zeny');expect(html).toContain('data-live-character-target="true">12');expect(html).toContain('data-live-global-target="true">34 ortak gözlem');
  });
  it('shows bag synchronization independently of successful source reading',async()=>{
    const source=stream('one');source.summary!.inventoryBaselineKnown=false;
    const html=await render(state([source],[farm()]),'a');
    expect(html).toContain('Çanta eşitlemesi bekleniyor');expect(html).toContain('data-live-read-health="ready"');expect(html).not.toContain('Okuma durdu');expect(html).toContain('≈20 Zeny');
  });
  it('uses cosmetic choices by exact character key and leaves unchosen characters neutral',async()=>{
    const source=state([stream('one','a'),stream('two','b',{character:{key:'b',name:'Çağrı',source:'recorded',playerId:43}}),stream('three','c')]),before=JSON.stringify(source);
    const html=await render(source,null,{a:'feminine-2',b:'masculine-3'});
    expect(html).toContain('data-live-appearance="feminine-2"');expect(html).toContain('data-live-appearance="masculine-3"');expect(html).toContain('data-live-appearance="default"');
    expect((html.match(/class="live-character-art"/g)??[])).toHaveLength(2);expect(html).toContain('Görünümler temsili');expect(JSON.stringify(source)).toBe(before);
  });
  it('animates only chosen artwork whose displayed source is readable and active',async()=>{
    const html=await render(state([stream('one','a'),stream('two','b',{status:'paused'}),stream('three','c',{status:'error'})]),null,{a:'feminine-1',b:'feminine-1',c:'feminine-1'});
    expect((html.match(/data-live-animating="true"/g)??[])).toHaveLength(1);expect((html.match(/data-live-animating="false"/g)??[])).toHaveLength(2);expect(html).toContain('Okuma durdu');
  });
  it('shows a bounded selected-character loot strip with shared generic art and retained quantities',async()=>{
    const source=state([stream('one','a'),stream('two','b')],[farm('a',[{...item(4317,100,3),itemName:'QA Card'},{...item(480001,100,2),itemName:'Costume QA Hood'},{...item(603,100,10),itemName:'Old Blue Box'},{...item(746,100,5),itemName:'Glass Bead'},...Array.from({length:10000},(_,i)=>item(1000000+i,1,1))]),farm('b',[{...item(4318,1,50),itemName:'Other Card'}])]),before=JSON.stringify(source);
    const html=await render(source,'a');
    expect((html.match(/data-loot-item-id=/g)??[])).toHaveLength(4);expect(html).toContain('data-loot-kind="card" data-loot-item-id="4317"');expect(html).toContain('data-loot-kind="costume" data-loot-item-id="480001"');
    expect(html).toContain('data-loot-kind="generic" data-loot-item-id="603"');expect(html).toContain('data-loot-kind="generic" data-loot-item-id="746"');expect((html.match(/src="[^\"]*loot-generic[^\"]*"/g)??[])).toHaveLength(2);
    expect(html).toContain('3 adet');expect(html).toContain('2 adet');expect(html).not.toContain('Other Card');expect(html).not.toContain('Üzerindeki ekipman');expect(html).not.toContain('SYNTHETIC-item-1009999');expect(JSON.stringify(source)).toBe(before);
  });
  it('keeps the seven-choice appearance picker cosmetic and grouped without assigning a class',async()=>{
    const {default:Picker}=await import('../src/components/LiveAppearancePicker');
    const html=renderToStaticMarkup(createElement(Picker,{characterName:'QA Karakter',selected:'feminine-4',onSelect:()=>{},onClose:()=>{}}));
    expect((html.match(/data-appearance-id=/g)??[])).toHaveLength(7);expect((html.match(/data-appearance-id="feminine-/g)??[])).toHaveLength(4);expect((html.match(/data-appearance-id="masculine-/g)??[])).toHaveLength(3);
    expect(html).toContain('QA Karakter için görünüm seç');expect(html).toContain('Oyundaki kıyafetin veya sınıfın değildir.');expect(html).toContain('Varsayılan simge');expect((html.match(/aria-pressed="true"/g)??[])).toHaveLength(1);
  });
});
