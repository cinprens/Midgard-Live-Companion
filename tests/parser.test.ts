import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseReplay, isConfirmedMonsterDeath, isConfirmedPersonalKill } from '../src/parser';

const bytes = (size: number) => new Uint8Array(size);
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const concat = (...parts: Uint8Array[]) => {
  const output = bytes(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) { output.set(part, position); position += part.length; }
  return output;
};
// Independent fixture encoder for the documented date-derived v5 XOR words.
function encode(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input);
  const dateBytes = bytes(4);
  view(dateBytes).setInt16(0, 2026, true); dateBytes[2] = 11; dateBytes[3] = 1;
  const k1 = view(dateBytes).getInt32(0, true) >> 5;
  const k2 = (12 << 8) >> 3;
  for (let word = 0; word < Math.floor(output.length / 4); word++) {
    view(output).setInt32(word * 4, view(output).getInt32(word * 4, true) ^ Math.imul(k1 + word + 1, k2), true);
  }
  return output;
}
function generic(id: number, data: Uint8Array): Uint8Array {
  const head = bytes(6); view(head).setInt16(0, id, true); view(head).setInt32(2, data.length, true);
  return concat(head, data);
}
function u32(value: number): Uint8Array { const output = bytes(4); view(output).setUint32(0, value, true); return output; }
function spawn(aid: number, mob = 1002, kind = 5): Uint8Array {
  const name = new TextEncoder().encode('Synthetic mob\0');
  const data = bytes(69 + name.length);
  view(data).setUint16(0, 0x0857, true); view(data).setUint16(2, data.length, true);
  data[4] = kind; view(data).setUint32(5, aid, true); view(data).setInt16(19, mob, true); data.set(name, 69);
  return data;
}
function death(aid: number, kind = 1): Uint8Array {
  const data = bytes(7); view(data).setUint16(0, 0x0080, true); view(data).setUint32(2, aid, true); data[6] = kind; return data;
}
function damage(source: number, target: number, amount = 100): Uint8Array {
  const data = bytes(33); view(data).setUint16(0, 0x02e1, true); view(data).setUint32(2, source, true);
  view(data).setUint32(6, target, true); view(data).setInt32(22, amount, true); view(data).setInt16(26, 1, true); return data;
}
function fixture(packets: { time: number; data: Uint8Array }[], names: { character?: string; characterBytes?: Uint8Array; map?: string; session?: Uint8Array } = {}): ArrayBuffer {
  const header = bytes(352);
  header.set(new TextEncoder().encode('<< Ragnarok Replay File Version 0.05 >>'));
  header[100] = 5; view(header).setInt16(104, 2026, true); header[106] = 11; header[107] = 1; header[109] = 12;
  const stream = concat(...packets.map((packet, i) => {
    const head = bytes(10); view(head).setInt32(0, i, true); view(head).setInt32(4, packet.time, true);
    view(head).setUint16(8, packet.data.length, true); return concat(head, encode(packet.data));
  }));
  const session = encode(concat(generic(1010, u32(42)), names.session ?? bytes(0)));
  const metadata = encode(concat(...[0, 1, 2, 3].map(id => generic(id, bytes(0))),
    generic(964, names.characterBytes ?? new TextEncoder().encode(`${names.character ?? 'Test character'}\0`)), generic(965, new TextEncoder().encode(`${names.map ?? 'test_map'}\0`)), generic(970, u32(60000))));
  let position = header.length;
  for (const [i, type, data] of [[0, 1, stream], [1, 3, session], [2, 2, metadata]] as const) {
    const at = 112 + i * 10; view(header).setUint16(at, type, true); view(header).setInt32(at + 2, data.length, true); view(header).setInt32(at + 6, position, true); position += data.length;
  }
  return concat(header, stream, session, metadata).buffer as ArrayBuffer;
}

