import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import KillCountPanel from '../src/components/KillCountPanel';
import {killSearchKey,presentedKillMonsters} from '../src/domain/kill-presentation';
import type {KillCountMonster,KillCountState,KillCountTotals} from '../src/shared/kill-count';
const totals=(value=125):KillCountTotals=>({totalKills:null,confirmedPersonalKills:0,observedDeaths:value,unknownDeaths:value,killsPerHour:null,knownKillsPerHour:0,durationMs:360000,monsterTypes:2,uncertain:true,range:{min:0,max:value},timeBasis:'replay-start'});
const monster=(monsterId:number,monsterName:string,value:number):KillCountMonster=>({monsterId,monsterName,lastKilledAt:null,totals:totals(value)});
const state=(monsters:KillCountMonster[],summary=totals()):KillCountState=>({countBasis:'own-damage',revision:1,status:'tracking',characters:[],monsters,totals:summary,notice:'Synthetic normalized test state; not a wire-packet compatibility claim.'});
describe('Kill Count presentation',()=>{
  it('shows three aggregate cards with an explicit own-damage estimate and no personal/event details',()=>{
    const html=renderToStaticMarkup(createElement(KillCountPanel,{state:state([monster(1002,'Hode',100),monster(1003,'Sandman',25)]),characters:[]}));
    expect(html.match(/<div class="summary-kill-kpis">(.*?)<\/div>/)?.[1].match(/<section>/g)).toHaveLength(3);
    expect(html).toContain('Hasarına göre kesim');expect(html).toContain('Takip süresi');expect(html).toContain('Yaratık türü');expect(html).toContain('data-summary-kills="true">125');
    expect(html).toContain('kesin kişisel kesim değildir');expect(html.indexOf('Hode')).toBeLessThan(html.indexOf('Sandman'));
    for(const removed of ['data-kill-metric=','Gözlenen ölüm','Son görülme','Replay zamanı','Av geçmişi'])expect(html).not.toContain(removed);
  });
  it('shows an accepted damage estimate without promoting it to a confirmed personal total or fake zero',()=>{
    const unknown=totals(),hode=monster(1002,'Hode',100),source=state([hode],unknown),before=JSON.stringify(source);
    const html=renderToStaticMarkup(createElement(KillCountPanel,{state:source,characters:[]}));
    expect(html).toContain('data-summary-kills="true">125');expect(html).toContain('hasara dayalı tahmindir');expect(html).toContain('kesin kişisel kesim değildir');
    expect(html).not.toContain('data-summary-kills="true">0');expect(html).not.toContain('data-kill-metric=');expect(JSON.stringify(source)).toBe(before);
    expect(source.totals).toMatchObject({totalKills:null,confirmedPersonalKills:0,unknownDeaths:125});
  });
  it('shows a waiting state while the data feed is absent',()=>{const html=renderToStaticMarkup(createElement(KillCountPanel,{state:undefined,characters:[{key:'not-yet-read',name:'Çağrı'}]}));expect(html).toContain('Kill verisi bekleniyor');expect(html).toContain('data-summary-kills="true">—');expect(html).not.toContain('data-summary-kills="true">0');expect(html).toContain('value="not-yet-read"');expect(html).not.toContain('NaN');});
  it('matches Turkish case and plain-keyboard versions of monster names',()=>{const rows=[monster(1,'İğneci',2),monster(2,'Işık',1)];expect(presentedKillMonsters(rows,'iĞNECİ').map(row=>row.monsterId)).toEqual([1]);expect(presentedKillMonsters(rows,'isik').map(row=>row.monsterId)).toEqual([2]);expect(killSearchKey('ŞÖVALYE')).toBe('sovalye');});
  it('orders displayed counts descending without modifying the backend snapshot',()=>{const rows=[monster(1,'Sandman',25),monster(2,'Hode',100)];expect(presentedKillMonsters(rows,'').map(row=>row.monsterId)).toEqual([2,1]);expect(rows.map(row=>row.monsterId)).toEqual([1,2]);});
  it('keeps unknown-death observation numbers explicit in list ordering',()=>{const row=monster(1,'İğneci',0);row.totals={...totals(0),totalKills:null,observedDeaths:7,unknownDeaths:7,killsPerHour:null,uncertain:true};expect(presentedKillMonsters([monster(2,'Hode',3),row],'').map(value=>value.monsterId)).toEqual([1,2]);expect(row.totals.totalKills).toBeNull();});
});

