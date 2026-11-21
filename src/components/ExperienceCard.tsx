import { useState } from 'react';
import { ChevronDown, Clock3, Settings2, TrendingUp } from 'lucide-react';
import type { CharacterExperienceView, ExperienceTrackView, JobTrack } from '../domain/experience';
import type { DesktopAPI } from '../shared/types';
import type { KillExperienceControl, KillExperienceSession } from '../shared/kill-experience';
import KillExperienceSummary from './KillExperienceSummary';

type Run = (action: (api: DesktopAPI) => Promise<unknown>) => Promise<void>;
const number = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(value);
const eta = (seconds: number | null) => seconds == null ? 'Hız verisi bekleniyor' : seconds < 60 ? '< 1 dk' : seconds < 3600 ? `${Math.ceil(seconds / 60)} dk` : `${number(seconds / 3600)} sa`;
const jobLabels: Record<JobTrack, string> = { novice: 'Novice', first: 'First Job', second: 'Second Job' };

function Track({ kind, data }: { kind: 'base' | 'job'; data: ExperienceTrackView | undefined }) {
  const label = kind === 'base' ? 'Base' : 'Job';
  return <section className={`expanded-exp-track ${kind}`} aria-label={`${label} EXP`}>
    <div className="expanded-exp-heading">
      <strong>{label.toUpperCase()} EXP <span className="expanded-exp-level">Lv. {number(data?.level)}</span></strong>
      <span className={`expanded-exp-quality ${data?.status ?? 'waiting'}`} title={data?.reason ?? undefined}>{data?.qualityLabel ?? 'Veri bekleniyor'}</span>
    </div>
    <div className="expanded-exp-amount"><strong>{number(data?.current)}</strong><span>/ {number(data?.required)}</span><b>{data?.percent == null ? '—' : `%${number(data.percent)}`}</b></div>
    <div className="expanded-exp-bar" role="progressbar" aria-label={`${label} EXP ilerlemesi`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={data?.percent ?? undefined} aria-valuetext={data?.percent == null ? 'EXP verisi bekleniyor' : `%${number(data.percent)}`}><span style={{ width: `${Math.max(0, Math.min(100, data?.percent ?? 0))}%` }} /></div>
    <div className="expanded-exp-remaining"><span>Kalan <strong>{number(data?.remaining)}</strong></span><span><Clock3 size={11} />{eta(data?.etaSeconds ?? null)}</span></div>
    <div className="expanded-exp-metrics">
      <div><span>Saatlik {label} EXP</span><strong>{number(data?.expPerHour)}</strong><small>{data?.expPerHour == null ? 'EXP verisi bekleniyor' : data.rateQuality === 'estimated' ? 'Son 15 dk · durum farkı' : 'Son 15 dk · gözlenen kazanım'}</small></div>
      <div><span>Son kazanım</span><strong data-exp-last-gain={kind}>{data?.lastGainAmount == null ? '—' : `+${number(data.lastGainAmount)}`}</strong><small>{data?.lastGainAmount == null ? 'Yeni EXP bildirimi bekleniyor' : data.lastGainSource === 'difference' ? 'Durum farkı · tahmini' : 'Açık EXP bildirimi'}</small></div>
    </div>
    <details className="expanded-exp-rates"><summary><TrendingUp size={12} /> Kazanım ayrıntıları</summary><dl><dt>Son 5 dakika</dt><dd>{number(data?.gains5m)}</dd><dt>Son 15 dakika</dt><dd>{number(data?.gains15m)}</dd><dt>Son 60 dakika</dt><dd>{number(data?.gains60m)}</dd><dt>Net saatlik EXP</dt><dd>{number(data?.netExpPerHour)}</dd></dl><p>{data?.reason ?? 'Desteklenen EXP bildirimi bekleniyor.'}</p>{data?.requiredSource && <p>Gereksinim: {data.requiredSource === 'packet' ? 'Replay paketinden' : 'Resmî sayılar · hedef seviye yorumu çapraz kontrollü'}{data.verifiedAt ? ` · ${data.verifiedAt}` : ''}</p>}<p>Hız hesabı izlemeye başladıktan sonraki kazanımları kullanır; ilk dosya geçmişini içermez.</p></details>
  </section>;
}

export interface ExperienceCardProps {
  streamId: string;
  view: CharacterExperienceView | undefined;
  busy: boolean;
  run: Run;
  killExperience?: KillExperienceSession;
  killExperienceBusy?: boolean;
  onKillExperienceControl?: (input: KillExperienceControl) => Promise<void>;
}

export default function ExperienceCard({ streamId, view, busy, run, killExperience, killExperienceBusy, onKillExperienceControl }: ExperienceCardProps) {
  const [kind, setKind] = useState<'base' | 'job'>('base'), [mode, setMode] = useState<'current' | 'percent'>('percent'), [value, setValue] = useState(''), [level, setLevel] = useState('');
  const automatic = view?.jobTrackSource !== 'manual';
  const tableLabel = view?.jobTrack ? `${jobLabels[view.jobTrack]} · ${automatic ? 'Replay sınıfından otomatik' : 'manuel seçim'}` : 'Meslek tablosu için sınıf verisi bekleniyor';
  const estimatedSession = killExperience?.streamId === streamId && (!view || killExperience.recordingId === view.recordingId) ? killExperience : undefined;
  return <section className="character-exp">
    <div className="character-exp-heading"><TrendingUp size={14} /><strong>EXP</strong></div>
    <div className="character-exp-stats">
      <div><span>Seviye</span><strong><span aria-label="Base seviye">Base {number(view?.base.level)}</span><i>·</i><span aria-label="Job seviye">Job {number(view?.job.level)}</span></strong></div>
      {!estimatedSession && <><div><span>Base EXP / saat</span><strong data-exp-hour="base">{number(view?.base.expPerHour)}</strong></div>
      <div><span>Job EXP / saat</span><strong data-exp-hour="job">{number(view?.job.expPerHour)}</strong></div></>}
    </div>
    {estimatedSession ? <KillExperienceSummary key={estimatedSession.id} session={estimatedSession} compact busy={killExperienceBusy ?? busy} onControl={onKillExperienceControl} /> : (view?.base.expPerHour == null || view?.job.expPerHour == null) && <p className="character-exp-waiting">EXP verisi bekleniyor</p>}
    <details className="character-exp-details"><summary>EXP ayrıntıları <ChevronDown size={13} /></summary><div className="expanded-experience">
    {estimatedSession && <p className="expanded-exp-table-source">Doğrudan Replay EXP verileri. Yukarıdaki tahmini kazanım mevcut EXP, yüzde veya ETA hesabına eklenmez.</p>}
    <Track kind="base" data={view?.base} /><Track kind="job" data={view?.job} />
    <p className="expanded-exp-table-source">{tableLabel}</p>
    <details className="expanded-exp-calibration"><summary><Settings2 size={13} /> İsteğe bağlı başlangıç ve meslek ayarları</summary>
      <p>Desteklenen Replay verisi otomatik okunur. EXP okunamıyorsa başlangıç değerini girebilirsiniz; saatlik hesap için yeni EXP bildirimi gerekir. Kayıt başındaki sınıf, sonradan meslek değişirse güncel sınıfı doğrulamaz.</p>
      <label>Meslek EXP tablosu<select aria-label="Meslek EXP tablosu" value={automatic ? '' : view?.jobTrack ?? ''} disabled={busy} onChange={event => void run(api => api.setExpJobTrack(streamId, (event.target.value || null) as JobTrack | null))}><option value="">Otomatik · Replay sınıfı</option><option value="novice">Novice</option><option value="first">First Job</option><option value="second">Second Job · 70'e kadar</option></select></label>
      <div className="expanded-exp-inputs"><select aria-label="Kalibrasyon EXP türü" value={kind} disabled={busy} onChange={event => setKind(event.target.value as 'base' | 'job')}><option value="base">Base</option><option value="job">Job</option></select><select aria-label="Kalibrasyon biçimi" value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'current' | 'percent')}><option value="percent">Yüzde</option><option value="current">EXP miktarı</option></select></div>
      <div className="expanded-exp-inputs"><input aria-label="Kalibrasyon seviyesi" type="number" min="1" placeholder={`Seviye (${view?.[kind].level ?? '?'})`} value={level} disabled={busy} onChange={event => setLevel(event.target.value)} /><input aria-label="Başlangıç EXP değeri" type="number" min="0" max={mode === 'percent' ? 100 : undefined} placeholder={mode === 'percent' ? 'Başlangıç %' : 'Başlangıç EXP'} value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></div>
      <button className="button secondary" disabled={busy || !value.trim()} onClick={() => void run(api => api.calibrateExp({ streamId, kind, ...(level ? { level: Number(level) } : {}), ...(mode === 'percent' ? { percent: Number(value) } : { current: Number(value) }) }))}>Başlangıcı uygula</button>
    </details>
    </div></details>
  </section>;
}
