import { useState } from 'react';
import { Clock3, Pause, Play, RotateCcw, Square, TrendingUp } from 'lucide-react';
import type { KillExperienceControl, KillExperienceSession, KillExperienceTrack } from '../shared/kill-experience';
import './KillExperienceSummary.css';

const number = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(value);
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const statuses: Record<KillExperienceSession['status'], string> = {
  running: 'Ölçüm açık', paused: 'Duraklatıldı', stopped: 'Son oturum · Durduruldu',
  'source-unavailable': 'Kaynak bekleniyor', 'recording-changed': 'Replay kaydı değişti',
};

function Track({ kind, track }: { kind: 'base' | 'job'; track: KillExperienceTrack }) {
  const label = kind === 'base' ? 'Base' : 'Job';
  return <div className={`kill-exp-track ${kind}`}>
    <div><span>{label} kazanımı</span><strong data-kill-exp-metric={`${kind}-gained`}>{number(track.gained)}</strong></div>
    <div className="kill-exp-loss"><span>{label} kaybı</span><strong data-kill-exp-metric={`${kind}-lost`}>{number(track.lost)}</strong></div>
    <div className="kill-exp-net"><span>Net {label} EXP</span><strong data-kill-exp-metric={`${kind}-net`}>{number(track.net)}</strong></div>
    <div><span>Net EXP / saat</span><strong data-kill-exp-metric={`${kind}-hour`}>{number(track.perHour)}</strong></div>
    {(track.missingDeaths > 0 || track.missingLosses > 0) && <p className="kill-exp-partial">Kısmi · {track.missingDeaths > 0 && <>{number(track.missingDeaths)} yaratık ölümü için kazanım değeri eksik. Bilinen kazanım: {number(track.knownGained)} EXP. </>}{track.missingLosses > 0 && <>{number(track.missingLosses)} karakter ölümü için kayıp gereksinimi bilinmiyor. Bilinen kayıp: {number(track.knownLost)} EXP. </>}<span data-kill-exp-known={`${kind}-net`}>Bilinen net: {number(track.knownNet)} EXP.</span>{track.knownPerHour !== null && <> Bilinen net hız: {number(track.knownPerHour)} EXP / saat.</>}</p>}
  </div>;
}

export interface KillExperienceSummaryProps {
  session: KillExperienceSession;
  compact?: boolean;
  busy?: boolean;
  onControl?: (input: KillExperienceControl) => Promise<void>;
}

