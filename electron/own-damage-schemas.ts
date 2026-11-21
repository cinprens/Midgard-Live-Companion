import {HUNT_ANALYTICS_SCHEMA} from './hunt-analytics-ingest';

// Separate ledgers keep legacy ambient deaths and their timing coverage intact.
export const OWN_DAMAGE_HUNT_SCHEMA = HUNT_ANALYTICS_SCHEMA.replaceAll('hunt_analytics_', 'own_damage_hunt_analytics_') + `
  CREATE TABLE IF NOT EXISTS own_damage_target_hunt_metadata(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS own_damage_target_hunt_sources(source_key TEXT NOT NULL,recording_key TEXT NOT NULL,frontier_ms REAL NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(source_key,recording_key));
  CREATE TABLE IF NOT EXISTS own_damage_target_hunt_candidates(id TEXT PRIMARY KEY,monster_id INTEGER NOT NULL,monster_name TEXT,map_id TEXT,target_id INTEGER NOT NULL,clock_ms REAL,event_ms REAL NOT NULL,time_basis TEXT NOT NULL,segment_id TEXT NOT NULL,source_key TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS own_damage_target_hunt_matching ON own_damage_target_hunt_candidates(map_id,target_id,monster_id,clock_ms);
  CREATE INDEX IF NOT EXISTS own_damage_target_hunt_chronology ON own_damage_target_hunt_candidates(monster_id,time_basis,clock_ms,event_ms);
  CREATE TABLE IF NOT EXISTS own_damage_target_hunt_observations(source_key TEXT NOT NULL,recording_key TEXT NOT NULL,event_key TEXT NOT NULL,candidate_id TEXT NOT NULL REFERENCES own_damage_target_hunt_candidates(id),event_ms REAL NOT NULL,PRIMARY KEY(source_key,recording_key,event_key),UNIQUE(candidate_id,source_key));
  CREATE TABLE IF NOT EXISTS own_damage_target_hunt_intervals(id TEXT PRIMARY KEY,segment_id TEXT NOT NULL,source_key TEXT NOT NULL,start_ms REAL NOT NULL,end_ms REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS own_damage_target_hunt_observation_time ON own_damage_target_hunt_observations(source_key,recording_key,event_ms);
  CREATE INDEX IF NOT EXISTS own_damage_target_hunt_recent ON own_damage_target_hunt_candidates(monster_id,clock_ms DESC,event_ms DESC);
  CREATE INDEX IF NOT EXISTS own_damage_target_hunt_previous ON own_damage_target_hunt_candidates(monster_id,time_basis,clock_ms DESC);
  CREATE INDEX IF NOT EXISTS own_damage_target_hunt_interval_segment ON own_damage_target_hunt_intervals(segment_id,start_ms,end_ms);
  CREATE INDEX IF NOT EXISTS own_damage_target_hunt_observation_candidate ON own_damage_target_hunt_observations(candidate_id);
  INSERT OR IGNORE INTO own_damage_target_hunt_metadata SELECT key,value_json FROM target_hunt_metadata WHERE key='targets';
`;
