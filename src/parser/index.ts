import { decodePacket, decryptChunk, deriveKeys, readHeader, readKoreanZ } from 'rrfparser';
import type { CryptKeys } from 'rrfparser';
import { analyzeEvents, emptySummary } from './analysis';
import { decodeItemObservation, ITEM_PACKET_IDS, summarizeItemObservations } from './items';
import { decodeTelemetry, decodeSessionTelemetry, TELEMETRY_PACKET_IDS, summarizeLiveTelemetry } from './telemetry';
import { decodeInventorySeed, InventoryFlow } from './inventory';
import { combatPacketEvidence, type KillProof } from './kills';
import type { ParsedReplay, ReplayEvent, Diagnostic, AnalysisSummary, LiveTelemetry } from './types';
export * from './types';
export { analyzeEvents, emptySummary } from './analysis';
export { decodeItemObservation, summarizeItemObservations } from './items';
export { decodeTelemetry, decodeSessionTelemetry, jobTrackForClass, summarizeLiveTelemetry, emptyLiveTelemetry } from './telemetry';
export { decodeInventorySeed, inventoryConfirmationTime, isReliableInventoryIncoming, isVerifiedLootIncoming, InventoryFlow } from './inventory';
export type { InventoryWeightProof } from './inventory';
export { isConfirmedMonsterDeath, isConfirmedPersonalKill, isOwnDamageKill, combatPacketEvidence } from './kills';
export type { KillProof } from './kills';
export { IncrementalReplayParser } from './incremental';
export type { IncrementalReplayBootstrap, IncrementalReplaySection } from './incremental';

export const PARSER_VERSION = '0.2.1';
export const MAX_REPLAY_BYTES = 128 * 1024 * 1024;
const MAX_CHUNKS = 400000;
const MAX_DURATION_MS = 7 * 24 * 3600000;
// Application display budget; this is not a claim about the RRF format's limits.
const MAX_DISPLAY_TEXT_BYTES = 1024;
const TABLE_END = 112 + 24 * 10;
const FIXED_LENGTHS = new Map([[0x0080, 7], [0x008a, 29], [0x02e1, 33], [0x08c8, 34], [0x01de, 33], [0x0091, 22]]);
type Chunk = { id: number; data: Uint8Array; time: number; offset: number; order: number; timedOrder?: number };
type Entity = { kind: string; view: number; name: string; dead: boolean; attackers: Map<number, number>;
  lifecycleId:string;generation:number;appearedAt:number;deathAt:number|null;
  lastAttackServerTick:number|null;lastAttackTimestamp:number|null };
const hex = (id: number) => `0x${id.toString(16).padStart(4, '0')}`;

