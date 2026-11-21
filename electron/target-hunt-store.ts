import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isConfirmedMonsterDeath, isOwnDamageKill, type ParsedReplay, type ReplayEvent } from '../src/parser';
import type { CharacterIdentity, LiveStreamStatus } from '../src/shared/types';
import type { TargetHuntSession, TargetHuntSource, TargetHuntState, TargetHuntTarget, TargetHuntTargetsInput } from '../src/shared/target-hunt';

export interface TargetHuntObservation { sourcePath: string; streamId: string; hash: string; recordingId: string; recordingReset?: boolean; observedAt?: string; bootstrap?: boolean }
interface Monitor { id: string; sourcePath: string; status: LiveStreamStatus; character?: CharacterIdentity }
interface Runtime { key: string; sourcePath: string; recording: string; streamId: string; filename: string; character: CharacterIdentity; edge: number; frontier: Set<string>; clock: number | null; intervalId: string | null; gap: boolean; hash: string; bootstrapQuiet?: boolean; hasWireEvents?: boolean }
interface Metadata { id: string; segment: string; cutoff: number | null; startedAt: string; broken: boolean }
type Row = Record<string, unknown>;
interface HistoryChange { row?: Row; unavailable: boolean }
interface TargetHistory { count: number; raw: number; unavailable: number; intervalCount: number; intervalTotal: number; latestKnown?: Row; latestUnknown?: Row; coverage: string; pending: HistoryChange[] }
const WINDOW_MS = 1500;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceKey = (value: string) => digest(path.resolve(value).toLowerCase());
const inactive = (value: LiveStreamStatus) => ['paused', 'stopped', 'missing', 'error', 'resource-wait'].includes(value);
function clockLabel(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function localKey(event: ReplayEvent): string { const life = String((event.rawData!.killProof as Row).lifecycleId); return `${life.startsWith('wire:') ? 'wire:' : ''}${digest(JSON.stringify([event.targetId, life]))}`; }
function sum(left: number, right: number): number { const result = left + right; if (!Number.isSafeInteger(result) || result < 0) throw new Error('Av zamanlaması güvenli sayı sınırını aşıyor.'); return result; }
function union(spans: [number, number][], after = -Infinity, before = Infinity): number {
  const ordered = spans.map(([a, b]) => [Math.max(a, after), Math.min(b, before)] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let result = 0, start = 0, end = 0, found = false;
  for (const [a, b] of ordered) { if (!found || a > end) { if (found) result = sum(result, end - start); start = a; end = b; found = true; } else end = Math.max(end, b); }
  return found ? sum(result, end - start) : 0;
}

/** Automatic observed target timing, independent of every EXP model and table. */
export class TargetHuntStore {
  private runtime = new Map<string, Runtime>();
  private monitors = new Map<string, Monitor>();
  private monitorsKnown = false;
  private removedObservedSource = false;
  private names = new Map<number, string>();
  private targets: number[];
  private meta: Metadata;
  private revision: number;
  private cache?: TargetHuntState;
  // At most the selected targets are cached. Each entry retains aggregates and two
  // tail rows; a bounded pending batch handles append without loading old deaths.
  private histories = new Map<number, TargetHistory>();
  constructor(private db: DatabaseSync, private options: {ownDamageOnly?: boolean} = {}) {
    const stored = this.prepare("SELECT value_json FROM target_hunt_metadata WHERE key='session'").get();
    this.meta = stored ? JSON.parse(String(stored.value_json)) : { id: randomUUID(), segment: randomUUID(), cutoff: null, startedAt: new Date().toISOString(), broken: false };
    const selected = this.prepare("SELECT value_json FROM target_hunt_metadata WHERE key='targets'").get();
    this.targets = selected ? JSON.parse(String(selected.value_json)) : [1313];
    this.revision = Number(this.prepare("SELECT value_json FROM target_hunt_metadata WHERE key='revision'").get()?.value_json ?? 0);
    if (stored) { this.meta.segment = randomUUID(); this.meta.cutoff = null; this.meta.broken = true; }
    this.transaction(() => { this.persistMeta(); this.changed(); });
  }
  private prepare(sql: string) {return this.db.prepare(this.options.ownDamageOnly ? sql.replaceAll('target_hunt_', 'own_damage_target_hunt_') : sql);}
  private transaction<T>(action: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = action(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private setting(key: string, value: unknown): void { this.prepare('INSERT INTO target_hunt_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key, JSON.stringify(value)); }
  private persistMeta(): void { this.setting('session', this.meta); }
  private changed(): void { this.cache = undefined; this.revision++; this.setting('revision', this.revision); }
  private breakContinuity(): void {
    const clocks = [...this.runtime.values()].filter(value => value.clock !== null).map(value => value.clock! + value.edge);
    this.meta = { ...this.meta, segment: randomUUID(), cutoff: clocks.length ? Math.max(...clocks) : null, broken: true };
    for (const value of this.runtime.values()) value.intervalId = null;
    this.persistMeta(); this.changed();
  }
  setTargets(input: TargetHuntTargetsInput): void {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => key !== 'monsterIds') || !Array.isArray(input.monsterIds) || input.monsterIds.length > 512 || input.monsterIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > 0xffffffff)) throw new Error('En fazla 512 geçerli yaratık kimliği seçin.');
    const ids = [...new Set(input.monsterIds)].sort((a, b) => a - b);
    if (JSON.stringify(ids) === JSON.stringify(this.targets)) return;
    this.transaction(() => { this.targets = ids; this.setting('targets', ids); this.changed(); });
    for (const id of this.histories.keys()) if (!ids.includes(id)) this.histories.delete(id);
  }
  setLocalMonsterNames(names: Map<number, string>): void { this.names = new Map(names); this.cache = undefined; this.revision++; }
  syncStatuses(streams: Monitor[]): void {
    const next = new Map(streams.map(({ id, sourcePath, status, character }) => [sourceKey(sourcePath), { id, sourcePath, status, character }]));
    const oldKeys = [...this.monitors.keys()].sort(), nextKeys = [...next.keys()].sort();
    let broken = this.monitors.size > 0 && JSON.stringify(oldKeys) !== JSON.stringify(nextKeys);
    for (const [key, old] of this.monitors) {
      const current = next.get(key), runtime = this.runtime.get(key);
      if (!current || inactive(old.status) !== inactive(current.status)) broken = true;
      if (runtime && (!current || inactive(current.status))) runtime.gap = true;
    }
    const different = !this.monitorsKnown || JSON.stringify([...this.monitors]) !== JSON.stringify([...next]);
    this.monitorsKnown = true;
    this.monitors = next;
    if (broken || different) this.transaction(() => { if (broken) this.breakContinuity(); else this.changed(); });
    for (const key of this.runtime.keys()) if (!next.has(key)) {this.runtime.delete(key);this.removedObservedSource=true;}
  }
  observe(parsed: ParsedReplay, info: TargetHuntObservation, character: CharacterIdentity): void {
    const delta = parsed.incremental?.delta === true;
    const key = sourceKey(info.sourcePath), clock = clockLabel(parsed.summary.startedAt);
    const strong = parsed.summary.startedAt !== null && parsed.summary.playerId !== null && parsed.summary.characterName !== null;
    const baseRecording = digest(strong ? JSON.stringify([parsed.summary.startedAt, parsed.summary.playerId, parsed.summary.characterName]) : `${key}:${info.recordingId}`);
    const generationRow = this.prepare('SELECT value_json FROM target_hunt_metadata WHERE key=?').get(`generation:${key}`);
    const savedGeneration = generationRow ? JSON.parse(String(generationRow.value_json)) as { base: string; generation: number } : null;
    const generation = (savedGeneration?.base === baseRecording ? savedGeneration.generation : 0) + (info.recordingReset ? 1 : 0);
    const recording = generation ? digest(`${baseRecording}:${generation}`) : baseRecording;
    let edge = delta && Number.isSafeInteger(parsed.summary.durationMs) ? Math.max(0, parsed.summary.durationMs) : 0; for (const event of parsed.events) if (Number.isSafeInteger(event.timestamp) && event.timestamp >= 0) edge = Math.max(edge, event.timestamp);
    const events = parsed.events.filter(event => Number.isSafeInteger(event.timestamp) && event.timestamp >= 0 && isConfirmedMonsterDeath(event) && (!this.options.ownDamageOnly || isOwnDamageKill(event, parsed.summary.playerId)));
    const frontier = new Set(events.filter(event => event.timestamp === edge).map(localKey));
    if (frontier.size > 8192) throw new Error('Aynı Replay zamanında çok fazla yaratık ölümü gözlemi var.');
    const previous = this.runtime.get(key), saved = this.prepare('SELECT frontier_ms FROM target_hunt_sources WHERE source_key=? AND recording_key=?').get(key, recording);
    if (delta && !info.recordingReset) edge = Math.max(edge, previous?.recording === recording ? previous.edge : Number(saved?.frontier_ms ?? 0));
    if (previous && previous.recording === recording && !info.recordingReset && edge < previous.edge) return;
    if (!delta && previous && previous.recording === recording && previous.hash === info.hash && previous.edge === edge && !previous.gap && !info.recordingReset) return;
    const replacement = previous && (previous.recording !== recording || previous.character.key !== character.key || info.recordingReset);
    const quiet = info.recordingReset === true || !!saved && (!previous || previous.gap || replacement) || !!(info.bootstrap && previous?.bootstrapQuiet), first = !saved;
    const current: Runtime = { key, sourcePath: info.sourcePath, recording, streamId: info.streamId, filename: path.basename(info.sourcePath), character, edge, frontier, clock, intervalId: previous?.recording === recording ? previous.intervalId : null, gap: false, hash: info.hash, bootstrapQuiet: info.bootstrap && quiet };
    current.hasWireEvents = previous?.recording === recording ? previous.hasWireEvents : !!this.prepare("SELECT 1 FROM target_hunt_observations WHERE source_key=? AND recording_key=? AND event_key LIKE 'wire:%' LIMIT 1").get(key, recording);
    const observedStatus = this.monitors.get(key)?.status;
    if (observedStatus && inactive(observedStatus)) { current.gap = true; this.runtime.set(key, current); return; }
    const partial = this.monitors.size > 0 && [...this.monitors.values()].some(stream => inactive(stream.status));
    const historyChanges: { monsterId: number; change: HistoryChange }[] = [];
    this.transaction(() => {
      this.setting(`generation:${key}`, { base: baseRecording, generation });
      if (replacement) { this.breakContinuity(); current.intervalId = null; }
      if (quiet && (!previous || previous.bootstrapQuiet) && this.runtime.size <= 1 && clock !== null) { this.meta.cutoff = clock + edge; this.persistMeta(); }
      if (clock !== null) {
        let from = first ? clock : clock + (previous?.edge ?? edge);
        if (quiet) from = clock + edge;
        if (this.meta.cutoff !== null && !first) from = Math.max(from, this.meta.cutoff);
        if (!current.intervalId) {
          current.intervalId = randomUUID(); this.prepare('INSERT INTO target_hunt_intervals VALUES(?,?,?,?,?)').run(current.intervalId, this.meta.segment, key, Math.min(from, clock + edge), clock + edge);
        } else if (quiet && info.bootstrap) this.prepare('UPDATE target_hunt_intervals SET start_ms=?,end_ms=? WHERE id=?').run(clock + edge, clock + edge, current.intervalId);
        else this.prepare('UPDATE target_hunt_intervals SET end_ms=MAX(end_ms,?) WHERE id=?').run(clock + edge, current.intervalId);
      }
      const incoming = quiet ? [] : first || delta ? events : events.filter(event => !previous || event.timestamp > previous.edge || event.timestamp === previous.edge && !previous.frontier.has(localKey(event)));
      for (const event of incoming) {
        const eventId = localKey(event);
        if (this.prepare('SELECT 1 FROM target_hunt_observations WHERE source_key=? AND recording_key=? AND event_key=?').get(key, recording, eventId)) continue;
        if (delta && saved && eventId.startsWith('wire:')) {
          const aliasPrefix = `wire-alias:${key}:${recording}:`;
          const legacy = this.prepare("SELECT o.event_key,m.value_json FROM target_hunt_observations o JOIN target_hunt_candidates c ON c.id=o.candidate_id LEFT JOIN target_hunt_metadata m ON m.key=?||o.event_key WHERE o.source_key=? AND o.recording_key=? AND o.event_ms=? AND c.target_id=? AND c.monster_id=? AND o.event_key NOT LIKE 'wire:%' AND (m.value_json IS NULL OR m.value_json=?) ORDER BY o.rowid LIMIT 1").get(aliasPrefix, key, recording, event.timestamp, event.targetId!, event.monsterId!, JSON.stringify(eventId));
          if (legacy) { if (legacy.value_json === null) this.setting(`${aliasPrefix}${String(legacy.event_key)}`, eventId); continue; }
        }
        if (!eventId.startsWith('wire:') && current.hasWireEvents) {
          const aliasPrefix = `legacy-alias:${key}:${recording}:`;
          const wire = this.prepare("SELECT o.event_key,m.value_json FROM target_hunt_observations o JOIN target_hunt_candidates c ON c.id=o.candidate_id LEFT JOIN target_hunt_metadata m ON m.key=?||o.event_key WHERE o.source_key=? AND o.recording_key=? AND o.event_ms=? AND c.target_id=? AND c.monster_id=? AND o.event_key LIKE 'wire:%' AND (m.value_json IS NULL OR m.value_json=?) ORDER BY o.rowid LIMIT 1").get(aliasPrefix, key, recording, event.timestamp, event.targetId!, event.monsterId!, JSON.stringify(eventId));
          if (wire) { if (wire.value_json === null) this.setting(`${aliasPrefix}${String(wire.event_key)}`, eventId); continue; }
        }
        const map = typeof event.mapId === 'string' && event.mapId.trim() ? event.mapId.trim().toLowerCase().slice(0, 200) : null;
        const absolute = clock === null ? null : clock + event.timestamp;
        const matching = map && absolute !== null ? this.prepare('SELECT c.id FROM target_hunt_candidates c WHERE c.map_id=? AND c.target_id=? AND c.monster_id=? AND c.clock_ms BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM target_hunt_observations o WHERE o.candidate_id=c.id AND o.source_key=?) ORDER BY ABS(c.clock_ms-?),c.rowid LIMIT 1').get(map, event.targetId!, event.monsterId!, absolute - WINDOW_MS, absolute + WINDOW_MS, key, absolute) : undefined;
        const candidate = matching ? String(matching.id) : randomUUID();
        let addedRow: Row | undefined;
        if (!matching) {
          const beforeBoundary = absolute !== null && this.meta.cutoff !== null && absolute < this.meta.cutoff;
          const segment = partial ? `partial:${candidate}` : beforeBoundary ? `history:${key}:${recording}` : this.meta.segment;
          const inserted = this.prepare('INSERT INTO target_hunt_candidates VALUES(?,?,?,?,?,?,?,?,?,?)').run(candidate, event.monsterId!, event.monsterName ?? null, map, event.targetId!, absolute, event.timestamp, clock === null ? recording : 'replay-clock', segment, key);
          addedRow = { sequence: Number(inserted.lastInsertRowid), id: candidate, monster_name: event.monsterName ?? null, clock_ms: absolute, event_ms: event.timestamp, timing: absolute ?? event.timestamp, map_id: map, segment_id: segment, time_basis: clock === null ? recording : 'replay-clock' };
        }
        this.prepare('INSERT INTO target_hunt_observations VALUES(?,?,?,?,?)').run(key, recording, eventId, candidate, event.timestamp);
        if (eventId.startsWith('wire:')) current.hasWireEvents = true;
        historyChanges.push({ monsterId: event.monsterId!, change: { row: addedRow, unavailable: map === null || absolute === null } });
      }
      this.prepare('INSERT INTO target_hunt_sources VALUES(?,?,?,?) ON CONFLICT(source_key,recording_key) DO UPDATE SET frontier_ms=excluded.frontier_ms,data_json=excluded.data_json').run(key, recording, edge, JSON.stringify({ filename: current.filename, characterKey: character.key, characterName: character.name }));
      this.changed();
    });
    for (const { monsterId, change } of historyChanges) { const history = this.histories.get(monsterId); if (history) { if (history.pending.length < 8192) history.pending.push(change); else this.histories.delete(monsterId); } }
    this.runtime.set(key, current);
  }
  private coverageKey(segments: Map<string, [number, number][]>, through: number): string {
    const result: [string, [number, number][]][] = [];
    for (const [id, spans] of segments) {
      const ordered = spans.map(([a, b]) => [a, Math.min(b, through)] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const span of ordered) { const last = merged.at(-1); if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push(span); }
      if (merged.length) result.push([id, merged]);
    }
    return JSON.stringify(result.sort(([left], [right]) => left.localeCompare(right)));
  }
  private history(monsterId: number, segments: Map<string, [number, number][]>, coveredInterval: (row: Row) => number | null): TargetHistory {
    let history = this.histories.get(monsterId);
    // Extending coverage beyond the latest old death cannot change an old interval.
    // Filling an earlier gap, or receiving an out-of-order observation, rebuilds
    // once from SQLite so averages remain correct across independent sources.
    if (history && history.coverage !== this.coverageKey(segments, Number(history.latestKnown?.clock_ms ?? -Infinity))) history = undefined;
    if (history) {
      let last = Number(history.latestKnown?.clock_ms ?? -Infinity);
      for (const change of history.pending) if (change.row?.clock_ms != null) { const time = Number(change.row.clock_ms); if (time < last) { history = undefined; break; } last = time; }
    }
    if (!history) {
      const rows = this.prepare(`WITH ordered AS (SELECT rowid sequence,*,COALESCE(clock_ms,event_ms) timing,LAG(COALESCE(clock_ms,event_ms)) OVER(PARTITION BY time_basis ORDER BY COALESCE(clock_ms,event_ms),rowid) previous_time,LAG(segment_id) OVER(PARTITION BY time_basis ORDER BY COALESCE(clock_ms,event_ms),rowid) previous_segment,LAG(map_id) OVER(PARTITION BY time_basis ORDER BY COALESCE(clock_ms,event_ms),rowid) previous_map FROM target_hunt_candidates WHERE monster_id=?) SELECT *,CASE WHEN clock_ms IS NOT NULL AND segment_id=previous_segment AND map_id=previous_map AND previous_time IS NOT NULL THEN timing-previous_time ELSE NULL END interval_ms FROM ordered ORDER BY clock_ms DESC,sequence DESC`).all(monsterId);
      const counts = this.prepare('SELECT COUNT(*) raw,SUM(CASE WHEN c.map_id IS NULL OR c.clock_ms IS NULL THEN 1 ELSE 0 END) unavailable FROM target_hunt_observations o JOIN target_hunt_candidates c ON c.id=o.candidate_id WHERE c.monster_id=?').get(monsterId)!;
      let intervalCount = 0, intervalTotal = 0;
      for (const row of rows) { const duration = coveredInterval(row); if (duration !== null) { intervalCount++; intervalTotal = sum(intervalTotal, duration); } }
      const latestKnown = rows.find(row => row.clock_ms !== null), latestUnknown = rows.find(row => row.clock_ms === null);
      history = { count: rows.length, raw: Number(counts.raw), unavailable: Number(counts.unavailable ?? 0), intervalCount, intervalTotal, latestKnown, latestUnknown, coverage: this.coverageKey(segments, Number(latestKnown?.clock_ms ?? -Infinity)), pending: [] };
    } else {
      for (const change of history.pending) {
        history.raw++; if (change.unavailable) history.unavailable++;
        if (!change.row) continue;
        const row = change.row; history.count++;
        if (row.clock_ms === null) { history.latestUnknown = row; continue; }
        const previous = history.latestKnown;
        row.previous_time = previous?.timing ?? null;
        row.interval_ms = previous && row.segment_id === previous.segment_id && row.map_id !== null && row.map_id === previous.map_id ? Number(row.timing) - Number(previous.timing) : null;
        const duration = coveredInterval(row); if (duration !== null) { history.intervalCount++; history.intervalTotal = sum(history.intervalTotal, duration); }
        history.latestKnown = row;
      }
      history.pending = [];
      history.coverage = this.coverageKey(segments, Number(history.latestKnown?.clock_ms ?? -Infinity));
    }
    this.histories.set(monsterId, history);
    return history;
  }
  snapshot(): TargetHuntState {
    if (this.cache) return this.cache;
    const intervals = this.prepare('SELECT start_ms,end_ms,segment_id FROM target_hunt_intervals').all();
    const spans: [number, number][] = intervals.map(row => [Number(row.start_ms), Number(row.end_ms)]);
    const currentSpans: [number, number][] = intervals.filter(row => row.segment_id === this.meta.segment).map(row => [Number(row.start_ms), Number(row.end_ms)]);
    const segmentSpans = new Map<string, [number, number][]>();
    for (const row of intervals) { const id = String(row.segment_id), values = segmentSpans.get(id) ?? []; values.push([Number(row.start_ms), Number(row.end_ms)]); segmentSpans.set(id, values); }
    const coveredInterval = (row: Row): number | null => {
      if (row.interval_ms === null) return null;
      const duration = Number(row.interval_ms);
      return duration >= 0 && union(segmentSpans.get(String(row.segment_id)) ?? [], Number(row.previous_time), Number(row.timing)) === duration ? duration : null;
    };
    const monitors = this.monitorsKnown ? [...this.monitors.values()] : [...this.runtime.values()].map(value => ({ id: value.streamId, sourcePath: value.sourcePath, status: 'following' as LiveStreamStatus, character: value.character }));
    const sources: TargetHuntSource[] = monitors.map(stream => ({ streamId: stream.id, filename: this.runtime.get(sourceKey(stream.sourcePath))?.filename ?? path.basename(stream.sourcePath), characterKey: stream.character?.key ?? null, characterName: stream.character?.name ?? null, status: stream.status }));
    const available = sources.filter(source => !inactive(source.status)).length, partial = available < sources.length;
    let matchingUnavailable = 0;
    const targets: TargetHuntTarget[] = this.targets.map(monsterId => {
      const history = this.history(monsterId, segmentSpans, coveredInterval), latest = history.latestKnown ?? history.latestUnknown;
      const raw = history.raw; matchingUnavailable += history.unavailable;
      let furthestEdge = -Infinity; for (const [, end] of currentSpans) furthestEdge = Math.max(furthestEdge, end);
      const ageEligible = !!latest && latest.clock_ms !== null && latest.map_id !== null && latest.segment_id === this.meta.segment && available > 0 && !partial;
      const ageDuration = ageEligible && furthestEdge >= Number(latest.clock_ms) ? furthestEdge - Number(latest.clock_ms) : null;
      const ageKnown = ageDuration !== null && union(currentSpans, Number(latest!.clock_ms), furthestEdge) === ageDuration;
      const continuityBroken = !!latest && (latest.segment_id !== this.meta.segment || partial || !available || ageEligible && !ageKnown);
      const lastIntervalMs = continuityBroken || !latest ? null : coveredInterval(latest);
      return { monsterId, monsterName: this.names.get(monsterId) ?? String(this.prepare('SELECT name FROM monster_database WHERE monster_id=? ORDER BY rowid DESC LIMIT 1').get(monsterId)?.name ?? latest?.monster_name ?? (monsterId === 1313 ? 'Mobster' : `Yaratık #${monsterId}`)), deathCount: history.count, rawObservations: raw, duplicateCandidates: raw - history.count,
        lastDeathAt: latest?.clock_ms == null ? null : new Date(Number(latest.clock_ms)).toISOString().replace(/Z$/, ''),
        lastIntervalMs, completedIntervals: history.intervalCount, averageIntervalMs: history.intervalCount ? history.intervalTotal / history.intervalCount : null,
        sinceLastDeathMs: ageKnown ? ageDuration : null, continuityBroken };
    });
    const status: TargetHuntSession['status'] = !sources.length ? this.runtime.size||this.removedObservedSource ? 'stopped' : 'waiting' : available ? 'tracking' : sources.every(source => source.status === 'paused') ? 'paused' : sources.every(source => source.status === 'stopped') ? 'stopped' : 'source-unavailable';
    const session: TargetHuntSession = { id: this.meta.id, status, startedAt: this.meta.startedAt, sources, activeDurationMs: union(spans), rawObservations: targets.reduce((total, target) => total + target.rawObservations, 0), duplicateCandidates: targets.reduce((total, target) => total + target.duplicateCandidates, 0), estimatedDeaths: targets.reduce((total, target) => total + target.deathCount, 0), matchingWindowMs: WINDOW_MS, coverage: { availableSources: available, totalSources: sources.length, partial, matchingUnavailable } };
    return this.cache = { revision: this.revision, session, targets, countBasis: this.options.ownDamageOnly ? 'own-damage' : 'observed-deaths', notice: this.options.ownDamageOnly ? 'Yalnız kendi hasarına göre filtrelenen hedef ölümleri; kesin öldüren kimliği kanıtı değildir. Eski çevre gözlemleri dahil edilmez.' : 'İzlenen bütün Replay kaynaklarında hedef yaratık ölümü gözlemleri. Kişisel kill veya kesin benzersiz sunucu ölümü değildir. Aynı harita, yaratık ve varlık kimliğinin ±1.500 ms Replay saat yakınlığı yalnız olası tekrar eşleştirmesidir. Ortalama, yalnız tamamlanmış geçerli iki ölüm aralığının ortalamasıdır; süre/ölüm sayısı değildir. Son ölümden geçen süre aktif Replay ilerlemesidir; dosya durunca ilerlemez. Kaynak kesintisi, yeniden açılış veya kayıt değişimi üzerinden aralık kurulmaz. Başlangıçta aynı kesintisiz Replay geçmişi kullanılabilir; saat/harita eksikse ölçüler bilinmiyor kalır.' };
  }
  close(): void { this.runtime.clear(); this.monitors.clear(); this.histories.clear(); this.cache = undefined; }
}
