import type { LiveTelemetry, ReplayEvent, StatusKey } from './types';

// Primary wire definitions: rAthena src/map/{map.hpp,packets_struct.hpp,clif.cpp}.
// In particular, SP_JOBLEVEL is 55; 12 is SP_SKILLPOINT. 0x0b1b is
// ZC_NOTIFY_ACTORINIT (2 bytes), never a 64-bit status packet.
const PARAMETERS = new Map<number, StatusKey>([
  [1, 'baseExp'], [2, 'jobExp'], [5, 'hp'], [6, 'maxHp'], [11, 'baseLevel'],
  [22, 'nextBaseExp'], [23, 'nextJobExp'], [24, 'weight'], [25, 'maxWeight'], [55, 'jobLevel'],
]);
export const TELEMETRY_PACKET_IDS = new Set([0x00b0, 0x00b1, 0x0acb, 0x07f6, 0x0acc]);

/** Client class IDs: rAthena src/common/mmo.hpp e_job, basic classes only.
 * Rebirth, baby and expanded classes do not imply the ordinary Zero EXP table.
 */
export function jobTrackForClass(jobClassId: number | null): NonNullable<LiveTelemetry['jobTrack']> | null {
  if (jobClassId === 0) return 'novice';
  if (jobClassId === null || !Number.isSafeInteger(jobClassId)) return null;
  if (jobClassId >= 1 && jobClassId <= 6) return 'first';
  if (jobClassId >= 7 && jobClassId <= 21) return 'second';
  return null;
}

/** Session is a recording-start snapshot. Its EXP fields do not describe later rewards. */
export function decodeSessionTelemetry(chunks: readonly { id: number; data: Uint8Array }[]): Partial<LiveTelemetry> {
  const read = (id: number, width: 4 | 8 = 4): number | null => {
    const matches = chunks.filter(chunk => chunk.id === id);
    if (matches.length !== 1 || matches[0]!.data.length !== width) return null;
    const data = matches[0]!.data;
    const view = new DataView(data.buffer, data.byteOffset, width);
    const value = width === 4 ? view.getUint32(0, true) : Number(view.getBigUint64(0, true));
    return Number.isSafeInteger(value) ? value : null;
  };
  const jobClassId = read(1014);
  const jobTrack = jobTrackForClass(jobClassId);
  const result: Partial<LiveTelemetry> = { jobClassId, jobTrack, jobTrackSource: jobTrack === null ? null : 'rrf-session-class' };
  for (const [id, key] of [[1016, 'baseLevel'], [1019, 'jobLevel']] as const) {
    const value = read(id);
    if (value !== null && value > 0) {
      result[key] = value;
      if (key === 'jobLevel') result.recordingStartJobLevel = value;
    }
  }
  if (read(1010)) {
    // Session 1051 matches the next recording after ZC_LONGPAR_CHANGE/20 on Skadi.
    const wallet = read(1051);
    if (wallet !== null && wallet <= 0x7fffffff) result.zenyBalance = wallet;
    const snapshot: NonNullable<LiveTelemetry['recordingStartExp']> = {};
    const pair = (level: number, amountId: number, requiredId: number, width: 4 | 8) => {
      const amount = read(amountId, width), required = read(requiredId, width);
      // At the job cap the client stores the low 32 bits of its cap sentinel in 1054.
      if (amount === null || required === null || required === 0 || amount >= required ||
          (width === 4 && required === 2_808_348_671)) return undefined;
      return { level, amount, required };
    };
    const base = result.baseLevel ? pair(result.baseLevel, 1015, 1018, 8) : undefined;
    const job = result.jobLevel ? pair(result.jobLevel, 1055, 1054, 4) : undefined;
    if (base) snapshot.base = base;
    if (job) snapshot.job = job;
    if (base || job) result.recordingStartExp = snapshot;
  }
  return result;
}
type DecodedTelemetry =
  | { kind: 'status'; statusKey: StatusKey; amount: number; parameter: number }
  | { kind: 'exp'; expKind: 'base' | 'job'; amount: number; actorId: number; quest: boolean }
  | { kind: 'invalid'; reason: string };

/** Strictly decode supported layouts; unsupported parameters remain unknown. */
export function decodeTelemetry(data: Uint8Array): DecodedTelemetry | null {
  if (data.length < 2) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const packet = view.getUint16(0, true);
  if (!TELEMETRY_PACKET_IDS.has(packet)) return null;
  const exp = packet === 0x07f6 || packet === 0x0acc;
  const wide = packet === 0x0acb || packet === 0x0acc;
  const expected = exp ? wide ? 18 : 14 : wide ? 12 : 8;
  if (data.length !== expected) return { kind: 'invalid', reason: 'Durum/EXP paketi uzunluğu kaynak tanımıyla uyuşmuyor.' };
  const offset = exp ? 6 : 4;
  const raw = wide ? view.getBigInt64(offset, true) : BigInt(view.getInt32(offset, true));
  if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER)) {
    return { kind: 'invalid', reason: 'Durum/EXP değeri kesin JavaScript tam sayı aralığını aşıyor; yuvarlanmadı.' };
  }
  const amount = Number(raw);
  const parameter = view.getUint16(exp ? wide ? 14 : 10 : 2, true);
  if (exp) {
    if (parameter !== 1 && parameter !== 2) return null;
    const type = view.getUint16(wide ? 16 : 12, true);
    if (type !== 0 && type !== 1) return { kind: 'invalid', reason: 'Tanımlanmamış EXP bildirim türü.' };
    return { kind: 'exp', expKind: parameter === 1 ? 'base' : 'job', amount, actorId: view.getUint32(2, true), quest: type === 1 };
  }
  // clif_updatestatus sends sd.status.zeny with ZC_LONGPAR_CHANGE to SELF.
  const statusKey = packet === 0x00b1 && parameter === 20 ? 'zenyBalance' : PARAMETERS.get(parameter);
  if (!statusKey) return null;
  if (amount < 0) return { kind: 'invalid', reason: 'Desteklenen karakter durumu negatif olamaz; değer kullanılmadı.' };
  return { kind: 'status', statusKey, amount, parameter };
}

