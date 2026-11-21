import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import KillCountPanel from '../src/components/KillCountPanel';
import {createDefaultKillView} from '../src/shared/kill-view';
import {EMPTY_KILL_TOTALS} from '../src/domain/kill-workspace';

describe('summary kill screen',()=>{
 it('retains totals and daily navigation while discarding a saved event-history selection',()=>{
  const totals={...EMPTY_KILL_TOTALS,observedDeaths:123,monsterTypes:1};
  const html=renderToStaticMarkup(createElement(KillCountPanel,{state:{countBasis:'own-damage',revision:1,status:'stopped',characters:[],monsters:[{monsterId:1176,monsterName:'Summary Monster',lastKilledAt:null,totals}],totals,notice:''},characters:[],view:{...createDefaultKillView(),tab:'history',sort:'recent-desc',recordingKey:'legacy-record'}}));
  expect(html).toContain('Summary Monster');expect(html).toContain('123');expect(html).toContain('Günlük');expect(html).toContain('Tümü');
  for(const removed of ['Son görülme','Replay zamanı','Av geçmişi','Son gözlemler','Hunt Analytics','Kayıt arşivi'])expect(html).not.toContain(removed);
 });
 it('does not show all-time rows while a daily summary is loading',()=>{
  const totals={...EMPTY_KILL_TOTALS,observedDeaths:555,monsterTypes:1};
  const html=renderToStaticMarkup(createElement(KillCountPanel,{state:{revision:1,status:'stopped',characters:[],monsters:[{monsterId:1176,monsterName:'Only all-time',lastKilledAt:null,totals}],totals,notice:''},characters:[],view:{...createDefaultKillView(),scopeMode:'daily',dailyDate:'2026-11-06'}}));
  expect(html).not.toContain('Only all-time');expect(html).toContain('Günlük toplamlar yükleniyor');
 });
});
