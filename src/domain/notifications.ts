import {inventoryConfirmationTime,isVerifiedLootIncoming} from '../parser/inventory';
import {rareDropCategory} from '../shared/rare-drop';

/** Volatile alert state only. This module has no filesystem, database or logging dependency. */
export const ALERT_KINDS = ['death', 'weight', 'card', 'glass-bead', 'old-blue-box', 'city', 'level', 'monster'] as const;
export type AlertKind = typeof ALERT_KINDS[number];
export const GLASS_BEAD_ITEM_ID = 746;
export const OLD_BLUE_BOX_ITEM_ID = 603;
export interface AlertPreferences {
  enabled: Record<AlertKind, boolean>;
  weightThreshold: number;
  selectedCardIds: number[];
  selectedMonsterIds: number[];
  cityMaps: string[];
  volume: number;
  muted: boolean;
}
export interface LiveNotification {
  id: string;
  type: AlertKind;
  streamId: string;
  character: string;
  characterKey?: string;
  subject?: string;
  threshold?: number;
  soundKind?: AlertKind;
  at: string;
  message: string;
  itemId?: number;
  monsterId?: number;
  amount?: number;
  audio?: {volume:number;muted:boolean};
}
export interface NotificationEvent {
  id?: string;
  timestamp: number;
  eventType: string;
  actorId?: number;
  targetId?: number;
  itemId?: number;
  monsterId?: number;
  monsterName?: string;
  entityKind?: string;
  confidence?: 'certain'|'estimated'|'unknown';
  attribution?: 'personal'|'party'|'other'|'unknown';
  amount?: number;
  mapId?: string;
  packetId?: string;
  statusKey?: string;
  expKind?: 'base' | 'job';
  rawData?: Record<string, unknown>;
}
export interface NotificationTelemetry {
  hp?: number | null;
  weight?: number | null;
  maxWeight?: number | null;
  baseLevel?: number | null;
  jobLevel?: number | null;
  currentMap?: string | null;
}
export interface NotificationSnapshot {
  streamId: string;
  character: string;
  characterKey?: string;
  recordIdentityVerified?: boolean;
  recordingContentHash?: string;
  recordingId: string;
  events: readonly NotificationEvent[];
  telemetry?: NotificationTelemetry | null;
  playerId?: number | null;
  mapName?: string | null;
  nameForItem?: (itemId: number) => string | undefined;
  isRareItem?: (itemId: number) => boolean;
  /** A new file identity or truncation. A normal RRF header update must not set this. */
  reset?: boolean;
  /** Events contain only newly decoded packets or corrected prior observations. */
  incremental?: boolean;
}
export const DEFAULT_ALERT_PREFERENCES: Readonly<AlertPreferences> = Object.freeze({
  enabled: Object.freeze({ death: true, weight: true, card: true, 'glass-bead': false, 'old-blue-box': true, city: true, level: true, monster: true }),
  weightThreshold: 65,
  selectedCardIds: Object.freeze([]) as unknown as number[],
  selectedMonsterIds: Object.freeze([1313]) as unknown as number[],
  cityMaps: Object.freeze([]) as unknown as string[],
  volume: 70,
  muted: false,
});
export function createDefaultAlertPreferences(): AlertPreferences {
  return { ...DEFAULT_ALERT_PREFERENCES, enabled: { ...DEFAULT_ALERT_PREFERENCES.enabled }, selectedCardIds: [], selectedMonsterIds:[1313], cityMaps: [] };
}
/** Earlier profiles stored a selected Glass Bead as a standalone switch. */
export function selectedItemIds(preferences: AlertPreferences): number[] {
  const ids=preferences.selectedCardIds;
  return preferences.enabled['glass-bead']&&!ids.includes(GLASS_BEAD_ITEM_ID)?[...ids,GLASS_BEAD_ITEM_ID]:ids;
}
const preferenceKeys = new Set(['enabled', 'weightThreshold', 'selectedCardIds', 'selectedMonsterIds', 'cityMaps', 'volume', 'muted']);
const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clonePreferences = (value: AlertPreferences): AlertPreferences => ({ ...value, enabled: { ...DEFAULT_ALERT_PREFERENCES.enabled,...value.enabled }, selectedCardIds: [...value.selectedCardIds], selectedMonsterIds:[...(value.selectedMonsterIds??[1313])], cityMaps: [...value.cityMaps] });
const normalizeMap = (value: string): string => value.normalize('NFC').trim().toLowerCase().replace(/\.gat$/i, '');

