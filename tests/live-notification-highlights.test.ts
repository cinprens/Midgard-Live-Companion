import {describe,expect,it} from 'vitest';
import type {LiveNotification} from '../src/domain/notifications';
import {liveNotificationHighlights} from '../src/domain/live-notification-highlights';

const now=Date.parse('2026-11-05T13:30:00Z');
const event=(id:string,changes:Partial<LiveNotification>={}):LiveNotification=>({id,type:'old-blue-box',streamId:'a',character:'Aynı görünen ad',at:new Date(now-500).toISOString(),message:'Çantaya geldi.',itemId:603,amount:1,...changes});

describe('source-scoped live notification highlights',()=>{
  it('matches the source group instead of equal display names and never changes notification data',()=>{
    const notifications=[event('other',{streamId:'b'}),event('copy',{streamId:'a-copy'})],before=JSON.stringify(notifications);
    const value=liveNotificationHighlights(notifications,['a','a-copy'],now);
    expect(value.card?.id).toBe('copy');expect(value.items.get(603)?.id).toBe('copy');expect(liveNotificationHighlights(notifications,['a'],now).card).toBeNull();expect(JSON.stringify(notifications)).toBe(before);
  });
  it('expires old notifications at five seconds, including after a remount',()=>{
    const notification=event('once',{at:new Date(now).toISOString()});
    expect(liveNotificationHighlights([notification],['a'],now).card?.id).toBe('once');
    expect(liveNotificationHighlights([notification],['a'],now+4999).items.has(603)).toBe(true);
    expect(liveNotificationHighlights([notification],['a'],now+5000)).toEqual({card:null,items:new Map()});
    expect(liveNotificationHighlights([notification],['a'],now+60000).card).toBeNull();
  });
  it('rejects future, invalid and absent times instead of inventing a fresh event',()=>{
    for(const at of ['not-a-date','',new Date(now+1).toISOString(),new Date(now+86400000).toISOString()])expect(liveNotificationHighlights([event('invalid',{at})],['a'],now).card).toBeNull();
    expect(liveNotificationHighlights([event('valid')],['a'],NaN).card).toBeNull();expect(liveNotificationHighlights([event('valid')],[],now).card).toBeNull();
  });
  it('highlights the character for non-item alerts without claiming an item acquisition',()=>{
    for(const type of ['weight','death','city','level','monster'] as const){const value=liveNotificationHighlights([event(type,{type})],['a'],now);expect(value.card?.id).toBe(type);expect(value.items.size).toBe(0);}
    for(const itemId of [undefined,null,0,-1,1.5,0x100000000]){const value=liveNotificationHighlights([event('no-item',{itemId:itemId as number|undefined})],['a'],now);expect(value.card?.id).toBe('no-item');expect(value.items.size).toBe(0);}
  });
  it('keeps the newest genuine event for each item without highlighting unrelated items or characters',()=>{
    const notifications=[event('old',{at:new Date(now-3000).toISOString()}),event('card',{type:'card',itemId:4317}),event('bead',{type:'glass-bead',itemId:746}),event('new',{at:new Date(now-50).toISOString()}),event('other-source',{streamId:'b',itemId:999999,at:new Date(now).toISOString()})];
    const value=liveNotificationHighlights(notifications,['a'],now);
    expect(value.card?.id).toBe('new');expect([...value.items.keys()].sort((a,b)=>a-b)).toEqual([603,746,4317]);expect(value.items.get(603)?.id).toBe('new');expect(value.items.get(603)?.expiresAt).toBe(now+4950);
  });
  it('does not infer an event from quantities, names or a missing notification ID',()=>{
    expect(liveNotificationHighlights([],['a'],now)).toEqual({card:null,items:new Map()});
    expect(liveNotificationHighlights([event('',{amount:100000})],['a'],now).card).toBeNull();
    const value=liveNotificationHighlights([event('real',{amount:1})],['a'],now);expect(value.items.size).toBe(1);expect(value.items.get(603)?.id).toBe('real');
  });
});
