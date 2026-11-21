import { decodePacket, decryptChunk, deriveKeys, readHeader, readKoreanZ } from 'rrfparser';
import type { CryptKeys } from 'rrfparser';
import { emptySummary } from './analysis';
import { decodeItemObservation, ITEM_PACKET_IDS } from './items';
import { applyLiveStatus, decodeTelemetry, decodeSessionTelemetry, TELEMETRY_PACKET_IDS, emptyLiveTelemetry } from './telemetry';
import { decodeInventorySeed, InventoryFlow, isReliableInventoryIncoming, isVerifiedLootIncoming, INVENTORY_CONTROL_IDS } from './inventory';
import { combatPacketEvidence, isConfirmedPersonalKill, type KillProof } from './kills';
import type { ParsedReplay, ReplayEvent, Diagnostic, AnalysisSummary, LiveTelemetry, MonsterSummary, ItemObservationSummary } from './types';

export interface IncrementalReplaySection {type:number;data:Uint8Array;offset:number}
export interface IncrementalReplayBootstrap {header:ArrayBuffer;sections:IncrementalReplaySection[]}
type Chunk={id:number;data:Uint8Array;time:number;offset:number;order:number};
type Entity={kind:string;view:number;name:string;dead:boolean;attackers:Map<number,number>;lifecycleId:string;generation:number;appearedAt:number;deathAt:number|null;lastAttackServerTick:number|null;lastAttackTimestamp:number|null};
const MAX_BATCH_BYTES=1024*1024,MAX_BOOTSTRAP_BYTES=8*1024*1024,MAX_DISPLAY_TEXT_BYTES=1024;
const FIXED_LENGTHS=new Map([[0x0080,7],[0x008a,29],[0x02e1,33],[0x08c8,34],[0x01de,33],[0x0091,22]]);
const ENTITY_PACKET_IDS=new Set([0x0857,0x09fd,0x09fe,0x09ff,0x0915,0x0080,0x008a,0x02e1,0x08c8,0x01de,0x0091]);
const hasSemanticHandler=(id:number)=>INVENTORY_CONTROL_IDS.has(id)||TELEMETRY_PACKET_IDS.has(id)||ITEM_PACKET_IDS.has(id)||ENTITY_PACKET_IDS.has(id)||id===0x007f||id===0x0148;
const hex=(id:number)=>`0x${id.toString(16).padStart(4,'0')}`;
const copyEvent=(event:ReplayEvent):ReplayEvent=>({...event,rawData:event.rawData?{...event.rawData}:undefined});

/** Stateful v5 decoder. No full session buffers or per-packet unknown event history are retained. */
export class IncrementalReplayParser {
  private keys:CryptKeys;
  private metadata:Partial<AnalysisSummary>={};
  private totals=emptySummary();
  private telemetry=emptyLiveTelemetry();
  private telemetryOverflow=new Set<'base'|'job'|'zeny'>();
  private monsters=new Map<number,MonsterSummary>();
  private buckets=new Map<number,{minute:number;deaths:number;damage:number}>();
  private items=new Map<number,ItemObservationSummary['items'][number]>();
  private itemTotals={groundCount:0,groundQuantity:0,obtainedCount:0,obtainedQuantity:0};
  private inventoryTotals={incomingCount:0,incomingQuantity:0,excludedRefreshCount:0,pendingCount:0};
  private inventory:InventoryFlow;
  private entities=new Map<number,Entity>();
  private seenDeaths=new Set<number>();
  private deadContexts=new Map<number,number>();
  private groundItems=new Map<number,number>();
  private mapEpoch=0;
  private lastServerClockTick:number|null=null;
  private currentMap:string|undefined;
  private levels:{baseLevel:number|null;jobLevel:number|null}={baseLevel:null,jobLevel:null};
  private deathJobTrack:LiveTelemetry['jobTrack']=null;
  private lastTime=0;
  private storedDuration=0;
  private wireOffset=0;
  private initial:Chunk[]=[];
  private tail=new Uint8Array(0);
  private packetCount=0;
  private eventCount=0;
  private sequence=0;
  private diagnostics:Diagnostic[]=[];
  private diagnosticKeys=new Set<string>();
  private unknown=new Map<string,number>();
  private occurrenceTime=-1;
  private occurrences=new Map<string,number>();
  private lifeTime=-1;
  private lifeOccurrences=new Map<number,number>();
  private failed:string|null=null;
  private committed:{summary:AnalysisSummary;packetCount:number;eventCount:number};

