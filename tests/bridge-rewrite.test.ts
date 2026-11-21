import { describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReplayFileSession, type BridgeMeta } from '../electron/live/file-session';
import { ExpansionStore } from '../electron/expansion-store';
import type { ParsedReplay, ReplayEvent } from '../src/parser/types';

const bytes = (size: number) => new Uint8Array(size);
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const text = (value: string) => new TextEncoder().encode(`${value}\0`);
function concat(...parts: Uint8Array[]) {
  const result = bytes(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function encrypt(input: Uint8Array) {
  const result = new Uint8Array(input), first = (2026 | (11 << 16) | (1 << 24)) >> 5, second = (12 << 8) >> 3;
  for (let index = 0; index < Math.floor(result.length / 4); index++) view(result).setInt32(index * 4, view(result).getInt32(index * 4, true) ^ Math.imul(first + index + 1, second), true);
  return result;
}
function u32(value: number) { const result = bytes(4); view(result).setUint32(0, value, true); return result; }
function generic(id: number, data: Uint8Array) { const head = bytes(6); view(head).setInt16(0, id, true); view(head).setInt32(2, data.length, true); return concat(head, data); }
function packet(id: number, length: number) { const result = bytes(length); view(result).setUint16(0, id, true); return result; }
function spawn() {
  const result = packet(0x0857, 74); view(result).setUint16(2, result.length, true); result[4] = 5;
  view(result).setUint32(5, 100, true); view(result).setInt16(19, 1002, true); result.set(text('Hode'), 69); return result;
}
function death() { const result = packet(0x0080, 7); view(result).setUint32(2, 100, true); result[6] = 1; return result; }
function status() { const result = packet(0x00b0, 8); view(result).setUint16(2, 24, true); view(result).setUint32(4, 100, true); return result; }
function revive() { const result = packet(0x0148, 8); view(result).setUint32(2, 100, true); return result; }
function frame(data: Uint8Array, timestamp: number, index: number) {
  const head = bytes(10); view(head).setInt32(0, index, true); view(head).setInt32(4, timestamp, true); view(head).setUint16(8, data.length, true);
  return concat(head, encrypt(data));
}
function replay(inserted?: 'unknown' | 'status') {
  const header = bytes(352); header.set(text('<< Ragnarok Replay File Version 0.05 >>')); header[100] = 5;
  view(header).setInt16(104, 2026, true); header[106] = 11; header[107] = 1; header[109] = 12;
  const metadata = encrypt(concat(...[0, 1, 2, 3].map(id => generic(id, bytes(0))), generic(964, text('Synthetic')), generic(965, text('qa_field')), generic(970, u32(0))));
  const session = encrypt(generic(1010, u32(42)));
  const frames = inserted ? [frame(inserted === 'unknown' ? packet(0x7777, 24) : status(), 50, 0), frame(spawn(), 100, 1), frame(death(), 200, 2)] : [frame(spawn(), 100, 0), frame(death(), 200, 1)];
  const sections = [{ type: 2, data: metadata }, { type: 3, data: session }, { type: 1, data: concat(...frames) }];
  let offset = header.length;
  for (const [slot, section] of sections.entries()) {
    const at = 112 + slot * 10; view(header).setUint16(at, section.type, true); view(header).setInt32(at + 2, section.type === 1 ? 0 : section.data.length, true); view(header).setInt32(at + 6, offset, true); offset += section.data.length;
  }
  return concat(header, ...sections.map(section => section.data));
}
const lifecycle = (event: ReplayEvent) => (event.rawData!.killProof as Record<string, unknown>).lifecycleId;

describe('Replay file rewrites preserve persistent death identities', () => {
  it.each(['unknown', 'status'] as const)('rebuilds after inserting an old %s frame without counting the same life again', async inserted => {
    const temporaryRoot = path.resolve(tmpdir()), directory = await mkdtemp(path.join(temporaryRoot, 'midgard-bridge-rewrite-'));
    const databaseFile = path.join(directory, 'synthetic.sqlite'), source = path.join(directory, 'synthetic.rrf');
    let store: ExpansionStore | undefined;
    try {
      await writeFile(source, replay()); const sourcePath = await realpath(source);
      const character = { key: 'recorded:42:Synthetic', name: 'Synthetic', source: 'recorded', playerId: 42 } as const;
      const attach = () => { store!.targetHunt.setTargets({ monsterIds: [1002] }); store!.targetHunt.syncStatuses([{ id: 'synthetic', sourcePath, status: 'following', character }]); };
      const consume = (events: ReplayEvent[], metadata: BridgeMeta[]) => async (parsed: ParsedReplay, meta: BridgeMeta) => {
        expect(parsed.status).not.toBe('invalid'); metadata.push(meta); events.push(...parsed.events.filter(event => event.eventType === 'death'));
        const observation = { sourcePath, streamId: 'synthetic', hash: meta.hash, recordingId: JSON.stringify([parsed.summary.startedAt, parsed.summary.playerId, parsed.summary.characterName]), recordingReset: meta.recordingReset, bootstrap: meta.initial };
        store!.killCount.observe(parsed, observation, character); store!.targetHunt.observe(parsed, observation, character);
      };
      const expectDeaths = (count: number) => { expect(store!.killCount.snapshot().totals.observedDeaths).toBe(count); expect(store!.targetHunt.snapshot().targets[0]).toMatchObject({ deathCount: count, rawObservations: count }); };
      const request = { sourcePath, streamId: 'synthetic', filename: 'synthetic.rrf' };
      store = new ExpansionStore(databaseFile); attach();
      const session = new ReplayFileSession({ batchBytes: 1024 }), initialDeaths: ReplayEvent[] = [];
      await session.run(request, new AbortController().signal, consume(initialDeaths, []));
      expect(initialDeaths).toHaveLength(1); expect(lifecycle(initialDeaths[0])).toBe('wire:0:100:100:1'); expectDeaths(1);

      await writeFile(sourcePath, replay(inserted));
      const rewrittenDeaths: ReplayEvent[] = [], rebuildMetadata: BridgeMeta[] = [];
      const verified = await session.run({ ...request, verify: true }, new AbortController().signal, consume(rewrittenDeaths, rebuildMetadata));
      expect(verified.pending).toBe(false); expect(verified.verifiedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rebuildMetadata.length).toBeGreaterThan(0); expect(rebuildMetadata.every(meta => meta.reset && meta.initial && !meta.recordingReset)).toBe(true);
      expect(rewrittenDeaths).toHaveLength(1); expect(rewrittenDeaths[0].id).not.toBe(initialDeaths[0].id);
      expect(lifecycle(rewrittenDeaths[0])).toBe(lifecycle(initialDeaths[0])); expectDeaths(1);

      await appendFile(sourcePath, concat(frame(revive(), 300, 3), frame(spawn(), 300, 4), frame(death(), 400, 5)));
      const liveDeaths: ReplayEvent[] = [], liveMetadata: BridgeMeta[] = [];
      await session.run(request, new AbortController().signal, consume(liveDeaths, liveMetadata));
      expect(liveMetadata.every(meta => !meta.initial && !meta.recordingReset)).toBe(true); expect(liveDeaths).toHaveLength(1);
      expect(lifecycle(liveDeaths[0])).toBe('wire:0:100:300:1'); expect(lifecycle(liveDeaths[0])).not.toBe(lifecycle(initialDeaths[0])); expectDeaths(2);

      store.close(); store = new ExpansionStore(databaseFile); attach();
      const reopenedDeaths: ReplayEvent[] = [];
      await new ReplayFileSession({ batchBytes: 1024 }).run({ ...request, verify: true }, new AbortController().signal, consume(reopenedDeaths, []));
      expect(reopenedDeaths.map(lifecycle)).toEqual([lifecycle(initialDeaths[0]), lifecycle(liveDeaths[0])]); expectDeaths(2);
    } finally {
      store?.close(); const resolved = path.resolve(directory);
      if (!resolved.startsWith(temporaryRoot + path.sep) || !path.basename(resolved).startsWith('midgard-bridge-rewrite-')) throw new Error('Temporary replay cleanup outside test directory refused.');
      await rm(resolved, { recursive: true, force: true });
    }
  });
});
