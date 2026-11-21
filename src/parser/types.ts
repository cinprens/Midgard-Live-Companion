export type Confidence = 'certain' | 'estimated' | 'unknown';
export type Attribution = 'personal' | 'party' | 'other' | 'unknown';
export type StatusKey = 'hp' | 'maxHp' | 'weight' | 'maxWeight' | 'zenyBalance' | 'baseLevel' | 'jobLevel' | 'baseExp' | 'jobExp' | 'nextBaseExp' | 'nextJobExp';
export interface LiveTelemetry {
  hp: number | null;
  maxHp: number | null;
  weight: number | null;
  maxWeight: number | null;
  weightPercent: number | null;
  /** Own wallet at recording start or its most recent timed balance update. */
  zenyBalance?: number | null;
  /** Sum of positive observed changes within this recording, across all causes. */
  zenyReceived?: number | null;
  baseLevel: number | null;
  jobLevel: number | null;
  /** Session 1019 before replayed status updates; never the final level cache. */
  recordingStartJobLevel?: number | null;
  /** Session snapshot at recording start. These balances never accumulate as gains. */
  recordingStartExp?: Partial<Record<'base' | 'job', { level: number; amount: number; required: number }>>;
  /** Self balances and requirements observed in the timed stream for the last observed level. */
  timedExp?: Partial<Record<'base' | 'job', { balance?: number; required?: number; reset?: boolean }>>;
  /** Recording-start class, not inferred from the job level or character name. */
  jobClassId?: number | null;
  /** Only ordinary novice/first/second classes have a compatible table mapping. */
  jobTrack?: 'novice' | 'first' | 'second' | null;
  jobTrackSource?: 'rrf-session-class' | null;
  currentBaseExp: number | null;
  currentJobExp: number | null;
  nextBaseExp: number | null;
  nextJobExp: number | null;
  lastBaseExpGain: number | null;
  lastJobExpGain: number | null;
  baseExpGained: number | null;
  jobExpGained: number | null;
  currentMap: string | null;
}
export interface ReplayEvent {
  id: string;
  timestamp: number;
  eventType: 'spawn' | 'damage' | 'death' | 'exp' | 'drop' | 'unknown' | 'map' | 'item-ground' | 'item-obtained' | 'item-disappear' | 'player-death' | 'status' | 'exp-gain' | 'exp-loss' | 'level-up' | 'inventory-ack' | 'inventory-snapshot' | 'inventory-removal' | 'server-time';
  statusKey?: StatusKey;
  expKind?: 'base' | 'job';
  actorId?: number;
  targetId?: number;
  monsterId?: number;
  monsterName?: string;
  itemId?: number;
  groundEntityId?: number;
  entityKind?: string;
  amount?: number;
  mapId?: string;
  packetId?: string;
  confidence: Confidence;
  attribution?: Attribution;
  rawData?: Record<string, unknown>;
}
export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  offset?: number;
}
export interface MonsterSummary {
  monsterId: number;
  name: string;
  observedDeaths: number;
  certainPersonalKills: number;
  estimatedPersonalKills: number;
  partyKills: number;
  otherKills: number;
  unknownKills: number;
  damage: number;
  drops: number | null;
  killsPerHour: number;
  lastSeenMs: number;
}
export interface AnalysisSummary {
  observedDeaths: number;
  certainPersonalKills: number;
  estimatedPersonalKills: number;
  partyKills: number;
  otherKills: number;
  unknownKills: number;
  totalDamage: number;
  totalExp: number | null;
  dropCount: number | null;
  killsPerHour: number;
  durationMs: number;
  startedAt: string | null;
  mapName: string | null;
  characterName: string | null;
  playerId: number | null;
  monsters: MonsterSummary[];
  timeline: { minute: number; deaths: number; damage: number }[];
  itemObservations?: ItemObservationSummary;
  liveTelemetry?: LiveTelemetry;
  inventoryFlow?: {
    baselineKnown: boolean;
    incomingCount: number;
    incomingQuantity: number;
    excludedRefreshCount: number;
    pendingCount: number;
    snapshotCount: number;
    rejectedPackets: number;
    compatibility: 'skadi-unverified';
  };
}
export interface ItemObservationSummary {
  groundCount: number;
  groundQuantity: number;
  obtainedCount: number;
  obtainedQuantity: number;
  personalDropCount: null;
  confidence: 'observed-only';
  items: { itemId: number; groundCount: number; groundQuantity: number; obtainedCount: number; obtainedQuantity: number }[];
}
export interface ParsedReplay {
  filename: string;
  format: 'RRF' | 'unknown';
  version: number | null;
  status: 'supported' | 'partial' | 'unsupported' | 'invalid';
  profile: 'rrf-v5-latam';
  compatibility: 'skadi-unverified';
  events: ReplayEvent[];
  diagnostics: Diagnostic[];
  unknownPackets: { packetId: string; count: number }[];
  packetCount: number;
  summary: AnalysisSummary;
  /** Incremental results carry cumulative counters and only newly emitted/revised events. */
  incremental?:{delta:true;sequence:number;recordingStart:boolean;eventCount:number};
}
