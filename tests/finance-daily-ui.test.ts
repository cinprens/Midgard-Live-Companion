import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import FinancePanel from '../src/components/FinancePanel';
import FinanceDailyNavigation from '../src/components/FinanceDailyNavigation';
import {createDefaultFinanceView} from '../src/shared/finance-view';
import type {FinanceDailyState} from '../src/shared/finance-daily';
import type {AutoFarmState} from '../src/shared/auto-farm';
import {EMPTY_FINANCE_TOTALS} from '../src/domain/finance-view';
import {KILL_DAILY_MIN_DATE,shiftKillDailyDate} from '../src/shared/kill-daily';

const date='2026-11-05';
function data():FinanceDailyState{return{date,timeZone:'Europe/Istanbul',priceBasis:'current-shared-prices',durationPartial:false,undatedQuantity:0,revision:1,status:'stopped',items:[],characters:[],prices:[],totals:{...EMPTY_FINANCE_TOTALS,estimatedValue:0},notice:'Synthetic test data',days:Array.from({length:7},(_,index)=>({date:shiftKillDailyDate(date,index-6),quantity:index===6?10:0,knownValue:index===6?500:0,partial:false,durationMs:0,durationPartial:false}))};}
function calendar(value:FinanceDailyState|undefined=data(),selected=date){return renderToStaticMarkup(createElement(FinanceDailyNavigation,{date:selected,today:date,data:value,loading:false,disabled:false,onDate:()=>{},onToday:()=>{}}));}

describe('daily finance calendar presentation',()=>{
  it('shows seven dated values, acquisition quantities and the current shared price basis',()=>{
    const html=calendar();expect(html.match(/data-finance-day=/g)).toHaveLength(7);expect(html).toContain('Güncel ortak fiyatlar');expect(html).toContain('500 Zeny');expect(html).toContain('10 adet');expect(html).toContain('Finans günü');expect(html).toContain('Türkiye saati');
  });
  it('distinguishes a real zero value from missing shared prices',()=>{
    const zero=data(),unknown=data();zero.days[6]={...zero.days[6],knownValue:0};unknown.days[6]={...unknown.days[6],knownValue:0,partial:true};
    expect(calendar(zero)).toContain('0 Zeny');expect(calendar(zero)).not.toContain('Fiyat bekliyor');expect(calendar(unknown)).toContain('Fiyat bekliyor');
  });
  it('keeps undated acquisitions separate from selected-day tiles',()=>{
    const value=data();value.undatedQuantity=123;const html=calendar(value);
    expect(html).toContain('Tarihi doğrulanamayan 123 adet eşya');expect(html).toContain('yalnız Tümü görünümünde');expect(html).toContain('Günlük değerlere eklenmez');expect(html).toContain('500 Zeny');
  });
  it('prevents navigation before the supported calendar and into future days',()=>{
    expect(calendar(undefined,KILL_DAILY_MIN_DATE)).toMatch(/aria-label="Önceki finans günü" disabled=""/);
    expect(calendar()).toMatch(/aria-label="Sonraki finans günü" disabled=""/);
  });
});

describe('finance all-time versus daily render contract',()=>{
  const source:AutoFarmState={revision:1,status:'stopped',items:[{itemId:603,itemName:'ARCHIVE ONLY ITEM',quantity:999,unitPrice:100,value:99900,sourceLabel:'Çantaya gelen eşya'}],characters:[],prices:[],totals:{...EMPTY_FINANCE_TOTALS,knownValue:99900,estimatedValue:99900,quantity:999,distinctItems:1},notice:'Synthetic'};
  it('never presents all-time item rows while daily data is not loaded',()=>{
    const html=renderToStaticMarkup(createElement(FinancePanel,{state:source,onPrice:async()=>{},view:{...createDefaultFinanceView(),scopeMode:'daily',dailyDate:date},onViewChange:()=>{}}));
    expect(html).toContain('data-finance-period="daily"');expect(html).toContain('Günlük finans defteri');expect(html).not.toContain('ARCHIVE ONLY ITEM');expect(html).not.toContain('data-farm-item-id');expect(html.match(/<article class="finance-stat[^\"]*"/g)).toHaveLength(3);
    expect(html).toContain('data-finance-all-total');expect(html).toContain('Günlük kayıtlar yükleniyor');
  });
  it('retains all-time rows and independent item filtering tabs by default',()=>{
    const before=JSON.stringify(source),html=renderToStaticMarkup(createElement(FinancePanel,{state:source,onPrice:async()=>{},view:createDefaultFinanceView(),onViewChange:()=>{}}));
    expect(html).toContain('data-finance-period="all"');expect(html).toContain('ARCHIVE ONLY ITEM');expect(html).not.toContain('Günlük finans defteri');expect(html).toContain('aria-label="Finans dönemi"');expect(html).toContain('aria-label="Finans görünümü"');expect(JSON.stringify(source)).toBe(before);
  });
});