  constructor(bootstrap:IncrementalReplayBootstrap,private filename:string){
    const bytes=new Uint8Array(bootstrap.header);
    if(bytes.length<352||!new TextDecoder('ascii').decode(bytes.subarray(0,40)).startsWith('<< Ragnarok Replay File Version')||bytes[100]!==5)throw new Error('Artımlı çözümleyici tam bir RRF v5 başlığı gerektirir.');
    if(bootstrap.sections.length>24||bootstrap.sections.reduce((sum,section)=>sum+section.data.byteLength,0)>MAX_BOOTSTRAP_BYTES)throw new Error('Replay başlangıç metaverisi 8 MiB güvenli sınırını aşıyor.');
    const date=readHeader(bootstrap.header).recordedAt;
    const dateCheck=new Date(Date.UTC(date.year,date.month-1,date.day,date.hour,date.minute,date.second));
    if(date.year<2000||date.year>2200||dateCheck.getUTCFullYear()!==date.year||dateCheck.getUTCMonth()!==date.month-1||dateCheck.getUTCDate()!==date.day||date.hour>23||date.minute>59||date.second>59)throw new Error('RRF kayıt tarihi geçersiz; XOR anahtarı güvenle belirlenemedi.');
    this.keys=deriveKeys(date);
    const pad=(n:number)=>String(n).padStart(2,'0');
    this.metadata.startedAt=`${date.year}-${pad(date.month)}-${pad(date.day)}T${pad(date.hour)}:${pad(date.minute)}:${pad(date.second)}`;
    const headerView=new DataView(bootstrap.header);
    for(let slot=0;slot<24;slot++)if(headerView.getUint16(112+slot*10,true)===1)this.wireOffset=headerView.getInt32(118+slot*10,true);
    let chunkCount=0;
    const inventoryChunks:Chunk[]=[];
    let telemetrySeed:Partial<LiveTelemetry>={};
    for(const section of bootstrap.sections){
      if(![2,3,8,14,15].includes(section.type))continue;
      const decoded=decryptChunk(section.data,section.data.byteLength,this.keys),view=new DataView(decoded.buffer,decoded.byteOffset,decoded.byteLength),chunks:Chunk[]=[];
      let at=0;
      while(at<decoded.length){
        if(++chunkCount>32768)throw new Error('Replay başlangıç parça kapasitesi aşıldı.');
        if(at+6>decoded.length)throw new Error('Replay başlangıç bölümünde eksik parça başlığı var.');
        const length=view.getInt32(at+2,true);
        if(length<0||at+6+length>decoded.length)throw new Error('Replay başlangıç bölümünde geçersiz parça uzunluğu var.');
        chunks.push({id:view.getInt16(at,true),data:decoded.subarray(at+6,at+6+length),time:0,offset:section.offset+at,order:-(section.offset+at+1)});at+=6+length;
      }
      if(section.type===2){
        const text=(chunk:Chunk|undefined)=>{if(!chunk)return null;const end=chunk.data.indexOf(0),data=chunk.data.subarray(0,Math.min(end<0?chunk.data.length:end,MAX_DISPLAY_TEXT_BYTES));try{return new TextDecoder('utf-8',{fatal:true}).decode(data)||null;}catch{return readKoreanZ(data)||null;}};
        this.metadata.characterName=text(chunks[4]);this.metadata.mapName=text(chunks[5]);
        const duration=chunks.find(chunk=>chunk.id===970&&chunk.data.length>=4);if(duration)this.storedDuration=new DataView(duration.data.buffer,duration.data.byteOffset,duration.data.length).getUint32(0,true);
      }
      if(section.type===3){const player=chunks.find(chunk=>chunk.id===1010&&chunk.data.length>=4);if(player)this.metadata.playerId=new DataView(player.data.buffer,player.data.byteOffset,player.data.length).getUint32(0,true)||null;telemetrySeed={...telemetrySeed,...decodeSessionTelemetry(chunks)};}
      if(section.type===8)inventoryChunks.push(...chunks);
      if(section.type===14||section.type===15)for(const chunk of chunks)if(chunk.data.length>=2)this.initial.push({...chunk,order:-(this.initial.length+1)});
    }
    const seed=decodeInventorySeed(inventoryChunks);this.inventory=new InventoryFlow(seed,{maximumPending:8192});
    this.telemetry={...this.telemetry,...telemetrySeed,currentMap:this.metadata.mapName??null};this.currentMap=this.metadata.mapName??undefined;
    this.levels={baseLevel:telemetrySeed.baseLevel??null,jobLevel:telemetrySeed.jobLevel??null};this.deathJobTrack=telemetrySeed.jobTrack??null;
    this.diagnostic('warning','SKADI_UNVERIFIED','Skadi uyumluluğu doğrulanmadı; desteklenmeyen paketler yalnız sayılır.');
    this.diagnostic('info','INCREMENTAL_REPLAY','Artımlı çözümleme: olaylar yalnız yeni veya kanıtı güncellenmiş kayıtları, özetler tüm işlenen geçmişi içerir.');
    if(seed.rejectedChunks)this.diagnostic('warning','INVENTORY_SEED_UNVERIFIED','Başlangıç çanta yapısının bir bölümü doğrulanamadı; bu eşyalar yeni kazanım sayılmadı.');
    this.committed={summary:this.summary(),packetCount:0,eventCount:0};
  }

