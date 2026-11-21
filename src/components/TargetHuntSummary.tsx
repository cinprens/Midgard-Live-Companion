import { Clock3, Crosshair } from 'lucide-react';
import type { TargetHuntState } from '../shared/target-hunt';
import './TargetHuntSummary.css';

const number = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const minutes = (value: number | null | undefined) => value == null || !Number.isFinite(value) || value < 0 ? '—' : `${number.format(value / 60000)} dk`;
const statusLabels = { waiting: 'İlk veri bekleniyor', tracking: 'Otomatik takip', paused: 'Takip duraklatıldı', 'source-unavailable': 'Kaynak bekleniyor', stopped: 'Takip durdu' };
export interface TargetHuntSummaryProps { state: TargetHuntState | undefined; compact?: boolean; }

export default function TargetHuntSummary({ state, compact = false }: TargetHuntSummaryProps) {
  const session = state?.session, targets = state?.targets ?? [], coverage = session?.coverage;
  return <section className={`target-hunt-summary${compact ? ' compact' : ''}`} data-target-hunt aria-label="Hedef av takibi">
    <header><div><span className="target-hunt-kicker"><Crosshair size={14} /> HEDEF AV TAKİBİ</span><h2>Avların arasındaki süre.</h2><p>İzlenen bütün Replay kaynakları · Seçili hedefler otomatik takip edilir.</p></div><span className="target-hunt-source-count" data-hunt-sources>{coverage ? `${coverage.availableSources}/${coverage.totalSources} kaynak` : 'Kaynak bekleniyor'}{session && <small>{statusLabels[session.status]}</small>}</span></header>
    <p className="target-hunt-clock-note">Süreler Replay ilerlemesine göredir; kayıt durursa sayaç bekler.</p>
    {coverage?.partial && <p className="target-hunt-warning" role="status">Bazı Replay kaynakları kullanılamıyor. Sonuçlar kısmi olabilir; takip boşluğunu aşan aralıklar hesaplanmaz.</p>}
    <div className="target-hunt-targets">{targets.map(target => <article className="target-hunt-target" key={target.monsterId} data-hunt-monster={target.monsterId}>
      <div className="target-hunt-target-heading"><h3>{target.monsterName || `Yaratık #${target.monsterId}`}<small>#{target.monsterId}</small></h3><span><strong data-hunt-metric="deaths">{number.format(target.deathCount)}</strong> ölüm gözlemi</span></div>
      <dl className="target-hunt-metrics"><div className="target-hunt-since"><dt><Clock3 size={13} /> Son avdan geçen</dt><dd data-hunt-metric="since-last">{minutes(target.sinceLastDeathMs)}</dd></div><div><dt>Son iki av arası</dt><dd data-hunt-metric="last-interval">{minutes(target.lastIntervalMs)}</dd></div><div><dt>Ortalama av aralığı</dt><dd data-hunt-metric="average-interval">{minutes(target.averageIntervalMs)}</dd></div></dl>
      {target.continuityBroken ? <p className="target-hunt-gap">Takipte boşluk var; yeni güvenilir av çifti bekleniyor.</p> : target.deathCount === 0 ? <p className="target-hunt-hint">İlk hedef ölümü bekleniyor.</p> : target.completedIntervals === 0 ? <p className="target-hunt-hint">{target.deathCount === 1 ? 'Aralık hesabı için ikinci hedef ölümü bekleniyor.' : 'Henüz karşılaştırılabilir iki av gözlemi yok.'}</p> : !compact && <p className="target-hunt-hint">Ortalama, {number.format(target.completedIntervals)} tamamlanan aralıktan hesaplandı.</p>}
    </article>)}</div>
    {!targets.length && <p className="target-hunt-empty">{!state ? 'Hedef av verileri hazırlanıyor.' : 'Takip edilecek hedef seçilmedi. Bildirim ayarlarından veya Hedefleri düzenle bölümünden yaratık ekleyebilirsin.'}</p>}
    {!compact && <details className="target-hunt-details"><summary>Takip bilgisi</summary><p>Ölüm gözlemleri kesin kişisel kill veya doğma süresi değildir. Kaynaklarda eşleşen tekrarlar ayıklanır; bütün eşleştirmeler kesin kabul edilmez.</p>{session && <p>{number.format(session.rawObservations)} ham gözlem · {number.format(session.duplicateCandidates)} tekrar adayı.</p>}{coverage && coverage.matchingUnavailable > 0 && <p>{number.format(coverage.matchingUnavailable)} gözlem kaynaklar arasında eşleştirilemedi; toplam tekrar içerebilir.</p>}<p>{state?.notice}</p></details>}
  </section>;
}