describe('v5 RRF profile and normalized analysis', () => {
  it('automatically loads Session levels/class then applies live level updates without invented EXP', () => {
    const status = (parameter: number, amount: number) => { const data = bytes(8); view(data).setUint16(0, 0x00b0, true);
      view(data).setUint16(2, parameter, true); view(data).setUint32(4, amount, true); return data; };
    const session = concat(generic(1014, u32(8)), generic(1016, u32(53)), generic(1019, u32(59)),
      generic(1015, bytes(8).fill(1)), generic(1018, bytes(8).fill(2)));
    const initial = parseReplay(fixture([{ time: 0, data: status(5, 100) }], { session }), 'initial-levels.rrf').summary.liveTelemetry!;
    expect(initial).toMatchObject({ baseLevel: 53, jobLevel: 59, recordingStartJobLevel: 59, jobClassId: 8, jobTrack: 'second', jobTrackSource: 'rrf-session-class',
      currentBaseExp: null, currentJobExp: null, baseExpGained: null, jobExpGained: null });
    const replay = parseReplay(fixture([{ time: 100, data: status(11, 54) }, { time: 200, data: status(55, 60) }], { session }), 'live-levels.rrf');
    expect(replay.summary.liveTelemetry).toMatchObject({ baseLevel: 54, jobLevel: 60, recordingStartJobLevel: 59, jobClassId: 8, jobTrack: 'second', currentBaseExp: null, currentJobExp: null });
    expect(replay.events.filter(event => event.eventType === 'level-up').map(event => [event.expKind, event.amount])).toEqual([['base', 54], ['job', 60]]);
    expect(replay.events.some(event => event.eventType === 'exp-gain')).toBe(false);
  });
  it('requires a death vanish rather than damage, ground disappearance or other vanish reasons', () => {
    const floor=bytes(6);view(floor).setUint16(0,0x00a1,true);view(floor).setUint32(2,100,true);
    const packets=[{time:0,data:spawn(100)},{time:1,data:damage(42,100,9999999)},{time:2,data:floor},
      ...[0,2,3,4].map((kind,i)=>({time:10+i,data:death(100,kind)}))];
    const replay=parseReplay(fixture(packets),'not-kills.rrf');
    expect(replay.events.filter(isConfirmedMonsterDeath)).toHaveLength(0);expect(replay.summary.observedDeaths).toBe(0);
  });
  it('normalizes observed mob death proof without claiming its exclusive attacker is a confirmed killer', () => {
    const hit=damage(42,100);view(hit).setUint32(10,0xffffffff,true);
    const clock=bytes(6);view(clock).setUint16(0,0x007f,true);view(clock).setUint32(2,12345,true);
    const replay=parseReplay(fixture([{time:0,data:spawn(100)},{time:1,data:clock},{time:2,data:hit},{time:3,data:death(100)}]),'proof.rrf');
    const event=replay.events.find(isConfirmedMonsterDeath)!;
    expect(event.rawData?.killProof).toMatchObject({death:'vanish-kind-1',ownership:'exclusive-observed-attacker-estimate',targetActorId:100,lifecycleId:'0:100:1',mapEpoch:0,spawnObserved:true,scope:'replay-local',serverDeathTick:null,lastAttackServerTick:0xffffffff,lastAttackTimestamp:2,lastServerClockTick:12345});
    expect(event.confidence).toBe('estimated');expect(isConfirmedPersonalKill(event,42)).toBe(false);expect(replay.summary.certainPersonalKills).toBe(0);
  });
  it('excludes NPC/PC/unknown-context deaths from the strict monster-death contract', () => {
    const replay=parseReplay(fixture([{time:0,data:spawn(100,1,0)},{time:1,data:spawn(101,1,6)},
      {time:2,data:death(100)},{time:3,data:death(101)},{time:4,data:damage(42,102,9999)},{time:5,data:death(102)}]),'not-mobs.rrf');
    expect(replay.events.filter(isConfirmedMonsterDeath)).toHaveLength(0);
    expect(replay.events.find(event=>event.eventType==='death'&&event.targetId===102)?.rawData?.killProof).toMatchObject({spawnObserved:false,ownership:'unknown'});
  });
  it('keeps ordinary visibility updates in one life and preserves competing attackers', () => {
    const replay=parseReplay(fixture([{time:0,data:spawn(100)},{time:1,data:damage(99,100)},
      {time:2,data:spawn(100)},{time:3,data:damage(42,100)},{time:4,data:death(100)}]),'visibility.rrf');
    const entries=replay.events.filter(event=>event.eventType==='spawn');expect(entries[0].rawData?.lifecycleId).toBe(entries[1].rawData?.lifecycleId);
    expect(replay.summary.estimatedPersonalKills).toBe(0);expect(replay.events.find(isConfirmedMonsterDeath)?.rawData?.killProof).toMatchObject({ownership:'unknown'});
  });
  it('does not rearm duplicate deaths from a same-timestamp entity replay', () => {
    const replay=parseReplay(fixture([{time:0,data:spawn(100)},{time:10,data:death(100)},{time:10,data:spawn(100)},{time:11,data:death(100)}]),'same-time.rrf');
    expect(replay.events.filter(isConfirmedMonsterDeath)).toHaveLength(1);
  });
  it('rearms an observed life after alive full-layout entry, but not dead entry refresh', () => {
    const entry=(hp:number)=>{const data=bytes(84);view(data).setUint16(0,0x09fe,true);view(data).setUint16(2,84,true);data[4]=5;view(data).setUint32(5,100,true);view(data).setInt16(23,1002,true);view(data).setInt32(72,100,true);view(data).setInt32(76,hp,true);return data;};
    const replay=parseReplay(fixture([{time:0,data:entry(100)},{time:10,data:death(100)},{time:20,data:entry(0)},
      {time:30,data:death(100)},{time:40,data:entry(100)},{time:50,data:death(100)}]),'alive-reentry.rrf');
    const deaths=replay.events.filter(isConfirmedMonsterDeath);expect(deaths).toHaveLength(2);
    expect(deaths[0].rawData?.killProof).toMatchObject({lifecycleId:'0:100:1'});expect(deaths[1].rawData?.killProof).toMatchObject({lifecycleId:'0:100:2'});
  });
  it('separates map epochs without converting map transitions to kills', () => {
    const map=bytes(22);view(map).setUint16(0,0x0091,true);map.set(new TextEncoder().encode('new_map'),2);
    const replay=parseReplay(fixture([{time:0,data:spawn(100)},{time:10,data:death(100)},{time:20,data:map},
      {time:30,data:spawn(100)},{time:40,data:death(100)}]),'map-life.rrf');
    const deaths=replay.events.filter(isConfirmedMonsterDeath);expect(deaths).toHaveLength(2);
    expect(deaths[1].mapId).toBe('new_map');expect(deaths[1].rawData?.killProof).toMatchObject({mapEpoch:1,lifecycleId:'1:100:2'});
  });
  it('does not use SP-only damage as personal HP kill attribution evidence', () => {
    const hit=bytes(34);view(hit).setUint16(0,0x08c8,true);view(hit).setUint32(2,42,true);view(hit).setUint32(6,100,true);view(hit).setInt32(22,100,true);hit[26]=1;view(hit).setInt16(27,1,true);
    const replay=parseReplay(fixture([{time:0,data:spawn(100)},{time:1,data:hit},{time:2,data:death(100)}]),'sp-only.rrf');
    expect(replay.summary.estimatedPersonalKills).toBe(0);expect(replay.events.find(isConfirmedMonsterDeath)?.rawData?.killProof).toMatchObject({ownership:'unknown',lastAttackServerTick:null});
  });
  it('keeps completed death proof stable while a later death tail is incomplete', () => {
    const full=fixture([{time:0,data:spawn(100)},{time:10,data:death(100)},{time:20,data:spawn(101)},{time:30,data:death(101)}]);
    const partial=full.slice(0);const v=new DataView(partial);v.setInt32(114,v.getInt32(114,true)-1,true);
    const earlier=parseReplay(partial,'partial-death.rrf'),complete=parseReplay(full,'complete-death.rrf');
    expect(earlier.events.filter(isConfirmedMonsterDeath)).toHaveLength(1);expect(complete.events.filter(isConfirmedMonsterDeath)).toHaveLength(2);
    expect(earlier.events.find(isConfirmedMonsterDeath)?.rawData?.killProof).toEqual(complete.events.find(isConfirmedMonsterDeath)?.rawData?.killProof);
  });
  it('normalizes own status, level changes and explicit EXP while excluding nearby actor gains', () => {
    const status = (parameter: number, amount: number) => {
      const data = bytes(8); view(data).setUint16(0, 0x00b0, true); view(data).setUint16(2, parameter, true); view(data).setInt32(4, amount, true); return data;
    };
    const exp = (actor: number, amount: bigint) => {
      const data = bytes(18); view(data).setUint16(0, 0x0acc, true); view(data).setUint32(2, actor, true); view(data).setBigInt64(6, amount, true); view(data).setUint16(14, 1, true); return data;
    };
    const replay = parseReplay(fixture([
      { time: 0, data: status(11, 53) }, { time: 1, data: status(11, 54) },
      { time: 2, data: status(12, 9) }, { time: 3, data: status(55, 43) },
      { time: 4, data: status(24, 65) }, { time: 5, data: status(25, 100) },
      { time: 6, data: exp(42, 700n) }, { time: 7, data: exp(99, 999n) },
      { time: 8, data: exp(42, -100n) }, { time: 9, data: status(1, 450) },
    ]), 'telemetry.rrf');
    expect(replay.events.filter(e => e.eventType === 'level-up')).toMatchObject([{ amount: 54, rawData: { levelType: 'base', previousLevel: 53 } }]);
    expect(replay.events.filter(e => e.eventType === 'exp-gain')).toHaveLength(1);
    expect(replay.events.filter(e => e.eventType === 'exp-loss')).toHaveLength(1);
    expect(replay.summary.liveTelemetry).toMatchObject({ weightPercent: 65, baseLevel: 54, jobLevel: 43, currentBaseExp: 450, baseExpGained: 700, jobExpGained: null });
    expect(replay.compatibility).toBe('skadi-unverified');
  });
  it('alerts only the recorded owner death, deduplicates, and re-arms after resurrection', () => {
    const resurrection = bytes(8); view(resurrection).setUint16(0, 0x0148, true); view(resurrection).setUint32(2, 42, true);
    const hp = bytes(8); view(hp).setUint16(0, 0x00b0, true); view(hp).setUint16(2, 5, true);
    const replay = parseReplay(fixture([
      { time: 0, data: hp }, { time: 1, data: death(99) }, { time: 2, data: death(42, 0) },
      { time: 3, data: death(42) }, { time: 4, data: death(42) },
      { time: 5, data: resurrection }, { time: 6, data: death(42) },
    ]), 'death.rrf');
    expect(replay.events.filter(e => e.eventType === 'player-death').map(e => e.timestamp)).toEqual([3, 6]);
    expect(replay.summary.observedDeaths).toBe(0);
  });
  it('attaches the levels at each own death rather than final Replay levels', () => {
    const status = (parameter: number, amount: number) => { const data = bytes(8); view(data).setUint16(0, 0x00b0, true); view(data).setUint16(2, parameter, true); view(data).setUint32(4, amount, true); return data; };
    const resurrection = bytes(8); view(resurrection).setUint16(0, 0x0148, true); view(resurrection).setUint32(2, 42, true);
    const session = concat(generic(1014, u32(8)), generic(1016, u32(53)), generic(1019, u32(59)));
    const replay = parseReplay(fixture([{ time: 1, data: death(42) }, { time: 2, data: resurrection }, { time: 3, data: status(11, 54) }, { time: 4, data: status(55, 60) }, { time: 5, data: death(42) }], { session }), 'death-levels.rrf');
    expect(replay.events.filter(event => event.eventType === 'player-death').map(event => event.rawData)).toMatchObject([{ baseLevel: 53, jobLevel: 59, jobTrack: 'second' }, { baseLevel: 54, jobLevel: 60, jobTrack: 'second' }]);
    expect(replay.summary.liveTelemetry).toMatchObject({ baseLevel: 54, jobLevel: 60 });
  });
  it('invalidates the death-time Job table after a Job level decrease and preserves missing levels', () => {
    const status = (amount: number) => { const data = bytes(8); view(data).setUint16(0, 0x00b0, true); view(data).setUint16(2, 55, true); view(data).setUint32(4, amount, true); return data; };
    const session = concat(generic(1014, u32(8)), generic(1016, u32(53)), generic(1019, u32(59)));
    const replay = parseReplay(fixture([{ time: 1, data: status(1) }, { time: 2, data: status(2) }, { time: 3, data: death(42) }], { session }), 'changed-job-death.rrf');
    expect(replay.events.find(event => event.eventType === 'player-death')?.rawData).toMatchObject({ baseLevel: 53, jobLevel: 2, jobTrack: null });
    expect(parseReplay(fixture([{ time: 1, data: death(42) }]), 'unknown-death-levels.rrf').events.find(event => event.eventType === 'player-death')?.rawData).toMatchObject({ baseLevel: null, jobLevel: null, jobTrack: null });
  });
  it('reads valid UTF-8 Turkish metadata before trying the legacy Korean decoder', () => {
    const name = 'Çağrı Şövalye İÖÜçğı';
    const replay = parseReplay(fixture([{time:0,data:spawn(100)}], {character:name}), 'turkish.rrf');
    expect(replay.summary.characterName).toBe(name);
    const decomposed = 'C\u0327ag\u0306rı S\u0327o\u0308valye';
    expect(parseReplay(fixture([{time:0,data:spawn(100)}], {character:decomposed}), 'unicode.rrf').summary.characterName).toBe(decomposed);
  });

  it('preserves valid legacy CP949 names when the raw field is not UTF-8', () => {
    // Synthetic CP949 bytes for a Korean name, followed by its field terminator.
    const replay = parseReplay(fixture([{time:0,data:spawn(100)}], {characterBytes:new Uint8Array([0xbe,0xc8,0xb3,0xe7,0])}), 'legacy.rrf');
    expect(replay.summary.characterName).toBe('안녕');
  });

  it('does not split a valid UTF-8 code point at the display byte budget', () => {
    const replay = parseReplay(fixture([{time:0,data:spawn(100)}], {character:'a'.repeat(1023)+'ü'}), 'utf8-budget.rrf');
    expect(replay.summary.characterName).toBe('a'.repeat(1023));
    expect(replay.summary.characterName).not.toContain('체');
    expect(replay.diagnostics.some(d=>d.code==='DISPLAY_TEXT_TRUNCATED')).toBe(true);
  });
  it('reads one real MIT LATAM recording; this is not a Skadi sample', () => {
    const file = readFileSync(new URL('./fixtures/latam-mergulho-test.rrf', import.meta.url));
    const replay = parseReplay(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), 'latam.rrf');
    expect(replay.status).toBe('partial');
    expect(replay.compatibility).toBe('skadi-unverified');
    expect(replay.summary.characterName).toBe('Preá');
    expect(replay.summary.playerId).toBe(1031076);
    expect(replay.summary.mapName).toBe('tra_fild');
    expect(replay.packetCount).toBe(26);
    expect(replay.events.filter(event => event.eventType === 'damage')).toHaveLength(4);
    expect(replay.events.find(event => event.eventType === 'damage')?.amount).toBe(573584);
    expect(replay.summary.totalExp).toBeNull();
    expect(replay.summary.dropCount).toBeNull();
  });

  it('counts ten observed monster deaths without asserting ten personal kills', () => {
    const packets = Array.from({ length: 10 }, (_, i) => [
      { time: i * 1000, data: spawn(100 + i) }, { time: i * 1000 + 500, data: death(100 + i) },
    ]).flat();
    const replay = parseReplay(fixture(packets), 'ten.rrf');
    expect(replay.summary.observedDeaths).toBe(10);
    expect(replay.summary.certainPersonalKills).toBe(0);
    expect(replay.summary.estimatedPersonalKills).toBe(0);
    expect(replay.summary.unknownKills).toBe(10);
    expect(replay.summary.monsters[0]?.observedDeaths).toBe(10);
  });

  it('does not count another nearby player kill as personal', () => {
    const replay = parseReplay(fixture([{ time: 0, data: spawn(99, 1, 0) }, { time: 1, data: spawn(100) }, { time: 10, data: damage(99, 100) }, { time: 20, data: death(100) }]), 'other.rrf');
    expect(replay.summary.otherKills).toBe(1);
    expect(replay.summary.estimatedPersonalKills).toBe(0);
    expect(replay.summary.totalDamage).toBe(0);
  });

  it('does not call an unknown damage source another player', () => {
    const replay = parseReplay(fixture([{ time: 0, data: spawn(100) }, { time: 10, data: damage(99, 100) }, { time: 20, data: death(100) }]), 'unknown-actor.rrf');
    expect(replay.summary.otherKills).toBe(0);
    expect(replay.summary.unknownKills).toBe(1);
    expect(replay.summary.estimatedPersonalKills).toBe(0);
  });

  it('caps character and map display text without inventing a format limit', () => {
    const replay = parseReplay(fixture([{ time: 0, data: spawn(100) }], { character: 'A'.repeat(8192), map: 'B'.repeat(8192) }), 'long-name.rrf');
    expect(replay.summary.characterName).toHaveLength(1024);
    expect(replay.summary.mapName).toHaveLength(1024);
    expect(replay.status).toBe('partial');
    expect(replay.diagnostics.filter(item => item.code === 'DISPLAY_TEXT_TRUNCATED')).toHaveLength(2);
    expect(replay.diagnostics.find(item => item.code === 'DISPLAY_TEXT_TRUNCATED')?.message).toContain('RRF format sınırı değildir');
  });

  it('marks even an exclusive observed player attack as estimated; mixed attackers stay unknown', () => {
    const replay = parseReplay(fixture([
      { time: 0, data: spawn(100) }, { time: 10, data: damage(42, 100) }, { time: 20, data: death(100) },
      { time: 30, data: spawn(101) }, { time: 40, data: damage(42, 101) }, { time: 50, data: damage(99, 101) }, { time: 60, data: death(101) },
    ]), 'mixed.rrf');
    expect(replay.summary.certainPersonalKills).toBe(0);
    expect(replay.summary.estimatedPersonalKills).toBe(1);
    expect(replay.summary.unknownKills).toBe(1);
    expect(replay.summary.totalDamage).toBe(200);
  });

  it('deduplicates a repeated vanish but allows a new life with reused entity id', () => {
    const replay = parseReplay(fixture([
      { time: 0, data: spawn(100) }, { time: 10, data: death(100) }, { time: 20, data: death(100) },
      { time: 30, data: spawn(100) }, { time: 40, data: death(100) },
    ]), 'lifecycle.rrf');
    expect(replay.summary.observedDeaths).toBe(2);
  });

  it('does not forget an earlier competing attacker when estimating a personal kill', () => {
    const replay = parseReplay(fixture([
      { time: 0, data: spawn(100) }, { time: 10, data: damage(99, 100) },
      { time: 20000, data: damage(42, 100) }, { time: 20001, data: death(100) },
    ]), 'older-competitor.rrf');
    expect(replay.summary.estimatedPersonalKills).toBe(0);
    expect(replay.summary.unknownKills).toBe(1);
  });

  it('keeps an unknown monster id and excludes PC deaths', () => {
    const replay = parseReplay(fixture([
      { time: 0, data: spawn(100, 32000) }, { time: 10, data: death(100) },
      { time: 20, data: spawn(101, 1, 0) }, { time: 30, data: death(101) },
    ]), 'unknown-mob.rrf');
    expect(replay.summary.observedDeaths).toBe(1);
    expect(replay.summary.monsters[0]?.monsterId).toBe(32000);
  });

  it('does not turn out-of-sight vanish into death and forgets stale attackers', () => {
    const replay = parseReplay(fixture([
      { time: 0, data: spawn(100) }, { time: 10, data: damage(42, 100) }, { time: 20, data: death(100, 0) },
      { time: 30, data: spawn(100) }, { time: 40, data: death(100) },
    ]), 'out-of-sight.rrf');
    expect(replay.summary.observedDeaths).toBe(1);
    expect(replay.summary.estimatedPersonalKills).toBe(0);
  });

  it('reports unknown packet id and preserves known observations', () => {
    const replay = parseReplay(fixture([{ time: 0, data: bytes(2).fill(255) }, { time: 1, data: spawn(100) }, { time: 2, data: death(100) }]), 'unknown.rrf');
    expect(replay.unknownPackets).toContainEqual({ packetId: '0xffff', count: 1 });
    expect(replay.summary.observedDeaths).toBe(1);
    expect(replay.status).toBe('partial');
  });

  it('rejects invalid magic, unsupported versions, corrupt section bounds and dates', () => {
    expect(parseReplay(bytes(400).buffer, 'bad.rrf').status).toBe('invalid');
    const unsupported = fixture([]); new Uint8Array(unsupported)[100] = 6;
    expect(parseReplay(unsupported, 'v6.rrf').status).toBe('unsupported');
    const bounds = fixture([{ time: 0, data: spawn(100) }]); new DataView(bounds).setInt32(118, 1, true);
    expect(parseReplay(bounds, 'bounds.rrf').status).toBe('invalid');
    const date = fixture([]); new Uint8Array(date)[106] = 13;
    expect(parseReplay(date, 'date.rrf').status).toBe('invalid');
  });

  it('retains valid earlier packets on a truncated final record without claiming full support', () => {
    const original = fixture([{ time: 0, data: spawn(100) }, { time: 10, data: death(100) }]);
    // Reduce only stream declared length so the following sections remain in bounds.
    const data = new DataView(original); data.setInt32(114, data.getInt32(114, true) - 1, true);
    const replay = parseReplay(original, 'partial.rrf');
    expect(replay.status).toBe('partial');
    expect(replay.summary.observedDeaths).toBe(0);
    expect(replay.diagnostics.some(d => d.code === 'TRUNCATED_PACKET')).toBe(true);
  });
});