  private diagnostic(severity:Diagnostic['severity'],code:string,message:string,offset?:number):void{
    const key=`${code}:${message}`;if(this.diagnosticKeys.has(key)||this.diagnostics.length>=100)return;
    this.diagnosticKeys.add(key);this.diagnostics.push({severity,code,message,offset});
  }
  private inventoryOccurrence(event:ReplayEvent):number{
    if(event.timestamp!==this.occurrenceTime){this.occurrenceTime=event.timestamp;this.occurrences.clear();}
    const key=`${event.itemId}:${event.amount}:${event.rawData?.slot}`;
    if(!this.occurrences.has(key)&&this.occurrences.size>=8192)throw new Error('Aynı zamanlı eşya olay grubu kapasitesi aşıldı.');
    const next=(this.occurrences.get(key)??0)+1;this.occurrences.set(key,next);return next;
  }
  private nextLife(aid:number,time:number,mapEpoch:number):{lifecycleId:string;generation:number}{
    if(time!==this.lifeTime){this.lifeTime=time;this.lifeOccurrences.clear();}
    if(!this.lifeOccurrences.has(aid)&&this.lifeOccurrences.size>=32768)throw new Error('Aynı zamanlı varlık yaşam grubu kapasitesi aşıldı.');
    const generation=(this.lifeOccurrences.get(aid)??0)+1;this.lifeOccurrences.set(aid,generation);
    return{lifecycleId:`wire:${mapEpoch}:${aid}:${time}:${generation}`,generation};
  }
  private pruneDead():void{
    while(this.deadContexts.size>4096){
      const [aid,deathAt]=this.deadContexts.entries().next().value!;
      this.deadContexts.delete(aid);this.seenDeaths.delete(aid);
      const entity=this.entities.get(aid);if(entity?.dead&&entity.deathAt===deathAt)this.entities.delete(aid);
      this.diagnostic('info','DEAD_CONTEXT_WINDOW','Yinelenen ölüm bağlamı harita başına son 4096 yaşam ile sınırlıdır.');
    }
  }
  private decode(input:Chunk,initial:boolean):ReplayEvent[]{
    this.pruneDead();
    const result={events:[] as ReplayEvent[]};
    const metadata=this.metadata,inventory=this.inventory,entities=this.entities,seenDeaths=this.seenDeaths,groundItems=this.groundItems,levels=this.levels;
    let currentMap=this.currentMap,mapEpoch=this.mapEpoch,lastServerClockTick=this.lastServerClockTick,deathJobTrack=this.deathJobTrack,lastTime=this.lastTime;
    const diagnostic=(severity:Diagnostic['severity'],code:string,message:string,offset?:number)=>this.diagnostic(severity,code,message,offset);
    const unsupportedPacket=(chunk:Chunk,id:string,reason='Tanımlanmamış paket')=>{
      if(!this.unknown.has(id)&&this.unknown.size>=4096)throw new Error('Tanımsız paket türü kapasitesi aşıldı.');
      const count=(this.unknown.get(id)??0)+1;this.unknown.set(id,count);
      if(count===1&&this.unknown.size<=16)diagnostic('info','UNKNOWN_PACKET_SAMPLE',`${id}: ${reason}; örnek ${[...chunk.data.subarray(0,16)].map(value=>value.toString(16).padStart(2,'0')).join(' ')}`);
    };
    for (const chunk of [input]) {
      const idNumber = chunk.data[0]! | (chunk.data[1]! << 8);
      const id = hex(idNumber);
      if (!initial) { this.packetCount++; lastTime = Math.max(lastTime, chunk.time); }
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
          if (statusKey === 'zenyBalance' && (initial || !metadata.playerId)) continue;
          if(statusKey==='weight')inventory.observeWeight(amount,chunk.time,metadata.playerId,initial);
          const status = statusKey.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
          result.events.push({ ...base, eventType: 'status', actorId: metadata.playerId ?? undefined, statusKey, amount,
            attribution: 'personal', rawData: { status, parameter, source: 'self-parameter-update', timed: !initial,
              ...(statusKey==='zenyBalance'?{timedPacketOrder:chunk.order}:{}) } });
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
        } else if (initial) {
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
          this.deadContexts.delete(aid);
          const entity = entities.get(aid);
          if (entity) {
            entity.dead = false; entity.attackers.clear();entity.deathAt=null;
            const life=this.nextLife(aid,chunk.time,mapEpoch);entity.generation=life.generation;
            entity.lifecycleId=life.lifecycleId;entity.appearedAt=chunk.time;entity.lastAttackServerTick=null;entity.lastAttackTimestamp=null;
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
          event.rawData!.inventoryOccurrence=this.inventoryOccurrence(event);inventory.receipt(event,item.slot,item.itemType,initial);result.events.push(event);
        }
        continue;
      }
      // Only these families contribute normalized analytical events in this profile.
      if (!ENTITY_PACKET_IDS.has(idNumber)) {
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
        const life=sameLife?null:this.nextLife(data.aid,chunk.time,mapEpoch),generation=sameLife?prev.generation:life!.generation;
        const entity: Entity = { kind: data.kind, view: data.view, name: entityName,
          dead: sameLife?prev.dead:false, attackers: sameLife?prev.attackers:new Map(),
          lifecycleId:sameLife?prev.lifecycleId:life!.lifecycleId,generation,
          appearedAt:sameLife?prev.appearedAt:chunk.time,deathAt:sameLife?prev.deathAt:null,
          lastAttackServerTick:sameLife?prev.lastAttackServerTick:null,lastAttackTimestamp:sameLife?prev.lastAttackTimestamp:null };
        entities.set(data.aid, entity);
        if(!entity.dead)this.deadContexts.delete(data.aid);
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
          if(!target.attackers.has(data.source)&&target.attackers.size>=256)throw new Error('Artımlı saldırgan bağlam kapasitesi aşıldı.');target.attackers.set(data.source, chunk.time);target.lastAttackServerTick=evidence.serverTick;target.lastAttackTimestamp=chunk.time;
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
        this.deadContexts.clear();
        groundItems.clear();
        result.events.push({ ...base, eventType: 'map', mapId: currentMap, confidence: 'certain' });
      } else if (decoded.type === 'vanish') {
        const data = decoded.data;
        const entity = entities.get(data.aid);
        if (data.kind !== 1) { entities.delete(data.aid);seenDeaths.delete(data.aid);this.deadContexts.delete(data.aid);continue; }
        if (seenDeaths.has(data.aid)) {
          diagnostic('info', 'DUPLICATE_DEATH', 'Aynı yaşam döngüsündeki yinelenmiş ölüm paketi sayılmadı.', chunk.offset);
          continue;
        }
        if(entity||data.aid===metadata.playerId){seenDeaths.add(data.aid);this.deadContexts.delete(data.aid);this.deadContexts.set(data.aid,chunk.time);}
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
          targetActorId:data.aid,lifecycleId:entity?.lifecycleId??`wire:${mapEpoch}:${data.aid}:${chunk.time}:0`,
          mapEpoch,spawnObserved:entity!==undefined,scope:'replay-local',serverDeathTick:null,
          lastAttackServerTick:entity?.lastAttackServerTick??null,lastAttackTimestamp:entity?.lastAttackTimestamp??null,lastServerClockTick};
        result.events.push({ ...base, eventType: 'death', targetId: data.aid, actorId: personal ? metadata.playerId ?? undefined : undefined,
          monsterId: entity?.kind === 'mob' ? entity.view : undefined, monsterName: entity?.name || undefined,
          entityKind: entity?.kind ?? 'unknown', confidence: personal || other ? 'estimated' : 'unknown',
          attribution: personal ? 'personal' : other ? 'other' : 'unknown', rawData: { observedDeath: true, attackers: entity ? [...entity.attackers.keys()] : [],killProof } });
      }
    }
    this.currentMap=currentMap;this.mapEpoch=mapEpoch;this.lastServerClockTick=lastServerClockTick;this.deathJobTrack=deathJobTrack;this.lastTime=lastTime;
    this.pruneDead();
    if(entities.size>32768||groundItems.size>32768)throw new Error('Artımlı aktif varlık bağlam kapasitesi aşıldı; önceki tamamlanan özet korundu.');
    return result.events;
  }

  private inventoryContribution(event:ReplayEvent,multiplier:number):void{
    if(isReliableInventoryIncoming(event)){this.inventoryTotals.incomingCount+=multiplier;this.inventoryTotals.incomingQuantity+=multiplier*event.amount!;}
    if(event.eventType==='inventory-ack'&&event.rawData?.pendingInventory!==true)this.inventoryTotals.excludedRefreshCount+=multiplier;
    if(event.rawData?.pendingInventory===true)this.inventoryTotals.pendingCount+=multiplier;
  }
  private itemContribution(event:ReplayEvent,multiplier:number):void{
    if(!event.itemId||!Number.isFinite(event.amount)||event.amount!<=0||!['item-ground','item-obtained'].includes(event.eventType))return;
    if(event.eventType==='item-obtained'&&!isVerifiedLootIncoming(event))return;
    if(!this.items.has(event.itemId)&&this.items.size>=8192)throw new Error('Artımlı eşya özeti kapasitesi aşıldı.');
    const row=this.items.get(event.itemId)??{itemId:event.itemId,groundCount:0,groundQuantity:0,obtainedCount:0,obtainedQuantity:0};this.items.set(event.itemId,row);
    if(event.eventType==='item-ground'){this.itemTotals.groundCount+=multiplier;this.itemTotals.groundQuantity+=multiplier*event.amount!;row.groundCount+=multiplier;row.groundQuantity+=multiplier*event.amount!;}
    else{this.itemTotals.obtainedCount+=multiplier;this.itemTotals.obtainedQuantity+=multiplier*event.amount!;row.obtainedCount+=multiplier;row.obtainedQuantity+=multiplier*event.amount!;}
    if(row.groundCount===0&&row.obtainedCount===0)this.items.delete(event.itemId);
  }
  private accumulate(event:ReplayEvent):void{
    this.itemContribution(event,1);
    if(event.eventType==='map'&&event.mapId)this.telemetry.currentMap=event.mapId;
    applyLiveStatus(this.telemetry,event,this.telemetryOverflow,true);
    if(event.eventType==='exp-gain'&&event.expKind&&Number.isSafeInteger(event.amount)&&event.amount!>=0&&event.attribution==='personal'){
      const totalKey=event.expKind==='base'?'baseExpGained':'jobExpGained',lastKey=event.expKind==='base'?'lastBaseExpGain':'lastJobExpGain';this.telemetry[lastKey]=event.amount!;
      const sum=(this.telemetry[totalKey]??0)+event.amount!;if(!Number.isSafeInteger(sum))this.telemetryOverflow.add(event.expKind);this.telemetry[totalKey]=this.telemetryOverflow.has(event.expKind)?null:sum;
    }
    if(event.entityKind!=='mob'||event.monsterId===undefined)return;
    if(!this.monsters.has(event.monsterId)&&this.monsters.size>=8192)throw new Error('Artımlı yaratık özeti kapasitesi aşıldı.');
    const row=this.monsters.get(event.monsterId)??{monsterId:event.monsterId,name:event.monsterName||`Monster #${event.monsterId}`,observedDeaths:0,certainPersonalKills:0,estimatedPersonalKills:0,partyKills:0,otherKills:0,unknownKills:0,damage:0,drops:null,killsPerHour:0,lastSeenMs:0};this.monsters.set(event.monsterId,row);row.lastSeenMs=Math.max(row.lastSeenMs,event.timestamp);
    const minute=Math.floor(event.timestamp/60000),bucket=this.buckets.get(minute)??{minute,deaths:0,damage:0};this.buckets.set(minute,bucket);
    while(this.buckets.size>1440){this.buckets.delete(this.buckets.keys().next().value!);this.diagnostic('info','TIMELINE_WINDOW','Zaman çizelgesi son 1440 gözlenen dakika ile sınırlı; toplamlar korunur.');}
    if(event.eventType==='damage'&&event.actorId===this.metadata.playerId){const amount=Math.max(0,event.amount??0);row.damage+=amount;this.totals.totalDamage+=amount;bucket.damage+=amount;}
    if(event.eventType!=='death')return;row.observedDeaths++;this.totals.observedDeaths++;bucket.deaths++;
    if(isConfirmedPersonalKill(event,this.metadata.playerId)){row.certainPersonalKills++;this.totals.certainPersonalKills++;}
    else if(event.attribution==='personal'&&event.confidence==='estimated'){row.estimatedPersonalKills++;this.totals.estimatedPersonalKills++;}
    else if(event.attribution==='party'){row.partyKills++;this.totals.partyKills++;}
    else if(event.attribution==='other'){row.otherKills++;this.totals.otherKills++;}
    else{row.unknownKills++;this.totals.unknownKills++;}
  }
  private summary():AnalysisSummary{
    const durationMs=Math.max(this.lastTime,this.storedDuration),perHour=durationMs>0?3600000/durationMs:0;
    return{...this.totals,...this.metadata,durationMs,killsPerHour:this.totals.observedDeaths*perHour,
      monsters:[...this.monsters.values()].map(row=>({...row,killsPerHour:row.observedDeaths*perHour})).sort((a,b)=>b.observedDeaths-a.observedDeaths||b.damage-a.damage),
      timeline:[...this.buckets.values()].map(row=>({...row})).sort((a,b)=>a.minute-b.minute),
      liveTelemetry:{...this.telemetry,weightPercent:this.telemetry.weight!==null&&this.telemetry.maxWeight!==null&&this.telemetry.maxWeight>0?this.telemetry.weight/this.telemetry.maxWeight*100:null},
      itemObservations:{...this.itemTotals,personalDropCount:null,confidence:'observed-only',items:[...this.items.values()].map(row=>({...row})).sort((a,b)=>b.obtainedQuantity-a.obtainedQuantity||b.groundQuantity-a.groundQuantity||a.itemId-b.itemId)},
      inventoryFlow:{...this.inventory.summary([]),...this.inventoryTotals}};
  }
  private output(events:ReplayEvent[],recordingStart:boolean):ParsedReplay{
    return{filename:this.filename,format:'RRF',version:5,status:this.failed?'invalid':this.unknown.size||this.diagnostics.some(d=>d.severity==='warning'&&d.code!=='SKADI_UNVERIFIED')?'partial':'supported',profile:'rrf-v5-latam',compatibility:'skadi-unverified',
      events,diagnostics:[...this.diagnostics],unknownPackets:[...this.unknown].map(([packetId,count])=>({packetId,count})),packetCount:this.failed?this.committed.packetCount:this.packetCount,summary:this.failed?this.committed.summary:this.summary(),
      incremental:{delta:true,sequence:++this.sequence,recordingStart,eventCount:this.failed?this.committed.eventCount:this.eventCount}};
  }

  push(frames:ArrayBuffer,options:{closed:boolean}):ParsedReplay{
    const recordingStart=this.sequence===0;
    if(this.failed)return this.output([],recordingStart);
    const delta=new Map<string,ReplayEvent>();
    const drain=(closed:boolean)=>{
      for(const {event,previous}of this.inventory.drainChanges(this.lastTime,closed)){
        if(previous){this.inventoryContribution(previous,-1);this.itemContribution(previous,-1);}
        this.inventoryContribution(event,1);this.itemContribution(event,1);delta.set(event.id,event);
      }
    };
    const consume=(chunk:Chunk,initial:boolean)=>{
      for(const event of this.decode(chunk,initial)){
        this.eventCount++;delta.set(event.id,event);
        if(event.eventType!=='item-obtained'&&event.eventType!=='inventory-ack')this.accumulate(event);
      }
      if(this.packetCount%128===0)drain(false);
    };
    try{
      if(frames.byteLength>MAX_BATCH_BYTES)throw new Error('Artımlı paket kümesi 1 MiB güvenli işlem sınırını aşıyor.');
      if(recordingStart){for(const chunk of this.initial)consume(chunk,true);this.initial=[];}
      const bytes=new Uint8Array(this.tail.byteLength+frames.byteLength);bytes.set(this.tail);bytes.set(new Uint8Array(frames),this.tail.byteLength);
      const view=new DataView(bytes.buffer);let at=0;
      while(at+10<=bytes.length){
        const size=view.getUint16(at+8,true),time=view.getInt32(at+4,true);
        if(size<2)throw new Error('Replay paket uzunluğu en az 2 byte olmalıdır.');
        if(at+10+size>bytes.length)break;
        const data=decryptChunk(bytes.subarray(at+10,at+10+size),size,this.keys),id=data[0]!|(data[1]!<<8);
        const zeroTimeUnknown=id===0x08ae&&time===0&&!hasSemanticHandler(id);
        if(time<0||(time<this.lastTime&&!zeroTimeUnknown))throw new Error('INVALID_TIMESTAMP_ORDER: Replay paket zamanı geriye gidiyor; sıralı artımlı akış güvenle sürdürülemedi.');
        if(time<this.lastTime&&zeroTimeUnknown)this.diagnostic('info','ZERO_TIME_UNKNOWN_PACKET','0x08ae sıfır zaman damgası yalnız tanılama için sayıldı; Replay saati korunuyor.',this.wireOffset+at);
        const chunk={id:view.getInt32(at,true),time,data,offset:this.wireOffset+at,order:this.packetCount+1};
        consume(chunk,false);at+=10+size;
      }
      this.wireOffset+=at;this.tail=bytes.slice(at);
      if(this.tail.byteLength>65545)throw new Error('Replay tamamlanmamış paket tampon sınırı aşıldı.');
      if(options.closed&&this.tail.length)this.diagnostic('warning','TRUNCATED_PACKET','Paket bölümü eksik bir son paketle kapanmış; yalnız tamamlanan paketler işlendi.',this.wireOffset);
      drain(options.closed&&this.tail.length===0);
      const result=this.output([...delta.values()].map(copyEvent),recordingStart);
      this.committed={summary:result.summary,packetCount:this.packetCount,eventCount:this.eventCount};return result;
    }catch(error){
      this.failed=error instanceof Error?error.message:'Artımlı Replay çözümlenemedi.';
      if(this.diagnostics.length>=100)this.diagnostics.pop();
      this.diagnostic('error','INCREMENTAL_PARSE_ERROR',this.failed);return this.output([],recordingStart);
    }
  }
}
