import type {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {isConfirmedMonsterDeath, isOwnDamageKill, type ParsedReplay, type ReplayEvent} from '../src/parser';
import type {CharacterIdentity, LiveStreamStatus} from '../src/shared/types';
import {replayClockBasis} from '../src/shared/replay-clock-basis';

export const HUNT_ANALYTICS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hunt_analytics_recordings(recording_key TEXT PRIMARY KEY,character_key TEXT NOT NULL,character_name TEXT NOT NULL,raw_started_at TEXT,anchor_ms REAL,time_zone TEXT NOT NULL,clock_version INTEGER NOT NULL,clock_status TEXT NOT NULL,identity_status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS hunt_analytics_sources(source_key TEXT NOT NULL,recording_key TEXT NOT NULL REFERENCES hunt_analytics_recordings(recording_key),status TEXT NOT NULL,updated_at TEXT NOT NULL,frontier_ms REAL NOT NULL,base_recording TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(source_key,recording_key));
  CREATE TABLE IF NOT EXISTS hunt_analytics_intervals(id TEXT PRIMARY KEY,recording_key TEXT NOT NULL REFERENCES hunt_analytics_recordings(recording_key),source_key TEXT NOT NULL,segment_id TEXT NOT NULL,start_ms REAL NOT NULL,end_ms REAL NOT NULL,provenance TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS hunt_analytics_events(id TEXT PRIMARY KEY,recording_key TEXT NOT NULL REFERENCES hunt_analytics_recordings(recording_key),character_key TEXT NOT NULL,monster_id INTEGER NOT NULL,monster_name TEXT,map_id TEXT,target_id INTEGER NOT NULL,event_ms REAL,replay_ms REAL NOT NULL,segment_id TEXT NOT NULL,provenance TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS hunt_analytics_event_aliases(alias_id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES hunt_analytics_events(id),UNIQUE(event_id));
  CREATE TABLE IF NOT EXISTS hunt_analytics_metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS hunt_analytics_statuses(id INTEGER PRIMARY KEY,source_key TEXT NOT NULL,recording_key TEXT,character_key TEXT,status TEXT NOT NULL,observed_at TEXT NOT NULL,segment_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS hunt_analytics_recording_character ON hunt_analytics_recordings(character_key,recording_key);
  CREATE INDEX IF NOT EXISTS hunt_analytics_interval_recording_time ON hunt_analytics_intervals(recording_key,start_ms,end_ms);
  CREATE INDEX IF NOT EXISTS hunt_analytics_interval_time ON hunt_analytics_intervals(start_ms,end_ms);
  CREATE INDEX IF NOT EXISTS hunt_analytics_event_monster_time ON hunt_analytics_events(monster_id,event_ms,id);
  CREATE INDEX IF NOT EXISTS hunt_analytics_event_character_time ON hunt_analytics_events(character_key,monster_id,event_ms,id);
  CREATE INDEX IF NOT EXISTS hunt_analytics_event_recording ON hunt_analytics_events(recording_key,replay_ms,target_id,monster_id);
  CREATE INDEX IF NOT EXISTS hunt_analytics_status_source ON hunt_analytics_statuses(source_key,id);
  INSERT OR IGNORE INTO hunt_analytics_metadata VALUES('revision',0);
`;
export interface HuntAnalyticsObservation {sourcePath: string; streamId: string; hash: string; recordingId: string; recordingReset?: boolean; initial?: boolean; observedAt?: string}
interface Monitor {id: string; sourcePath: string; status: LiveStreamStatus; character?: CharacterIdentity}
interface Runtime {recording: string; base: string; generation: number; characterKey: string; edge: number; hash: string; initial: boolean; gap: boolean; intervalId: string | null; segment: string; provenance: 'legacy' | 'prospective'; anchor: number | null}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sourceKey = (source: string) => digest(path.resolve(source).toLowerCase());
const inactive = (status: string) => ['paused', 'stopped', 'missing', 'error', 'resource-wait'].includes(status);
const eventKey = (event: ReplayEvent) => digest(JSON.stringify([event.timestamp, event.targetId, event.monsterId, event.mapId?.trim().toLowerCase() ?? null, String((event.rawData!.killProof as Record<string, unknown>).lifecycleId)]));

/** Separate evidence ledger: existing kill archives and historical clock values are immutable. */
export class HuntAnalyticsIngest {
  private runtime = new Map<string, Runtime>();
  private monitors = new Map<string, Monitor>();
  private segment = randomUUID();
  constructor(private db: DatabaseSync, private options: {ownDamageOnly?: boolean; lightweightHistory?: boolean} = {}) {}
  private prepare(sql: string) {return this.db.prepare(this.options.ownDamageOnly ? sql.replaceAll('hunt_analytics_', 'own_damage_hunt_analytics_') : sql);}
  private transaction(action: () => void): void {this.db.exec('BEGIN IMMEDIATE'); try {action(); this.db.exec('COMMIT');} catch (error) {this.db.exec('ROLLBACK'); throw error;}}
  private changed(): void {this.prepare("UPDATE hunt_analytics_metadata SET value=value+1 WHERE key='revision'").run();}
  private breakContinuity(): void {this.segment = randomUUID(); for (const runtime of this.runtime.values()) runtime.intervalId = null;}
  syncStatuses(streams: Monitor[]): void {
    const next = new Map(streams.map(stream => [sourceKey(stream.sourcePath), stream]));
    const changes = new Set([...this.monitors.keys(), ...next.keys()]);
    let broken = false;
    const changed = [...changes].filter(key => {
      const before = this.monitors.get(key), after = next.get(key);
      const different = before?.status !== after?.status || before?.character?.key !== after?.character?.key || !before !== !after;
      if (different && (!before || !after || inactive(before.status) !== inactive(after.status) || before.character?.key !== after.character?.key)) broken = true;
      if (this.runtime.has(key) && (!after || inactive(after.status))) this.runtime.get(key)!.gap = true;
      return different && (!this.options.lightweightHistory || !before || !after ||
        before.character?.key !== after.character?.key || inactive(before.status) !== inactive(after.status));
    });
    if (!changed.length) {for(const key of this.runtime.keys())if(!next.has(key))this.runtime.delete(key);this.monitors=next;return;}
    this.transaction(() => {
      if (broken) this.breakContinuity();
      const now = new Date().toISOString();
      for (const key of changed) {
        const monitor = next.get(key), runtime = this.runtime.get(key);
        this.prepare('INSERT INTO hunt_analytics_statuses(source_key,recording_key,character_key,status,observed_at,segment_id) VALUES(?,?,?,?,?,?)').run(key, runtime?.recording ?? null, monitor?.character?.key ?? runtime?.characterKey ?? null, monitor?.status ?? 'removed', now, this.segment);
        if (runtime) this.prepare('UPDATE hunt_analytics_sources SET status=?,updated_at=? WHERE source_key=? AND recording_key=?').run(monitor?.status ?? 'removed', now, key, runtime.recording);
      }
      this.changed();
    });
    for(const key of this.runtime.keys())if(!next.has(key))this.runtime.delete(key);
    this.monitors = next;
  }
  observe(parsed: ParsedReplay, info: HuntAnalyticsObservation, character: CharacterIdentity): void {
    if (parsed.status === 'invalid' || parsed.status === 'unsupported') return;
    const key = sourceKey(info.sourcePath), basis = replayClockBasis(parsed.summary.startedAt);
    const strong = parsed.summary.startedAt !== null && parsed.summary.playerId !== null && parsed.summary.characterName !== null;
    const base = digest(strong ? JSON.stringify([parsed.summary.startedAt, parsed.summary.playerId, parsed.summary.characterName]) : `${key}:${info.recordingId}`);
    const before = this.runtime.get(key);
    const saved = this.prepare('SELECT generation,recording_key,frontier_ms FROM hunt_analytics_sources WHERE source_key=? AND base_recording=? ORDER BY generation DESC LIMIT 1').get(key, base);
    // A reset flag may span every initial parser chunk; increment once per rebuild.
    const reset = !!info.recordingReset && (!before || !before.initial || !parsed.incremental || parsed.incremental.recordingStart === true);
    const generation = Number(saved?.generation ?? 0) + (reset ? 1 : 0);
    const recording = digest(JSON.stringify([base, generation]));
    let edge = Number.isSafeInteger(parsed.summary.durationMs) && parsed.summary.durationMs >= 0 ? parsed.summary.durationMs : 0;
    for (const event of parsed.events) if (Number.isSafeInteger(event.timestamp) && event.timestamp >= 0) edge = Math.max(edge, event.timestamp);
    const previous = before?.recording === recording && before.characterKey === character.key ? before : undefined;
    if (previous && edge < previous.edge && !reset) return;
    if (previous && edge === previous.edge && previous.hash === info.hash && previous.initial === !!info.initial && !previous.gap && !reset) return;
    const status = this.monitors.get(key)?.status ?? 'following';
    const initial = !!info.initial;
    const legacy = initial || !previous || previous.gap || inactive(status) || basis.anchorMs === null || !strong || parsed.diagnostics.some(diagnostic => /^(?:TRUNCATED_PACKET|INCOMPLETE)/.test(diagnostic.code));
    const provenance = legacy ? 'legacy' : 'prospective';
    const intervalFrom = previous ? previous.edge : 0;
    const current: Runtime = {recording, base, generation, characterKey: character.key, edge, hash: info.hash, initial, gap: inactive(status), intervalId: previous?.intervalId ?? null, segment: this.segment, provenance, anchor: basis.anchorMs};
    this.transaction(() => {
      if (before && (before.recording !== recording || before.characterKey !== character.key || reset)) {this.breakContinuity(); current.segment = this.segment; current.intervalId = null;}
      this.prepare('INSERT OR IGNORE INTO hunt_analytics_recordings VALUES(?,?,?,?,?,?,?,?,?)').run(recording, character.key, character.name, basis.rawStartedAt, basis.anchorMs, basis.timeZone, basis.version, basis.status, strong ? 'strong' : 'weak');
      // Character reassignment cannot retroactively attribute previously archived observations.
      const owner = this.prepare('SELECT character_key FROM hunt_analytics_recordings WHERE recording_key=?').get(recording);
      if (owner?.character_key !== character.key) {current.provenance = 'legacy'; current.gap = true;}
      if (previous?.segment !== current.segment || previous?.provenance !== current.provenance) current.intervalId = null;
      if (basis.anchorMs !== null && (edge > intervalFrom || current.provenance === 'prospective' && edge > 0 && edge === intervalFrom)) {
        // Replay packet timestamps are discrete milliseconds. Include the final
        // observed millisecond while retaining half-open spans and day cuts.
        const intervalEnd = basis.anchorMs + edge + 1;
        if (!current.intervalId) {
          current.intervalId = randomUUID();
          this.prepare('INSERT INTO hunt_analytics_intervals VALUES(?,?,?,?,?,?,?)').run(current.intervalId, recording, key, current.segment, basis.anchorMs + intervalFrom, intervalEnd, current.provenance);
        } else this.prepare('UPDATE hunt_analytics_intervals SET end_ms=MAX(end_ms,?) WHERE id=?').run(intervalEnd, current.intervalId);
      }
      const insert = this.prepare('INSERT OR IGNORE INTO hunt_analytics_events VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      const knownEvent = this.prepare('SELECT id,provenance FROM hunt_analytics_events WHERE id=? UNION ALL SELECT e.id,e.provenance FROM hunt_analytics_event_aliases a JOIN hunt_analytics_events e ON e.id=a.event_id WHERE a.alias_id=? LIMIT 1');
      const findEquivalent = this.prepare('SELECT e.id,e.provenance FROM hunt_analytics_events e WHERE recording_key=? AND replay_ms=? AND target_id=? AND monster_id=? AND map_id IS ? AND e.id LIKE ? AND NOT EXISTS(SELECT 1 FROM hunt_analytics_event_aliases a WHERE a.event_id=e.id) ORDER BY e.rowid LIMIT 1');
      const alias = this.prepare('INSERT INTO hunt_analytics_event_aliases VALUES(?,?)');
      const promote = this.prepare("UPDATE hunt_analytics_events SET provenance='prospective',segment_id=? WHERE id=? AND provenance='legacy'");
      for (const event of parsed.events) {
        if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0 || !isConfirmedMonsterDeath(event) || this.options.ownDamageOnly && !isOwnDamageKill(event, parsed.summary.playerId)) continue;
        const map = typeof event.mapId === 'string' && event.mapId.trim() ? event.mapId.trim().toLowerCase().slice(0, 200) : null;
        const eventProvenance = event.timestamp < intervalFrom ? 'legacy' : current.provenance;
        // A copy can archive a death ahead of the original live source. Only a
        // genuinely new covered slice may later supply prospective proof for it;
        // replaying already-read timestamps must never upgrade legacy evidence.
        const canPromote = eventProvenance === 'prospective' && previous !== undefined && event.timestamp > intervalFrom && current.intervalId !== null;
        const wire = String((event.rawData!.killProof as Record<string, unknown>).lifecycleId).startsWith('wire:');
        const id = `${wire ? 'wire' : 'legacy'}:${digest(`${recording}:${eventKey(event)}`)}`;
        const known = knownEvent.get(id, id);
        if (known) {if (canPromote && known.provenance === 'legacy') promote.run(current.segment, String(known.id)); continue;}
        // Wire and whole-file decoders can give the same observation different lifecycle labels.
        const equivalent = findEquivalent.get(recording, event.timestamp, event.targetId!, event.monsterId!, map, wire ? 'legacy:%' : 'wire:%');
        if (equivalent) {alias.run(id, String(equivalent.id)); if (canPromote && equivalent.provenance === 'legacy') promote.run(current.segment, String(equivalent.id)); continue;}
        insert.run(id, recording, String(owner!.character_key), event.monsterId!, event.monsterName ?? null, map, event.targetId!, basis.anchorMs === null ? null : basis.anchorMs + event.timestamp, event.timestamp, current.segment, eventProvenance);
      }
      this.prepare('INSERT INTO hunt_analytics_sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_key,recording_key) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,frontier_ms=MAX(frontier_ms,excluded.frontier_ms)').run(key, recording, status, info.observedAt ?? new Date().toISOString(), edge, base, generation);
      this.changed();
    });
    this.runtime.set(key, current);
  }
  close(): void {this.runtime.clear(); this.monitors.clear();}
}