export function emptyLiveTelemetry(): LiveTelemetry {
  return { hp: null, maxHp: null, weight: null, maxWeight: null, weightPercent: null,
    zenyBalance: null, zenyReceived: null,
    baseLevel: null, jobLevel: null, recordingStartJobLevel: null, jobClassId: null, jobTrack: null, jobTrackSource: null, timedExp: {}, currentBaseExp: null, currentJobExp: null,
    nextBaseExp: null, nextJobExp: null, lastBaseExpGain: null, lastJobExpGain: null,
    baseExpGained: null, jobExpGained: null, currentMap: null };
}

const expTracks = new Map<StatusKey, 'base' | 'job'>([
  ['baseExp', 'base'], ['nextBaseExp', 'base'], ['baseLevel', 'base'],
  ['jobExp', 'job'], ['nextJobExp', 'job'], ['jobLevel', 'job'],
]);

/** Apply the same wallet baselines and status updates in the full and streaming parsers. */
export function applyLiveStatus(telemetry: LiveTelemetry, event: ReplayEvent, overflow: Set<'base' | 'job' | 'zeny'>, annotateWallet=false): void {
  const {statusKey, amount} = event;
  if (event.eventType !== 'status' || !statusKey || amount == null || !Number.isSafeInteger(amount) || amount < 0) return;
  if (statusKey === 'zenyBalance') {
    if(annotateWallet)delete event.walletIncrease;
    if (event.attribution !== 'personal' || !event.actorId || amount > 0x7fffffff) return;
    const previous = telemetry.zenyBalance;
    if (previous != null) {
      const increase=Math.max(0, amount - previous);
      if(annotateWallet)event.walletIncrease=increase;
      const total = (telemetry.zenyReceived ?? 0) + increase;
      if (!Number.isSafeInteger(total)) overflow.add('zeny');
      telemetry.zenyReceived = overflow.has('zeny') ? null : total;
    }
  }
  const track = expTracks.get(statusKey);
  if (track && event.attribution === 'personal' && event.actorId && event.rawData?.source === 'self-parameter-update') {
    const previous = telemetry.timedExp?.[track];
    if (statusKey === 'baseLevel' || statusKey === 'jobLevel') {
      // A balance or threshold sent before a level change cannot be safely assigned to the new level.
      const level = telemetry[statusKey];
      if (level !== amount && (previous || level !== null && amount < level)) {
        const reset = previous?.reset || level !== null && amount < level;
        telemetry.timedExp = {...telemetry.timedExp, [track]: reset ? {reset: true} : {}};
      }
    } else if (event.rawData.timed === true) {
      const balance = statusKey === 'baseExp' || statusKey === 'jobExp';
      const field = balance ? 'balance' : 'required';
      const value = !balance && track === 'job' && amount === 2_808_348_671 ? 0 : amount;
      telemetry.timedExp = {...telemetry.timedExp, [track]: {...previous, [field]: value}};
    }
  }
  const key = statusKey === 'baseExp' ? 'currentBaseExp' : statusKey === 'jobExp' ? 'currentJobExp' : statusKey;
  telemetry[key] = amount;
}

/** Keep unknown separate from zero; never derive EXP gained from status differences. */
export function summarizeLiveTelemetry(events: ReplayEvent[], seed: Partial<LiveTelemetry> = {}, annotateWallet=false): LiveTelemetry {
  const result = { ...emptyLiveTelemetry(), ...seed };
  const seen = new Set<string>();
  const overflow = new Set<'base' | 'job' | 'zeny'>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.eventType === 'map' && event.mapId) result.currentMap = event.mapId;
    applyLiveStatus(result, event, overflow, annotateWallet);
    if (event.eventType !== 'exp-gain' || !event.expKind || !Number.isSafeInteger(event.amount) || event.amount! < 0 || event.attribution !== 'personal') continue;
    const totalKey = event.expKind === 'base' ? 'baseExpGained' : 'jobExpGained';
    const lastKey = event.expKind === 'base' ? 'lastBaseExpGain' : 'lastJobExpGain';
    result[lastKey] = event.amount!;
    const sum = (result[totalKey] ?? 0) + event.amount!;
    if (!Number.isSafeInteger(sum)) overflow.add(event.expKind);
    result[totalKey] = overflow.has(event.expKind) ? null : sum;
  }
  result.weightPercent = result.weight !== null && result.maxWeight !== null && result.maxWeight > 0 ? result.weight / result.maxWeight * 100 : null;
  return result;
}