export default function KillExperienceSummary({ session, compact = false, busy = false, onControl }: KillExperienceSummaryProps) {
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function control(action: KillExperienceControl['action']) {
    if (!onControl || pending || busy) return;
    setPending(true); setError('');
    try { await onControl({ characterKey: session.characterKey, streamId: session.streamId, recordingId: session.recordingId, action,
      ...(session.mode === 'party' ? { sessionId: session.id, groupId: session.groupId ?? undefined, ...(action === 'reset' ? { sources: session.sources.map(({ characterKey, streamId, recordingId }) => ({ characterKey, streamId, recordingId })) } : {}) } : {}),
    }); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'EXP ölçümü güncellenemedi. Yeniden deneyebilirsin.'); }
    finally { setPending(false); }
  }
  const active = session.status === 'running' || session.status === 'paused';
  const party = session.mode === 'party';
  return <section className={`kill-exp-summary${compact ? ' compact' : ''}`} data-kill-exp-summary data-kill-exp-session={session.id} data-kill-exp-mode={session.mode} data-kill-exp-group={session.groupId ?? undefined} aria-label="Tahmini EXP oturumu">
    <header><span><TrendingUp size={15} />{party ? 'Party tahmini EXP' : 'Tahmini EXP'}<small>· {party ? 'Ortak ölüm havuzu' : 'Ölüm gözlemi'}</small></span><b className={`kill-exp-status ${session.status}`}>{statuses[session.status]}</b></header>
    {!compact && <p className="kill-exp-explanation">{party ? 'Ortak ölüm tahmini × bu karakterin kendi EXP değerleri. Eşleşen tekrarlar ayıklanır; kesim aidiyeti veya EXP mesafesi doğrulanmaz. Ek party çarpanı uygulanmaz.' : 'Gözlenen yaratık ölümleri × bu karakter için kaydettiğin EXP; seçilen karakter ölüm kayıpları ayrıca düşülür. Kişisel kill veya gerçek EXP paketi kanıtı değildir.'}</p>}
    <div className="kill-exp-tracks"><Track kind="base" track={session.base} /><Track kind="job" track={session.job} /></div>
    <div className="kill-exp-session-meta"><span><Clock3 size={12} /> Aktif Replay süresi <strong data-kill-exp-metric="duration">{duration(session.durationMs)}</strong></span><span>{party ? 'Ortak ölüm tahmini' : 'Ölüm gözlemi'} <strong data-kill-exp-metric="deaths">{number(session.observedDeaths)}</strong></span><span>Karakter ölümü <strong data-kill-exp-metric="player-deaths">{number(session.observedPlayerDeaths)}</strong></span></div>
    {party && <div className="kill-exp-party-proof"><span>Ham gözlem <strong data-kill-exp-metric="party-raw">{number(session.rawObservations)}</strong></span><span>Eşleşen tekrar adayı <strong data-kill-exp-metric="party-duplicates">{number(session.duplicateCandidates)}</strong></span><span>Kaynak <strong data-kill-exp-metric="party-coverage">{session.coverage.availableSources}/{session.coverage.totalSources}</strong></span></div>}
    {party && session.coverage.partial && <p className="kill-exp-session-warning">Kısmi party kapsamı · {session.coverage.availableSources}/{session.coverage.totalSources} kaynak kullanılabilir. Ortak havuz ulaşılabilen kaynaklarla ilerler; eksik kaynaktaki ölümler görülmeyebilir.</p>}
    {party && session.coverage.matchingUnavailable > 0 && <p className="kill-exp-session-warning"><span data-kill-exp-metric="party-unmatched">{number(session.coverage.matchingUnavailable)}</span> gözlem harita veya zaman bilgisi eksikliğiyle kaynaklar arasında eşleştirilemedi; ortak tahmin tekrar içerebilir.</p>}
    {session.status === 'source-unavailable' && <p className="kill-exp-session-warning">{party ? 'Party kaynaklarına ulaşılamıyor.' : 'Seçilen kaynak kullanılamıyor.'} Yeni kazanım ve süre eklenmiyor; son ölçüm gösteriliyor.</p>}
    {session.status === 'recording-changed' && <p className="kill-exp-session-warning">Kaynakta Replay kaydı veya karakter değişti. Eski ölçüm korunuyor; Kill Count içinden kaynakları yeniden seçerek yeni ölçüm başlat.</p>}
    {!compact && <p className="kill-exp-source" title={party ? session.sources.map(source => source.filename).join(' · ') : session.filename}>{party ? `Party kaynakları: ${session.sources.map(source => source.filename).join(' · ')}` : `Kaynak: ${session.filename}`} · Ölçüm başlangıcından önceki ölümler dahil edilmez.</p>}
    {party && <p className="kill-exp-group-controls-note">{compact ? 'Kontroller tüm party ölçümünü yönetir.' : 'Duraklatma, sürdürme, sıfırlama ve durdurma tüm party ölçümünü etkiler. Üyeleri değiştirmek için durdurup yeni party başlat. Ölüm kaybı yalnız bu karaktere aittir.'}</p>}
    {onControl && session.status !== 'stopped' && <div className="kill-exp-controls">
      {active && <button type="button" disabled={pending || busy} aria-label={session.status === 'paused' ? 'Tahmini EXP sürdür' : 'Tahmini EXP duraklat'} onClick={() => void control(session.status === 'paused' ? 'resume' : 'pause')}>{session.status === 'paused' ? <Play size={12} /> : <Pause size={12} />}{session.status === 'paused' ? 'Devam et' : 'Duraklat'}</button>}
      {active && <button type="button" disabled={pending || busy} aria-label="Tahmini EXP sıfırla" title={party ? 'Tüm party EXP ölçümünü aynı üyelerle yeniden başlatır. Kaydedilmiş yaratık değerleri korunur.' : 'Yalnız bu EXP ölçümünü yeniden başlatır. Kaydedilmiş yaratık değerleri korunur.'} onClick={() => void control('reset')}><RotateCcw size={12} /> Sıfırla</button>}
      <button type="button" disabled={pending || busy} aria-label="Tahmini EXP durdur" onClick={() => void control('stop')}><Square size={11} /> Durdur</button>
    </div>}
    {error && <p className="kill-exp-error" role="alert">{error}</p>}
  </section>;
}
