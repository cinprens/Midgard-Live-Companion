import type { DatabaseSync } from 'node:sqlite';
import {migrateCompactExperience,compactExperienceEnsureCharacter,compactExperienceGain,compactExperienceDuration} from './compact-experience';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isConfirmedMonsterDeath, isOwnDamageKill, type ParsedReplay, type ReplayEvent } from '../src/parser';
import { experienceRequirement, type JobTrack } from '../src/domain/experience-table';
import { captureSoloExperienceReference, projectSoloExperience } from '../src/domain/solo-experience';
import type { LiveTelemetry } from '../src/parser/types';
import { replayClockBasis, type ReplayClockBasis } from '../src/shared/replay-clock-basis';
import type { CharacterIdentity, LiveStreamStatus } from '../src/shared/types';
import type { KillExperienceControl, KillExperiencePenaltyInput, KillExperienceRate, KillExperienceRateInput, KillExperienceSession, KillExperienceSource, KillExperienceSourceInput, KillExperienceState, KillExperienceTrack } from '../src/shared/kill-experience';

export interface KillExperienceObservation {
  sourcePath: string; streamId: string; hash: string; recordingId: string;
  recordingReset?: boolean; observedAt?: string; initial?: boolean;
}
interface Source {
  sourceKey: string; recordingKey: string; character: CharacterIdentity; streamId: string;
  recordingId: string; filename: string; edge: number; frontier: Set<string>; status: LiveStreamStatus; clockStart: number | null;
  telemetry?: LiveTelemetry;
  calendarClock: ReplayClockBasis;
}
interface StoredSession extends KillExperienceSession {
  sourceKey: string; recordingKey: string; resumeRunning: boolean; characterName: string;
  compactFrontier?:number;
}
interface CalendarIntervalTail {id:string;characterKey:string;recordingKey:string;anchor:number;end:number}
interface Cursor { edge: number; baseline: Set<string>; calendarInterval?:CalendarIntervalTail }
interface GroupMember extends KillExperienceSourceInput { sourceKey: string; recordingKey: string; filename: string; characterName: string; durationAnchor: number }
interface StoredGroup {
  id: string; members: GroupMember[]; status: KillExperienceSession['status']; resumeRunning: boolean;
  rawObservations: number; duplicateCandidates: number; estimatedDeaths: number; matchingUnavailable: number;
  notBeforeClock: number | null; durationCutoff: number;
}
interface GroupCursor extends Cursor { intervalId: string }
const MATCHING_WINDOW_MS = 1500;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceKey = (value: string) => digest(path.resolve(value).toLowerCase());
const unavailable = (status: LiveStreamStatus) => ['paused', 'stopped', 'missing', 'error'].includes(status);
function clockLabel(value: string | null): number | null {
  if (!value) return null;
  const result = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);
  return Number.isSafeInteger(result) ? result : null;
}
function unionMilliseconds(spans: [number, number][]): number {
  const ordered = spans.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  let result = 0, start = 0, end = 0, found = false;
  for (const [left, right] of ordered) {
    if (!found || left > end) { if (found) result = safeAdd(result, end - start); start = left; end = right; found = true; }
    else end = Math.max(end, right);
  }
  return found ? safeAdd(result, end - start) : 0;
}
const blankTrack = (): KillExperienceTrack => ({ gained: 0, knownGained: 0, perHour: null, knownPerHour: null, missingDeaths: 0, lost: 0, knownLost: 0, net: 0, knownNet: 0, missingLosses: 0 });
function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} geçersiz.`);
  return value;
}
function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Tahmini EXP güvenli tam sayı sınırını aşıyor; ölçüm durduruldu.');
  return result;
}
function eventKey(event: ReplayEvent): string {
  if (event.eventType === 'player-death') return digest(JSON.stringify(['player-death', event.id, event.timestamp, event.actorId]));
  const proof = event.rawData!.killProof as { lifecycleId: string };
  return digest(JSON.stringify([event.targetId, proof.lifecycleId]));
}
function ownDeath(event: ReplayEvent, playerId: number | null): boolean {
  return playerId !== null && Number.isSafeInteger(playerId) && playerId > 0 && event.eventType === 'player-death' &&
    event.actorId === playerId && event.targetId === playerId && event.entityKind === 'pc' && event.confidence === 'certain' &&
    event.attribution === 'personal' && event.rawData?.source === 'own-death-vanish' && event.rawData.observedDeath === true &&
    typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 256;
}
function deathLoss(event: ReplayEvent, kind: 'base' | 'job', percent: 0 | 5 | 10): number | null {
  if (percent === 0) return 0;
  const level = event.rawData?.[kind === 'base' ? 'baseLevel' : 'jobLevel'];
  const rawTrack = event.rawData?.jobTrack;
  const jobTrack: JobTrack | null = rawTrack === 'novice' || rawTrack === 'first' || rawTrack === 'second' ? rawTrack : null;
  if (typeof level !== 'number') return null;
  const required = experienceRequirement(kind, level, jobTrack)?.required;
  if (required == null || !Number.isSafeInteger(required) || required < 0) return null;
  return Number(BigInt(required) * BigInt(percent) / 100n);
}

/** This separate model estimates EXP from observed deaths, never from confirmed personal kills. */
export class KillExperienceStore {
  private sources = new Map<string, Source>();
  private sessions = new Map<string, StoredSession>();
  private names = new Map<string, string>();
  private cursors = new Map<string, Cursor>();
  private groups = new Map<string, StoredGroup>();
  private groupCursors = new Map<string, Map<string, GroupCursor>>();
  private revision = 0;
  private compactSeen = new Map<string,Set<string>>();
  private compactRestartFloors = new Map<string,number>();
  constructor(private db: DatabaseSync, private options: { soloOnly?: boolean;summaryOnly?:boolean } = {}) {
    if(options.summaryOnly){this.options={...options,soloOnly:true};migrateCompactExperience(db);for(const row of db.prepare('SELECT character_key,character_name FROM compact_experience_totals').all())this.names.set(String(row.character_key),String(row.character_name));}
    for (const row of db.prepare(options.summaryOnly?'SELECT data_json FROM compact_experience_current ORDER BY rowid':'SELECT data_json FROM kill_experience_sessions ORDER BY rowid').all()) {
      const session = JSON.parse(String(row.data_json)) as StoredSession;
      session.observedPlayerDeaths ??= 0;
      session.mode ??= 'single'; session.groupId ??= null;
      session.sources ??= [{ characterKey: session.characterKey, streamId: session.streamId, recordingId: session.recordingId, filename: session.filename, status: 'missing' }];
      session.rawObservations ??= session.observedDeaths; session.duplicateCandidates ??= 0; session.estimatedDeaths ??= session.observedDeaths;
      session.matchingWindowMs ??= 0; session.coverage ??= { availableSources: 0, totalSources: 1, partial: true, matchingUnavailable: 0 };
      session.base = { ...blankTrack(), ...session.base }; session.job = { ...blankTrack(), ...session.job };
      this.refreshTracks(session);
      if (session.status === 'running') session.status = 'source-unavailable';
      if (this.options.soloOnly && (session.mode === 'party' || session.groupId || !session.soloReference || session.attributionPolicy !== 'own-damage-v1')) {
        session.status = 'stopped'; session.resumeRunning = false;
      }
      if(options.summaryOnly){
        if(Number.isSafeInteger(session.compactFrontier)&&session.compactFrontier!>=0)this.compactRestartFloors.set(session.id,session.compactFrontier!);
        else {session.status='stopped';session.resumeRunning=false;}
      }
      this.sessions.set(session.characterKey, session);
      this.names.set(session.characterKey, session.characterName);
    }
    for (const row of options.summaryOnly?[]:db.prepare('SELECT data_json FROM kill_experience_groups ORDER BY rowid').all()) {
      const group = JSON.parse(String(row.data_json)) as StoredGroup;
      if (group.status === 'running') group.status = 'source-unavailable';
      if (this.options.soloOnly) { group.status = 'stopped'; group.resumeRunning = false; }
      this.groups.set(group.id, group);
    }
    this.revision = Number(db.prepare("SELECT value FROM finance_metadata WHERE key='kill_experience_revision'").get()?.value ?? 0);
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private changed(): void {
    this.revision++;
    this.db.prepare("INSERT INTO finance_metadata VALUES('kill_experience_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.revision));
  }
  private save(session: StoredSession): void {
    if(this.options.summaryOnly){this.db.prepare('INSERT INTO compact_experience_current VALUES(?,?) ON CONFLICT(character_key) DO UPDATE SET data_json=excluded.data_json').run(session.characterKey,JSON.stringify(session));return;}
    this.db.prepare('INSERT INTO kill_experience_sessions(id,character_key,data_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(session.id, session.characterKey, JSON.stringify(session));
  }
  private baseline(session: StoredSession, source: Source, calendarInterval?:CalendarIntervalTail): void {
    const edge=this.options.summaryOnly?Math.max(source.edge,session.compactFrontier??0):source.edge;
    if(this.options.summaryOnly){session.compactFrontier=edge;if(edge>source.edge)this.compactRestartFloors.set(session.id,Math.max(edge,this.compactRestartFloors.get(session.id)??-1));}
    this.cursors.set(session.id, { edge, baseline: new Set(source.frontier), calendarInterval });
  }
  /** Called inside the award/session transaction; old awards are never backfilled. */
  private calendarAnchor(session: StoredSession, source: Source): number | null {
    if (!this.options.soloOnly || session.mode !== 'single' || !session.soloReference || session.attributionPolicy !== 'own-damage-v1') return null;
    const basis = source.calendarClock;
    if(this.options.summaryOnly)return basis.anchorMs;
    this.db.prepare('INSERT OR IGNORE INTO solo_experience_calendar_sessions(session_id,character_key,character_name,anchor_ms,raw_started_at,time_zone,clock_version) VALUES(?,?,?,?,?,?,?)')
      .run(session.id, session.characterKey, session.characterName, basis.anchorMs, basis.rawStartedAt, basis.timeZone, basis.version);
    const saved = this.db.prepare('SELECT character_key,anchor_ms,raw_started_at,time_zone,clock_version FROM solo_experience_calendar_sessions WHERE session_id=?').get(session.id);
    if (basis.anchorMs === null || !saved || saved.anchor_ms === null || saved.character_key !== session.characterKey ||
      Number(saved.anchor_ms) !== basis.anchorMs || saved.raw_started_at !== basis.rawStartedAt ||
      saved.time_zone !== basis.timeZone || Number(saved.clock_version) !== basis.version) return null;
    return basis.anchorMs;
  }
  private calendarTime(anchor: number | null, replayMs: number): number | null {
    if (anchor === null) return null;
    const result = anchor + replayMs;
    return Number.isSafeInteger(result) && Number.isFinite(new Date(result).getTime()) ? result : null;
  }
  /** Matches an observed recording to the controller's current file, independently of real EXP telemetry. */
  getSource(streamId: string, currentSourcePath?: string): KillExperienceSource | null {
    const source = this.sources.get(streamId);
    if (!source || currentSourcePath !== undefined && source.sourceKey !== sourceKey(currentSourcePath)) return null;
    return this.publicSource(source);
  }
  setRate(input: KillExperienceRateInput): void {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['characterKey', 'monsterId', 'baseExp', 'jobExp'].includes(key))) throw new Error('EXP ayarı alanları geçersiz.');
    identity(input.characterKey, 'Karakter');
    if (!Number.isSafeInteger(input.monsterId) || input.monsterId < 1 || input.monsterId > 0xffffffff) throw new Error('Monster ID pozitif 32 bit tam sayı olmalıdır.');
    for (const value of [input.baseExp, input.jobExp]) if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new Error('EXP sıfır veya pozitif güvenli tam sayı olmalıdır; bilinmeyen değer boş kalmalıdır.');
    this.transaction(() => {
      this.db.prepare('INSERT INTO kill_experience_rates VALUES(?,?,?,?,?) ON CONFLICT(character_key,monster_id) DO UPDATE SET base_exp=excluded.base_exp,job_exp=excluded.job_exp,updated_at=excluded.updated_at').run(input.characterKey, input.monsterId, input.baseExp, input.jobExp, new Date().toISOString());
      this.changed();
    });
  }
  setDeathPenalty(input: KillExperiencePenaltyInput): void {
    if (this.options.soloOnly) throw new Error('Solo EXP kazanımı ölüm kaybı hesaplamaz.');
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['characterKey', 'percent'].includes(key)) || ![0, 5, 10].includes(input.percent)) throw new Error('Ölüm EXP kaybı kapalı, %5 veya %10 olmalıdır.');
    identity(input.characterKey, 'Karakter');
    this.transaction(() => {
      this.db.prepare('INSERT INTO kill_experience_penalties VALUES(?,?,?) ON CONFLICT(character_key) DO UPDATE SET percent=excluded.percent,updated_at=excluded.updated_at').run(input.characterKey, input.percent, new Date().toISOString());
      this.changed();
    });
  }
  control(input: KillExperienceControl): void {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['characterKey', 'streamId', 'recordingId', 'action', 'sources', 'sessionId', 'groupId'].includes(key)) || !['start', 'pause', 'resume', 'reset', 'stop'].includes(input.action)) throw new Error('Tahmini EXP işlemi geçersiz.');
    identity(input.characterKey, 'Karakter'); identity(input.streamId, 'Replay kaynağı'); identity(input.recordingId, 'Replay kaydı');
    const source = this.sources.get(input.streamId), previous = this.sessions.get(input.characterKey);
    if (this.options.soloOnly && (previous ? input.sessionId !== previous.id : input.action !== 'start')) throw new Error('Ölçüm değişti; güncel solo oturumunu kullanın.');
    if (input.sessionId !== undefined && input.sessionId !== previous?.id || input.groupId !== undefined && input.groupId !== previous?.groupId) throw new Error('Ölçüm değişti; güncel parti kartını kullanın.');
    if (this.options.soloOnly && (input.sources && (!Array.isArray(input.sources) || input.sources.length > 1) ||
      input.groupId || previous?.groupId && input.action !== 'start') && input.action !== 'stop') throw new Error('Bu sürümde yalnız tek karakter ve tek Replay ile solo tahmin kullanılabilir.');
    if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 32 || input.sources.some(value => !value || typeof value !== 'object' || Object.keys(value).some(key => !['characterKey', 'streamId', 'recordingId'].includes(key))))) throw new Error('Parti için en fazla 32 ayrı karakter kaynağı seçin.');
    if (input.sources && !['start', 'reset'].includes(input.action)) throw new Error('Parti üyeleri yalnız yeni ölçüm başlatılırken belirlenir.');
    if (previous?.groupId && input.action !== 'start') { this.controlGroup(input, previous); return; }
    if (input.sources && input.sources.length > 1) {
      if (input.action !== 'start') throw new Error('Parti üyelerini değiştirmek için yeni ortak ölçüm başlatın.');
      this.startGroup(input, input.sources); return;
    }
    if (input.sources?.length === 1 && (input.sources[0].characterKey !== input.characterKey || input.sources[0].streamId !== input.streamId || input.sources[0].recordingId !== input.recordingId)) throw new Error('Tek kaynak seçimi karakterle eşleşmiyor.');
    if (input.action === 'pause' || input.action === 'stop') {
      if (!previous || previous.streamId !== input.streamId || previous.recordingId !== input.recordingId) throw new Error('Tahmini EXP oturumu güncel değil.');
      if (input.action === 'pause' && ['stopped', 'recording-changed'].includes(previous.status)) throw new Error('Durdurulmuş ölçüm yeniden duraklatılamaz; yeni ölçüm başlatın.');
      const session = { ...previous, status: input.action === 'pause' ? 'paused' : 'stopped', resumeRunning: false } as StoredSession;
      this.transaction(() => { this.save(session); this.changed(); });
      this.sessions.set(session.characterKey, session); this.cursors.delete(session.id); return;
    }
    if (!source || source.character.key !== input.characterKey || source.recordingId !== input.recordingId || unavailable(source.status)) throw new Error('Başlatmak için bu karakterin güncel ve okunabilir Replay kaynağını seçin.');
    let session: StoredSession;
    if (input.action === 'resume') {
      if (!previous || previous.status === 'stopped' || previous.status === 'recording-changed' || previous.sourceKey !== source.sourceKey || previous.recordingKey !== source.recordingKey) throw new Error('Replay kaydı değişti; yeni bir tahmini EXP ölçümü başlatın.');
      if (this.options.soloOnly && (!previous.soloReference || previous.attributionPolicy !== 'own-damage-v1')) throw new Error('Eski çevre gözlemleri devam ettirilemez; kendi hasarınıza göre yeni bir ölçüm başlatın.');
      session = { ...previous, streamId: source.streamId, recordingId: source.recordingId, filename: source.filename, status: 'running', resumeRunning: true };
    } else {
      session = { id: randomUUID(), characterKey: input.characterKey, characterName: source.character.name, streamId: source.streamId, recordingId: source.recordingId, filename: source.filename, sourceKey: source.sourceKey, recordingKey: source.recordingKey, status: 'running', resumeRunning: true, startedAt: new Date().toISOString(), durationMs: 0, observedDeaths: 0, observedPlayerDeaths: 0, mode: 'single', groupId: null, sources: [this.publicSource(source)], rawObservations: 0, duplicateCandidates: 0, estimatedDeaths: 0, matchingWindowMs: 0, coverage: { availableSources: 1, totalSources: 1, partial: false, matchingUnavailable: 0 }, base: blankTrack(), job: blankTrack() };
      if (this.options.soloOnly) {
        session.attributionPolicy = 'own-damage-v1';
        session.soloReference = captureSoloExperienceReference(source.telemetry,source.calendarClock.rawStartedAt);
        session.targetMonsterIds = this.db.prepare('SELECT monster_id FROM kill_experience_rates WHERE character_key=? AND (base_exp IS NOT NULL OR job_exp IS NOT NULL) ORDER BY monster_id').all(input.characterKey).map(row => Number(row.monster_id));
        if (!session.targetMonsterIds.length) throw new Error('Başlatmak için en az bir yaratığın Base veya Job EXP değerini girin.');
      }
    }
    if (previous?.groupId&&!this.options.summaryOnly) this.setGroupStatus(this.groups.get(previous.groupId)!, 'stopped', false);
    if(this.options.summaryOnly)session.compactFrontier=Math.max(source.edge,session.compactFrontier??0,previous?.recordingKey===source.recordingKey?previous.compactFrontier??0:0);
    this.transaction(() => {
      if (previous && previous.id !== session.id) this.save({ ...previous, status: 'stopped', resumeRunning: false });
      this.save(session);
      if (this.options.soloOnly && input.action !== 'resume') {this.calendarAnchor(session, source);if(this.options.summaryOnly)compactExperienceEnsureCharacter(this.db,session.characterKey,session.characterName);}
      this.changed();
    });
    if (previous) {this.cursors.delete(previous.id);if(previous.id!==session.id){this.compactSeen.delete(previous.id);this.compactRestartFloors.delete(previous.id);}}
    this.sessions.set(session.characterKey, session); this.baseline(session, source);
  }
  private publicSource(source: Source): KillExperienceSource {
    return { characterKey: source.character.key, streamId: source.streamId, recordingId: source.recordingId, filename: source.filename, status: source.status };
  }
  private memberSource(member: GroupMember): Source | undefined {
    return [...this.sources.values()].find(source => source.sourceKey === member.sourceKey && source.recordingKey === member.recordingKey && source.character.key === member.characterKey);
  }
  private saveGroup(group: StoredGroup): void {
    this.db.prepare('INSERT INTO kill_experience_groups(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(group.id, JSON.stringify(group));
  }
  private currentGroupSessions(group: StoredGroup): StoredSession[] {
    return group.members.map(member => this.sessions.get(member.characterKey)).filter((session): session is StoredSession => session?.groupId === group.id);
  }
  private refreshGroup(group: StoredGroup, sessions: StoredSession[]): void {
    const sources: KillExperienceSource[] = group.members.map(member => {
      const source = this.memberSource(member);
      return source ? this.publicSource(source) : { characterKey: member.characterKey, streamId: member.streamId, recordingId: member.recordingId, filename: member.filename, status: 'missing' };
    });
    const availableSources = sources.filter(source => !unavailable(source.status)).length;
    const duration = unionMilliseconds(this.db.prepare('SELECT start_ms,end_ms FROM kill_experience_group_intervals WHERE group_id=?').all(group.id).map(row => [Number(row.start_ms), Number(row.end_ms)]));
    for (const session of sessions) {
      const own = sources.find(source => source.characterKey === session.characterKey)!;
      session.streamId = own.streamId; session.recordingId = own.recordingId; session.filename = own.filename;
      session.status = group.status; session.resumeRunning = group.resumeRunning; session.durationMs = duration;
      session.sources = sources.map(source => ({ ...source })); session.rawObservations = group.rawObservations;
      session.duplicateCandidates = group.duplicateCandidates; session.estimatedDeaths = group.estimatedDeaths;
      session.observedDeaths = group.estimatedDeaths; session.matchingWindowMs = MATCHING_WINDOW_MS;
      session.coverage = { availableSources, totalSources: sources.length, partial: availableSources < sources.length, matchingUnavailable: group.matchingUnavailable };
      this.refreshTracks(session); this.save(session);
    }
    this.saveGroup(group);
  }
  private setGroupStatus(previous: StoredGroup, status: StoredGroup['status'], resumeRunning: boolean): void {
    const group = { ...previous, status, resumeRunning };
    const sessions = this.currentGroupSessions(group).map(session => ({ ...session, base: { ...session.base }, job: { ...session.job } }));
    this.transaction(() => { this.refreshGroup(group, sessions); this.changed(); });
    this.groups.set(group.id, group); for (const session of sessions) this.sessions.set(session.characterKey, session);
    this.groupCursors.delete(group.id);
  }
  private resolveGroupSources(inputs: KillExperienceSourceInput[]): Source[] {
    const values = inputs.map(input => {
      identity(input.characterKey, 'Parti karakteri'); identity(input.streamId, 'Parti kaynağı'); identity(input.recordingId, 'Parti kaydı');
      const source = this.sources.get(input.streamId);
      if (!source || source.character.key !== input.characterKey || source.recordingId !== input.recordingId || unavailable(source.status)) throw new Error('Parti kaynakları güncel, okunabilir ve ayrı karakterlere ait olmalıdır.');
      return source;
    });
    if (new Set(values.map(source => source.character.key)).size !== values.length || new Set(values.map(source => source.sourceKey)).size !== values.length) throw new Error('Her parti karakteri için yalnız bir farklı Replay kaynağı seçin.');
    return values;
  }
  private groupBaseline(group: StoredGroup, member: GroupMember, source: Source): void {
    const cursors = this.groupCursors.get(group.id) ?? new Map<string, GroupCursor>();
    const intervalId = randomUUID(), start = Math.max(group.durationCutoff, member.durationAnchor + source.edge);
    this.db.prepare('INSERT INTO kill_experience_group_intervals VALUES(?,?,?,?,?)').run(intervalId, group.id, member.sourceKey, start, start);
    cursors.set(member.sourceKey, { edge: source.edge, baseline: new Set(source.frontier), intervalId }); this.groupCursors.set(group.id, cursors);
  }
  private startGroup(input: KillExperienceControl, inputs: KillExperienceSourceInput[]): void {
    const sources = this.resolveGroupSources(inputs);
    if (!sources.some(source => source.character.key === input.characterKey && source.streamId === input.streamId && source.recordingId === input.recordingId)) throw new Error('Parti başlatan karakter seçili kaynaklar içinde bulunmalıdır.');
    const oldGroups = new Set(sources.map(source => this.sessions.get(source.character.key)?.groupId).filter((id): id is string => !!id));
    for (const id of oldGroups) this.setGroupStatus(this.groups.get(id)!, 'stopped', false);
    const aligned = sources.every(source => source.clockStart !== null);
    const members: GroupMember[] = sources.map(source => ({ characterKey: source.character.key, characterName: source.character.name, streamId: source.streamId, recordingId: source.recordingId, sourceKey: source.sourceKey, recordingKey: source.recordingKey, filename: source.filename, durationAnchor: aligned ? source.clockStart! : -source.edge }));
    const clocks = sources.filter(source => source.clockStart !== null).map(source => source.clockStart! + source.edge);
    const group: StoredGroup = { id: randomUUID(), members, status: 'running', resumeRunning: true, rawObservations: 0, duplicateCandidates: 0, estimatedDeaths: 0, matchingUnavailable: 0, notBeforeClock: clocks.length ? Math.max(...clocks) : null, durationCutoff: Math.max(...members.map((member, index) => member.durationAnchor + sources[index].edge)) };
    const startedAt = new Date().toISOString();
    const sessions: StoredSession[] = members.map(member => ({ id: randomUUID(), characterKey: member.characterKey, characterName: member.characterName, sourceKey: member.sourceKey, recordingKey: member.recordingKey, streamId: member.streamId, recordingId: member.recordingId, filename: member.filename, startedAt, status: 'running', resumeRunning: true, durationMs: 0, observedDeaths: 0, observedPlayerDeaths: 0, mode: 'party', groupId: group.id, sources: [], rawObservations: 0, duplicateCandidates: 0, estimatedDeaths: 0, matchingWindowMs: MATCHING_WINDOW_MS, coverage: { availableSources: sources.length, totalSources: sources.length, partial: false, matchingUnavailable: 0 }, base: blankTrack(), job: blankTrack() }));
    this.transaction(() => {
      this.saveGroup(group);
      for (let index = 0; index < members.length; index++) {
        const old = this.sessions.get(members[index].characterKey);
        if (old) this.save({ ...old, status: 'stopped', resumeRunning: false });
        this.save(sessions[index]); this.groupBaseline(group, members[index], sources[index]);
      }
      this.refreshGroup(group, sessions); this.changed();
    });
    this.groups.set(group.id, group);
    for (const session of sessions) { const previous = this.sessions.get(session.characterKey); if (previous) this.cursors.delete(previous.id); this.sessions.set(session.characterKey, session); }
  }
  private controlGroup(input: KillExperienceControl, previous: StoredSession): void {
    if (input.sessionId !== previous.id || input.groupId !== previous.groupId || input.streamId !== previous.streamId || input.recordingId !== previous.recordingId) throw new Error('Parti ölçümü değişti; güncel oturum kartını kullanın.');
    const group = this.groups.get(previous.groupId!);
    if (!group) throw new Error('Parti ölçümü bulunamadı.');
    if (input.action === 'pause' && ['stopped', 'recording-changed'].includes(group.status)) throw new Error('Durdurulmuş parti yeniden duraklatılamaz; yeni ortak ölçüm başlatın.');
    if (input.action === 'pause' || input.action === 'stop') { this.setGroupStatus(group, input.action === 'pause' ? 'paused' : 'stopped', false); return; }
    if (input.action === 'reset') {
      const inputs = input.sources ?? group.members.map(({ characterKey, streamId, recordingId }) => ({ characterKey, streamId, recordingId }));
      const current = this.resolveGroupSources(inputs);
      if (current.length !== group.members.length || current.some(source => !group.members.some(member => member.characterKey === source.character.key && member.sourceKey === source.sourceKey && member.recordingKey === source.recordingKey))) throw new Error('Sıfırlama parti üyelerini değiştiremez; yeni ortak ölçüm başlatın.');
      this.startGroup(input, inputs); return;
    }
    if (input.action !== 'resume' || ['stopped', 'recording-changed'].includes(group.status)) throw new Error('Bu parti kaydı sürdürülemez; yeni ortak ölçüm başlatın.');
    const sources = group.members.map(member => this.memberSource(member)).filter((source): source is Source => !!source && !unavailable(source.status));
    if (!sources.length) throw new Error('Sürdürmek için en az bir güncel parti kaynağı gerekli.');
    const next = { ...group, members: group.members.map(member => ({ ...member })), status: 'running' as const, resumeRunning: true };
    const sessions = this.currentGroupSessions(next).map(session => ({ ...session, base: { ...session.base }, job: { ...session.job } }));
    this.groupCursors.delete(group.id);
    const clocks = sources.filter(source => source.clockStart !== null).map(source => source.clockStart! + source.edge);
    if (clocks.length) next.notBeforeClock = Math.max(next.notBeforeClock ?? clocks[0], ...clocks);
    next.durationCutoff = Math.max(next.durationCutoff, ...sources.map(source => next.members.find(member => member.sourceKey === source.sourceKey)!.durationAnchor + source.edge));
    this.transaction(() => { for (const source of sources) this.groupBaseline(next, next.members.find(member => member.sourceKey === source.sourceKey)!, source); this.refreshGroup(next, sessions); this.changed(); });
    this.groups.set(next.id, next); for (const session of sessions) this.sessions.set(session.characterKey, session);
  }
  private observeGroups(source: Source, deaths: ReplayEvent[], reset: boolean): void {
    for (const previous of this.groups.values()) {
      if (['stopped', 'recording-changed'].includes(previous.status)) continue;
      const expected = previous.members.find(member => member.sourceKey === source.sourceKey || member.streamId === source.streamId);
      if (!expected) continue;
      if (expected.sourceKey !== source.sourceKey || expected.recordingKey !== source.recordingKey || expected.characterKey !== source.character.key || reset) { this.setGroupStatus(previous, 'recording-changed', false); continue; }
      const group = { ...previous, members: previous.members.map(member => ({ ...member })) }, member = group.members.find(value => value.sourceKey === source.sourceKey)!;
      member.streamId = source.streamId; member.recordingId = source.recordingId; member.filename = source.filename; member.characterName = source.character.name;
      const sessions = this.currentGroupSessions(group).map(session => ({ ...session, base: { ...session.base }, job: { ...session.job } }));
      if (sessions.length !== group.members.length) { this.setGroupStatus(previous, 'stopped', false); continue; }
      const cursor = this.groupCursors.get(group.id)?.get(source.sourceKey);
      if (!group.resumeRunning || unavailable(source.status)) {
        this.groupCursors.get(group.id)?.delete(source.sourceKey);
        this.transaction(() => { this.refreshGroup(group, sessions); this.changed(); });
      } else if (!cursor) {
        if (previous.status === 'source-unavailable' && !this.groupCursors.get(group.id)?.size) {
          const clock = source.clockStart === null ? null : source.clockStart + source.edge;
          if (clock !== null) group.notBeforeClock = Math.max(group.notBeforeClock ?? clock, clock);
          group.durationCutoff = Math.max(group.durationCutoff, member.durationAnchor + source.edge);
        }
        group.status = 'running';
        this.transaction(() => { this.groupBaseline(group, member, source); this.refreshGroup(group, sessions); this.changed(); });
      } else if (source.edge >= cursor.edge) {
        group.status = 'running';
        const incoming = deaths.filter(event => (event.timestamp > cursor.edge || event.timestamp === cursor.edge && !cursor.baseline.has(eventKey(event))) && (source.clockStart === null || group.notBeforeClock === null || source.clockStart + event.timestamp >= group.notBeforeClock));
        try {
          this.transaction(() => {
            for (const event of incoming) {
              if (event.eventType === 'player-death') { this.applyGroupLoss(group, sessions.find(session => session.characterKey === source.character.key)!, event); continue; }
              const localKey = digest(`${source.recordingKey}:${eventKey(event)}`);
              if (this.db.prepare('SELECT 1 FROM kill_experience_group_observations WHERE group_id=? AND source_key=? AND event_key=?').get(group.id, source.sourceKey, localKey)) continue;
              const map = typeof event.mapId === 'string' && event.mapId.trim() ? event.mapId.trim().toLowerCase().slice(0, 200) : null;
              const clock = source.clockStart === null ? null : source.clockStart + event.timestamp;
              const matched = map && clock !== null ? this.db.prepare('SELECT c.id FROM kill_experience_group_candidates c WHERE c.group_id=? AND c.map_id=? AND c.target_id=? AND c.monster_id=? AND c.clock_ms BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM kill_experience_group_observations o WHERE o.group_id=c.group_id AND o.candidate_id=c.id AND o.source_key=?) ORDER BY ABS(c.clock_ms-?),c.rowid LIMIT 1').get(group.id, map, event.targetId!, event.monsterId!, clock - MATCHING_WINDOW_MS, clock + MATCHING_WINDOW_MS, source.sourceKey, clock) : undefined;
              const candidateId = matched ? String(matched.id) : randomUUID();
              if (!matched) this.db.prepare('INSERT INTO kill_experience_group_candidates VALUES(?,?,?,?,?,?)').run(candidateId, group.id, map, event.targetId!, event.monsterId!, clock);
              this.db.prepare('INSERT INTO kill_experience_group_observations VALUES(?,?,?,?,?)').run(group.id, source.sourceKey, localKey, candidateId, event.timestamp);
              group.rawObservations = safeAdd(group.rawObservations, 1);
              if (!map || clock === null) group.matchingUnavailable = safeAdd(group.matchingUnavailable, 1);
              if (matched) group.duplicateCandidates = safeAdd(group.duplicateCandidates, 1);
              else {
                group.estimatedDeaths = safeAdd(group.estimatedDeaths, 1);
                for (const session of sessions) this.applyGroupAward(session, candidateId, event.monsterId!);
              }
            }
            this.db.prepare('UPDATE kill_experience_group_intervals SET end_ms=MAX(start_ms,?) WHERE id=?').run(member.durationAnchor + source.edge, cursor.intervalId);
            this.refreshGroup(group, sessions); this.changed();
          });
        } catch (error) { this.setGroupStatus(previous, 'stopped', false); throw error; }
        this.groupCursors.get(group.id)!.set(source.sourceKey, { ...cursor, edge: source.edge, baseline: new Set(source.frontier) });
      } else continue;
      this.groups.set(group.id, group); for (const session of sessions) this.sessions.set(session.characterKey, session);
    }
  }
  private applyGroupAward(session: StoredSession, candidateId: string, monsterId: number): void {
    const row = this.db.prepare('SELECT base_exp,job_exp FROM kill_experience_rates WHERE character_key=? AND monster_id=?').get(session.characterKey, monsterId);
    const base = row?.base_exp == null ? null : Number(row.base_exp), job = row?.job_exp == null ? null : Number(row.job_exp);
    this.db.prepare('INSERT INTO kill_experience_awards VALUES(?,?,?,?,?)').run(session.id, `party:${candidateId}`, monsterId, base, job);
    for (const [track, amount] of [[session.base, base], [session.job, job]] as const) {
      if (amount === null) track.missingDeaths = safeAdd(track.missingDeaths, 1); else track.knownGained = safeAdd(track.knownGained, amount);
    }
  }
  private applyGroupLoss(group: StoredGroup, session: StoredSession, event: ReplayEvent): void {
    const percent = Number(this.db.prepare('SELECT percent FROM kill_experience_penalties WHERE character_key=?').get(session.characterKey)?.percent ?? 0) as 0 | 5 | 10;
    const base = deathLoss(event, 'base', percent), job = deathLoss(event, 'job', percent);
    if (!Number(this.db.prepare('INSERT OR IGNORE INTO kill_experience_losses VALUES(?,?,?,?,?)').run(session.id, eventKey(event), percent, base, job).changes)) return;
    session.observedPlayerDeaths = safeAdd(session.observedPlayerDeaths, 1);
    for (const [track, amount] of [[session.base, base], [session.job, job]] as const) {
      if (amount === null) track.missingLosses = safeAdd(track.missingLosses, 1); else track.knownLost = safeAdd(track.knownLost, amount);
    }
  }
  observe(parsed: ParsedReplay, meta: KillExperienceObservation, character: CharacterIdentity): void {
    identity(character.key, 'Karakter'); identity(meta.streamId, 'Replay kaynağı'); identity(meta.recordingId, 'Replay kaydı');
    if (this.options.soloOnly && ['invalid', 'unsupported'].includes(parsed.status)) {
      this.sources.delete(meta.streamId);
      for (const session of this.sessions.values()) if (!session.groupId && session.streamId === meta.streamId) this.markUnavailable(session);
      return;
    }
    const key = sourceKey(meta.sourcePath), strong = parsed.summary.startedAt !== null && parsed.summary.playerId !== null && parsed.summary.characterName !== null;
    const recordingKey = digest(strong ? JSON.stringify([parsed.summary.startedAt, parsed.summary.playerId, parsed.summary.characterName]) : `${key}:${meta.recordingId}`);
    const valid = parsed.events.filter(event => Number.isSafeInteger(event.timestamp) && event.timestamp >= 0);
    let edge = parsed.incremental?.delta && Number.isSafeInteger(parsed.summary.durationMs) ? Math.max(0, parsed.summary.durationMs) : 0;
    for (const event of valid) edge = Math.max(edge, event.timestamp);
    const deaths = valid.filter(event => isConfirmedMonsterDeath(event) || !this.options.soloOnly && ownDeath(event, parsed.summary.playerId));
    const frontier = new Set(deaths.filter(event => event.timestamp === edge).map(eventKey));
    const priorSource = this.sources.get(meta.streamId);
    if (parsed.incremental?.delta && !meta.recordingReset && priorSource?.recordingKey === recordingKey && priorSource.edge === edge) for (const key of priorSource.frontier) frontier.add(key);
    if (frontier.size > 8192) throw new Error('Aynı Replay zamanındaki ölüm sayısı güvenli gözlem sınırını aşıyor.');
    const telemetry = parsed.summary.liveTelemetry;
    const calendarClock = replayClockBasis(parsed.summary.startedAt);
    const source: Source = { sourceKey: key, recordingKey, character, streamId: meta.streamId, recordingId: meta.recordingId, filename: path.basename(meta.sourcePath), edge, frontier, clockStart: this.options.soloOnly ? calendarClock.anchorMs : clockLabel(parsed.summary.startedAt), calendarClock, status: priorSource?.status ?? 'following', telemetry };
    this.sources.set(meta.streamId, source); this.names.set(character.key, character.name);
    if (!this.options.soloOnly) this.observeGroups(source, deaths, meta.recordingReset === true);
    for (const previous of this.sessions.values()) {
      if (previous.groupId) continue;
      if (this.options.soloOnly && (!previous.soloReference || previous.attributionPolicy !== 'own-damage-v1')) continue;
      if (previous.sourceKey !== key) {
        if (previous.streamId === meta.streamId) this.markRecordingChanged(previous);
        continue;
      }
      if (previous.characterKey !== character.key || previous.recordingKey !== recordingKey || meta.recordingReset) {
        this.markRecordingChanged(previous);
        continue;
      }
      const session = { ...previous, characterName: character.name, streamId: source.streamId, recordingId: source.recordingId, filename: source.filename, base: { ...previous.base }, job: { ...previous.job } };
      const cursor = this.cursors.get(session.id);
      if (session.status === 'recording-changed' || session.status === 'stopped') continue;
      if (unavailable(source.status)) { this.markUnavailable(session); continue; }
      if (!cursor || session.status === 'source-unavailable' || this.options.soloOnly && meta.initial) {
        if (session.resumeRunning) session.status = 'running';
        this.baseline(session, source);
        this.transaction(() => { this.save(session); this.changed(); }); this.sessions.set(session.characterKey, session); continue;
      }
      if (session.status !== 'running' || source.edge < cursor.edge) continue;
      const incoming = deaths.filter(event => (!this.options.summaryOnly||event.timestamp>(this.compactRestartFloors.get(session.id)??-1))&&(event.timestamp > cursor.edge || event.timestamp === cursor.edge && !cursor.baseline.has(eventKey(event))));
      let calendarInterval=cursor.calendarInterval;
      const compactSeen=new Set(this.compactSeen.get(session.id));
      try {
        this.transaction(() => {
          const insert = this.options.summaryOnly?null:this.db.prepare('INSERT OR IGNORE INTO kill_experience_awards(session_id,event_key,monster_id,base_exp,job_exp) VALUES(?,?,?,?,?)');
          const insertLoss = this.options.summaryOnly?null:this.db.prepare('INSERT OR IGNORE INTO kill_experience_losses(session_id,event_key,percent,base_loss,job_loss) VALUES(?,?,?,?,?)');
          const rate = this.db.prepare('SELECT base_exp,job_exp FROM kill_experience_rates WHERE character_key=? AND monster_id=?');
          const percent = (this.options.soloOnly ? 0 : Number(this.db.prepare('SELECT percent FROM kill_experience_penalties WHERE character_key=?').get(character.key)?.percent ?? 0)) as 0 | 5 | 10;
          const calendarAnchor = this.options.soloOnly ? this.calendarAnchor(session, source) : null;
          const calendarAward = calendarAnchor === null || this.options.summaryOnly ? null : this.db.prepare('INSERT INTO solo_experience_calendar_awards(session_id,event_key,character_key,at_ms,monster_id,base_exp,job_exp) VALUES(?,?,?,?,?,?,?)');
          for (const event of incoming) {
            if (event.eventType === 'player-death') {
              const baseLoss = deathLoss(event, 'base', percent), jobLoss = deathLoss(event, 'job', percent);
              if (!Number(insertLoss!.run(session.id, eventKey(event), percent, baseLoss, jobLoss).changes)) continue;
              session.observedPlayerDeaths = safeAdd(session.observedPlayerDeaths, 1);
              for (const [track, amount] of [[session.base, baseLoss], [session.job, jobLoss]] as const) {
                if (amount === null) track.missingLosses = safeAdd(track.missingLosses, 1);
                else track.knownLost = safeAdd(track.knownLost, amount);
              }
              continue;
            }
            if (this.options.soloOnly && (!session.targetMonsterIds?.includes(event.monsterId!) || !isOwnDamageKill(event, parsed.summary.playerId))) continue;
            const value = rate.get(character.key, event.monsterId!), base = value?.base_exp == null ? null : Number(value.base_exp), job = value?.job_exp == null ? null : Number(value.job_exp);
            const key = eventKey(event);
            if(this.options.summaryOnly){if(compactSeen.has(key))continue;compactSeen.add(key);if(compactSeen.size>8192)compactSeen.delete(compactSeen.values().next().value!);}
            else if (!Number(insert!.run(session.id, key, event.monsterId!, base, job).changes)) continue;
            const at = this.calendarTime(calendarAnchor, event.timestamp);
            if(this.options.summaryOnly)compactExperienceGain(this.db,session.characterKey,session.characterName,at,base,job);
            else if (at !== null) calendarAward!.run(session.id, key, session.characterKey, at, event.monsterId!, base, job);
            session.observedDeaths = safeAdd(session.observedDeaths, 1);
            session.rawObservations = session.observedDeaths; session.estimatedDeaths = session.observedDeaths;
            for (const [track, amount] of [[session.base, base], [session.job, job]] as const) {
              if (amount === null) track.missingDeaths = safeAdd(track.missingDeaths, 1);
              else track.knownGained = safeAdd(track.knownGained, amount);
            }
          }
          const from = this.calendarTime(calendarAnchor, cursor.edge), to = this.calendarTime(calendarAnchor, source.edge);
          if(this.options.summaryOnly)compactExperienceDuration(this.db,session.characterKey,session.characterName,source.edge-cursor.edge,from,to);
          else if (from !== null && to !== null && to > from) {
            // Only extend the current uninterrupted runtime span; existing archive rows are not merged or removed.
            const tail=calendarInterval;
            const extended=tail&&tail.characterKey===session.characterKey&&tail.recordingKey===source.recordingKey&&tail.anchor===calendarAnchor&&tail.end===from&&
              Number(this.db.prepare('UPDATE solo_experience_calendar_intervals SET end_ms=? WHERE id=? AND session_id=? AND character_key=? AND end_ms=?').run(to,tail.id,session.id,session.characterKey,from).changes)>0;
            const id=extended?tail!.id:digest(JSON.stringify([session.id,cursor.edge,source.edge]));
            if(!extended)this.db.prepare('INSERT OR IGNORE INTO solo_experience_calendar_intervals(id,session_id,character_key,start_ms,end_ms) VALUES(?,?,?,?,?)').run(id,session.id,session.characterKey,from,to);
            calendarInterval={id,characterKey:session.characterKey,recordingKey:source.recordingKey,anchor:calendarAnchor!,end:to};
          }else if(calendarAnchor===null)calendarInterval=undefined;
          session.durationMs = safeAdd(session.durationMs, source.edge - cursor.edge);
          if(this.options.summaryOnly)session.compactFrontier=Math.max(session.compactFrontier??0,source.edge);
          this.refreshTracks(session); this.save(session); this.changed();
        });
      } catch (error) {
        const stopped = { ...previous, status: 'stopped', resumeRunning: false } as StoredSession;
        this.transaction(() => { this.save(stopped); this.changed(); }); this.sessions.set(previous.characterKey, stopped); this.cursors.delete(previous.id); throw error;
      }
      if(this.options.summaryOnly)this.compactSeen.set(session.id,compactSeen);
      this.sessions.set(session.characterKey, session); this.baseline(session, source,calendarInterval);
    }
  }
  private refreshTracks(session: StoredSession): void {
    for (const track of [session.base, session.job]) {
      track.gained = track.missingDeaths ? null : track.knownGained;
      track.lost = track.missingLosses ? null : track.knownLost;
      track.knownNet = track.knownGained - track.knownLost;
      track.net = track.gained === null || track.lost === null ? null : track.knownNet;
      const rate = session.durationMs > 0 ? track.knownNet / (session.durationMs / 3600000) : null;
      if (rate !== null && (!Number.isFinite(rate) || Math.abs(rate) > Number.MAX_SAFE_INTEGER)) throw new Error('Tahmini EXP/saat güvenli sayı sınırını aşıyor; ölçüm durduruldu.');
      track.knownPerHour = rate; track.perHour = track.net === null ? null : rate;
    }
  }
  private markUnavailable(previous: StoredSession): void {
    this.cursors.delete(previous.id);
    if (previous.status !== 'running') return;
    const session = { ...previous, status: 'source-unavailable' } as StoredSession;
    this.transaction(() => { this.save(session); this.changed(); }); this.sessions.set(session.characterKey, session);
  }
  private markRecordingChanged(previous: StoredSession): void {
    if (previous.status === 'stopped' || previous.status === 'recording-changed') return;
    const changed = { ...previous, status: 'recording-changed', resumeRunning: false } as StoredSession;
    this.transaction(() => { this.save(changed); this.changed(); }); this.sessions.set(previous.characterKey, changed); this.cursors.delete(previous.id);
  }
  syncStatuses(streams: { id: string; sourcePath: string; status: LiveStreamStatus; character?: CharacterIdentity; currentSnapshot?: boolean }[]): void {
    const previousNames = new Map(this.names);
    const active = new Set(streams.map(stream => stream.id));
    const retainedCharacters = new Set([
      ...streams.flatMap(stream => stream.character ? [stream.character.key] : []),
      ...this.sessions.keys(),
      ...this.db.prepare('SELECT DISTINCT character_key FROM kill_experience_rates').all().map(row => String(row.character_key)),
      ...this.db.prepare('SELECT character_key FROM kill_experience_penalties').all().map(row => String(row.character_key)),
    ]);
    for (const stream of streams) {
      const source = this.sources.get(stream.id); if (source) source.status = stream.status;
      if (stream.character) this.names.set(stream.character.key, stream.character.name);
    }
    for (const key of this.names.keys()) if (!retainedCharacters.has(key)) this.names.delete(key);
    for (const [id] of this.sources) if (!active.has(id)) this.sources.delete(id);
    for (const previous of this.sessions.values()) {
      if (previous.groupId) continue;
      if (this.options.soloOnly && previous.attributionPolicy !== 'own-damage-v1') continue;
      if (previous.status === 'stopped' || previous.status === 'recording-changed') continue;
      const stream = streams.find(value => sourceKey(value.sourcePath) === previous.sourceKey) ?? streams.find(value => value.id === previous.streamId);
      // A newly attached stream has an unassigned placeholder until its first
      // Replay header is parsed. It is not evidence of a character replacement.
      if (stream && (sourceKey(stream.sourcePath) !== previous.sourceKey || stream.character && stream.character.source !== 'unassigned' && stream.character.key !== previous.characterKey)) this.markRecordingChanged(previous);
      else if (!stream || stream.character?.source === 'unassigned' || unavailable(stream.status)) this.markUnavailable(previous);
      else if (this.options.soloOnly && previous.status === 'source-unavailable' && previous.resumeRunning && stream.currentSnapshot === true && ['following', 'settled'].includes(stream.status)) {
        const source = this.sources.get(stream.id);
        if (!source || source.sourceKey !== previous.sourceKey || source.recordingKey !== previous.recordingKey || source.character.key !== previous.characterKey) continue;
        // The controller has accepted this exact file snapshot. Reconnect at its
        // frontier without attributing unavailable time or backfilled deaths.
        const session = { ...previous, streamId: source.streamId, recordingId: source.recordingId, filename: source.filename, status: 'running' as const };
        this.transaction(() => { this.save(session); this.changed(); });
        this.sessions.set(session.characterKey, session); this.baseline(session, source);
      }
    }
    for (const previous of this.groups.values()) {
      if (this.options.soloOnly) continue;
      if (['stopped', 'recording-changed'].includes(previous.status)) continue;
      const changed = previous.members.some(member => {
        const stream = streams.find(value => sourceKey(value.sourcePath) === member.sourceKey) ?? streams.find(value => value.id === member.streamId);
        return !!stream && (sourceKey(stream.sourcePath) !== member.sourceKey || stream.character && stream.character.key !== member.characterKey);
      });
      if (changed) { this.setGroupStatus(previous, 'recording-changed', false); continue; }
      const available = previous.members.filter(member => { const source = this.memberSource(member); return source && !unavailable(source.status); });
      for (const member of previous.members) { const source = this.memberSource(member); if (!source || unavailable(source.status)) this.groupCursors.get(previous.id)?.delete(member.sourceKey); }
      const nextStatus = previous.resumeRunning && !available.length ? 'source-unavailable' : previous.status;
      const sessions = this.currentGroupSessions(previous);
      const publicSources = previous.members.map(member => { const source = this.memberSource(member); return source ? this.publicSource(source) : { characterKey: member.characterKey, streamId: member.streamId, recordingId: member.recordingId, filename: member.filename, status: 'missing' }; });
      if (sessions.length && (previous.status !== nextStatus || JSON.stringify(sessions[0].sources) !== JSON.stringify(publicSources))) {
        const group = { ...previous, status: nextStatus };
        const copies = sessions.map(session => ({ ...session, base: { ...session.base }, job: { ...session.job } }));
        this.transaction(() => { this.refreshGroup(group, copies); this.changed(); });
        this.groups.set(group.id, group); for (const session of copies) this.sessions.set(session.characterKey, session);
      }
    }
    if (previousNames.size !== this.names.size || [...this.names].some(([key, name]) => previousNames.get(key) !== name)) this.transaction(() => this.changed());
  }
  snapshot(): KillExperienceState {
    const rates: KillExperienceRate[] = this.db.prepare('SELECT * FROM kill_experience_rates ORDER BY character_key,monster_id').all().map(row => ({ characterKey: String(row.character_key), monsterId: Number(row.monster_id), baseExp: row.base_exp === null ? null : Number(row.base_exp), jobExp: row.job_exp === null ? null : Number(row.job_exp), updatedAt: String(row.updated_at) }));
    const penalties = new Map(this.db.prepare('SELECT character_key,percent FROM kill_experience_penalties').all().map(row => [String(row.character_key), Number(row.percent) as 0 | 5 | 10]));
    const keys = new Set([...this.names.keys(), ...rates.map(rate => rate.characterKey), ...this.sessions.keys(), ...penalties.keys()]);
    const historicalName = this.db.prepare('SELECT character_name FROM kill_count_sessions WHERE character_key=? ORDER BY rowid DESC LIMIT 1');
    return { revision: this.revision, sources: [...this.sources.values()].map(source => this.publicSource(source)), characters: [...keys].map(characterKey => {
      const stored = this.sessions.get(characterKey);
      const singleSource = stored && !stored.groupId ? [...this.sources.values()].find(source => source.sourceKey === stored.sourceKey && source.recordingKey === stored.recordingKey && source.character.key === characterKey) : undefined;
      const sources = stored?.groupId ? stored.sources : stored ? singleSource ? [this.publicSource(singleSource)] : [{ characterKey, streamId: stored.streamId, recordingId: stored.recordingId, filename: stored.filename, status: 'missing' as const }] : [];
      const coverage = stored?.groupId ? stored.coverage : { availableSources: singleSource && !unavailable(singleSource.status) ? 1 : 0, totalSources: 1, partial: !singleSource || unavailable(singleSource.status), matchingUnavailable: 0 };
      const session: KillExperienceSession | null = stored ? { id: stored.id, characterKey, streamId: stored.streamId, recordingId: stored.recordingId, filename: stored.filename, status: stored.status, startedAt: stored.startedAt, durationMs: stored.durationMs, observedDeaths: stored.observedDeaths, observedPlayerDeaths: stored.observedPlayerDeaths, mode: stored.mode, groupId: stored.groupId, sources: sources.map(source => ({ ...source })), rawObservations: stored.rawObservations, duplicateCandidates: stored.duplicateCandidates, estimatedDeaths: stored.estimatedDeaths, matchingWindowMs: stored.matchingWindowMs, coverage: { ...coverage }, base: { ...stored.base }, job: { ...stored.job } } : null;
      if (session && (this.options.soloOnly || stored?.soloReference)) {
        session.attributionPolicy = stored?.attributionPolicy;
        session.soloReference = stored?.soloReference ? { ...stored.soloReference } : null;
        session.targetMonsterIds = [...(stored?.targetMonsterIds ?? [])];
        session.soloProgress = projectSoloExperience(session.soloReference, session);
      }
      return { characterKey, characterName: this.names.get(characterKey) ?? stored?.characterName ?? String(historicalName.get(characterKey)?.character_name ?? characterKey), deathPenaltyPercent: penalties.get(characterKey) ?? 0, rates: rates.filter(rate => rate.characterKey === characterKey), session };
    }), notice: this.options.soloOnly ? 'Kendi hasarına göre solo tahmin; oyundan ölçülen EXP veya doğrulanmış kişisel kesim değildir. Yalnız kendi hasarı görülen, başlangıçta EXP değeri girilmiş hedef ölümleri sayılır. Başkasının/karışık saldırganların ölümleri ve hasarsız gözlemler dışarıda kalır. Eski çevre gözlemleri yeni toplamlara eklenmez. Seçilen tek Replay kullanılır. Sonradan eklenen yaratıklar yeni ölçümde dahil olur; değer değişiklikleri yalnız gelecekteki gözlemleri etkiler. Yüzde, kazanımın ölçüm başındaki otomatik okunan seviyenin EXP gereksinimine oranıdır; mevcut EXP yüzdesi değildir ve %100 üzerinde olabilir. Saatlik değer yalnız ölçülen Replay süresini kullanır; duraklatılan veya uygulama kapalıyken geçen aralıklar dahil edilmez.' : 'Ölüm gözlemine göre tahmini EXP; kesin kişisel kill veya oyundan ölçülen EXP değildir. Parti modu seçilen kaynakları ortak havuza alır; aynı harita, yaratık türü ve varlık kimliğinin ±1.500 ms Replay saat yakınlığı yalnız olası tekrar eşleştirmesidir. Aynı kaynaktaki ayrı yaşamlar birleştirilmez; harita veya başlangıç saati yoksa eşleştirme yapılamaz. Her karakter ortak tahmini ölümlerden kendi girdiği kişisel EXP değerini alır; ek parti çarpanı uygulanmaz. Kişisel ölüm cezası yalnız kendi kaynağından gelir. Net hız ortak aktif Replay sürelerinin birleşimidir; kaynak kaybında kapsam kısmidir. Ölüm kaybı varsayılan kapalı; %5/%10 sonraki Base/Job seviye gereksiniminden aşağı yuvarlanır. Gerçek mevcut EXP bilinmediğinden kayıp kısılmaz; net negatif olabilir. Ayar değişiklikleri geçmişi değiştirmez.' };
  }
  close(): void { this.sources.clear(); this.cursors.clear(); this.groupCursors.clear(); this.compactSeen.clear(); this.compactRestartFloors.clear(); }
}
