import dataset from '../data/experience-requirements.v1.json';

export type JobTrack = 'novice' | 'first' | 'second';
export type ExperienceKind = 'base' | 'job';
export const EXPERIENCE_DATASET_VERSION = dataset.datasetVersion;
export const EXPERIENCE_DATASET = dataset;
export interface ExperienceRequirement {
  kind: ExperienceKind;
  jobTrack: 'base' | JobTrack;
  /** Current level; `required` is the cost of reaching level + 1. */
  level: number;
  required: number | null;
  sourceUrl: string;
  verifiedAt: string;
  publishedLevel: number | null;
  indexing: 'destination-level';
  indexingConfidence: 'supporting-calculator-cross-check';
  datasetVersion: string;
}
/** Original published rows are preserved in JSON. No extrapolation beyond a table. */
export const EXPERIENCE_REQUIREMENTS: readonly ExperienceRequirement[] = ['base', 'novice', 'first', 'second'].flatMap(track => {
  const rows = dataset.rows.filter(row => row.track === track).sort((a, b) => a.publishedLevel - b.publishedLevel);
  return rows.map(row => {
    const target = rows.find(candidate => candidate.publishedLevel === row.publishedLevel + 1);
    return { kind: track === 'base' ? 'base' as const : 'job' as const, jobTrack: track as 'base' | JobTrack,
      level: row.publishedLevel, required: target?.requiredExp ?? null, sourceUrl: row.sourceUrl,
      verifiedAt: row.verifiedAt, publishedLevel: target?.publishedLevel ?? null,
      indexing: 'destination-level' as const, indexingConfidence: 'supporting-calculator-cross-check' as const,
      datasetVersion: EXPERIENCE_DATASET_VERSION };
  });
});
const requirements = new Map(EXPERIENCE_REQUIREMENTS.map(row => [`${row.jobTrack}:${row.level}`, row]));
export function experienceRequirement(kind: ExperienceKind, level: number | null, jobTrack: JobTrack | null = null): ExperienceRequirement | null {
  if (level === null || !Number.isSafeInteger(level) || level < 1 || (kind === 'job' && jobTrack === null)) return null;
  return requirements.get(`${kind === 'base' ? 'base' : jobTrack}:${level}`) ?? null;
}
