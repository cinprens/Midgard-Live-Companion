import { availableParallelism, freemem, totalmem } from 'node:os';
import type { LiveResourceLimits } from '../../src/shared/types';

export const MIB = 1024 * 1024;
export function deriveLiveLimits(overrides: Partial<LiveResourceLimits> = {}): LiveResourceLimits {
  const automaticBudget=Math.min(1024*MIB,Math.max(192*MIB,Math.min(freemem()/4,totalmem()/8)));
  const budget = Math.max(3 * MIB, Math.floor(overrides.memoryBudgetBytes ?? automaticBudget));
  const perFileBytes = Math.max(1, Math.min(overrides.perFileBytes ?? 128 * MIB, Math.floor(budget / 3),128 * MIB));
  return {
    memoryBudgetBytes: budget,
    perFileBytes,
    maxWorkers: Math.max(1, Math.floor(overrides.maxWorkers ?? Math.min(Math.max(1,availableParallelism()-1),Math.max(1,Math.floor(budget/(96*MIB)))))),
    pollIntervalMs: Math.max(50, Math.floor(overrides.pollIntervalMs ?? 1500)),
    settleMs: Math.max(0, Math.floor(overrides.settleMs ?? 3000)),
  };
}

type Work = { id: string; bytes: number; run: (signal: AbortSignal) => Promise<void> };
/** FIFO admission prevents a large file from starving behind repeatedly changing small files. */
export class FairWorkQueue {
  private pending: Work[] = [];
  private running = new Map<string, { controller: AbortController; bytes: number }>();
  private idleWaiters: (() => void)[] = [];
  private closed = false;
  constructor(public readonly maxWorkers: number, public readonly memoryBudgetBytes: number, private changed: () => void = () => {}) {}
  get activeWorkers(): number { return this.running.size; }
  get queuedCount(): number { return this.pending.length; }
  get reservedBytes(): number { return [...this.running.values()].reduce((sum,item)=>sum+item.bytes,0); }
  has(id: string): boolean { return this.running.has(id) || this.pending.some(item=>item.id===id); }
  isRunning(id:string):boolean{return this.running.has(id);}
  enqueue(work: Work): boolean {
    if(this.closed || this.has(work.id))return false;
    if(!Number.isSafeInteger(work.bytes) || work.bytes < 0 || work.bytes > this.memoryBudgetBytes)throw new Error('Dosya canlı analiz bellek bütçesine sığmıyor.');
    this.pending.push(work);this.changed();queueMicrotask(()=>this.drain());return true;
  }
  cancel(id: string): void {
    this.pending=this.pending.filter(item=>item.id!==id);this.running.get(id)?.controller.abort();this.changed();this.resolveIdle();
  }
  async close(): Promise<void> { this.closed=true;this.pending=[];for(const item of this.running.values())item.controller.abort();await this.waitForIdle(); }
  waitForIdle(): Promise<void> { return this.running.size===0&&this.pending.length===0 ? Promise.resolve() : new Promise(resolve=>this.idleWaiters.push(resolve)); }
  private resolveIdle(): void { if(this.running.size===0&&this.pending.length===0)for(const resolve of this.idleWaiters.splice(0))resolve(); }
  private drain(): void {
    while(!this.closed&&this.pending.length&&this.running.size<this.maxWorkers){
      const work=this.pending[0];if(this.reservedBytes+work.bytes>this.memoryBudgetBytes)break;
      this.pending.shift();const controller=new AbortController();this.running.set(work.id,{controller,bytes:work.bytes});this.changed();
      void work.run(controller.signal).catch(()=>undefined).finally(()=>{this.running.delete(work.id);this.changed();this.resolveIdle();this.drain();});
    }
    this.resolveIdle();
  }
}
