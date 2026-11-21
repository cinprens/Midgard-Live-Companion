import type { LiveTelemetry } from '../parser/types';
import { experienceRequirement, type ExperienceKind, type JobTrack } from './experience-table';
export * from './experience-table';

export type ExperienceStatus = 'actual' | 'calibrated' | 'estimated' | 'waiting' | 'stale';
export interface ExperienceEvent {
  timestamp: number; eventType: string; amount?: number; statusKey?: string; expKind?: ExperienceKind;
  actorId?: number; attribution?: string; packetId?: string; rawData?: Record<string, unknown>;
}
export interface ExperienceSnapshot {
  streamId: string; recordingId: string; events: readonly ExperienceEvent[];
  telemetry?: Partial<LiveTelemetry> | null;
  playerId?: number | null;
  observedAt?: number;
  reset?: boolean;
  /** False only when the source has a known incomplete/truncated tail, not just unknown packet IDs. */
  complete?: boolean;
  /** Requires external Skadi/game-screen verification; a source-defined decoder alone is insufficient. */
  liveVerified?: boolean;
}
export interface ExperienceCalibration {
  streamId: string; kind: ExperienceKind; level?: number; jobTrack?: JobTrack | null;
  current?: number; percent?: number;
}
export interface ExperienceTrackView {
  kind: ExperienceKind; level: number | null; current: number | null; required: number | null;
  remaining: number | null; percent: number | null; status: ExperienceStatus; qualityLabel: string;
  requiredSource: 'packet' | 'official-table' | null; sourceUrl: string | null; verifiedAt: string | null;
  lastObservedAt: number | null; lastGainAt: number | null;
  lastGainAmount: number | null; lastGainSource: 'explicit' | 'difference' | null;
  gains5m: number | null; gains15m: number | null; gains60m: number | null;
  losses5m: number | null; losses15m: number | null; losses60m: number | null;
  expPerHour: number | null; netExpPerHour: number | null; etaSeconds: number | null;
  rateWindowMinutes: 15; rateCoveredSeconds: number;
  rateQuality: 'observed' | 'estimated' | 'waiting'; reason: string | null;
}
export interface CharacterExperienceView {
  streamId: string; recordingId: string; jobTrack: JobTrack | null;
  jobTrackSource: 'manual' | 'rrf-session-class' | null; jobClassId: number | null;
  base: ExperienceTrackView; job: ExperienceTrackView;
  lastObservedAt: number; liveVerified: boolean; notice: string;
}
type Origin = 'packet' | 'calibrated' | 'estimated' | null;
interface Bucket { gain: number; loss: number; estimated: boolean }
interface Track {
  kind: ExperienceKind; level: number | null; current: number | null;
  packetRequired: number | null; packetRequiredLevel: number | null;
  origin: Origin; calibration: 'absolute' | 'percent' | null;
  lastObservedAt: number | null; lastGainAt: number | null;
  lastGainAmount: number | null; lastGainSource: 'explicit' | 'difference' | null;
  rateAvailable: boolean; rateObserved: boolean; buckets: Map<number, Bucket>; reason: string | null;
}
interface Stream {
  id: string; recordingId: string; jobTrack: JobTrack | null;
  manualJobTrack: JobTrack | null; automaticJobTrack: JobTrack | null; jobClassId: number | null; automaticJobTrackInvalidated: boolean;
  base: Track; job: Track; startedAt: number; lastObservedAt: number;
  watermark: number; fingerprints: Map<string, number>; saturated: boolean;
  anchorAt: number; anchorReplay: number; complete: boolean; liveVerified: boolean;
}
export interface ExperienceTrackerOptions { clock?: () => number; staleAfterMs?: number; maxFingerprintsPerStream?: number }
const HOUR = 3600000, WINDOW = 15 * 60000;
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const levelValue = (value: unknown): value is number => valid(value) && value > 0 && value <= 1000;
const validTrack = (value: unknown): value is JobTrack => ['novice', 'first', 'second'].includes(String(value));
const keyOf = (event: ExperienceEvent): string => event.statusKey ?? String(event.rawData?.status ?? '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const relevant = (event: ExperienceEvent): boolean => ['status', 'exp-gain', 'exp-loss', 'level-up'].includes(event.eventType);
const fingerprint = (event: ExperienceEvent): string => JSON.stringify([event.eventType, event.timestamp, event.amount, event.statusKey, event.expKind, event.actorId, event.packetId, event.rawData?.status, event.rawData?.levelType]);
const newTrack = (kind: ExperienceKind): Track => ({ kind, level: null, current: null, packetRequired: null, packetRequiredLevel: null,
  origin: null, calibration: null, lastObservedAt: null, lastGainAt: null, lastGainAmount: null, lastGainSource: null,
  rateAvailable: false, rateObserved: false, buckets: new Map(), reason: null });

/** RAM-only tracking. Historical first snapshots seed a baseline, never hourly gains. */
export class ExperienceTracker {
  private streams = new Map<string, Stream>();
  private clock: () => number;
  private staleAfter: number;
  private maxFingerprints: number;
  constructor(options: ExperienceTrackerOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.staleAfter = options.staleAfterMs ?? 120000;
    this.maxFingerprints = options.maxFingerprintsPerStream ?? 2048;
    if (!Number.isFinite(this.staleAfter) || this.staleAfter <= 0 || !Number.isSafeInteger(this.maxFingerprints) || this.maxFingerprints < 8 || this.maxFingerprints > 4096) throw new Error('EXP takip sınırları geçersiz.');
  }
  observe(snapshot: ExperienceSnapshot): CharacterExperienceView {
    const now = snapshot.observedAt ?? this.clock();
    if (!snapshot.streamId || !snapshot.recordingId || !Number.isFinite(now)) throw new Error('EXP akışı ve gözlem zamanı geçerli olmalıdır.');
    let stream = this.streams.get(snapshot.streamId);
    const baseline = !stream || snapshot.reset === true || stream.recordingId !== snapshot.recordingId;
    let maximum = -1;
    for (const event of snapshot.events) if (valid(event.timestamp)) maximum = Math.max(maximum, event.timestamp);
    if (baseline) {
      stream = { id: snapshot.streamId, recordingId: snapshot.recordingId, jobTrack: stream?.manualJobTrack ?? null,
        manualJobTrack: stream?.manualJobTrack ?? null, automaticJobTrack: null, jobClassId: null, automaticJobTrackInvalidated: false,
        base: newTrack('base'), job: newTrack('job'), startedAt: now, lastObservedAt: now,
        watermark: -1, fingerprints: new Map(), saturated: false, anchorAt: now, anchorReplay: Math.max(0, maximum),
        complete: snapshot.complete !== false, liveVerified: snapshot.liveVerified === true };
      this.streams.set(snapshot.streamId, stream);
    }
    const state = stream!;
    // An incomplete view cannot rewind a stream or make its previously seen gains repeat.
    if (!baseline && maximum < state.watermark) return this.makeView(state, now);
    state.lastObservedAt = Math.max(state.lastObservedAt, now);
    state.complete = snapshot.complete !== false;
    state.liveVerified = snapshot.liveVerified === true;
    const telemetry = snapshot.telemetry;
    if (baseline && levelValue(telemetry?.recordingStartJobLevel)) this.applyLevel(state.job, telemetry.recordingStartJobLevel);
    if (valid(telemetry?.jobClassId)) state.jobClassId = telemetry.jobClassId;
    if (!state.automaticJobTrackInvalidated && telemetry?.jobTrackSource === 'rrf-session-class' && validTrack(telemetry.jobTrack)) {
      state.automaticJobTrack = telemetry.jobTrack;
      this.changeJobTrack(state, state.manualJobTrack ?? state.automaticJobTrack);
    }
    const old = { base: { ...state.base, required: this.required(state, state.base).amount },
      job: { ...state.job, required: this.required(state, state.job).amount } };
    const counts = new Map<string, number>(), seen = new Map<string, number>();
    let saturated = false;
    const incoming: ExperienceEvent[] = [];
    // Packet times still determine the full snapshot watermark above, but only
    // EXP-relevant events enter sorting, fingerprinting or transition processing.
    let events = snapshot.events.filter(event => valid(event.timestamp) && relevant(event));
    for (let i = 1; i < events.length; i++) if (events[i].timestamp < events[i - 1].timestamp) { events = [...events].sort((a, b) => a.timestamp - b.timestamp); break; }
    for (const event of events) {
      const key = fingerprint(event);
      if (event.timestamp === maximum) {
        if (counts.has(key) || counts.size < this.maxFingerprints) counts.set(key, (counts.get(key) ?? 0) + 1); else saturated = true;
      }
      if (event.timestamp < state.watermark) continue;
      if (event.timestamp === state.watermark) {
        if (state.saturated) continue;
        const occurrence = (seen.get(key) ?? 0) + 1; seen.set(key, occurrence);
        if (occurrence <= (state.fingerprints.get(key) ?? 0)) continue;
      }
      incoming.push(event);
    }
    const absolute = new Set<ExperienceKind>(), requirements = new Set<ExperienceKind>(), explicit = new Set<ExperienceKind>(), levels = new Set<ExperienceKind>();
    const deltas: Record<ExperienceKind, { amount: number; at: number }[]> = { base: [], job: [] };
    for (const event of incoming) {
      if ((event.eventType === 'exp-gain' || event.eventType === 'exp-loss') && (event.expKind === 'base' || event.expKind === 'job') && this.personal(event, snapshot)) explicit.add(event.expKind);
    }
    for (const event of incoming) {
      const at = Math.min(now, Math.max(state.startedAt, state.anchorAt + event.timestamp - state.anchorReplay));
      if (event.eventType === 'status') {
        const key = keyOf(event);
        if (!valid(event.amount)) continue;
        if (key === 'baseLevel' || key === 'jobLevel') { const kind = key === 'baseLevel' ? 'base' : 'job'; this.observedLevel(state, kind, event.amount); levels.add(kind); }
        if (key === 'baseExp' || key === 'jobExp') {
          const kind = key === 'baseExp' ? 'base' : 'job';
          this.absolute(state[kind], event.amount, at); absolute.add(kind);
        }
        if (key === 'nextBaseExp' || key === 'nextJobExp') {
          const kind = key === 'nextBaseExp' ? 'base' : 'job';
          state[kind].packetRequired = event.amount > 0 ? event.amount : null;
          state[kind].packetRequiredLevel = state[kind].level; requirements.add(kind);
        }
      } else if (event.eventType === 'level-up' && levelValue(event.amount)) {
        const kind = event.expKind ?? (event.rawData?.levelType === 'job' ? 'job' : 'base');
        this.observedLevel(state, kind, event.amount); levels.add(kind);
      } else if ((event.eventType === 'exp-gain' || event.eventType === 'exp-loss') && event.expKind && this.personal(event, snapshot) && Number.isSafeInteger(event.amount)) {
        const amount = Math.abs(event.amount!);
        if (!amount || (event.eventType === 'exp-gain' && event.amount! < 0)) continue;
        const track = state[event.expKind];
        if (!baseline) {
          this.record(track, at, event.eventType === 'exp-gain' ? amount : -amount, false, now);
          deltas[event.expKind].push({ amount: event.eventType === 'exp-gain' ? amount : -amount, at });
        }
      }
    }
    // Final telemetry resolves packets whose current EXP and level updates arrive in either order.
    for (const kind of ['base', 'job'] as const) {
      const track = state[kind], telemetry = snapshot.telemetry;
      const nextLevel = telemetry?.[kind === 'base' ? 'baseLevel' : 'jobLevel'];
      if ((baseline || levels.has(kind)) && levelValue(nextLevel)) this.applyLevel(track, nextLevel);
      const current = telemetry?.[kind === 'base' ? 'currentBaseExp' : 'currentJobExp'];
      if ((baseline || absolute.has(kind)) && valid(current)) this.absolute(track, current, baseline ? now : track.lastObservedAt ?? now);
      const required = telemetry?.[kind === 'base' ? 'nextBaseExp' : 'nextJobExp'];
      // A requirement packet preceding a later level change may belong to the old
      // level. applyLevel deliberately invalidates it; do not resurrect it from
      // the parser's last-value telemetry cache after that invalidation.
      if (baseline && !requirements.has(kind) && valid(required) && required > 0) { track.packetRequired = required; track.packetRequiredLevel = track.level; }
      if (!baseline && !absolute.has(kind) && deltas[kind].length && old[kind].current !== null) {
        const previous = old[kind], observedLevel = levels.has(kind) ? track.level : null;
        track.level = previous.level; track.current = previous.current; track.origin = previous.origin;
        track.calibration = previous.calibration; track.packetRequired = previous.packetRequired; track.packetRequiredLevel = previous.packetRequiredLevel;
        for (const delta of deltas[kind]) this.applyDelta(state, track, delta.amount, delta.at);
        if (observedLevel !== null && track.level !== observedLevel) this.applyLevel(track, observedLevel);
      }
      if (!baseline && !explicit.has(kind) && absolute.has(kind)) {
        const previous = old[kind];
        const delta = this.distance(state, kind, previous.level, previous.current, track.level, track.current, previous.required);
        if (delta !== null) this.record(track, now, delta, true, now);
      }
      if (!state.complete && track.origin !== 'packet' && track.current !== null) { track.origin = 'estimated'; track.reason = 'Eksik akış; hesaplanan EXP tamlığı doğrulanamadı.'; }
      this.trim(track, now);
    }
    if (maximum === state.watermark) {
      // A partial view at the same time cannot forget already observed
      // occurrences. Keep the high-water count and any saturation latch.
      for (const [key, count] of state.fingerprints) {
        if (counts.has(key)) counts.set(key, Math.max(count, counts.get(key)!));
        else if (counts.size < this.maxFingerprints) counts.set(key, count);
        else saturated = true;
      }
      saturated ||= state.saturated;
    }
    state.watermark = Math.max(state.watermark, maximum); state.fingerprints = counts; state.saturated = saturated;
    return this.makeView(state, now);
  }
  view(streamId: string, now = this.clock()): CharacterExperienceView | null {
    const stream = this.streams.get(streamId); return stream ? this.makeView(stream, now) : null;
  }
  views(now = this.clock()): Record<string, CharacterExperienceView> { return Object.fromEntries([...this.streams].map(([id, state]) => [id, this.makeView(state, now)])); }
  calibrate(input: ExperienceCalibration, now = this.clock()): CharacterExperienceView {
    const stream = this.streams.get(input.streamId);
    if (!stream) throw new Error('Kalibrasyon için önce karakterin Replay verisini bekleyin.');
    if (input.kind !== 'base' && input.kind !== 'job') throw new Error('EXP türü geçersiz.');
    if (!Number.isFinite(now)) throw new Error('Kalibrasyon zamanı geçersiz.');
    if ((input.current === undefined) === (input.percent === undefined)) throw new Error('EXP miktarı veya yüzdesinden yalnızca birini girin.');
    if (input.jobTrack !== undefined && input.jobTrack !== null && !validTrack(input.jobTrack)) throw new Error('Meslek EXP tablosu geçersiz.');
    const jobTrack = input.jobTrack === undefined ? stream.jobTrack : input.jobTrack ?? (stream.automaticJobTrackInvalidated ? null : stream.automaticJobTrack);
    const track = { ...stream[input.kind] };
    if (input.level !== undefined) {
      if (!levelValue(input.level)) throw new Error('Seviye pozitif bir tam sayı olmalıdır.');
      this.applyLevel(track, input.level);
    }
    const required = this.required({ ...stream, jobTrack }, track).amount;
    let current = input.current;
    if (input.percent !== undefined) {
      if (!Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100) throw new Error('EXP yüzdesi 0–100 aralığında olmalıdır.');
      if (required === null) throw new Error('Yüzde kalibrasyonu için seviye ve meslek EXP tablosu gereklidir.');
      current = Math.floor(required * input.percent / 100);
    }
    if (!valid(current) || (required !== null && current > required)) throw new Error('EXP miktarı geçerli bir tam sayı olmalı ve seviye gereksinimini aşmamalıdır.');
    track.current = current; track.origin = 'calibrated'; track.calibration = input.percent !== undefined ? 'percent' : 'absolute';
    track.lastObservedAt = now; track.reason = 'Başlangıç değeri kullanıcı tarafından kalibre edildi; sonraki açık EXP olaylarıyla hesaplanır.';
    if (input.jobTrack !== undefined) this.setJobTrack(input.streamId, input.jobTrack);
    Object.assign(stream[input.kind], track);
    return this.makeView(stream, now);
  }
  setJobTrack(streamId: string, jobTrack: JobTrack | null): CharacterExperienceView {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error('Karakter EXP akışı bulunamadı.');
    if (jobTrack !== null && !validTrack(jobTrack)) throw new Error('Meslek EXP tablosu geçersiz.');
    stream.manualJobTrack = jobTrack;
    this.changeJobTrack(stream, jobTrack ?? (stream.automaticJobTrackInvalidated ? null : stream.automaticJobTrack));
    return this.makeView(stream, this.clock());
  }
  private changeJobTrack(stream: Stream, jobTrack: JobTrack | null): void {
    if (stream.jobTrack !== jobTrack && stream.job.calibration === 'percent') {
      stream.job.current = null; stream.job.origin = null; stream.job.calibration = null;
      stream.job.reason = 'Meslek tablosu değişti; yüzde kalibrasyonunu yeniden girin.';
    }
    stream.jobTrack = jobTrack;
  }
  remove(streamId: string): void { this.streams.delete(streamId); }
  clear(): void { this.streams.clear(); }
  stats(): { streams: number; buckets: number; fingerprints: number } {
    let buckets = 0, fingerprints = 0;
    for (const stream of this.streams.values()) { buckets += stream.base.buckets.size + stream.job.buckets.size; fingerprints += stream.fingerprints.size; }
    return { streams: this.streams.size, buckets, fingerprints };
  }
  private personal(event: ExperienceEvent, snapshot: ExperienceSnapshot): boolean {
    return event.attribution === 'personal' && valid(snapshot.playerId) && snapshot.playerId > 0 && event.actorId === snapshot.playerId;
  }
  private absolute(track: Track, amount: number, at: number): void {
    track.current = amount; track.origin = 'packet'; track.calibration = null; track.lastObservedAt = at; track.rateAvailable = true; track.reason = null;
  }
  private applyLevel(track: Track, level: number): void {
    if (!levelValue(level) || track.level === level) return;
    if (track.level !== null) { track.current = null; track.origin = null; track.reason = 'Seviye değişti; yeni seviyenin mevcut EXP değeri veya kalibrasyonu bekleniyor.'; }
    track.level = level; track.packetRequired = null; track.packetRequiredLevel = null;
  }
  private observedLevel(stream: Stream, kind: ExperienceKind, level: number): void {
    if (kind === 'job' && levelValue(level) && stream.job.level !== null && level < stream.job.level) {
      // Session class describes recording start; a job-level reset can mark a later class change.
      stream.automaticJobTrackInvalidated = true;
      this.changeJobTrack(stream, stream.manualJobTrack);
    }
    this.applyLevel(stream[kind], level);
  }
  private required(stream: Stream, track: Track): { amount: number | null; source: 'packet' | 'official-table' | null; url: string | null; date: string | null } {
    if (track.packetRequired !== null && track.packetRequiredLevel === track.level) return { amount: track.packetRequired, source: 'packet', url: null, date: null };
    const row = experienceRequirement(track.kind, track.level, stream.jobTrack);
    return { amount: row?.required ?? null, source: row?.required != null ? 'official-table' : null, url: row?.sourceUrl ?? null, date: row?.verifiedAt ?? null };
  }
  private applyDelta(stream: Stream, track: Track, delta: number, at: number): void {
    if (track.current === null) return;
    const total = track.current + delta;
    if (!valid(total)) { track.current = null; track.origin = null; track.reason = delta < 0 ? 'EXP kaybı başlangıç değerini aştı; yeniden kalibrasyon gerekli.' : 'EXP toplamı güvenli tam sayı sınırını aştı.'; return; }
    track.current = total;
    if (track.origin === 'packet') track.origin = 'estimated';
    track.lastObservedAt = at;
    if (delta > 0 && track.level !== null) {
      for (let steps = 0; steps < 1000; steps++) {
        const requirement = this.required(stream, track).amount;
        if (requirement === null || track.current < requirement) break;
        track.current -= requirement; track.level++;
        track.packetRequired = null; track.packetRequiredLevel = null;
      }
    }
  }
  private distance(stream: Stream, kind: ExperienceKind, fromLevel: number | null, from: number | null, toLevel: number | null, to: number | null, firstRequired: number | null): number | null {
    if (from === null || to === null || fromLevel === null || toLevel === null || toLevel < fromLevel || toLevel - fromLevel > 1000) return null;
    let result = to - from;
    for (let level = fromLevel; level < toLevel; level++) {
      const required = level === fromLevel ? firstRequired : experienceRequirement(kind, level, stream.jobTrack)?.required;
      if (required == null) return null;
      result += required;
      if (!Number.isSafeInteger(result)) return null;
    }
    return Number.isSafeInteger(result) ? result : null;
  }
  private record(track: Track, at: number, delta: number, estimated: boolean, now: number): void {
    track.rateAvailable = true;
    track.rateObserved = true;
    if (delta === 0 || at <= now - HOUR) return;
    const second = Math.floor(at / 1000), bucket = track.buckets.get(second) ?? { gain: 0, loss: 0, estimated: false };
    const key = delta > 0 ? 'gain' : 'loss';
    const next = bucket[key] + Math.abs(delta);
    if (!Number.isSafeInteger(next)) { track.reason = 'EXP hız toplamı güvenli tam sayı sınırını aştı.'; return; }
    bucket[key] = next; bucket.estimated ||= estimated; track.buckets.set(second, bucket);
    if (delta > 0) { track.lastGainAt = at; track.lastGainAmount = delta; track.lastGainSource = estimated ? 'difference' : 'explicit'; }
  }
  private trim(track: Track, now: number): void { for (const second of track.buckets.keys()) if (second * 1000 <= now - HOUR) track.buckets.delete(second); }
  private trackView(stream: Stream, track: Track, now: number): ExperienceTrackView {
    this.trim(track, now);
    const requirement = this.required(stream, track), required = requirement.amount;
    let status: ExperienceStatus = track.current === null ? 'waiting' : track.origin === 'calibrated' ? 'calibrated' : track.origin === 'packet' && stream.liveVerified && stream.complete ? 'actual' : 'estimated';
    if (track.current !== null && track.lastObservedAt !== null && now - track.lastObservedAt >= this.staleAfter) status = 'stale';
    const labels: Record<ExperienceStatus, string> = { actual: 'Doğrulanmış canlı veri', calibrated: 'Kalibre edilmiş hesaplama', estimated: track.origin === 'packet' ? 'Paket gözlemi · Skadi doğrulaması bekleniyor' : 'Tahmini değer', waiting: 'Veri bekleniyor', stale: 'Eski veri' };
    const totals = (minutes: number) => {
      let gain = 0, loss = 0, estimated = false;
      for (const [second, bucket] of track.buckets) if (second * 1000 > now - minutes * 60000 && second * 1000 <= now) { gain += bucket.gain; loss += bucket.loss; estimated ||= bucket.estimated; }
      return { gain: Number.isSafeInteger(gain) ? gain : null, loss: Number.isSafeInteger(loss) ? loss : null, estimated };
    };
    const five = totals(5), fifteen = totals(15), sixty = totals(60);
    const covered = Math.max(0, Math.min(WINDOW, now - stream.startedAt)), denominator = covered > 0 ? covered / HOUR : null;
    const rate = track.rateObserved && denominator !== null && fifteen.gain !== null ? fifteen.gain / denominator : null;
    const netRate = rate !== null && fifteen.loss !== null && denominator !== null ? (fifteen.gain! - fifteen.loss) / denominator : null;
    const remaining = track.current !== null && required !== null ? Math.max(0, required - track.current) : null;
    const percent = track.current !== null && required !== null && required > 0 ? Math.max(0, Math.min(100, track.current / required * 100)) : null;
    const reason = track.reason ?? (track.current === null ? 'Mevcut EXP okunamadı; desteklenen güncel EXP veya kişisel kazanım bildirimi bekleniyor.' : requirement.source === 'official-table' ? 'Gereksinim resmî tablodan; hedef seviye indekslemesi destekleyici hesaplayıcıyla karşılaştırıldı, Skadi paket doğrulaması bekleniyor.' : !stream.liveVerified ? 'Paket düzeni kaynak tanımlıdır; Skadi oyun ekranıyla EXP karşılaştırması tamamlanmadı.' : null);
    return { kind: track.kind, level: track.level, current: track.current, required, remaining, percent, status, qualityLabel: labels[status],
      requiredSource: requirement.source, sourceUrl: requirement.url, verifiedAt: requirement.date, lastObservedAt: track.lastObservedAt, lastGainAt: track.lastGainAt,
      lastGainAmount: track.lastGainAmount, lastGainSource: track.lastGainSource,
      gains5m: track.rateAvailable ? five.gain : null, gains15m: track.rateAvailable ? fifteen.gain : null, gains60m: track.rateAvailable ? sixty.gain : null,
      losses5m: track.rateAvailable ? five.loss : null, losses15m: track.rateAvailable ? fifteen.loss : null, losses60m: track.rateAvailable ? sixty.loss : null,
      expPerHour: rate, netExpPerHour: netRate, etaSeconds: remaining === 0 ? 0 : remaining !== null && netRate !== null && netRate > 0 ? remaining / netRate * 3600 : null,
      rateWindowMinutes: 15, rateCoveredSeconds: covered / 1000, rateQuality: !track.rateObserved ? 'waiting' : fifteen.estimated ? 'estimated' : 'observed', reason };
  }
  private makeView(stream: Stream, now: number): CharacterExperienceView {
    if (!Number.isFinite(now)) throw new Error('EXP görüntüleme zamanı geçersiz.');
    return { streamId: stream.id, recordingId: stream.recordingId, jobTrack: stream.jobTrack,
      jobTrackSource: stream.manualJobTrack !== null ? 'manual' : stream.jobTrack !== null ? 'rrf-session-class' : null, jobClassId: stream.jobClassId,
      base: this.trackView(stream, stream.base, now), job: this.trackView(stream, stream.job, now), lastObservedAt: stream.lastObservedAt,
      liveVerified: stream.liveVerified, notice: 'Seviye gereksinimleri yaratık EXP değeri ve etkinlik bonusundan ayrıdır. Party/etkinlik çarpanı otomatik uygulanmaz. EXP hızı ilk dosya geçmişini içermez.' };
  }
}