/** Accepts a partial preference patch and returns a complete validated independent value. */
export function validateAlertPreferences(value: unknown, defaults: AlertPreferences = createDefaultAlertPreferences()): AlertPreferences {
  if (!plainObject(value) || Object.keys(value).some(key => !preferenceKeys.has(key))) throw new Error('Geçersiz bildirim ayarları.');
  const result = clonePreferences(defaults);
  if (value.enabled !== undefined) {
    if (!plainObject(value.enabled) || Object.keys(value.enabled).some(key => !ALERT_KINDS.includes(key as AlertKind)) || Object.values(value.enabled).some(enabled => typeof enabled !== 'boolean')) throw new Error('Geçersiz bildirim türü tercihi.');
    Object.assign(result.enabled, value.enabled);
  }
  for (const [key, minimum, maximum] of [['weightThreshold', 1, 100], ['volume', 0, 100]] as const) {
    const selected = value[key];
    if (selected !== undefined) {
      if (typeof selected !== 'number' || !Number.isFinite(selected) || selected < minimum || selected > maximum) throw new Error(`${key === 'volume' ? 'Ses düzeyi' : 'Ağırlık eşiği'} izin verilen aralıkta olmalıdır.`);
      result[key] = selected;
    }
  }
  if (value.muted !== undefined) {
    if (typeof value.muted !== 'boolean') throw new Error('Geçersiz sessiz mod tercihi.');
    result.muted = value.muted;
  }
  if (value.selectedCardIds !== undefined) {
    if (!Array.isArray(value.selectedCardIds) || value.selectedCardIds.length > 512 || value.selectedCardIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff)) throw new Error('Eşya kimlikleri pozitif tam sayılardan oluşmalıdır.');
    result.selectedCardIds = [...new Set(value.selectedCardIds as number[])];
  }
  if (value.selectedMonsterIds !== undefined) {
    if (!Array.isArray(value.selectedMonsterIds) || value.selectedMonsterIds.length > 512 || value.selectedMonsterIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff)) throw new Error('Yaratık kimlikleri pozitif tam sayılardan oluşmalıdır.');
    result.selectedMonsterIds = [...new Set(value.selectedMonsterIds as number[])];
  }
  if (value.cityMaps !== undefined) {
    if (!Array.isArray(value.cityMaps) || value.cityMaps.length > 128 || value.cityMaps.some(map => typeof map !== 'string' || !/^[a-z0-9_@-]{1,48}(?:\.gat)?$/i.test(map.trim()))) throw new Error('Şehir haritası kimlikleri geçerli kısa harita adları olmalıdır.');
    result.cityMaps = [...new Set((value.cityMaps as string[]).map(normalizeMap))];
  }
  return result;
}

