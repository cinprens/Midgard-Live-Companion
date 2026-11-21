import type { LiveStreamStatus } from './types';
import type { SoloExperienceReference, SoloExperienceProgress } from './solo-experience';

export interface KillExperiencePenaltyInput {
  characterKey: string;
  percent: 0 | 5 | 10;
}

export interface KillExperienceRateInput {
  characterKey: string;
  monsterId: number;
  baseExp: number | null;
  jobExp: number | null;
}

export interface KillExperienceRate extends KillExperienceRateInput {
  updatedAt: string;
}

export interface KillExperienceControl {
  characterKey: string;
  streamId: string;
  recordingId: string;
  action: 'start' | 'pause' | 'resume' | 'reset' | 'stop';
  sources?: KillExperienceSourceInput[];
  sessionId?: string;
  groupId?: string;
}

export interface KillExperienceSourceInput {
  characterKey: string;
  streamId: string;
  recordingId: string;
}

export interface KillExperienceSource {
  characterKey: string;
  streamId: string;
  recordingId: string;
  filename: string;
  status: LiveStreamStatus;
}

export interface KillExperienceTrack {
  gained: number | null;
  knownGained: number;
  perHour: number | null;
  knownPerHour: number | null;
  missingDeaths: number;
  lost: number | null;
  knownLost: number;
  net: number | null;
  knownNet: number;
  missingLosses: number;
}

export interface KillExperienceSession {
  id: string;
  characterKey: string;
  streamId: string;
  recordingId: string;
  filename: string;
  status: 'running' | 'paused' | 'stopped' | 'source-unavailable' | 'recording-changed';
  startedAt: string;
  durationMs: number;
  observedDeaths: number;
  observedPlayerDeaths: number;
  mode: 'single' | 'party';
  groupId: string | null;
  sources: KillExperienceSource[];
  rawObservations: number;
  duplicateCandidates: number;
  estimatedDeaths: number;
  matchingWindowMs: number;
  coverage: {
    availableSources: number;
    totalSources: number;
    partial: boolean;
    matchingUnavailable: number;
  };
  base: KillExperienceTrack;
  job: KillExperienceTrack;
  soloReference?: SoloExperienceReference | null;
  soloProgress?: SoloExperienceProgress;
  /** Only these configured monsters contribute to this solo session. Fixed at start/reset. */
  targetMonsterIds?: number[];
  /** Missing on legacy environment-observation estimates; never combine with filtered sessions. */
  attributionPolicy?: 'own-damage-v1';
}

export interface KillExperienceCharacter {
  characterKey: string;
  characterName: string;
  deathPenaltyPercent: 0 | 5 | 10;
  rates: KillExperienceRate[];
  session: KillExperienceSession | null;
}

export interface KillExperienceState {
  revision: number;
  characters: KillExperienceCharacter[];
  notice: string;
  sources?: KillExperienceSource[];
}
