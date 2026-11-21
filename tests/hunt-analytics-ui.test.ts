import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {AnalyticsMetrics,HuntTrendChart} from '../src/components/HuntAnalyticsWorkspace';
import type {HuntAnalyticsDay,HuntAnalyticsState} from '../src/shared/hunt-analytics';

const day=(date:string,durationMs:number,observations:number,ratePerHour:number|null,partial=false):HuntAnalyticsDay=>({date,durationMs,observations,ratePerHour,partial,excludedObservations:0,excludedDurationMs:0});
function state():HuntAnalyticsState{return{
  query:{monsterId:1313,date:'2026-11-05',scope:{kind:'character',characterKey:'a'},reference:'previous-day',trendDays:7},revision:1,timeZone:'Europe/Istanbul',monsterName:'Mobster',durationBasis:'character-replay',
  current:{observations:60,durationMs:4*3600000,ratePerHour:15,excludedObservations:0,excludedDurationMs:0},
  reference:{observations:40,durationMs:2*3600000,ratePerHour:20,excludedObservations:0,excludedDurationMs:0,startDate:'2026-11-04',endDate:'2026-11-04',trackedDays:1},
  comparison:{eligible:true,rateChangePercent:-25,countChangePercent:50,referenceEquivalentCount:80,reason:null},days:[],quality:{partial:false,reasons:[],excludedObservations:0,excludedDurationMs:0,legacyObservations:0},rhythm:null,insight:'',notice:'',
};}
describe('Av analysis presentation contracts',()=>{
  it('distinguishes no tracking from tracked zero observations in both chart and readable values',()=>{
    const html=renderToStaticMarkup(createElement(HuntTrendChart,{metric:'count',days:[day('2026-11-03',0,0,null),day('2026-11-04',3600000,0,0),day('2026-11-05',3600000,12,12)]}));
    expect(html).toContain('3 Kas: Kayıt yok');expect(html).toContain('4 Kas: 0 gözlem');expect(html).toContain('5 Kas: 12 gözlem');
    expect(html).toContain('<td>—</td><td>—</td><td>—</td>');expect(html).toContain('<td>0</td><td>1 sa</td><td>0</td>');
  });
  it('keeps a short recording rate unknown without erasing its known observation count',()=>{
    const days=[day('2026-11-05',5*60000,3,null)];
    const html=renderToStaticMarkup(createElement(HuntTrendChart,{metric:'rate',days}));
    expect(html).toContain('Tempo için takip birikiyor');expect(html).toContain('<td>3</td><td>5 dk</td><td>—</td>');
  });
  it('shows decreased tempo separately from increased daily count',()=>{
    const html=renderToStaticMarkup(createElement(AnalyticsMetrics,{data:state()}));
    expect(html).toContain('↓ %25');expect(html).toContain('<strong>60</strong>');expect(html).toContain('<strong>15</strong>');expect(html).not.toContain('%50');
  });
  it('never paints a comparative percentage when source coverage is partial',()=>{
    const data=state();data.quality.partial=true;
    const html=renderToStaticMarkup(createElement(AnalyticsMetrics,{data}));
    expect(html).not.toContain('%25');expect(html).not.toContain('hunt-negative');expect(html).toContain('<strong>60</strong>');
  });
  it('presents small differences neutrally without inventing statistical confidence',()=>{
    const data=state();data.comparison.rateChangePercent=4.9;
    const html=renderToStaticMarkup(createElement(AnalyticsMetrics,{data}));
    expect(html).toContain('Benzer tempo');expect(html).not.toContain('hunt-positive');
  });
});
