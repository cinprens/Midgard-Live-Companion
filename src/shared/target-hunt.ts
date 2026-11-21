import type { LiveStreamStatus } from './types';

export interface TargetHuntSource {
  streamId: string;
  filename: string;
  characterKey: string | null;
  characterName: string | null;
  status: LiveStreamStatus;
}

export interface TargetHuntTarget {
  monsterId: number;
  monsterName: string;
  deathCount: number;
  rawObservations: number;
  duplicateCandidates: number;
  /** Replay-local clock label; it does not assert a UTC timezone. */
  lastDeathAt: string | null;
  lastIntervalMs: number | null;
  completedIntervals: number;
  averageIntervalMs: number | null;
  sinceLastDeathMs: number | null;
  continuityBroken: boolean;
}

export interface TargetHuntSession {
  id: string;
  status: 'waiting' | 'tracking' | 'paused' | 'source-unavailable' | 'stopped';
  startedAt: string;
  sources: TargetHuntSource[];
  activeDurationMs: number;
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
}

export interface TargetHuntState {
  countBasis?: 'own-damage' | 'observed-deaths';
  revision: number;
  session: TargetHuntSession | null;
  targets: TargetHuntTarget[];
  notice: string;
}

export interface TargetHuntTargetsInput { monsterIds: number[] }
