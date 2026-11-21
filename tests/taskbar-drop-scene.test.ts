import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RareDropEvent } from '../src/shared/types';
import { TaskbarDropQueue } from '../src/hooks/useTaskbarDropQueue';
import { generalTaskbarScene } from '../src/domain/taskbar-scenes';
import { getSceneSeconds } from '../src/shared/scene-durations';

function drop(id: string, category: RareDropEvent['category']): RareDropEvent {
  return { id, category, itemId: 1, quantity: 1, itemName: 'Ödül', character: id, streamId: id,
    at: 0, audio: { muted: false, volume: 50 } };
}

describe('Taskbar rare drop scenes', () => {
  afterEach(() => vi.useRealTimers());

  it('gives overlapping drops from all three characters a full five seconds with their sound at the start', () => {
    vi.useFakeTimers();
    const show = vi.fn(), play = vi.fn();
    const queue = new TaskbarDropQueue(show);
    const events = [drop('Bir', 'card'), drop('İki', 'costume'), drop('Üç', 'card')];
    queue.setActive(true);
    for (const event of events) expect(queue.enqueue(event, () => play(event.id))).toBe(true);
    for (const [index, event] of events.entries()) {
      expect(show).toHaveBeenLastCalledWith(event);
      vi.advanceTimersByTime(1500); // rendering may wait on a busy window
      expect(play).toHaveBeenCalledTimes(index);
      queue.presented(event);
      queue.presented(event);
      expect(play.mock.calls.flat()).toEqual(events.slice(0, index + 1).map(entry => entry.id));
      vi.advanceTimersByTime(4999);
      expect(show).toHaveBeenLastCalledWith(event);
      vi.advanceTimersByTime(1);
    }
    expect(show).toHaveBeenLastCalledWith(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the normal window alone and never revives old scenes when switching back', () => {
    vi.useFakeTimers();
    const show = vi.fn(), play = vi.fn();
    const queue = new TaskbarDropQueue(show);
    expect(queue.enqueue(drop('Ana pencere', 'card'), play)).toBe(false);
    expect(show).not.toHaveBeenCalled();
    queue.setActive(true);
    queue.enqueue(drop('Bir', 'card'), play);
    queue.enqueue(drop('İki', 'costume'), play);
    queue.setActive(false);
    expect(show).toHaveBeenLastCalledWith(null);
    queue.setActive(true);
    vi.advanceTimersByTime(5000);
    expect(show).toHaveBeenLastCalledWith(null);
    expect(play).toHaveBeenCalledTimes(2);
    queue.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('presents general and rare alerts in one queue for their independent configured durations',()=>{
    vi.useFakeTimers();
    const show=vi.fn(),play=vi.fn(),queue=new TaskbarDropQueue(show);
    queue.setActive(true);
    const notification={id:'g',character:'Ada',at:'2026-11-21',streamId:'s',message:'Gözlem'};
    const death=generalTaskbarScene({...notification,type:'death'},'actor')!;
    const item=generalTaskbarScene({...notification,id:'i',type:'old-blue-box'},'actor')!;
    const gem=drop('Kart','card');
    const seconds={death:1,item:60,card:3};
    for(const event of [death,gem,item])queue.enqueue(event,()=>play(event.id),getSceneSeconds(seconds,event.category));
    for(const [event,ms] of [[death,1000],[gem,3000],[item,60000]] as const) {
      expect(show).toHaveBeenLastCalledWith(event);
      queue.presented(event);
      vi.advanceTimersByTime(ms-1);
      expect(show).toHaveBeenLastCalledWith(event);
      vi.advanceTimersByTime(1);
    }
    expect(show).toHaveBeenLastCalledWith(null);
    expect(play.mock.calls.flat()).toEqual(['g','Kart','i']);
  });

  it('scenes use the gameplay event, independent of sound identity, including per-item legacy overrides',()=>{
    const event={id:'a',streamId:'s',character:'Ada',at:'2026-11-21',message:'Ada: Eşya alındı'};
    expect(generalTaskbarScene({...event,type:'card',soundKind:'glass-bead',itemId:746,subject:'Glass Bead'},'k'))
      .toMatchObject({category:'item',subject:'Glass Bead',characterKey:'k'});
    expect(generalTaskbarScene({...event,type:'city',characterKey:'original',subject:'geffen'},'new')?.characterKey).toBe('original');
    expect(generalTaskbarScene({...event,type:'level'})).toBe(null);
    expect(generalTaskbarScene({...event,type:'death',streamId:'sound-test'})).toBe(null);
  });

  it('shows a fresh scene immediately after re-entry during a long previous scene',()=>{
    vi.useFakeTimers();const show=vi.fn(),play=vi.fn(),queue=new TaskbarDropQueue(show);
    const [old,waiting,fresh]=['old','waiting','fresh'].map(id=>drop(id,'card'));
    queue.setActive(true);queue.enqueue(old,()=>play(old.id),60);queue.presented(old);
    queue.enqueue(waiting,()=>play(waiting.id),60);queue.setActive(false);
    queue.setActive(true);queue.enqueue(fresh,()=>play(fresh.id),2);
    expect(show).toHaveBeenLastCalledWith(fresh);
    queue.presented(fresh);vi.advanceTimersByTime(2000);
    expect(show).toHaveBeenLastCalledWith(null);
    expect(play.mock.calls.flat()).toEqual(['old','fresh','waiting']);
    queue.dispose();
  });
});