function localClock(d: { year: number; month: number; day: number; hour: number; minute: number; second: number }): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.year}-${pad(d.month)}-${pad(d.day)}T${pad(d.hour)}:${pad(d.minute)}:${pad(d.second)}`;
}

/** Decode only the source-verified v5 envelope and packet profile. Never opens a network connection. */
export function parseReplay(buffer: ArrayBuffer, filename: string): ParsedReplay {
  const result: ParsedReplay = { filename, format: 'unknown', version: null, status: 'invalid',
    profile: 'rrf-v5-latam', compatibility: 'skadi-unverified', events: [], diagnostics: [],
    unknownPackets: [], packetCount: 0, summary: emptySummary() };
  const diagnostic = (severity: Diagnostic['severity'], code: string, message: string, offset?: number) => {
    if (result.diagnostics.length < 200) result.diagnostics.push({ severity, code, message, offset });
  };
  const readDisplayText = (chunk: Chunk): string | null => {
    const window = chunk.data.subarray(0, MAX_DISPLAY_TEXT_BYTES);
    const terminator = window.indexOf(0);
    const truncated = terminator < 0 && chunk.data.length > MAX_DISPLAY_TEXT_BYTES;
    if (truncated) {
      diagnostic('warning', 'DISPLAY_TEXT_TRUNCATED', 'Görüntülenecek metin uygulamanın 1024 byte kaynak sınırında kısaltıldı; bu bir RRF format sınırı değildir.', chunk.offset);
    }
    const content = terminator < 0 ? window : window.subarray(0, terminator);
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    try {
      return utf8.decode(content) || null;
    } catch {
      // A capped UTF-8 field may end inside one code point. Validate that whole
      // sequence using at most three extra source bytes, then omit it from display.
      if (truncated && content.length) {
        let start = content.length - 1;
        while (start >= 0 && (content[start]! & 0xc0) === 0x80) start--;
        const lead = content[start] ?? 0;
        const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
        if (width && start + width > content.length && start + width <= chunk.data.length) {
          try {
            utf8.decode(chunk.data.subarray(0, start + width));
            return utf8.decode(content.subarray(0, start)) || null;
          } catch { /* The field is not valid UTF-8; retain the legacy decoder. */ }
        }
      }
      return readKoreanZ(content) || null;
    }
  };
  diagnostic('warning', 'SKADI_UNVERIFIED', 'Skadi uyumluluğu doğrulanmadı. Paket profili LATAM v5 kayıtlarına dayanır; sonuçları oyun ekranıyla karşılaştırın.');
  diagnostic('info', 'LIMITED_EVENTS', 'EXP kazanımı yalnız açık kişisel EXP bildirimi varsa okunur. Eşyanın yaratık kökeni ve party aidiyeti doğrulanmıyor; bilinmeyen değerler sıfır sayılmaz.');
  if (buffer.byteLength > MAX_REPLAY_BYTES) {
    diagnostic('error', 'FILE_TOO_LARGE', 'Dosya 128 MiB güvenli analiz sınırını aşıyor.');
    return result;
  }
  const bytes = new Uint8Array(buffer);
  const prefix = new TextDecoder('ascii').decode(bytes.subarray(0, 40));
  if (!prefix.startsWith('<< Ragnarok Replay File Version')) {
    diagnostic('error', 'MAGIC_MISMATCH', 'Ragnarok replay başlığı bulunamadı. Dosyanın gerçek bir .rrf kaydı olduğunu kontrol edin.');
    return result;
  }
  result.format = 'RRF';
  if (buffer.byteLength < 112) {
    diagnostic('error', 'TRUNCATED_HEADER', 'RRF başlığı eksik; kayıt henüz tamamlanmamış veya bozuk olabilir.');
    return result;
  }
  result.version = bytes[100] ?? null;
  if (result.version !== 5) {
    result.status = 'unsupported';
    diagnostic('error', 'UNSUPPORTED_VERSION', `RRF sürümü ${result.version} desteklenmiyor. Bu sürüm için paket tanımları uygulanmadı.`);
    return result;
  }
  if (buffer.byteLength < TABLE_END) {
    diagnostic('error', 'TRUNCATED_TABLE', '24 bölümlük RRF tanım tablosu eksik. Kaydın yazımının tamamlanmasını bekleyin.');
    return result;
  }
  try {
    const header = readHeader(buffer);
    const date = header.recordedAt;
    const dateCheck = new Date(Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute, date.second));
    if (date.year < 2000 || date.year > 2200 || dateCheck.getUTCFullYear() !== date.year ||
      dateCheck.getUTCMonth() !== date.month - 1 || dateCheck.getUTCDate() !== date.day ||
      date.hour > 23 || date.minute > 59 || date.second > 59) {
      throw new Error('RRF kayıt tarihi geçersiz; XOR anahtarı güvenle belirlenemedi.');
    }
    const keys = deriveKeys(date);
    const view = new DataView(buffer);
    const stream: Chunk[] = [];
    const initial: Chunk[] = [];
    const inventoryChunks: Chunk[] = [];
    const metadata: Partial<AnalysisSummary> = { startedAt: localClock(date) };
    const telemetrySeed: Partial<LiveTelemetry> = {};
    let totalChunks = 0;
    let storedDuration = 0;
    let closedPacketStream = true;
    const ranges: { start: number; end: number }[] = [];
    const generic = (body: Uint8Array, keys_: CryptKeys, fileOffset: number): Chunk[] => {
      const decoded = decryptChunk(body, body.length, keys_);
      const dataView = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      const chunks: Chunk[] = [];
      let at = 0;
      while (at < decoded.length) {
        if (++totalChunks > MAX_CHUNKS) throw new Error('Kayıt 400.000 parça analiz sınırını aşıyor.');
        if (at + 6 > decoded.length) {
          diagnostic('warning', 'TRUNCATED_CHUNK', 'Bölümün son parçası eksik; sağlam parçalar korundu.', fileOffset + at);
          break;
        }
        const length = dataView.getInt32(at + 2, true);
        if (length < 0 || at + 6 + length > decoded.length) {
          diagnostic('warning', 'INVALID_CHUNK_LENGTH', 'Bölümde geçersiz parça uzunluğu var; bölümün kalan kısmı atlandı.', fileOffset + at);
          break;
        }
        chunks.push({ id: dataView.getInt16(at, true), data: decoded.subarray(at + 6, at + 6 + length), time: 0, offset: fileOffset + at, order: totalChunks });
        at += 6 + length;
      }
      return chunks;
    };
    for (let slot = 0; slot < 24; slot++) {
      const at = 112 + slot * 10;
      const type = view.getUint16(at, true);
      const declared = view.getInt32(at + 2, true);
      const start = view.getInt32(at + 6, true);
      if (declared === 0 && start === 0) continue;
      const length = declared === 0 ? buffer.byteLength - start : declared;
      if (declared < 0 || start < TABLE_END || length < 0 || start + length > buffer.byteLength) {
        throw new Error(`RRF bölüm ${slot} sınırı geçersiz (konum ${start}, uzunluk ${declared}); dosya eksik olabilir.`);
      }
      if (ranges.some(range => start < range.end && start + length > range.start)) {
        throw new Error(`RRF bölüm ${slot} başka bir bölümle örtüşüyor; bozuk bölüm tablosu.`);
      }
      ranges.push({ start, end: start + length });
      const body = bytes.subarray(start, start + length);
      if (type === 1) {
        if(declared===0)closedPacketStream=false;
        const packetView = new DataView(buffer, start, length);
        let pointer = 0;
        while (pointer < length) {
          if (++totalChunks > MAX_CHUNKS) throw new Error('Kayıt 400.000 parça analiz sınırını aşıyor.');
          if (pointer + 10 > length) {
            diagnostic('warning', 'TRUNCATED_PACKET_HEADER', 'Son paket başlığı eksik; tamamlanmış paketler korundu.', start + pointer);
            break;
          }
          const size = packetView.getUint16(pointer + 8, true);
          const time = packetView.getInt32(pointer + 4, true);
          if (time < 0 || time > MAX_DURATION_MS) {
            diagnostic('warning', 'INVALID_TIMESTAMP', 'Geçersiz paket zamanı; paket atlandı.', start + pointer);
          } else if (size < 2 || pointer + 10 + size > length) {
            diagnostic('warning', 'TRUNCATED_PACKET', 'Paket eksik veya uzunluğu geçersiz; akışın kalan kısmı atlandı.', start + pointer);
            break;
          } else {
            stream.push({ id: packetView.getInt32(pointer, true), time, data: decryptChunk(body.subarray(pointer + 10, pointer + 10 + size), size, keys), offset: start + pointer, order: totalChunks, timedOrder: stream.length+1 });
          }
          pointer += 10 + size;
        }
      } else if ([2, 3, 8, 14, 15].includes(type)) {
        if (declared === 0) {
          diagnostic('warning', 'ZERO_LENGTH_GENERIC', 'Uzunluğu belirtilmemiş veri bölümü yorumlanmadı.', start);
          continue;
        }
        const chunks = generic(body, keys, start);
        if(type===8)inventoryChunks.push(...chunks);
        if (type === 2) {
          metadata.characterName = chunks[4] ? readDisplayText(chunks[4]) : null;
          metadata.mapName = chunks[5] ? readDisplayText(chunks[5]) : null;
          const duration = chunks.find(chunk => chunk.id === 970 && chunk.data.length >= 4);
          if (duration) storedDuration = new DataView(duration.data.buffer, duration.data.byteOffset, duration.data.length).getUint32(0, true);
        }
        if (type === 3) {
          const player = chunks.find(chunk => chunk.id === 1010 && chunk.data.length >= 4);
          if (player) metadata.playerId = new DataView(player.data.buffer, player.data.byteOffset, player.data.length).getUint32(0, true) || null;
          Object.assign(telemetrySeed, decodeSessionTelemetry(chunks));
        }
        if (type === 14 || type === 15) initial.push(...chunks.filter(chunk => chunk.data.length >= 2));
      }
    }
    const entities = new Map<number, Entity>();
    const unknown = new Map<string, number>();
    const all = [...initial, ...stream.sort((a, b) => a.time - b.time || a.order - b.order)];
    const initialOrders = new Set(initial.map(chunk => chunk.order));
    const seenDeaths = new Set<number>();
    const generations = new Map<number,number>();
    let mapEpoch=0;
    let lastServerClockTick:number|null=null;
    const groundItems = new Map<number,number>();
    const inventorySeed=decodeInventorySeed(inventoryChunks);
    const inventory=new InventoryFlow(inventorySeed);
    if(inventorySeed.rejectedChunks)diagnostic('warning','INVENTORY_SEED_UNVERIFIED','Başlangıç çanta yapısının bir bölümü doğrulanamadı; bu eşyalar yeni kazanım sayılmadı.');
    let currentMap = metadata.mapName ?? undefined;
    const levels = { baseLevel: telemetrySeed.baseLevel ?? null, jobLevel: telemetrySeed.jobLevel ?? null };
    let deathJobTrack = telemetrySeed.jobTrack ?? null;
    let lastTime = 0;
    const unsupportedPacket = (chunk: Chunk, id: string, reason = 'Tanımlanmamış paket'): void => {
      unknown.set(id, (unknown.get(id) ?? 0) + 1);
      result.events.push({ id: `packet-${chunk.order}`, timestamp: chunk.time, eventType: 'unknown', confidence: 'unknown', packetId: id,
        mapId: currentMap, rawData: { reason, length: chunk.data.length, prefixHex: [...chunk.data.subarray(0, 24)].map(b => b.toString(16).padStart(2, '0')).join(' ') } });
    };
    for (const chunk of all) {
      const idNumber = chunk.data[0]! | (chunk.data[1]! << 8);
      const id = hex(idNumber);
      if (!initialOrders.has(chunk.order)) { result.packetCount++; lastTime = Math.max(lastTime, chunk.time); }
      const inventoryControl=inventory.control(chunk.data,{id:`packet-${chunk.order}`,timestamp:chunk.time,packetId:id,mapId:currentMap},metadata.playerId??null);
      if(inventoryControl.handled){
        result.events.push(...inventoryControl.events);
        if(inventoryControl.error){diagnostic('warning','INVENTORY_LAYOUT_MISMATCH',inventoryControl.error,chunk.offset);unsupportedPacket(chunk,id,inventoryControl.error);}
        continue;
      }
      if(idNumber===0x007f){
        if(chunk.data.length!==6){diagnostic('warning','PACKET_LAYOUT_MISMATCH','0x007f sunucu saati paketi tam 6 byte olmalıdır.',chunk.offset);unsupportedPacket(chunk,id,'Sunucu saati düzeni uyuşmuyor');}
        else {lastServerClockTick=new DataView(chunk.data.buffer,chunk.data.byteOffset,6).getUint32(2,true);result.events.push({id:`packet-${chunk.order}`,timestamp:chunk.time,eventType:'server-time',packetId:id,mapId:currentMap,confidence:'certain',rawData:{serverTick:lastServerClockTick,source:'server-clock-sample',deathTick:false}});}
        continue;
      }
      if (TELEMETRY_PACKET_IDS.has(idNumber)) {
        const telemetry = decodeTelemetry(chunk.data);
        const base = { id: `packet-${chunk.order}`, timestamp: chunk.time, packetId: id, mapId: currentMap, confidence: 'certain' as const };
        if (!telemetry || telemetry.kind === 'invalid') {
          if(telemetry?.kind==='invalid'){inventory.finalize(chunk.time,false);inventory.invalidateWeight('invalid-telemetry');}
          if (telemetry?.kind === 'invalid') diagnostic('warning', 'TELEMETRY_LAYOUT_MISMATCH', telemetry.reason, chunk.offset);
          unsupportedPacket(chunk, id, telemetry?.kind === 'invalid' ? telemetry.reason : 'Desteklenmeyen durum parametresi');
        } else if (telemetry.kind === 'status') {
          const { statusKey, amount, parameter } = telemetry;
          if (statusKey === 'zenyBalance' && (initialOrders.has(chunk.order) || !metadata.playerId)) continue;
          if(statusKey==='weight')inventory.observeWeight(amount,chunk.time,metadata.playerId,initialOrders.has(chunk.order));
          const status = statusKey.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
          result.events.push({ ...base, eventType: 'status', actorId: metadata.playerId ?? undefined, statusKey, amount,
            attribution: 'personal', rawData: { status, parameter, source: 'self-parameter-update', timed: !initialOrders.has(chunk.order),
              ...(statusKey==='zenyBalance'?{timedPacketOrder:chunk.timedOrder}:{}) } });
          if (statusKey === 'baseLevel' || statusKey === 'jobLevel') {
            const previousLevel = levels[statusKey];
            if (statusKey === 'jobLevel' && previousLevel !== null && amount < previousLevel) deathJobTrack = null;
            if (previousLevel !== null && amount > previousLevel) {
              result.events.push({ ...base, id: `${base.id}-level`, eventType: 'level-up', actorId: metadata.playerId ?? undefined,
                amount, expKind: statusKey === 'baseLevel' ? 'base' : 'job', attribution: 'personal',
                rawData: { levelType: statusKey === 'baseLevel' ? 'base' : 'job', previousLevel, source: 'self-level-change' } });
            }
            levels[statusKey] = amount;
          }
        } else if (initialOrders.has(chunk.order)) {
          continue;
        } else if (metadata.playerId != null && telemetry.actorId === metadata.playerId) {
          result.events.push({ ...base, eventType: telemetry.amount < 0 ? 'exp-loss' : 'exp-gain', actorId: telemetry.actorId,
            amount: telemetry.amount, expKind: telemetry.expKind, attribution: 'personal',
            rawData: { expType: telemetry.expKind, quest: telemetry.quest, source: 'explicit-exp-notification' } });
        } else {
          unsupportedPacket(chunk, id, 'EXP bildiriminin karakter kimliği kayıt sahibiyle doğrulanamadı');
        }
        continue;
      }
      if (idNumber === 0x0148) {
        if (chunk.data.length !== 8) {
          diagnostic('warning', 'PACKET_LAYOUT_MISMATCH', '0x0148 dirilme paketi uzunluğu uyuşmuyor.', chunk.offset);
          unsupportedPacket(chunk, id, 'Dirilme paketi düzeni uyuşmuyor');
        } else {
          const aid = new DataView(chunk.data.buffer, chunk.data.byteOffset, 8).getUint32(2, true);
          seenDeaths.delete(aid);
          const entity = entities.get(aid);
          if (entity) {
            entity.dead = false; entity.attackers.clear();entity.deathAt=null;
            entity.generation=(generations.get(aid)??entity.generation)+1;generations.set(aid,entity.generation);
            entity.lifecycleId=`${mapEpoch}:${aid}:${entity.generation}`;entity.appearedAt=chunk.time;entity.lastAttackServerTick=null;entity.lastAttackTimestamp=null;
          }
        }
        continue;
      }
      if(ITEM_PACKET_IDS.has(idNumber)){
        const item=decodeItemObservation(chunk.data);
        const base={id:`packet-${chunk.order}`,timestamp:chunk.time,packetId:id,mapId:currentMap};
        if(!item||item.kind==='invalid'){
          inventory.finalize(chunk.time,false);inventory.invalidateWeight('invalid-item-layout');
          diagnostic('warning','ITEM_LAYOUT_MISMATCH',item?.kind==='invalid'?item.reason:'Eşya paketi çözülemedi.',chunk.offset);
          unsupportedPacket(chunk,id,'Eşya paket düzeni uyuşmuyor');
        }else if(item.kind==='failed'){
          inventory.finalize(chunk.time,false);inventory.invalidateWeight('failed-item-receipt');
          diagnostic('info','ITEM_RECEIVE_FAILED',`${id} eşya edinme işlemi başarısız (sonuç ${item.result}); edinilen eşya olarak sayılmadı.`,chunk.offset);
        }else if(item.kind==='disappear'){
          groundItems.delete(item.groundEntityId);
          result.events.push({...base,eventType:'item-disappear',groundEntityId:item.groundEntityId,confidence:'certain',attribution:'unknown'});
        }else if(item.kind==='ground'){
          if(groundItems.get(item.groundEntityId)===item.itemId)continue;
          groundItems.set(item.groundEntityId,item.itemId);
          result.events.push({...base,eventType:'item-ground',itemId:item.itemId,groundEntityId:item.groundEntityId,amount:item.amount,confidence:'certain',attribution:'unknown',rawData:{observedOnly:true,appearance:item.appearance,x:item.x,y:item.y,identifierKind:'client-nameid',personalDrop:false}});
        }else{
          const event:ReplayEvent={...base,eventType:'item-obtained',itemId:item.itemId,amount:item.amount,actorId:metadata.playerId??undefined,confidence:'certain',attribution:'unknown',rawData:{observedOnly:true,slot:item.slot,result:0,source:'inventory-add-ack',identifierKind:'client-nameid',monsterOriginUnknown:true,personalDrop:false}};
          event.rawData!.equipLocation=item.equipLocation;
          inventory.receipt(event,item.slot,item.itemType,initialOrders.has(chunk.order));result.events.push(event);
        }
        continue;
      }
      // Only these families contribute normalized analytical events in this profile.
      if (![0x0857, 0x09fd, 0x09fe, 0x09ff, 0x0915, 0x0080, 0x008a, 0x02e1, 0x08c8, 0x01de, 0x0091].includes(idNumber)) {
        unsupportedPacket(chunk, id);
        continue;
      }
      const fixedLength = FIXED_LENGTHS.get(idNumber);
      if ((fixedLength !== undefined && chunk.data.length !== fixedLength) ||
        (fixedLength === undefined && (chunk.data.length < (idNumber === 0x0857 ? 69 : 84) ||
          new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length).getUint16(2, true) !== chunk.data.length))) {
        diagnostic('warning', 'PACKET_LAYOUT_MISMATCH', `${id} paket uzunluğu doğrulanmış profille uyuşmuyor; olay sayılmadı.`, chunk.offset);
        unsupportedPacket(chunk, id, 'Paket düzeni uyuşmuyor');
        continue;
      }
      const decoded = decodePacket(chunk.data, chunk.time);
      if (!decoded) {
        diagnostic('warning', 'PACKET_DECODE_FAILED', `${id} paketi çözülemedi; olay sayılmadı.`, chunk.offset);
        unsupportedPacket(chunk, id, 'Paket çözülemedi');
        continue;
      }
      const base = { id: `packet-${chunk.order}`, timestamp: chunk.time, packetId: id, mapId: currentMap };
      if (decoded.type === 'entity') {
        const data = decoded.data;
        // Packet payloads are u16-bounded, but their names also receive a display budget.
        const entityName = data.name.slice(0, MAX_DISPLAY_TEXT_BYTES);
        if (entityName.length !== data.name.length) {
          diagnostic('warning', 'DISPLAY_TEXT_TRUNCATED', 'Varlık adı uygulamanın 1024 karakter görüntüleme sınırında kısaltıldı; bu bir RRF format sınırı değildir.', chunk.offset);
        }
        const prev = entities.get(data.aid);
        // Idle/movement entries are also visibility updates, not unique spawn IDs.
        // A dead full-layout mob needs an alive HP observation before a new life.
        const aliveReentry=prev?.dead&&data.kind==='mob'&&chunk.time>(prev.deathAt??-1)&&
          (idNumber===0x0857||(data.maxHp>0&&data.hp>0));
        const sameLife=prev!==undefined&&prev.kind===data.kind&&prev.view===data.view&&(!prev.dead||!aliveReentry);
        const generation=sameLife?prev.generation:(generations.get(data.aid)??0)+1;
        generations.set(data.aid,generation);
        const entity: Entity = { kind: data.kind, view: data.view, name: entityName,
          dead: sameLife?prev.dead:false, attackers: sameLife?prev.attackers:new Map(),
          lifecycleId:sameLife?prev.lifecycleId:`${mapEpoch}:${data.aid}:${generation}`,generation,
          appearedAt:sameLife?prev.appearedAt:chunk.time,deathAt:sameLife?prev.deathAt:null,
          lastAttackServerTick:sameLife?prev.lastAttackServerTick:null,lastAttackTimestamp:sameLife?prev.lastAttackTimestamp:null };
        entities.set(data.aid, entity);
        if(!sameLife)seenDeaths.delete(data.aid);
        result.events.push({ ...base, eventType: 'spawn', actorId: data.aid, monsterId: data.kind === 'mob' ? data.view : undefined,
          monsterName: entityName || undefined, entityKind: data.kind, confidence: 'certain',
          rawData:{lifecycleId:entity.lifecycleId,mapEpoch,spawnGeneration:generation,entryMeaning:sameLife?'visibility-update':'new-observed-segment',uniqueServerSpawnId:false} });
      } else if (decoded.type === 'damage') {
        const data = decoded.data;
        const target = entities.get(data.target);
        const evidence=combatPacketEvidence(chunk.data);
        const hpAttack=data.damage>0&&evidence&&!evidence.isSpDamage&&![1,2,3,11].includes(evidence.action);
        if (hpAttack && target && !target.dead) {
          target.attackers.set(data.source, chunk.time);target.lastAttackServerTick=evidence.serverTick;target.lastAttackTimestamp=chunk.time;
        }
        result.events.push({ ...base, eventType: 'damage', actorId: data.source, targetId: data.target, amount: data.damage,
          monsterId: target?.kind === 'mob' ? target.view : undefined, monsterName: target?.name || undefined,
          entityKind: target?.kind ?? 'unknown', confidence: 'certain', rawData: { skillId: data.skillId, hits: data.hits,
            serverTick:evidence?.serverTick??null,action:evidence?.action??null,isSpDamage:evidence?.isSpDamage??false,
            lifecycleId:target?.lifecycleId??null,fatalDamage:null,fatalDamageEvidence:'not-carried',deathEvidence:false } });
      } else if (decoded.type === 'mapChange') {
        inventory.mapChanged(chunk.time);
        currentMap = decoded.data.map;
        mapEpoch++;
        lastServerClockTick=null;
        entities.clear();
        seenDeaths.clear();
        groundItems.clear();
        result.events.push({ ...base, eventType: 'map', mapId: currentMap, confidence: 'certain' });
      } else if (decoded.type === 'vanish') {
        const data = decoded.data;
        const entity = entities.get(data.aid);
        if (data.kind !== 1) { entities.delete(data.aid); continue; }
        if (seenDeaths.has(data.aid)) {
          diagnostic('info', 'DUPLICATE_DEATH', 'Aynı yaşam döngüsündeki yinelenmiş ölüm paketi sayılmadı.', chunk.offset);
          continue;
        }
        seenDeaths.add(data.aid);
        if (metadata.playerId != null && data.aid === metadata.playerId) {
          result.events.push({ ...base, id: `${base.id}-player-death`, eventType: 'player-death', actorId: metadata.playerId, targetId: data.aid,
            entityKind: 'pc', confidence: 'certain', attribution: 'personal', rawData: { source: 'own-death-vanish', observedDeath: true,
              baseLevel: levels.baseLevel, jobLevel: levels.jobLevel, jobTrack: deathJobTrack, lifecycleId: entity?.lifecycleId ?? null, mapEpoch } });
        }
        const recent = entity ? [...entity.attackers.entries()].filter(([, time]) => chunk.time - time <= 10000).map(([actor]) => actor) : [];
        const personal = metadata.playerId != null && entity?.attackers.size === 1 && recent.length === 1 && recent[0] === metadata.playerId;
        const other = metadata.playerId != null && recent.length > 0 && entity !== undefined &&
          !entity.attackers.has(metadata.playerId) && [...entity.attackers.keys()].every(actor => entities.get(actor)?.kind === 'pc');
        if (entity) {entity.dead = true;entity.deathAt=chunk.time;}
        const killProof:KillProof={death:'vanish-kind-1',ownership:personal?'exclusive-observed-attacker-estimate':other?'observed-other-attacker-estimate':'unknown',
          targetActorId:data.aid,lifecycleId:entity?.lifecycleId??`${mapEpoch}:${data.aid}:${generations.get(data.aid)??0}`,
          mapEpoch,spawnObserved:entity!==undefined,scope:'replay-local',serverDeathTick:null,
          lastAttackServerTick:entity?.lastAttackServerTick??null,lastAttackTimestamp:entity?.lastAttackTimestamp??null,lastServerClockTick};
        result.events.push({ ...base, eventType: 'death', targetId: data.aid, actorId: personal ? metadata.playerId ?? undefined : undefined,
          monsterId: entity?.kind === 'mob' ? entity.view : undefined, monsterName: entity?.name || undefined,
          entityKind: entity?.kind ?? 'unknown', confidence: personal || other ? 'estimated' : 'unknown',
          attribution: personal ? 'personal' : other ? 'other' : 'unknown', rawData: { observedDeath: true, attackers: entity ? [...entity.attackers.keys()] : [],killProof } });
      }
    }
    if (storedDuration > MAX_DURATION_MS) {
      diagnostic('warning', 'INVALID_DURATION', 'Kayıt süresi yedi günlük sınırı aşıyor; paket süresi kullanıldı.');
      storedDuration = 0;
    }
    inventory.finalize(lastTime,closedPacketStream&&!result.diagnostics.some(item=>item.code.startsWith('TRUNCATED_')));
    result.summary = analyzeEvents(result.events, { ...metadata, durationMs: Math.max(lastTime, storedDuration) });
    result.summary.inventoryFlow=inventory.summary(result.events);
    result.summary.itemObservations=summarizeItemObservations(result.events);
    result.summary.liveTelemetry = summarizeLiveTelemetry(result.events, { ...telemetrySeed, currentMap: metadata.mapName ?? null }, true);
    if(result.summary.itemObservations.groundCount||result.summary.itemObservations.obtainedCount)diagnostic('info','ITEM_OBSERVATION_ONLY','Yerde görülen veya envantere eklenen eşyalar gözlemdir; yaratık kökeni ve kişisel drop aidiyeti doğrulanmadı.');
    result.unknownPackets = [...unknown.entries()].map(([packetId, count]) => ({ packetId, count }));
    result.status = result.unknownPackets.length > 0 || result.diagnostics.some(d => d.code !== 'SKADI_UNVERIFIED' && d.severity === 'warning') ? 'partial' : 'supported';
    if (stream.length === 0) {
      diagnostic('warning', 'NO_PACKET_STREAM', 'Kayıtta tamamlanmış paket akışı bulunamadı; yalnızca başlangıç bilgileri mevcut.');
      result.status = 'partial';
    }
    diagnostic('info', 'ATTRIBUTION_LIMIT', 'Gözlenen yaratık ölümü kesin kill aidiyeti değildir. Yalnız kendi hasarı görülen ölüm bile tahmini kişisel kill sayılır; paylaşımlı veya hasarsız ölüm belirsizdir.');
    diagnostic('info', 'CLOCK_NO_TIMEZONE', 'Başlıktaki tarih yerel duvar saatidir; dosya saat dilimi taşımaz. Kayıtlar arası örtüşme eşleştirmesi kesin değildir.');
    return result;
  } catch (error) {
    diagnostic('error', 'INVALID_STRUCTURE', error instanceof Error ? error.message : 'RRF veri yapısı okunamadı.');
    // A failed structural analysis must not leak partially accumulated statistics.
    result.events = [];
    result.summary = emptySummary();
    return result;
  }
}
