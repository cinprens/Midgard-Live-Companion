import type { JobTrack } from '../domain/experience-table';

/** Captured automatically at session start; never a current EXP anchor. */
export interface SoloExperienceReference {
  baseLevel: number | null;
  jobLevel: number | null;
  jobTrack: JobTrack | null;
  /** Frozen when the measurement starts. Historical references used the original EXP table. */
  requirements?: Record<'base' | 'job', {amount:number; source:'replay'|'official-table'} | null>;
}

export type SoloExperienceStatus = 'estimated' | 'incomplete' | 'unavailable';

export interface SoloExperienceTrackProgress {
  status: SoloExperienceStatus;
  level: number | null;
  gained: number | null;
  knownGained: number;
  percent: number | null;
  requiredExp: number | null;
  perHour: number | null;
  knownPerHour: number | null;
  notice: string;
}

export interface SoloExperienceProgress {
  base: SoloExperienceTrackProgress;
  job: SoloExperienceTrackProgress;
}
