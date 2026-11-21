export type Confidence = 'confirmed' | 'inferred' | 'unknown';
import type { AlertKind, AlertPreferences, LiveNotification } from '../domain/notifications';
export type { AlertKind, AlertPreferences, LiveNotification } from '../domain/notifications';
export type { RareDropEvent, RareDropCategory } from './rare-drop';
export interface SoundChoice { name: string; dataUrl: string; }
export interface MonsterStat {
  monsterId: number;
  name: string;
  deaths: number;
  personalKills: number;
  inferredKills: number;
  partyKills: number;
  damage: number;
  lastSeenMs: number;
}
export interface AnalysisSummary {
  durationMs: number;
  startedAt: string | null;
  mapName: string | null;
  characterName: string | null;
  playerId: number | null;
  deaths: number;
  personalKills: number;
  inferredKills: number;
  partyKills: number;
  unknownKills: number;
  damage: number;
  exp: number | null;
  drops: number | null;
  monsters: MonsterStat[];
  timeline: { minute: number; deaths: number; damage: number }[];
  itemObservations?: ItemObservationSummary;
  liveTelemetry?: import('../parser/types').LiveTelemetry;
  inventoryBaselineKnown?: boolean;
  inventoryPendingCount?: number;
}
export interface ItemObservationSummary {
  groundCount: number;
  groundQuantity: number;
  obtainedCount: number;
  obtainedQuantity: number;
  items: { itemId: number; groundCount: number; groundQuantity: number; obtainedCount: number; obtainedQuantity: number }[];
  personalDropCount: null;
  confidence: 'observed-only';
}
export interface ReplayRecord {
  id: string;
  filename: string;
  hash: string;
  size: number;
  importedAt: string;
  status: 'analyzed' | 'unsupported' | 'error';
  format: string;
  version: string;
  summary: AnalysisSummary | null;
  diagnostics: string[];
  error: string | null;
  overlapExcluded: boolean;
  character?: CharacterIdentity;
}
export interface CharacterIdentity {
  key: string;
  name: string;
  source: 'recorded' | 'manual' | 'unassigned';
  playerId: number | null;
}
export interface ManualCharacterInput { key?: string; name: string; }
export type LiveStreamStatus = 'queued' | 'reading' | 'analyzing' | 'following' | 'settled' | 'paused' | 'stopped' | 'missing' | 'error' | 'resource-wait';
export interface RecentLootSummary {
  pickupCount: number;
  totalQuantity: number;
  items: {itemId: number; quantity: number}[];
}
export interface DailyLootSummary {
  /** İstanbul calendar day, using the same dated receipts as the finance archive. */
  date: string;
  totalQuantity: number;
  /** Current daily counts for just the item IDs in this stream’s recent pickup list. */
  itemQuantities: Record<number, number>;
}
export interface LiveStreamState {
  id: string;
  /** Today's estimated own-damage kills from the character's dated Kill Count archive. */
  taskbarKillDay?: {date: string; count: number | null};
  /** Observed character totals for one Istanbul calendar day. */
  taskbarDay?: {
    date: string;
    items: {itemId: number; quantity: number}[];
    recentItemIds: number[];
    lootObserved: boolean;
    zenyReceived: number | null;
    observedMs: number | null;
  };
  /** Most recent accepted bag delta in this live source, for this app session. */
  lastLoot?: {itemId: number; quantity: number};
  /** Latest three accepted pickups on this stream, grouped by item in newest-first order. */
  recentLoot?: RecentLootSummary;
  dailyLoot?: DailyLootSummary;
  filename: string;
  sourcePath: string;
  status: LiveStreamStatus;
  revision: number;
  readPosition: number;
  fileSize: number;
  bytesReadTotal: number;
  lastActivityAt: string | null;
  lastSuccessfulReadAt: string | null;
  diagnostics: string[];
  packetCount: number;
  eventCount: number;
  summary: AnalysisSummary | null;
  character?: CharacterIdentity;
  compatibility: 'skadi-unverified';
  contentHash?: string;
  sourceMode?: 'manual' | 'folder';
  liveActivity?: 'waiting' | 'live' | 'idle';
  lastValidatedProgressAt?: string | null;
}
export interface LiveResourceLimits {
  maxWorkers: number;
  memoryBudgetBytes: number;
  perFileBytes: number;
  pollIntervalMs: number;
  settleMs: number;
}
export interface LiveRuntimeState {
  streams: LiveStreamState[];
  limits: LiveResourceLimits;
  activeWorkers: number;
  queuedCount: number;
  bufferedBytes: number;
  discovery: { enabled: boolean; folder: string | null; blockedReason: string | null; candidateCount?: number; recordingsRevision?: number;
    waitingCount?: number; liveCount?: number; idleCount?: number; lastScanAt?: string | null; idleAfterMs?: number };
  compatibility: 'skadi-unverified';
  mode: 'experimental-snapshots' | 'incremental';
}
export interface FolderEntry {
  name: string;
  size: number;
  modifiedAt: string;
  status: string;
}
export interface AnalysisJob {
  id: string;
  filename: string;
  status: string;
  message: string;
  createdAt: string;
}
export interface AppState {
  expansion?: import('./expansion').ExpansionState;
  assistance?: {
    liveOnly: boolean;
    preferences: AlertPreferences;
    preferencesPath: string;
    sounds: Partial<Record<AlertKind, { name: string }>>;
    rareDropSounds?: import('./rare-drop-sounds').RareSoundSetting[];
    sceneDurations?: import('./scene-durations').SceneDurations;
    preferenceError: string | null;
  };
  records: ReplayRecord[];
  jobs: AnalysisJob[];
  folderFiles: FolderEntry[];
  live?: LiveRuntimeState;
  replayTime?: import('./replay-clock').ReplayClockState;
  comparison?: import('../domain/characters').CharacterComparison;
  manualCharacters?: CharacterIdentity[];
  settings: {
    replayFolder: string | null;
    databasePath: string;
    watchRequested: boolean;
    watchPermissionConfirmed: boolean;
    watchActive: boolean;
    watchPolicyVerified: boolean;
  };
}
export interface TaskbarOptions {
  pinned: boolean;
  orientation: 'horizontal' | 'vertical';
}
export interface DesktopAPI {
  closeStartup(): void;
  onRareDrop(callback: (event: import('./rare-drop').RareDropEvent) => void): () => void;
  compareReplayExperience?(mode: 'tracked' | 'choose'): Promise<import('../domain/replay-experience-comparison').ReplayComparisonResult | null>;
  getTaskbarMode(): Promise<boolean>;
  setTaskbarMode(active: boolean): Promise<boolean>;
  getTaskbarOptions(): Promise<TaskbarOptions>;
  setTaskbarOptions(patch: Partial<TaskbarOptions>): Promise<TaskbarOptions>;
  closeTaskbar(): Promise<void>;
  setTaskbarDetailHeight(height: number): Promise<void>;
  getHuntAnalytics(query:import('./hunt-analytics').HuntAnalyticsQuery):Promise<import('./hunt-analytics').HuntAnalyticsState>;
  getHuntAnalyticsEvidence(query:import('./hunt-analytics').HuntAnalyticsEvidenceQuery):Promise<import('./hunt-analytics').HuntAnalyticsEvidencePage>;
  getHuntAnalyticsPreferences():Promise<import('./hunt-analytics-preferences').HuntAnalyticsPreferences>;
  setHuntAnalyticsPreferences(value:import('./hunt-analytics-preferences').HuntAnalyticsPreferences):Promise<import('./hunt-analytics-preferences').HuntAnalyticsPreferences>;
  setKillExperienceRate(input:import('./kill-experience').KillExperienceRateInput):Promise<AppState>;
  setKillExperiencePenalty(input:import('./kill-experience').KillExperiencePenaltyInput):Promise<AppState>;
  controlKillExperience(input:import('./kill-experience').KillExperienceControl):Promise<AppState>;
  getSoloExperienceDaily(query:import('./solo-experience-daily').SoloExperienceDailyQuery):Promise<import('./solo-experience-daily').SoloExperienceDailyState>;
  getAppearanceTheme(): Promise<'light' | 'dark'>;
  getLanguage(): Promise<'tr' | 'en'>;
  setLanguage(value: 'tr' | 'en'): Promise<void>;
  setAppearanceTheme(theme: 'light' | 'dark'): Promise<void>;
  getFinanceView():Promise<import('./finance-view').FinanceViewPreferences>;
  getFinanceDaily(query:import('./finance-daily').FinanceDailyQuery):Promise<import('./finance-daily').FinanceDailyState>;
  setFinanceView(view:import('./finance-view').FinanceViewPreferences):Promise<import('./finance-view').FinanceViewPreferences>;
  getKillView():Promise<import('./kill-view').KillViewPreferences>;
  setKillView(view:import('./kill-view').KillViewPreferences):Promise<import('./kill-view').KillViewPreferences>;
  getLiveView():Promise<import('./live-view').LiveViewPreferences>;
  setLiveView(view:import('./live-view').LiveViewPreferences):Promise<import('./live-view').LiveViewPreferences>;
  getKillRecords(query?:import('./kill-history').KillRecordsQuery):Promise<import('./kill-history').KillRecordsPage>;
  getKillEvents(query?:import('./kill-history').KillEventsQuery):Promise<import('./kill-history').KillEventsPage>;
  getKillDaily(query:import('./kill-daily').KillDailyQuery):Promise<import('./kill-daily').KillDailyState>;
  getKillRhythm(query:import('./kill-history').KillRhythmQuery):Promise<import('./kill-history').KillRhythmPage>;
  setReplayClockReference(input:import('./replay-clock').ReplayClockReferenceInput):Promise<AppState>;
  clearReplayClockReference(streamId:string):Promise<AppState>;
  setFarmPrice(input:import('./auto-farm').FarmPriceInput):Promise<AppState>;
  financeCommand(command: import('../domain/finance').FinanceCommand): Promise<AppState>;
  searchCatalog(query: import('./expansion').CatalogSearch): Promise<import('./expansion').CatalogPage>;
  importCatalog(): Promise<AppState>;
  calibrateExp(input: {streamId:string;kind:'base'|'job';level?:number;jobTrack?:'novice'|'first'|'second'|null;current?:number;percent?:number}): Promise<AppState>;
  setExpJobTrack(streamId:string, jobTrack:'novice'|'first'|'second'|null): Promise<AppState>;
  setCharacterAlerts(characterKey:string, preferences:import('../domain/expansion-alerts').CharacterAlertPreferences|null):Promise<AppState>;
  onExpansionNotification(callback:(notification:import('../domain/expansion-alerts').ExpansionNotification)=>void):()=>void;
  getAlertTargetNames(): Promise<import('../domain/alert-targets').AlertTargetNames>;
  setAlertPreferences(patch: import('../domain/notifications').AlertPreferencesPatch): Promise<AppState>;
  setSceneDuration(kind: import('./scene-durations').SceneKind, seconds:number):Promise<AppState>;
  chooseAlertSound(kind: AlertKind): Promise<SoundChoice | null>;
  chooseRareDropSound(target: import('./rare-drop-sounds').RareSoundTarget): Promise<{token:string; sound:SoundChoice} | null>;
  setRareDropSound(target: import('./rare-drop-sounds').RareSoundTarget, token:string | null): Promise<AppState>;
  getRareDropSound(target: import('./rare-drop-sounds').RareSoundTarget): Promise<SoundChoice | null>;
  chooseRagnarokLevelSound(): Promise<SoundChoice | null>;
  chooseRagnarokMobsterSound(): Promise<SoundChoice | null>;
  chooseLootChimeSound(): Promise<SoundChoice>;
  getAlertSound(kind: AlertKind): Promise<SoundChoice | null>;
  testAlert(kind: AlertKind): Promise<LiveNotification>;
  onNotification(callback: (notification: LiveNotification) => void): () => void;
  getState(): Promise<AppState>;
  importFiles(): Promise<AppState>;
  chooseFolder(): Promise<AppState>;
  scanFolder(): Promise<AppState>;
  reanalyze(id: string): Promise<AppState>;
  exportData(format: 'json' | 'csv'): Promise<string | null>;
  exportLoot(): Promise<string | null>;
  backup(): Promise<string | null>;
  setSettings(patch: { watchRequested?: boolean; watchPermissionConfirmed?: boolean }): Promise<AppState>;
  addLiveFiles(): Promise<AppState>;
  addLiveFolder(discover: boolean): Promise<AppState>;
  refreshLive(): Promise<AppState>;
  controlLive(id: string, action: 'pause' | 'resume' | 'stop' | 'remove'): Promise<AppState>;
  assignCharacter(target: { kind: 'replay' | 'stream'; id: string }, character: ManualCharacterInput | null): Promise<AppState>;
  onUpdate(callback: (state: AppState) => void): () => void;
}
declare global {
  interface Window { midgard?: DesktopAPI; }
}