interface StreamAlertState {
  recordingId: string;
  watermark: number;
  countsAtWatermark: Map<string, number>;
  watermarkSaturated: boolean;
  lootBaselineTimestamp: number;
  lootBaselineCounts: Map<string, number>;
  lootBaselineSaturated: boolean;
  weight: number | null;
  maxWeight: number | null;
  weightLatched: boolean;
  baseLevel: number | null;
  jobLevel: number | null;
  map: string | null;
}
export type AlertPreferencesPatch = Omit<Partial<AlertPreferences>, 'enabled'> & { enabled?: Partial<Record<AlertKind, boolean>> };
export interface NotificationEngineOptions { clock?: () => number; maxFingerprintsPerStream?: number; maxNotificationsPerSnapshot?: number; }
const knownNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const knownLevel = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const relevantEvent = (event: NotificationEvent): boolean => ['player-death', 'status', 'level-up', 'map', 'item-obtained'].includes(event.eventType);
function eventFingerprint(event: NotificationEvent): string {
  // Packet positions and IDs can move when RRF section headers change. Use semantic fields.
  return JSON.stringify([event.eventType, event.timestamp, event.actorId, event.targetId, event.itemId, event.amount,
    event.mapId, event.packetId, event.statusKey, event.expKind, event.rawData?.status,
    event.rawData?.levelType, event.rawData?.previousLevel, event.rawData?.slot, event.rawData?.result]);
}
const lootFingerprint=(event:NotificationEvent,incremental?:boolean)=>JSON.stringify([incremental?event.id:null,event.timestamp,event.actorId,event.itemId,event.amount,event.packetId,event.rawData?.slot,event.rawData?.result]);
function confirmedLootTime(event:NotificationEvent,playerId:number|null|undefined):number|null {
  if(playerId===undefined||(event.rawData?.result!==undefined&&event.rawData.result!==0)||!isVerifiedLootIncoming(event,playerId))return null;
  return inventoryConfirmationTime(event);
}
const notificationTime=(event:NotificationEvent,playerId:number|null|undefined)=>confirmedLootTime(event,playerId)??event.timestamp;
const statusKey = (event: NotificationEvent): string => event.statusKey ?? String(event.rawData?.status ?? '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const ratio = (state: StreamAlertState): number | null => state.weight !== null && state.maxWeight !== null && state.maxWeight > 0 ? state.weight * 100 / state.maxWeight : null;

/** First snapshots are silent baselines. Only future observed transitions can emit alerts. */
export class NotificationEngine {
  private preferences: AlertPreferences;
  private streams = new Map<string, StreamAlertState>();
  private sequence = 0;
  private clock: () => number;
  private maxFingerprints: number;
  private maxNotifications: number;
  constructor(preferences: AlertPreferences = createDefaultAlertPreferences(), options: NotificationEngineOptions = {}) {
    this.preferences = validateAlertPreferences(preferences);
    this.clock = options.clock ?? Date.now;
    const fingerprints = options.maxFingerprintsPerStream;
    const notificationLimit = options.maxNotificationsPerSnapshot;
    this.maxFingerprints = Math.max(8, Math.min(4096, Math.floor(typeof fingerprints === 'number' && Number.isFinite(fingerprints) ? fingerprints : 512)));
    this.maxNotifications = Math.max(1, Math.min(64, Math.floor(typeof notificationLimit === 'number' && Number.isFinite(notificationLimit) ? notificationLimit : 16)));
  }
  getPreferences(): AlertPreferences { return clonePreferences(this.preferences); }
  setPreferences(patch: AlertPreferencesPatch): AlertPreferences {
    const previousThreshold = this.preferences.weightThreshold;
    this.preferences = validateAlertPreferences(patch, this.preferences);
    // Changing an option does not replay historical threshold crossings.
    if (this.preferences.weightThreshold !== previousThreshold) {
      for (const state of this.streams.values()) state.weightLatched = (ratio(state) ?? -1) >= this.preferences.weightThreshold;
    }
    return this.getPreferences();
  }
  remove(streamId: string): void { this.streams.delete(streamId); }
  clear(): void { this.streams.clear(); }
  stats(): { streams: number; retainedFingerprints: number; maximumFingerprintsPerStream: number } {
    let fingerprints = 0;
    for (const stream of this.streams.values()) fingerprints += stream.countsAtWatermark.size;
    return { streams: this.streams.size, retainedFingerprints: fingerprints, maximumFingerprintsPerStream: this.maxFingerprints };
  }
  observe(snapshot: NotificationSnapshot, sharedItemIds: readonly number[] = []): LiveNotification[] {
    if (!snapshot.streamId || !snapshot.recordingId) throw new Error('Bildirim akışı ve kayıt kimliği gereklidir.');
    let state = this.streams.get(snapshot.streamId);
    const baseline = !state || snapshot.reset === true || state.recordingId !== snapshot.recordingId;
    if (baseline) {
      state = { recordingId: snapshot.recordingId, watermark: -1, countsAtWatermark: new Map(), watermarkSaturated: false,
        lootBaselineTimestamp:-1,lootBaselineCounts:new Map(),lootBaselineSaturated:false,
        weight: null, maxWeight: null, weightLatched: false, baseLevel: null, jobLevel: null,
        map: snapshot.mapName ? normalizeMap(snapshot.mapName) : null };
      this.streams.set(snapshot.streamId, state);
    }
    const current = state!;
    const output: LiveNotification[] = [];
    const push = (type: AlertKind, message: string, fields: Pick<LiveNotification, 'itemId' | 'amount' | 'subject' | 'threshold'> = {}) => {
      if (baseline || !this.preferences.enabled[type]) return;
      // Bound one observation burst; selected item alerts take priority over less urgent map notices.
      const priority: Record<AlertKind, number> = { card: 0, 'glass-bead': 0, 'old-blue-box': 0, death: 1, weight: 2, monster: 2, level: 3, city: 4 };
      let replace = -1;
      if (output.length >= this.maxNotifications) {
        for (let i = 0; i < output.length; i++) if (replace < 0 || priority[output[i].type] >= priority[output[replace].type]) replace = i;
        if (priority[type] >= priority[output[replace].type]) return;
      }
      const notification = { id: `${snapshot.streamId}:${++this.sequence}`, type, streamId: snapshot.streamId,
        character: snapshot.character, characterKey:snapshot.characterKey, at: new Date(this.clock()).toISOString(), message, ...fields };
      if (replace < 0) output.push(notification); else output[replace] = notification;
    };
    let maximumTimestamp = -1;
    for (const event of snapshot.events) if (Number.isFinite(event.timestamp) && event.timestamp >= 0) {
      maximumTimestamp = Math.max(maximumTimestamp, notificationTime(event,snapshot.playerId));
      if(baseline)current.lootBaselineTimestamp=Math.max(current.lootBaselineTimestamp,event.timestamp);
    }
    if(baseline)for(const event of snapshot.events){
      if(event.timestamp!==current.lootBaselineTimestamp||!['item-obtained','inventory-ack'].includes(event.eventType)||!event.itemId||confirmedLootTime(event,snapshot.playerId)!==null)continue;
      const fingerprint=lootFingerprint(event,snapshot.incremental);
      if(current.lootBaselineCounts.has(fingerprint)||current.lootBaselineCounts.size<this.maxFingerprints)current.lootBaselineCounts.set(fingerprint,(current.lootBaselineCounts.get(fingerprint)??0)+1);
      else current.lootBaselineSaturated=true;
    }
    // A temporarily cut tail must not move the watermark backwards and replay old alerts later.
    if (!baseline && maximumTimestamp < current.watermark) return output;
    const oldBaseLevel = current.baseLevel, oldJobLevel = current.jobLevel;
    const explicitPrevious: { base?: number; job?: number } = {};
    const selectedItems=new Set([...selectedItemIds(this.preferences),...sharedItemIds]);
    const itemAmounts = new Map<number, number>();
    const changedStatus = new Set<string>();
    const sameTimeSeen = new Map<string, number>();
    const nextWatermarkCounts = new Map<string, number>();
    const baselineLootSeen=new Map<string,number>();
    let saturated = false;
    let ordered = snapshot.events;
    for (let i = 1; i < snapshot.events.length; i++) if (notificationTime(snapshot.events[i],snapshot.playerId) < notificationTime(snapshot.events[i - 1],snapshot.playerId)) { ordered = [...snapshot.events].sort((a, b) => notificationTime(a,snapshot.playerId) - notificationTime(b,snapshot.playerId)); break; }
    for (const event of ordered) {
      const eventTime=notificationTime(event,snapshot.playerId);
      if (!Number.isFinite(event.timestamp) || eventTime < current.watermark || event.timestamp < 0 || !relevantEvent(event)) continue;
      if(event.eventType==='item-obtained'){
        if(confirmedLootTime(event,snapshot.playerId)===null)continue;
        if(current.watermarkSaturated&&event.timestamp<=current.watermark)continue;
        if(!baseline&&event.timestamp<current.lootBaselineTimestamp)continue;
        if(!baseline&&event.timestamp===current.lootBaselineTimestamp){
          if(current.lootBaselineSaturated)continue;
          const key=lootFingerprint(event,snapshot.incremental);
          if(!baselineLootSeen.has(key)&&baselineLootSeen.size>=this.maxFingerprints)continue;
          const count=(baselineLootSeen.get(key)??0)+1;baselineLootSeen.set(key,count);
          if(count<=(current.lootBaselineCounts.get(key)??0))continue;
        }
      }
      const fingerprint = snapshot.incremental ? JSON.stringify([event.id,eventFingerprint(event)]) : eventFingerprint(event);
      if (eventTime === maximumTimestamp) {
        if (nextWatermarkCounts.has(fingerprint) || nextWatermarkCounts.size < this.maxFingerprints) nextWatermarkCounts.set(fingerprint, (nextWatermarkCounts.get(fingerprint) ?? 0) + 1);
        else saturated = true;
      }
      if (eventTime === current.watermark) {
        if (current.watermarkSaturated) continue;
        // A malformed or unusually dense frontier cannot grow the temporary deduplication map.
        if (!sameTimeSeen.has(fingerprint) && sameTimeSeen.size >= this.maxFingerprints) continue;
        const occurrence = (sameTimeSeen.get(fingerprint) ?? 0) + 1;
        sameTimeSeen.set(fingerprint, occurrence);
        if (occurrence <= (current.countsAtWatermark.get(fingerprint) ?? 0)) continue;
      }
      if (event.eventType === 'player-death') {
        const target = event.targetId ?? event.actorId;
        if (snapshot.playerId != null && target === snapshot.playerId) {
          push('death', `${snapshot.character}: Karakter öldü.`);
        }
      } else if (event.eventType === 'map' && event.mapId) {
        const map = normalizeMap(event.mapId), previous = current.map;
        current.map = map;
        changedStatus.add('map');
        if (previous !== null && previous !== map && this.preferences.cityMaps.includes(map)) push('city', `${snapshot.character}: Şehir olarak seçilen haritaya geçildi (${map}).`, {subject:map});
      } else if (event.eventType === 'status' || event.eventType === 'level-up') {
        const key = event.eventType === 'level-up' ? event.rawData?.levelType === 'job' ? 'jobLevel' : 'baseLevel' : statusKey(event);
        if (key && ['weight', 'maxWeight', 'baseLevel', 'jobLevel'].includes(key)) changedStatus.add(key);
        if (key === 'weight' && knownNonnegative(event.amount)) current.weight = event.amount;
        if (key === 'maxWeight' && knownNonnegative(event.amount) && event.amount > 0) current.maxWeight = event.amount;
        if ((key === 'baseLevel' || key === 'jobLevel') && knownLevel(event.amount)) {
          current[key] = event.amount;
          if (event.eventType === 'level-up' && knownLevel(event.rawData?.previousLevel)) explicitPrevious[key === 'baseLevel' ? 'base' : 'job'] = event.rawData.previousLevel;
        }
      } else if (event.eventType === 'item-obtained' && event.itemId !== undefined && knownNonnegative(event.amount) && event.amount > 0) {
        const id=event.itemId;
        if (baseline || !this.preferences.enabled.card || (id===OLD_BLUE_BOX_ITEM_ID ? !this.preferences.enabled['old-blue-box'] : !selectedItems.has(id))) continue;
        if (rareDropCategory(event.rawData?.itemType,event.rawData?.equipLocation)) continue;
        itemAmounts.set(id,(itemAmounts.get(id)??0)+event.amount);
      }
    }
    const telemetry = snapshot.telemetry;
    if (telemetry) {
      // A shortened same-timestamp tail must not roll state backwards and re-arm old alerts.
      if (baseline || changedStatus.has('weight') || changedStatus.has('maxWeight')) {
        if (knownNonnegative(telemetry.weight)) current.weight = telemetry.weight;
        if (knownNonnegative(telemetry.maxWeight) && telemetry.maxWeight > 0) current.maxWeight = telemetry.maxWeight;
      }
      if ((baseline || changedStatus.has('baseLevel')) && knownLevel(telemetry.baseLevel)) current.baseLevel = telemetry.baseLevel;
      if ((baseline || changedStatus.has('jobLevel')) && knownLevel(telemetry.jobLevel)) current.jobLevel = telemetry.jobLevel;
      if ((baseline || changedStatus.has('map')) && telemetry.currentMap) current.map = normalizeMap(telemetry.currentMap);
    }
    const weightPercent = ratio(current);
    if (weightPercent !== null) {
      if (baseline) current.weightLatched = weightPercent >= this.preferences.weightThreshold;
      else if (!current.weightLatched && weightPercent >= this.preferences.weightThreshold) {
        current.weightLatched = true;
        const percent='%'+new Intl.NumberFormat('tr-TR', {maximumFractionDigits:1}).format(weightPercent);
        push('weight', `${snapshot.character}: Ağırlık ${percent} oldu; %${this.preferences.weightThreshold} eşiğine ulaşıldı.`, {amount:weightPercent,subject:percent,threshold:this.preferences.weightThreshold});
      } else if (current.weightLatched && weightPercent < Math.max(0, this.preferences.weightThreshold - 3)) current.weightLatched = false;
    }
    for (const [kind, previous, value] of [['base', oldBaseLevel ?? explicitPrevious.base, current.baseLevel], ['job', oldJobLevel ?? explicitPrevious.job, current.jobLevel]] as const) {
      if (previous != null && value !== null && value > previous) push('level', `${snapshot.character}: ${kind === 'base' ? 'Temel' : 'Meslek'} seviyesi ${value} oldu.`, { amount: value });
    }
    for (const [itemId,amount] of itemAmounts) {
      if(snapshot.isRareItem?.(itemId))continue;
      const fallback=itemId===OLD_BLUE_BOX_ITEM_ID?'Old Blue Box':itemId===GLASS_BEAD_ITEM_ID?'Glass Bead':`Eşya #${itemId}`;
      const catalogName=snapshot.nameForItem?.(itemId);
      const name=catalogName&&catalogName!==`Eşya #${itemId}`?catalogName:fallback;
      push(itemId===OLD_BLUE_BOX_ITEM_ID?'old-blue-box':'card', `${snapshot.character}: ${name} çantaya geldi (${new Intl.NumberFormat('tr-TR').format(amount)} adet). Kaynağı doğrulanmadı.`, {itemId,amount,subject:name});
    }
    if (maximumTimestamp === current.watermark) {
      for (const [fingerprint, count] of current.countsAtWatermark) {
        if (nextWatermarkCounts.has(fingerprint)) nextWatermarkCounts.set(fingerprint, Math.max(count, nextWatermarkCounts.get(fingerprint)!));
        else if (nextWatermarkCounts.size < this.maxFingerprints) nextWatermarkCounts.set(fingerprint, count);
        else saturated = true;
      }
      saturated ||= current.watermarkSaturated;
    }
    current.watermark = Math.max(current.watermark, maximumTimestamp);
    current.countsAtWatermark = nextWatermarkCounts;
    current.watermarkSaturated = saturated;
    return output;
  }
}
