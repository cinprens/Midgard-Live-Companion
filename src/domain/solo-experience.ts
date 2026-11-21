import type { KillExperienceSession, KillExperienceTrack } from '../shared/kill-experience';
import type { SoloExperienceProgress, SoloExperienceReference, SoloExperienceTrackProgress } from '../shared/solo-experience';
import { experienceRequirement, type ExperienceKind, type JobTrack } from './experience-table';
import type { LiveTelemetry } from '../parser/types';
import { replayTrackAtCap, skadiNextLevelRequirement, usesRebalancedExp } from './skadi-level-cap';
import { replayClockBasis } from '../shared/replay-clock-basis';

export type SoloExperienceSessionInput = Pick<KillExperienceSession, 'base' | 'job' | 'durationMs'> &
  Partial<Pick<KillExperienceSession, 'observedPlayerDeaths' | 'coverage'>> & { soloCoverageIncomplete?: boolean };

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isLevel = (value: unknown): value is number => isAmount(value) && value > 0;
const isTrack = (value: unknown): value is JobTrack => value === 'novice' || value === 'first' || value === 'second';

export function captureSoloExperienceReference(telemetry: LiveTelemetry | undefined, startedAt: string | null): SoloExperienceReference {
  const reference: SoloExperienceReference = {
    baseLevel:isLevel(telemetry?.baseLevel) ? telemetry.baseLevel : null,
    jobLevel:isLevel(telemetry?.jobLevel) ? telemetry.jobLevel : null,
    jobTrack:isTrack(telemetry?.jobTrack) ? telemetry.jobTrack : null,
  };
  const currentTable = usesRebalancedExp(startedAt);
  if (!currentTable && replayClockBasis(startedAt).anchorMs !== null) return reference;
  if (telemetry?.timedExp?.job?.reset) reference.jobTrack = null;
  function threshold(kind: ExperienceKind): NonNullable<SoloExperienceReference['requirements']>[ExperienceKind] {
    const level = reference[kind === 'base' ? 'baseLevel' : 'jobLevel'];
    const timed = telemetry?.timedExp?.[kind];
    const jobClass = kind === 'job' && timed?.reset ? null : telemetry?.jobClassId ?? null;
    if (!isLevel(level) || replayTrackAtCap(kind,level,startedAt,jobClass)) return null;
    const opening = telemetry?.recordingStartExp?.[kind];
    const value = timed?.required ?? (!timed?.reset && opening?.level === level ? opening.required : null);
    if (value != null) return isLevel(value) && !(kind === 'job' && value === 2_808_348_671) ? {amount:value,source:'replay'} : null;
    const official = currentTable ? skadiNextLevelRequirement(kind,level,jobClass) : null;
    return isLevel(official) ? {amount:official,source:'official-table'} : null;
  }
  reference.requirements = {base:threshold('base'),job:threshold('job')};
  return reference;
}

function safeRatio(value: number, denominator: number, scale: number): number | null {
  const result = value / denominator * scale;
  return Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER ? result : null;
}

function hourly(gained: number, durationMs: number): number | null {
  return isAmount(durationMs) && durationMs > 0 ? safeRatio(gained, durationMs, 3_600_000) : null;
}

function projectTrack(kind: ExperienceKind, reference: SoloExperienceReference | null | undefined,
  track: KillExperienceTrack | undefined, session: SoloExperienceSessionInput): SoloExperienceTrackProgress {
  const selectedLevel = kind === 'base' ? reference?.baseLevel : reference?.jobLevel;
  const level = isLevel(selectedLevel) ? selectedLevel : null;
  const jobTrack = isTrack(reference?.jobTrack) ? reference.jobTrack : null;
  const requirement = reference?.requirements ? reference.requirements[kind]?.amount : experienceRequirement(kind, level, jobTrack)?.required;
  const requiredExp = level !== null && isLevel(requirement) ? requirement : null;
  const coverageNotice = session.soloCoverageIncomplete === true || session.coverage?.partial === true
    ? ' Kaydı eksik kalan aralıklar için kazanım eklenmez.' : '';
  const knownGained = isAmount(track?.knownGained) ? track.knownGained : 0;
  const knownPerHour = isAmount(track?.knownGained) ? hourly(knownGained, session.durationMs) : null;
  const unavailable: SoloExperienceTrackProgress = {
    status: 'unavailable', level, gained: null, knownGained, percent: null, requiredExp,
    perHour: null, knownPerHour, notice: 'EXP toplamı güvenli biçimde hesaplanamıyor.' + coverageNotice,
  };
  if (!track || !isAmount(track.missingDeaths)) return unavailable;
  if (track.gained === null || track.missingDeaths > 0) {
    if (!isAmount(track.knownGained)) return unavailable;
    return { ...unavailable, status: 'incomplete',
      notice: 'Bazı yaratıkların EXP değeri eksik; yalnız bilinen kazanım gösteriliyor.' + coverageNotice };
  }
  if (!isAmount(track.gained)) return unavailable;

  const gained = track.gained;
  const percent = requiredExp === null ? null : safeRatio(gained, requiredExp, 100);
  const perHour = hourly(gained, session.durationMs);
  const percentNotice = requiredExp === null
    ? ' Başlangıç seviyesi için doğrulanmış bir EXP eşiği yok.'
    : percent === null ? ' Yüzde karşılığı güvenli hesaplama aralığını aşıyor.'
      : ' Yüzde, başlangıç seviyesinin EXP gereksinimine göre kazanım karşılığıdır.';
  const durationNotice = !isAmount(session.durationMs) || session.durationMs === 0
    ? ' Saatlik hesap için kayıt süresi gerekiyor.'
    : perHour === null ? ' Saatlik değer güvenli hesaplama aralığını aşıyor.' : '';
  return { status: 'estimated', level, gained, knownGained: gained, percent, requiredExp, perHour, knownPerHour: perHour,
    notice: 'Girilen yaratık EXP değerlerine göre brüt kazanım tahmini.' + percentNotice + durationNotice + coverageNotice };
}

/** Gross session gain against a frozen starting level; never current EXP or inferred level-up progress. */
export function projectSoloExperience(reference: SoloExperienceReference | null | undefined,
  session: SoloExperienceSessionInput): SoloExperienceProgress {
  return { base: projectTrack('base', reference, session.base, session), job: projectTrack('job', reference, session.job, session) };
}
